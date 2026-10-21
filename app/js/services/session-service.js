// Exercises: building one, running one, and finishing one.
//
// AN EXERCISE IS PART OF A GOAL, not a thing beside it. There is no free-standing
// "session" concept in this app: an exercise is a numbered sitting that a goal
// produced, it is stored with that goal's id, it is listed on that goal's page, and
// it is reached from that goal's page. Nothing here takes a goal that the caller did
// not name, and nothing here decides which goal to build for — that decision belongs
// to the reader and is made on the goal.
//
// A SESSION IS A SNAPSHOT, and every function here is written on the back of that.
// The service reads questions ONCE, at the moment an exercise is created, and writes
// their text, kind and options into the items. After that nothing in this file -- or
// anywhere else -- asks the question store what a session is asking:
//
//   * `start` freezes. Once the items are written the set is fixed; there is no
//     code path that adds a question to an open session, and the reason there is not
//     one is that the items carry their own text. There is nothing to append TO.
//
//   * `load` draws from the items. The question map it returns is built out of the
//     items' frozen copies, so editing a question mid-session changes what the NEXT
//     session asks and leaves this one exactly as it was.
//
//   * `answer` grades against the frozen options. This is the part that matters most
//     and is easiest to get wrong: an option the reader has since unticked was
//     correct when this session was built, and grading against the current marks is
//     what makes a session change under the reader's hands.
//
// Three decisions that are not obvious from the code:
//
//   * AN ANSWER IS WRITTEN BEFORE THE UI SHOWS WHETHER IT WAS RIGHT. The verdict is
//     a consequence of a record that exists, not the other way round. The reverse
//     order is what produces a session that advances past a question whose answer was
//     lost to a tab closed in between.
//
//   * A SESSION MAY BE REPEATED, AND THE REPEAT COPIES THE FROZEN COPIES. A repeat is
//     the same questions again, which under the snapshot rule means the same TEXTS
//     again -- not a fresh copy of the current questions. A reader revising for an
//     exam on Sunday wants the twenty words they practised on Tuesday, and a repeat
//     that silently picked up this week's edits is not that.
//
//   * THE GOAL IS ALWAYS NAMED. `start`, `repeat`, `load`, `answer` and `finish` all
//     take the goal or read it off the exercise record. The one exception is `last-
//     Finished`, which exists for a nav destination that no longer exists, and it
//     says so.

import { planSchedule, SCHEDULE } from "../domain/schedule.js";
import { REVIEW_DEPTH } from "../config.js";
import {
    buildExercisePlan, buildSelectedPlan, nextExerciseNumber, hasAnythingToAsk, reviewWindow,
    exerciseQuota, shuffle
} from "../domain/exercise-builder.js";
import {
    questionsForGoal, questionsForSelection, isExactSelection
} from "../domain/goal-content.js";
import {
    resumeSession, isFinished, progress, countKinds, firstPass, questionOf, isDrawable
} from "../domain/session.js";
import { latestAttempt } from "../domain/stats.js";
import { ScheduleError, InvalidTransitionError, NotFoundError } from "../domain/errors.js";
import { getGoal, goalRefsFor } from "../data/repo-goals.js";
import { listQuestions, listAllOptions, orderOptions } from "../data/repo-questions.js";
import {
    getExercise, listExercises, listAllAttempts,
    createExercise as createExerciseRecord, completeExercise, listItems, recordAttempt,
    listAttempts, setSourceExercise
} from "../data/repo-sessions.js";

/* -------------------------------------------------------------------------- */
/*                              what a goal has                                 */
/* -------------------------------------------------------------------------- */

/** A goal by id, but a tombstoned one is not a goal. `null` rather than a throw,
 *  because every caller of this is a page deciding what to draw and a missing goal
 *  is something to draw. */
async function readGoal(goalId) {
    try {
        const goal = await getGoal(goalId);
        return goal.deletedAt ? null : goal;
    } catch {
        return null;
    }
}

