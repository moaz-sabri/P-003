// Exercises: building one, running one, and finishing one.
//
// The session is reconstructed from the attempt log rather than held in a
// variable (see domain/session-run.js). This module is the glue: it asks the
// schedule whether a new exercise may be built, asks the builder what to put in
// it, writes it with its items in one transaction, and then answers questions by
// writing an attempt and asking the session what the state is now.
//
// Two decisions that are not obvious from the code:
//
//   * `start()` REFUSES WHEN SOMETHING IS OPEN. Not because that is tidy, but
//     because the alternative is two exercises for one interval, and the reader
//     would have questions from the first one still to answer with nothing left
//     to answer them with. `planSchedule` already knows; this only turns the
//     knowledge into an error rather than an overwrite.
//
//   * AN ANSWER IS WRITTEN BEFORE THE UI SHOWS WHETHER IT WAS RIGHT. The verdict
//     is a consequence of a record that exists, not the other way round. The
//     reverse order — decide, show, and write afterwards — is what produces an
//     exercise that advances past a question whose answer was lost to a tab
//     closed in between, and the reader comes back to a session that has already
//     moved on and cannot say they got it wrong.

import { planSchedule, SCHEDULE, latestExercise } from "../domain/schedule.js";
import { buildExercisePlan, nextExerciseNumber, hasAnythingToAsk, reviewWindow } from "../domain/exercise-builder.js";
import { resumeSession, isFinished, progress, countKinds, firstPass } from "../domain/session-run.js";
import { latestAttempt } from "../domain/stats.js";
import { ScheduleError, InvalidTransitionError, NotFoundError } from "../domain/errors.js";
import { addDays } from "../domain/time.js";
import {
    getActiveGoal, listExercises, listQuestions, listAllAttempts, getExercise, getQuestion,
    createExercise as createExerciseRecord, completeExercise, listItems,
    listAllOptions, recordAttempt, listAttempts
} from "../data/repos.js";

/** Where the app is with respect to the schedule. Read by three pages, so it is
 *  a service call and not a repository call — the question is "what should the
 *  Exercise button do", which is not a question any one store can answer. */
export async function status() {
    const goal = await getActiveGoal();
    if (!goal) return { state: SCHEDULE.NO_GOAL, goal: null };
    const exercises = await listExercises(goal.id);
    return { ...planSchedule({ goal, exercises }), goal, exercises };
}

/**
 * Build and write the next exercise.
 *
 * @param {() => number} [rand] injected for tests; Math.random in the app
 * @returns {Promise<{exercise: object, plan: object}>}
 */
export async function start(rand = Math.random) {
    const goal = await getActiveGoal();
    if (!goal) throw new ScheduleError("no_goal");
    if (goal.status === "completed") throw new ScheduleError("goal_completed");

    const exercises = await listExercises(goal.id);
    const plan = planSchedule({ goal, exercises });

    if (plan.state === SCHEDULE.IN_PROGRESS) {
        // The caller is offered the open exercise instead. Throwing rather than
        // returning it keeps one rule in one place: nothing anywhere in this app
        // creates a second exercise for an interval that already has one open.
        throw new InvalidTransitionError(plan.state, "start_exercise");
    }
    if (plan.state === SCHEDULE.WAITING) throw new ScheduleError("too_soon");

    const [questions, attempts] = await Promise.all([
        listQuestions(goal.id),
        listAllAttempts()
    ]);
    const history = latestAttempt(attempts);

    // THE REVIEW WINDOW: the questions of the last `reviewDepth` exercises, oldest
    // first. This is the whole of what makes an exercise grow — 5 new per exercise
    // with a 3-deep window gives 5, then 10, then 15, then 20, and then 20 for as
    // long as the questions last. It is read here rather than derived from the
    // attempt log because "which questions were in the last three exercises" is a
    // question about exercise ITEMS, and the item rows are the record of that.
    const window = reviewWindow(await itemsOfLast(exercises, goal), goal);

    const built = buildExercisePlan({ goal, questions, history, recent: window, rand });

    if (!hasAnythingToAsk(built)) throw new ScheduleError("nothing_to_exercise");

    const { exercise } = await createExerciseRecord({
        goalId: goal.id,
        number: nextExerciseNumber(exercises),
        items: built.items,
        intervalDays: goal.intervalDays
    });

    return { exercise, plan: built };
}