/**
 * The questions a goal draws on, with their options, in the reader's order.
 *
 * THE JOIN, DONE IN ONE PLACE. This is the only function that assembles "what this
 * goal is made of": it reads the references, resolves the groups, expands them
 * against the whole question list, and hands back questions that already carry their
 * options -- because the builder freezes from `question.options` and an item with no
 * options in it is an item the session page cannot draw.
 *
 * The options are read AFTER the questions rather than in the same transaction, so
 * the `questionIds` are known. That is a second transaction on purpose: the
 * alternative is an options read per question, which is the N-transactions-per-row
 * pattern the question list used to have and which the batch read exists to avoid.
 *
 * A goal with no references at all returns an empty list, and that is a real state
 * rather than an error: "a goal may be created without any questions" is one of the
 * things this app is built to allow, and the goal page says so and offers the two
 * ways to attach material. It is ALSO the reason a question never reaches a goal by
 * accident -- nothing here falls back to the whole question list.
 */
export async function questionsFor(goalId) {
    const [refs, all] = await Promise.all([goalRefsFor(goalId), listQuestions()]);
    const questions = questionsForGoal({ groups: refs.groups, questionIds: refs.questionIds, allQuestions: all });
    if (!questions.length) return [];

    const options = await listAllOptions(questions.map((q) => q.id));
    const byQuestion = new Map();
    for (const option of options) {
        if (!byQuestion.has(option.questionId)) byQuestion.set(option.questionId, []);
        byQuestion.get(option.questionId).push(option);
    }
    return questions.map((question) => ({
        ...question,
        options: orderOptions(byQuestion.get(question.id))
    }));
}

/* -------------------------------------------------------------------------- */
/*                                  starting                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build and write this goal's next exercise.
 *
 * THE GOAL IS REQUIRED. `goalId = null` and "the newest active goal" used to be the
 * default here, which is what made an exercise a free-standing thing that could be
 * produced without anyone choosing a plan for it. It is now a parameter with no
 * default: the caller is a page about a goal, and the reader chose which goal by
 * being on it.
 *
 * @param {{goalId: string, groupIds?: string[]|null, questionIds?: string[]|null,
 *          excludeIds?: string[]|null, rand?: () => number}} input
 *   A selection -- `groupIds`, `questionIds`, or both -- means the reader NAMED the
 *   material and the session is exactly that, with no plan, no review window and no
 *   shuffle. Omitting all three means the plan draws the next session the way it
 *   always has. `rand` is injected for tests; `Math.random` in the app.
 * @returns {Promise<{exercise: object, plan: object, quota: object}>}
 */
export async function start({ goalId, groupIds = null, questionIds = null, excludeIds = null, rand = Math.random }) {
    const goal = await readGoal(goalId);
    if (!goal) throw new ScheduleError("no_goal");
    if (goal.status === "completed") throw new ScheduleError("goal_completed");
    if (goal.archivedAt) throw new ScheduleError("goal_archived");

    // The goal's OWN exercises, and only those: the interval is measured from them and
    // so is the rate cap. The cap used to be counted over every exercise on the device,
    // which meant a goal created this morning could not be started at all because a
    // different goal had been worked hard in the last two days -- and the refusal came
    // from here as a toast on a Start button the page had drawn as live, because the
    // page had counted the same way and the count was about somebody else's work.
    const exercises = await listExercises(goal.id);
    const quota = exerciseQuota(exercises);
    const plan = planSchedule({ goal, exercises, quota });

    // AN OPEN EXERCISE NO LONGER BLOCKS A NEW ONE. It used to, and that was the rule
    // the old "one session at a time" screen was built around. It was right when the
    // only way to be asked a second set of questions was to wait, and that stopped
    // being true once a question could be filed in a group and asked whenever the
    // reader liked. What stops them queueing forty is the cap, which counts how fast
    // exercises are STARTED and so does not punish somebody who simply left one open.
    //
    // There used to be a second gate here — the interval, `SCHEDULE.WAITING`, a
    // "come back in N days" refusal. The interval is gone with the plan it belonged
    // to, so the cap is the only thing `start` may refuse on.
    if (plan.state === SCHEDULE.RATE_LIMITED) throw new ScheduleError("too_many_exercises", { quota });

    const [questions, attempts] = await Promise.all([
        questionsFor(goal.id),
        listAllAttempts()
    ]);
    const history = latestAttempt(attempts);

    // ONE DECISION, ASKED ONCE. Whether this is a named session or a planned one is
    // decided in goal-content.js and nowhere else, so the two paths cannot each hold a
    // slightly different idea of what a selection is -- which is what happens the
    // moment a page grows its own `if (groupIds.length)` beside this one.
    const selection = { groupIds, questionIds, excludeIds };
    const named = isExactSelection(selection);
    const pool = questionsForSelection(questions, selection);

    let built;
    if (named) {
        // THE NAMED SESSION. No window, no cap on new items, no shuffle -- the reader
        // said which questions and this is the set they get. `hasAnythingToAsk` is
        // still the guard, and it is here for the case where every named question was
        // deleted on another device since the picker drew it: a session with no items
        // is one that finishes instantly and reads as a completed sitting.
        built = buildSelectedPlan({ questions: pool, history, rand });
        if (!hasAnythingToAsk(built)) throw new ScheduleError("nothing_to_exercise");
    } else {
        // THE PLANNED SESSION. The review window is the questions of the last
        // `REVIEW_DEPTH` exercises, oldest first, and this is the whole of what makes a
        // session grow: 10 new per session with a 3-deep window gives 10, then 20,
        // then 30, and 30 for as long as the questions last. It is read from the
        // item rows rather than derived from the attempt log because "which questions
        // were in the last three sessions" is a question about session ITEMS, and the
        // item rows are the record of that.
        const window = reviewWindow(await itemsOfLast(exercises));
        built = buildExercisePlan({ questions: pool, history, recent: window, rand });
        if (!hasAnythingToAsk(built)) throw new ScheduleError("nothing_to_exercise");
    }

    // `pool` rather than `questions`: a named selection is a subset, and writing the
    // whole goal's questions into the items would put back every question the reader
    // deliberately unticked.
    const { exercise } = await createExerciseRecord({
        goalId: goal.id,
        number: nextExerciseNumber(exercises),
        items: built.items,
        groupIds,
        questionIds,
        excludeIds
    });

    // What is left of the allowance AFTER this one, which is the only figure the
    // reader can act on: "2 of 3 left" tells them to start the one they meant rather
    // than the one they happened to open. Counted over the goal's own exercises for
    // the reason `start` counts over them.
    return { exercise, plan: built, quota: exerciseQuota([...exercises, exercise]) };
}