/**
 * Everything the exercise page needs, and the session rebuilt from the log.
 *
 * `questions` and `options` come back keyed by id rather than as lists in item
 * order, because the page asks for one question at a time and a map lookup is
 * how it gets it. Building a per-item question list here would mean carrying
 * twenty copies of the same object to answer one of them.
 */
export async function load(exerciseId) {
    const exercise = await getExercise(exerciseId);
    if (exercise.deletedAt) throw new NotFoundError("exercise", exerciseId);

    const [items, attempts, allQuestions] = await Promise.all([
        listItems(exerciseId),
        attemptsFor(exerciseId),
        listQuestions(exercise.goalId)
    ]);

    const wanted = new Set(items.map((i) => i.questionId));
    const relevant = allQuestions.filter((q) => wanted.has(q.id));
    const options = await listAllOptions(relevant.map((q) => q.id));

    const optionsByQuestion = new Map();
    for (const option of options) {
        if (!optionsByQuestion.has(option.questionId)) optionsByQuestion.set(option.questionId, []);
        optionsByQuestion.get(option.questionId).push(option);
    }

    const questions = new Map();
    for (const question of relevant) {
        questions.set(question.id, {
            ...question,
            // The presentation order is frozen here, at the moment the question
            // is first drawn, and not stored. It is a function of the stored
            // item order plus a hash of the question id, so it is the same order
            // after a reload — which is what matters, since reloading mid-exercise
            // must not reshuffle the options under the reader — and it is not a
            // field that has to survive a sync merge.
            options: shuffleForDisplay(optionsByQuestion.get(question.id) ?? [], question.id)
        });
    }

    const session = resumeSession(items, attempts);
    return {
        exercise,
        items,
        attempts,
        questions,
        optionsByQuestion,
        session,
        progress: progress(session, items.length),
        finished: isFinished(session) && Boolean(exercise.completedAt)
    };
}

/** The exercise to resume, or null. */
export async function openOne(goalId) {
    const exercises = await listExercises(goalId);
    const latest = latestExercise(exercises);
    return latest && !latest.completedAt ? latest : null;
}

/** The exercise the result page is about when the URL does not name one — the
 *  most recent exercise that was actually finished.
 *
 *  `latestExercise` and not "the last one in the list", and `completedAt` and not
 *  merely "the last one", because a result page is reachable from the nav bar as
 *  well as from the end of an exercise, and the two do not have to agree about
 *  which exercise is the latest: an exercise that was started this morning and
 *  left open has a higher number than yesterday's finished one, and showing its
 *  score would be showing a score for a session that has not ended. */
export async function lastFinished() {
    const goal = await getActiveGoal();
    if (!goal) return null;
    const exercises = await listExercises(goal.id);
    const latest = latestExercise(exercises);
    return latest?.completedAt ? latest : null;
}

/** One exercise by id, or null.
 *
 *  Null rather than a throw, because the id comes from a URL and the question
 *  "is this still here" is one the result page asks before deciding what to draw
 *  — the same answer shape `question-service.load()` gives the editor. */
export async function findExercise(id) {
    try {
        const exercise = await getExercise(id);
        return exercise.deletedAt ? null : exercise;
    } catch {
        return null;
    }
}

/** Open the exercise the Exercise button should lead to: the open one if there
 *  is one, otherwise the page that starts a new one. */
export async function resumeId() {
    const goal = await getActiveGoal();
    if (!goal) return null;
    const open = await openOne(goal.id);
    return open?.id ?? null;
}

async function attemptsFor(exerciseId) {
    return listAttempts(exerciseId);
}

/** The items of a goal's exercises, oldest exercise first, one array per
 *  exercise. The window wants them in that order and nothing else, and building
 *  the whole list here rather than a window's worth is what keeps the slice in
 *  `reviewWindow` the single place the depth is decided. */
async function itemsOfLast(exercises, goal) {
    const depth = Math.max(1, Math.round(Number(goal?.reviewDepth) || 3));
    const wanted = exercises.slice(-depth);
    return Promise.all(wanted.map((exercise) => listItems(exercise.id)));
}