/**
 * Build the SAME questions again, as a new exercise of the same goal.
 *
 * "the exercise closes, and the same words can be asked again whenever you like" --
 * a finished exercise is a set of questions that was asked once, not a record that
 * has been used up. A reader revising for an exam wants the same twenty questions on
 * Sunday, and an app that answers "come back on the 14th" has not read what they
 * asked for.
 *
 * A NEW EXERCISE WITH THE SAME ITEMS, and that is the whole design. Re-opening the
 * old record would append the second sitting to its attempt log, so the report would
 * score the session over both and the first-try figure -- the one number on the result
 * page that means anything -- would be gone. A repeat with its own record has its own
 * score, its own time and its own row in the goal's history, and the original is
 * untouched and still reportable.
 *
 * THE FROZEN COPIES ARE COPIED, NOT RE-READ. This is the snapshot rule applied to a
 * repeat: a session repeated on Sunday is the same questions in the same words as the
 * one from Tuesday, so it repeats the TEXT rather than looking the question up again.
 *
 * An item whose question no longer exists is copied anyway, for the same reason: the
 * original carried its own copy of the question, so the repeat carries it too.
 *
 * The rate cap applies here too. A repeat is an exercise, it consumes a slot, and the
 * cap exists to bound how fast a reader can queue them -- letting repeats around it
 * would make the cap decorative.
 */