/**
 * Record one answer and return what the reader should be told.
 *
 * `selected` is the option ids that were tapped, in the order they were tapped,
 * so that a report can show the sequence rather than a set. Correctness is
 * decided here and not in the page: the page could get it wrong in a way nothing
 * would catch — a hidden duplicate option, an option that was added by a sync
 * merge after the question was drawn — while this is the one place that can be
 * tested against the same comparison the whole app uses.
 *
 * `round` comes from the caller's session rather than being worked out here,
 * because the session is what the page is looking at; deriving it again from the
 * log would be a second answer to a question that already has one, and the two
 * would differ on the item that repeats.
 *
 * @returns {Promise<{correct: boolean, correctIds: string[], finished: boolean,
 *                    repeated: boolean, session: object, attempt: object}>}
 */
export async function answer(exerciseId, item, selected, round = 1) {
    const exercise = await getExercise(exerciseId);
    if (exercise.deletedAt) throw new NotFoundError("exercise", exerciseId);
    if (exercise.completedAt) throw new InvalidTransitionError("completed", "answer");

    const [options, attempts] = await Promise.all([
        listAllOptions([item.questionId]),
        attemptsFor(exerciseId)
    ]);

    const chosen = [...new Set(selected)].sort();
    const expected = options
        .filter((o) => o.isCorrect)
        .map((o) => o.id)
        .sort();

    // Set equality on both sides. A subset is wrong — "you missed one" is the
    // single most useful thing an exercise can say — and a superset is wrong for
    // the same reason. Sorting both sides is what makes a single-choice question
    // and a multiple-choice question go through the same comparison.
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

    // THE SESSION IS REBUILT, NOT ADVANCED. The attempt is already in the list
    // handed to `resumeSession`, so the log now describes the answer that was just
    // given and the rebuilt session already accounts for it — feeding the same
    // answer through `advance` on top applies it twice. It used to be harmless:
    // `resumeSession` read only the current round, so the item it had just moved
    // into `repeat` came back into the queue and `advance` moved it once more.
    // With the item's round taken into account, `advance` sees an answer for
    // something no longer on screen, ignores it, and `repeated` is silently false
    // for every answer that was supposed to say "again".
    const session = resumeSession(items, [...attempts, attempt]);

    return {
        correct,
        correctIds: expected,
        finished: isFinished(session),
        // "Again" is exactly this: the round moved on past the round the answer was
        // given in. Read off the rebuilt session rather than carried out of
        // `advance`, because there is one session in this function and having two
        // is how the two of them came to disagree.
        repeated: !isFinished(session) && session.round > round,
        session,
        attempt
    };
}

/**
 * Finish an exercise, once the session has run out.
 *
 * The guard is the finished session rather than a timer or a question count:
 * there is no state in which the page can finish an exercise that is not
 * finished, because the page asks for the item out of the session queue and the
 * queue is empty. Which is why `finish()` here only has to check one thing — that
 * the record really is complete — and can refuse if it is not.
 */
export async function finish(exerciseId) {
    const exercise = await getExercise(exerciseId);
    if (exercise.completedAt) return { exercise, summary: await summaryFor(exercise) };

    const [items, attempts] = await Promise.all([listItems(exerciseId), attemptsFor(exerciseId)]);
    // `hasItems` is not a formality. An open exercise whose questions were all
    // deleted — on this device or by a sync tombstone on another — has an empty
    // queue, and "the queue is empty" is exactly what "finished" means everywhere
    // else in this file. Stamping it would log a completed exercise that asked
    // zero questions and move the goal's schedule on by an interval, having
    // rehearsed nothing.
    if (!items.length || !isFinished(resumeSession(items, attempts), items.length > 0)) {
        throw new InvalidTransitionError("in_progress", "finish_exercise");
    }

    const done = await completeExercise(exerciseId);
    return { exercise: done, summary: await summaryFor(done) };
}

/** What the result page shows. Derived from the attempt log and the interval on
 *  the goal — both already stored, neither written again.
 *
 *  SEVEN FIGURES, and the split between them is the point:
 *
 *    first        what the reader got right the first time they saw each
 *                 question. This is the score. Averaging every tap instead makes
 *                 a reader who was shown the same question six times look better
 *                 than one who was shown six questions and knew four.
 *    wrong        how many of those were not right to begin with.
 *    reasks       how many times a question had to be shown again to get there.
 *    final        where the exercise ended, which is 100% of the items asked by
 *                 construction — an exercise does not finish otherwise.
 *    elapsed      from the exercise's creation to its last answer.
 *    nextDueAt    when the next one opens, from WHEN THIS ONE FINISHED.
 *
 *  And the list of what was wrong, with the right answer beside it: `wrongItems`
 *  carries the question text and the correct options, resolved here rather than on
 *  the page, because the page would need the same three queries and would get a
 *  slightly different answer the moment an option was edited. */