export async function repeat(exerciseId, { rand = Math.random } = {}) {
    const original = await getExercise(exerciseId);
    if (original.deletedAt) throw new NotFoundError("exercise", exerciseId);

    const goal = await readGoal(original.goalId);
    if (!goal) throw new ScheduleError("no_goal");
    if (goal.status === "completed") throw new ScheduleError("goal_completed");
    if (goal.archivedAt) throw new ScheduleError("goal_archived");

    // THE GOAL'S OWN EXERCISES, for the same reason `start` counts over them: the cap is
    // an allowance for this goal and not a shared budget, so a repeat on goal B does
    // not spend a slot goal A has already spent, and a repeat on goal A is not refused
    // by goal B's evening.
    const exercises = await listExercises(goal.id);
    const quota = exerciseQuota(exercises);
    if (quota.blocked) throw new ScheduleError("too_many_exercises", { quota });

    const originalItems = await listItems(exerciseId);
    const items = originalItems
        // Only an item that could have been drawn is copied. An item with no frozen
        // text is one written before the snapshot existed, and repeating it would
        // build a session with an undrawable question in it.
        .filter((item) => isDrawable(item))
        .map((item, order) => ({
            questionId: item.questionId,
            kind: item.kind,
            order,
            questionText: item.questionText,
            questionKind: item.questionKind,
            // THE OPTIONS ARE SHUFFLED AGAIN. A repeat is a NEW exercise, and the one
            // thing every freshly built exercise has in common is that its options
            // were arranged by `rand` at build time — see `freeze` in the builder and
            // `buildSelectedPlan`. The `order` is rewritten to the new position, so
            // the arrangement survives a reload exactly like every other build's.
            options: shuffle(item.options ?? [], rand).map((o, i) => ({
                id: o.id, text: o.text, isCorrect: Boolean(o.isCorrect), order: i
            }))
        }));
    if (!items.length) throw new ScheduleError("nothing_to_exercise");

    const { exercise } = await createExerciseRecord({
        goalId: goal.id,
        number: nextExerciseNumber(exercises),
        items,
        // THE ORIGINAL'S SELECTION, all three halves of it. Copying only `groupIds`
        // was half the answer to "the same questions again": a session the reader
        // built by ticking four specific questions repeated as one that records no
        // selection at all, and the record then claimed the plan had chosen it.
        groupIds: original.groupIds ?? null,
        questionIds: original.questionIds ?? null,
        // The exclusions too. They are irrelevant to WHAT the repeat asks -- the items
        // are copied from the original, so a question the reader left out last time is
        // not in them -- but they are the record of the decision, and dropping them
        // would make the repeat look like a plain plan draw.
        excludeIds: original.excludeIds ?? null
    });

    // `sourceId` is written after the record exists, because it is the new exercise's
    // own id that has to be on it. It is the only field written outside
    // `createExercise`, and it is written through the same `touch` path so it is
    // dirty like everything else.
    const repeatOf = await setSourceExercise(exercise.id, exerciseId);
    return { exercise: repeatOf, source: original, items };
}

/* -------------------------------------------------------------------------- */
/*                                   running                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything the exercise page needs, with the session rebuilt from the log.
 *
 * `questions` is a map of item id -> the question that item carries, keyed by ITEM
 * and not by question. The same question can be in two items of one exercise only if
 * the reader named it twice, which the builder prevents, but the keying is by item
 * because the item is what the page navigates by and asking a question store for
 * "the question with this id" is the dependency the snapshot exists to remove.
 *
 * Building a per-item question list would mean carrying twenty copies of the same
 * object to answer one of them; a map lookup by item id is how the page gets the one
 * it is on.
 */
export async function load(exerciseId) {
    const exercise = await getExercise(exerciseId);
    if (exercise.deletedAt) throw new NotFoundError("exercise", exerciseId);

    const [items, attempts] = await Promise.all([listItems(exerciseId), listAttempts(exerciseId)]);

    const questions = new Map();
    for (const item of items) {
        questions.set(item.id, questionOf(item));
    }

    const session = resumeSession(items, attempts);
    return {
        exercise,
        items,
        attempts,
        questions,
        session,
        progress: progress(session, items.length),
        finished: isFinished(session) && Boolean(exercise.completedAt)
    };
}

/**
 * Record one answer and return what the reader should be told.
 *
 * `selected` is the option ids that were tapped, in the order they were tapped,
 * so that a report can show the sequence rather than a set.
 *
 * THE KEY IS THE FROZEN OPTIONS, AND THAT IS THE WHOLE OF THE SNAPSHOT RULE HERE.
 * The expected answer is read off `item.options` -- the copy written when the session
 * was created -- and never off the question store. An option the reader unticked after
 * starting is still correct in this session, because it was correct when the session
 * began, and grading it against the current marks is precisely the "the session
 * changed under me" failure.
 *
 * `round` comes from the caller's session rather than being worked out here, because
 * the session is what the page is looking at; deriving it again from the log would be
 * a second answer to a question that already has one, and the two would differ on the
 * item that repeats.
 *
 * @returns {Promise<{correct: boolean, correctIds: string[], finished: boolean,
 *                    repeated: boolean, session: object, attempt: object}>}
 */
export async function answer(exerciseId, item, selected, round = 1) {
    const exercise = await getExercise(exerciseId);
    if (exercise.deletedAt) throw new NotFoundError("exercise", exerciseId);
    if (exercise.completedAt) throw new InvalidTransitionError("completed", "answer");

    // NO OPTIONS ARE READ HERE, and the absence is the point. The item carries them;
    // a read would be a second answer key that could disagree with the one on screen.
    const frozen = Array.isArray(item?.options) ? item.options : [];
    const attempts = await listAllAttempts();

    const chosen = [...new Set(selected)].sort();
    // THE KEY IS THE OPTION ID, NOT ITS POSITION. Ids are what the attempt log
    // stores, and a key built from `indexOf` would break the moment an option was
    // added above another one -- silently, with the page showing the same answer
    // marked correct twice.
    const expected = frozen
        .filter((o) => o.isCorrect)
        .map((o) => o.id)
        .sort();

    // Set equality on both sides. A subset is wrong -- "you missed one" is the
    // single most useful thing a session can say -- and a superset is wrong for the
    // same reason. Sorting both sides is what makes a single-choice question and a
    // multiple-choice question go through the same comparison.
    const correct = chosen.length === expected.length
        && chosen.every((id, i) => id === expected[i]);

    const attempt = await recordAttempt({
        exerciseId,
        itemId: item.id,
        questionId: item.questionId,
        round,
        correct,
        selected: chosen
    });

    const items = await listItems(exerciseId);

    // THE SESSION IS REBUILT, NOT ADVANCED. The attempt is already in the list handed
    // to `resumeSession`, so the log now describes the answer that was just given and
    // the rebuilt session already accounts for it -- feeding the same answer through
    // `advance` on top applies it twice. It used to be harmless: `resumeSession` read
    // only the current round, so the item it had just moved into `repeat` came back
    // into the queue and `advance` moved it once more. With the item's round taken
    // into account, `advance` sees an answer for something no longer on screen, ignores
    // it, and `repeated` is silently false for every answer that was supposed to say
    // "again".
    const session = resumeSession(items, [...attempts, attempt]);

    return {
        correct,
        correctIds: expected,
        finished: isFinished(session),
        // "Again" is exactly this: the round moved on past the round the answer was
        // given in. Read off the rebuilt session rather than carried out of `advance`,
        // because there is one session in this function and having two is how the two
        // of them came to disagree.
        repeated: !isFinished(session) && session.round > round,
        session,
        attempt
    };
}

/**
 * Finish an exercise, once the queue has run out.
 *
 * The guard is the finished session rather than a timer or a question count: there
 * is no state in which the page can finish an exercise that is not finished, because
 * the page asks for the item out of the session queue and the queue is empty. Which
 * is why `finish()` here only has to check one thing -- that the record really is
 * complete -- and can refuse if it is not.
 */
export async function finish(exerciseId) {
    const exercise = await getExercise(exerciseId);
    if (exercise.completedAt) return { exercise, summary: await summaryFor(exercise) };

    const [items, attempts] = await Promise.all([listItems(exerciseId), listAttempts(exerciseId)]);
    // `items.length` is not a formality. An open exercise whose items were all
    // tombstoned by the migration, on a device that had sessions built before the
    // snapshot existed, has an empty queue -- and "the queue is empty" is exactly what
    // "finished" means everywhere else in this file. Stamping it would log a completed
    // session that asked zero questions and move the goal's schedule on by an
    // interval, having rehearsed nothing.
    if (!items.length || !isFinished(resumeSession(items, attempts), items.length > 0)) {
        throw new InvalidTransitionError("in_progress", "finish_exercise");
    }

    const done = await completeExercise(exerciseId);
    return { exercise: done, summary: await summaryFor(done) };
}

/* -------------------------------------------------------------------------- */
/*                                  reporting                                  */
/* -------------------------------------------------------------------------- */

/** One exercise by id, or null.
 *
 *  Null rather than a throw, because the id comes from a URL and the question "is
 *  this still here" is one the result page asks before deciding what to draw — the
 *  same answer shape `question-service.load()` gives the editor. */
export async function findExercise(id) {
    try {
        const exercise = await getExercise(id);
        return exercise.deletedAt ? null : exercise;
    } catch {
        return null;
    }
}