export async function summaryFor(exercise) {
    const goal = await getActiveGoal();
    const [items, attempts] = await Promise.all([listItems(exercise.id), attemptsFor(exercise.id)]);
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
        // The score IS the first-attempt figure. The all-rounds one is kept as
        // `taps` below and is deliberately not what the page calls "Score": a
        // question shown six times until it was right and five questions known
        // first time produce the same number of taps, and only one of them is a
        // thing the reader did.
        percent: first.percent,
        first,
        wrong: first.wrong,
        reasks: first.reasks,
        newCount: kinds.new,
        newCorrect: kinds.newCorrect,
        reviewCount: kinds.review,
        reviewCorrect: kinds.reviewCorrect,
        elapsed,
        wrongItems: await describeWrong(items, attempts, first.wrongItemIds),
        // The next unlock is measured from when this exercise FINISHED, not from
        // when it was created — hence `completedAt` and not `createdAt`. An
        // exercise left open for three days and finished in a minute must not
        // unlock the next one three days after the one before it. `schedule.js`
        // computes the same value for the same exercise from the same two inputs,
        // which is what stops the two screens disagreeing.
        nextDueAt: addDays(exercise.completedAt ?? Date.now(), goal?.intervalDays ?? 1)
    };
}

/**
 * The questions the reader got wrong first time, with the answer they should have
 * picked.
 *
 * The options are read NOW rather than being reconstructed from the attempt's
 * `selected` list, and that is deliberate: an option can have been edited since
 * the attempt was written, and the point of the list is "this is the right answer
 * today", not "this is what the database would have said at the time". The
 * attempt's own `selected` ids are still resolved, because "you picked this" is
 * only true of the option as it was — and an id that no longer resolves to an
 * option is dropped rather than printed as a blank, which is the only honest thing
 * to do with it.
 */
async function describeWrong(items, attempts, wrongItemIds) {
    if (!wrongItemIds.length) return [];
    const byItem = new Map(items.map((i) => [i.id, i]));
    const wanted = wrongItemIds.map((id) => byItem.get(id)).filter(Boolean);
    if (!wanted.length) return [];

    const questionIds = [...new Set(wanted.map((i) => i.questionId))];
    const [questions, options] = await Promise.all([
        Promise.all(questionIds.map((id) => getQuestion(id).catch(() => null))),
        listAllOptions(questionIds)
    ]);
    const textOf = new Map();
    questions.filter(Boolean).forEach((q) => textOf.set(q.id, q.text));

    const byQuestion = new Map();
    for (const option of options) {
        if (!byQuestion.has(option.questionId)) byQuestion.set(option.questionId, []);
        byQuestion.get(option.questionId).push(option);
    }

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
        const optionsForQuestion = (byQuestion.get(item.questionId) ?? [])
            .slice()
            .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
        const first = firstOf.get(item.id);
        return {
            itemId: item.id,
            kind: item.kind,
            text: textOf.get(item.questionId) ?? "",
            correct: optionsForQuestion.filter((o) => o.isCorrect).map((o) => o.text),
            selected: (first?.selected ?? [])
                .map((id) => optionsForQuestion.find((o) => o.id === id)?.text)
                .filter(Boolean)
        };
    });
}

/* -------------------------------------------------------------------------- */

/**
 * A stable, per-question shuffle of the options.
 *
 * Deterministic rather than random, because of the reload rule above: `order`
 * on the exercise item is stored, but the option order is not, and a fresh
 * `Math.random()` on every draw would move the answers around every time the tab
 * was reloaded — including between two taps of the same question. A hash of the
 * question id gives the same permutation for the same question on every device
 * (so the sync merge produces the same picture everywhere) and a different one for
 * every question (so the answers do not sit in the same row all the time).
 */
function shuffleForDisplay(options, seed) {
    if (options.length < 2) return options.slice();
    let hash = 0x811c9dc5;
    const text = String(seed);
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const out = options.slice();
    for (let i = out.length - 1; i > 0; i--) {
        // A hash walk rather than Math.random: deterministic, and it degrades to
        // something that still differs for consecutive questions because the id
        // differs.
        hash ^= hash << 13; hash >>>= 0;
        hash ^= hash >> 17;
        hash ^= hash << 5; hash >>>= 0;
        const j = hash % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}