/* -------------------------------------------------------------------------- */
/*                                  reporting                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the result page shows. Derived from the attempt log and the items' own frozen
 * copies -- all already stored, none of it written again.
 *
 * THE FIGURES, and the split between them is the point:
 *
 *    first        what the reader got right the first time they saw each
 *                 question. This is the score. Averaging every tap instead makes a
 *                 reader who was shown the same question six times look better than
 *                 one who was shown six questions and knew four.
 *    wrong        how many of those were not right to begin with.
 *    reasks       how many times a question had to be shown again to get there.
 *    final        where the session ended, which is 100% of the items asked by
 *                 construction -- a session does not finish otherwise.
 *    elapsed      from the session's creation to its last answer.
 *
 * And the list of what was wrong, with the right answer beside it: `wrongItems`
 * carries the question text and the correct options, read from the item's FROZEN copy.
 * A report of a session from last Tuesday is about the questions as they were last
 * Tuesday, and resolving the text and the answer key from the question store instead
 * would mean editing one option after the fact silently rewrote what last week's
 * result page said the right answer was.
 *
 * (There used to be a seventh figure, `nextDueAt` — when the next exercise unlocks —
 * and it is gone with the interval it was computed from. A finished exercise ends
 * with Continue or Stop now, and neither needs a date.)
 */
export async function summaryFor(exercise) {
    const [items, attempts] = await Promise.all([listItems(exercise.id), listAttempts(exercise.id)]);
    const kinds = countKinds(items, attempts);
    const first = firstPass(items, attempts);
    const correct = attempts.filter((a) => a.correct).length;
    const elapsed = attempts.length
        ? Math.max(...attempts.map((a) => a.answeredAt)) - exercise.createdAt
        : 0;

    return {
        exercise,
        total: items.length,
        attempts: attempts.length,
        correct,
        // The score IS the first-attempt figure. The all-rounds one is deliberately not
        // what the page calls "Score": a question shown six times until it was right
        // and five questions known first time produce the same number of taps, and only
        // one of them is a thing the reader did.
        percent: first.percent,
        first,
        wrong: first.wrong,
        reasks: first.reasks,
        newCount: kinds.new,
        newCorrect: kinds.newCorrect,
        reviewCount: kinds.review,
        reviewCorrect: kinds.reviewCorrect,
        elapsed,
        wrongItems: describeWrong(items, attempts, first.wrongItemIds)
    };
}

/**
 * The questions the reader got wrong first time, with the answer they should have
 * picked.
 *
 * EVERYTHING COMES FROM THE ITEM. The text, the correct options and the order they
 * were shown in are all in the item's frozen copy, and none of them are read from the
 * question store.
 *
 * The attempt's own `selected` ids are resolved against the same frozen list, because
 * "you picked this" is only true of the option as it was -- and an id that no longer
 * resolves is dropped rather than printed as a blank, which is the only honest thing to
 * do with it.
 */
function describeWrong(items, attempts, wrongItemIds) {
    if (!wrongItemIds.length) return [];
    const byItem = new Map(items.map((i) => [i.id, i]));
    const wanted = wrongItemIds.map((id) => byItem.get(id)).filter(Boolean);
    if (!wanted.length) return [];

    // The FIRST attempt of each wrong item, so the "you picked" line is the answer
    // that was actually wrong rather than the last one before it was put right.
    const firstOf = new Map();
    const wantedSet = new Set(wrongItemIds);
    for (const a of attempts) {
        if (a.round !== 1 || !wantedSet.has(a.itemId)) continue;
        const held = firstOf.get(a.itemId);
        if (!held || a.id > held.id) firstOf.set(a.itemId, a);
    }

    return wanted.map((item) => {
        const options = orderOptions(item.options ?? []);
        const first = firstOf.get(item.id);
        return {
            itemId: item.id,
            kind: item.kind,
            // `questionOf` rather than a field read, so the one function that knows
            // the item's shape is the one that reads it. A `questionText` read here
            // would be a second rule about where a question's words come from, and the
            // two would disagree the first time a session was built by a different
            // path.
            text: questionOf(item).text,
            correct: options.filter((o) => o.isCorrect).map((o) => o.text),
            selected: (first?.selected ?? [])
                .map((id) => options.find((o) => o.id === id)?.text)
                .filter(Boolean)
        };
    });
}

/* -------------------------------------------------------------------------- */
/*                                  internals                                  */
/* -------------------------------------------------------------------------- */

/** The items of a goal's exercises, oldest first, one array per exercise. The window
 *  wants them in that order and nothing else, and building the whole list here rather
 *  than a window's worth is what keeps the slice in `reviewWindow` the single place the
 *  depth is decided. */
async function itemsOfLast(exercises) {
    const wanted = exercises.slice(-REVIEW_DEPTH);
    return Promise.all(wanted.map((exercise) => listItems(exercise.id)));
}
