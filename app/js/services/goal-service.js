// Goals: the plan, what it is made of, and the one rule that says when a new
// exercise may start.
//
// A GOAL IS A PLAN AND NOT A CONTAINER. It says why the reader is training and how
// often; it says nothing about which questions exist and holds no questions. What it
// draws on is a set of `goalRefs` rows -- some naming groups, some naming individual
// questions -- and a goal with none of them is a complete, valid, empty goal.
//
// It is worth being precise about what that is not. It is not that a goal became
// optional as a way of reaching a question: a goal is still where the training
// settings live, and an exercise is still started from one. It is that the questions
// stopped being the goal's property. The consequences the pages can feel:
//
//   * A goal can be created with no questions and is finished on that basis rather
//     than being a mistake to repair -- so the create form does not send the reader
//     anywhere to write material first.
//   * NOTHING ATTACHES A QUESTION AUTOMATICALLY. Not writing one, not opening one,
//     not answering it. `questionsFor` below widens only through reference rows, and
//     reference rows are written only by goal-content-service's two `attach`
//     functions, which only the picker on the goal's own page calls.
//   * THE GOAL PAGE IS THE ONLY PLACE AN EXERCISE IS DECIDED. `overview()` and
//     `overviews()` below read everything a goal's page and the home page need, and
//     `domain/goal-action.js` turns that into the single decision about what can be
//     done. Neither page decides anything for itself.
//
// Everything about the SCHEDULE is unchanged: one exercise per interval, counted from
// when the last one was finished, with a cap on how fast any ONE goal may start new
// ones. None of that depends on who owns the questions.

import { validateGoal, assertValid } from "../domain/validation.js";
import { planSchedule, SCHEDULE } from "../domain/schedule.js";
import { exerciseQuota } from "../domain/exercise-builder.js";
import { summarize } from "../domain/stats.js";
import { questionsForGoal } from "../domain/goal-content.js";
import { goalAction, ACTION } from "../domain/goal-action.js";
import { InvalidTransitionError, ScheduleError } from "../domain/errors.js";
import { CLOSE_REQUIRES_NO_OPEN_EXERCISES, MAX_ACTIVE_GOALS } from "../config.js";
import {
    getActiveGoal, listActiveGoals, listArchivedGoals, listGoals, getGoal, goalRefsFor,
    archiveGoal, unarchiveGoal,
    // The three writes, imported here so a page never reaches past this module into
    // the data layer to change a goal. The separation is the point of the service
    // layer: `createGoal` below validates, and the repository neither knows nor cares
    // what a valid goal is.
    createGoal as createGoalRecord, updateGoalPlan, completeGoal, addGoalRefs
} from "../data/repo-goals.js";
import { listQuestions } from "../data/repo-questions.js";
import {
    listExercises, listAllAttempts, openExercises
} from "../data/repo-sessions.js";

export { SCHEDULE };
export { ACTION };
export { goalAction };
export { getActiveGoal, listActiveGoals, listArchivedGoals, getGoal };

export async function listHistory() {
    return listGoals();
}

/* -------------------------------------------------------------------------- */
/*                                 the overview                                */
/* -------------------------------------------------------------------------- */

/**
 * Every active goal, newest first, with everything its page and the home page need.
 *
 * THE DEVICE-WIDE READ HAPPENS ONCE. The attempt log every figure below is derived
 * from, and the whole question list the material join expands against, are read a
 * single time for the whole page rather than once per goal. With three goals that is
 * two transactions instead of six -- and, the part that matters more, two moments in
 * time rather than three, so two cards cannot describe different instants.
 *
 * THE EXERCISE ALLOWANCE IS NOT IN THAT HALF, and that is the correction. It used to
 * be computed from `listAllExercises()` here and handed to every goal, so the cap was
 * one between the reader's goals: a goal made this morning was refused because another
 * one had been worked hard, and the card said so in a sentence about nothing the
 * reader was looking at. Each goal is now counted from its own exercises -- which it
 * was reading anyway, for the interval and for the counts below -- so a goal with no
 * exercises has the whole allowance and says READY, which is the truth about it.
 *
 * The per-goal reads (the exercises, the references) are still per goal, because a
 * goal's material and history are its own and there is no read that answers it for
 * several at once.
 */
export async function overviews() {
    const goals = await listActiveGoals();
    if (!goals.length) return [];

    const [attempts, allQuestions] = await Promise.all([
        listAllAttempts(),
        listQuestions()
    ]);

    // `Promise.all` over the goals rather than a loop with awaits: three goals is
    // three reads that do not depend on each other, and serialising them would make
    // the home page three times slower for no reason.
    return Promise.all(goals.map(async (goal) => {
        const [exercises, refs] = await Promise.all([
            listExercises(goal.id),
            goalRefsFor(goal.id)
        ]);
        return assemble(goal, exercises, exerciseQuota(exercises), attempts, refs, allQuestions);
    }));
}

/**
 * One goal by id, with the same shape `overviews()` produces for every goal, or
 * `null`.
 *
 * The goal is read by the id in the URL, so an archived goal is readable here (the
 * archive page links one, and its page must still show its exercises) while a
 * tombstoned one is not. `null` rather than a throw, because every caller of this is a
 * page deciding what to draw and a missing goal is something to draw.
 */
export async function overview(goalId) {
    const goal = await readGoal(goalId);
    if (!goal) return null;

    const [exercises, attempts, refs, allQuestions] = await Promise.all([
        listExercises(goal.id),
        listAllAttempts(),
        goalRefsFor(goal.id),
        listQuestions()
    ]);
    // The goal's OWN exercises, for the reason `overviews()` gives: the cap is a fact
    // about this goal and not about the device it happens to sit on.
    return assemble(goal, exercises, exerciseQuota(exercises), attempts, refs, allQuestions);
}

/**
 * Everything a goal's page and the home page need, in one read.
 *
 * WHAT IS IN IT:
 *
 *   plan      from `planSchedule`, with the goal's own quota already folded in.
 *   quota     the allowance -- THIS GOAL's, counted from its own exercises, so two
 *             goals never spend each other's slots.
 *   open      the exercises still in progress, newest first. A fact about the goal
 *             rather than a filter each page should write for itself.
 *   exercises the records, and the three counts the goal page lists and the home page
 *             summarises.
 *   material  THE JOIN. `count` is how many questions the goal draws on, and it is
 *             zero for a goal nothing is attached to -- which is a complete plan, not
 *             a failure to read. `groups` are the shelves with their own sizes, so the
 *             home page can show the categories without a second read.
 *   stats     what the reader has done with THIS goal's exercises and THIS goal's
 *             material. Derived from the attempt log, never stored on the question,
 *             because a stored "learned" flag has to be maintained by every write that
 *             touches an attempt -- including the one the sync merge makes on the other
 *             device.
 *
 * @param {object} goal
 * @param {object[]} exercises  this goal's exercises, already read
 * @param {object} quota        this goal's allowance, counted from those exercises
 * @param {object[]} attempts    the device-wide attempt log, already read
 * @param {{groups: object[], questionIds: string[]}} refs  this goal's references
 * @param {object[]} allQuestions  the device's whole question list, already read
 */
async function assemble(goal, exercises, quota, attempts, refs, allQuestions) {
    const open = openExercises(exercises);
    // The goal's material, expanded through the references and de-duplicated by the
    // one rule in domain/goal-content.js. It is a join and not a filter on a column,
    // and it is the only thing that widens what a goal trains on.
    const questions = questionsForGoal({ groups: refs.groups, questionIds: refs.questionIds, allQuestions });
    const summary = summarize({ goal, exercises, questions, attempts });

    // Every `groupId` that is neither on an attached shelf nor absent, so the card can
    // say "and 6 you picked one by one" without re-counting the question list here.
    const loose = refs.questionIds.length;

    return {
        goal,
        plan: planSchedule({ goal, exercises, quota }),
        quota,
        open,
        exercises,
        exercisesCount: {
            total: exercises.length,
            completed: exercises.filter((x) => x.completedAt).length,
            open: open.length
        },
        material: {
            // HOW MANY QUESTIONS, AND HOW THEY WERE ARRANGED. `groups` carries the
            // shelves the reader attached whole; `loose` is how many they attached one
            // at a time. Both are needed for the total to be explainable, and the total
            // is the number a goal page is judged on.
            count: questions.length,
            learned: summary.progress.learned,
            groups: sizeGroups(refs.groups, allQuestions),
            loose
        },
        stats: summary
    };
}

/** A goal by id, but a tombstoned one is not a goal. */
async function readGoal(goalId) {
    try {
        const goal = await getGoal(goalId);
        return goal.deletedAt ? null : goal;
    } catch {
        return null;
    }
}

/* -------------------------------------------------------------------------- */
/*                                  the joins                                  */
/* -------------------------------------------------------------------------- */

/**
 * The shelves a goal draws on, each with the number of questions filed on it.
 *
 * THE COUNT IS THE SHELF'S OWN SIZE, not "how many of them this goal will actually
 * ask". The difference is real and it is the point of the separation: a shelf of
 * thirty that this goal draws on none of is the row a reader needs to see before
 * attaching it, and printing "30" beside a tick that is off is a number that answers a
 * different question from the one being asked.
 *
 * Built from the question list the caller already has rather than by asking each group
 * for its questions. A card and a picker are drawn from one read, and a second read of
 * the same table is a window in which a sync merge makes the two describe different
 * moments.
 */
function sizeGroups(groups, allQuestions) {
    if (!groups.length) return [];
    const counts = new Map(groups.map((g) => [g.id, 0]));
    for (const question of allQuestions) {
        if (question.groupId && counts.has(question.groupId)) {
            counts.set(question.groupId, counts.get(question.groupId) + 1);
        }
    }
    return groups.map((group) => ({
        id: group.id,
        name: group.name,
        size: counts.get(group.id) ?? 0
    }));
}

/* -------------------------------------------------------------------------- */
/*                                   writing                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a given number of active goals means, as arithmetic and nothing else.
 *
 * SEPARATED FROM `goalSlots` SO IT CAN BE ASKED WITHOUT A DATABASE. Everything that
 * decides whether a fourth goal may exist — the create form, the list page, the
 * successor written when one is closed — needs the same three numbers, and a rule
 * that only exists inside a function which opens a transaction is a rule that can
 * only be tested by opening one.
 *
 * `used` IS CLAMPED TO A COUNT rather than trusted: it comes from a list, and a list
 * is the only place a negative or fractional number could come from.
 *
 * @param {number} used
 * @param {number} [limit]
 * @returns {{used: number, limit: number, remaining: number, full: boolean}}
 */
export function slotsFor(used, limit = MAX_ACTIVE_GOALS) {
    const count = Number.isFinite(used) && used > 0 ? Math.round(used) : 0;
    return {
        used: count,
        limit,
        remaining: Math.max(0, limit - count),
        full: count >= limit
    };
}

/**
 * How many active goals there are, and how many there may be.
 *
 * READ SEPARATELY FROM `overviews()` ON PURPOSE. The list page needs the number
 * before it draws anything — it is what decides whether "Create a goal" is a button or
 * a sentence — and the home page already has the rows, so it counts what it was given
 * rather than asking the store a second time for the same answer.
 *
 * @returns {Promise<{used: number, limit: number, remaining: number, full: boolean}>}
 */
export async function goalSlots() {
    return slotsFor((await listActiveGoals()).length);
}

/**
 * Create a goal. Validated here rather than in the repository so the same rules run
 * on the API, and so the form gets a per-field result instead of an exception.
 *
 * NO QUESTIONS ARE CREATED AND NONE ARE ATTACHED, and the form does not send the
 * reader anywhere to type one. A goal is a plan; the material is attached afterwards,
 * or never, and a goal with nothing attached is finished and valid rather than
 * half-made.
 *
 * THE ACTIVE GOAL COUNT IS CHECKED HERE, AFTER THE DRAFT IS VALIDATED. The order is
 * the order of what the reader did: they typed something wrong, and telling them about
 * the title before telling them about the three-goal limit is the only way both get
 * said. The page checks it too, to decide whether to draw the form at all, but this is
 * where it is true — a form that is the enforcement is a form that can be bypassed by
 * the other writer.
 */
export async function createGoal(draft) {
    const values = assertValid(validateGoal(draft), "goal");
    const slots = await goalSlots();
    if (slots.full) throw new ScheduleError("too_many_goals", { slots });
    return createGoalRecord(values);
}

/** Save the four numbers. The title and description are not editable: they are read
 *  rather than edited, and a field that can be changed by accident halfway through
 *  reading the goal page is worse than no field. */
export async function updatePlan(id, draft) {
    const values = assertValid(validateGoal({ title: "x", ...draft }), "goal");
    return updateGoalPlan(id, values);
}

/**
 * Close a goal. Refused while ANY of its exercises is open.
 *
 * `latestExercise` is not the question any more. There can be several exercises open
 * on one goal now, so "the newest one" answers "is the newest one finished", which is
 * a different question from "can this goal be closed" -- a goal whose newest exercise
 * was finished yesterday and whose first one is still sitting at 40% would be closed,
 * and that exercise would be left with no goal to be resumed against. Every open
 * exercise has to be counted.
 *
 * ARCHIVING IS THE WAY OUT, and the error the reader is given says so. `archive` keeps
 * the goal, its exercises and its report and simply stops anything new being started;
 * a reader who wants to stop working on a goal has not got to throw away the half of it
 * they have already answered.
 */
export async function finishGoal(id) {
    const goal = await getGoal(id);
    if (goal.status === "completed") throw new InvalidTransitionError("completed", "finish_goal");
    const exercises = await listExercises(id);
    // `latestExercise` is deliberately not used: see above. One open exercise anywhere
    // in the goal is enough to refuse.
    const open = exercises.filter((x) => !x.deletedAt && !x.completedAt);
    if (open.length && CLOSE_REQUIRES_NO_OPEN_EXERCISES) {
        throw new InvalidTransitionError("exercise_open", "finish_goal");
    }
    return completeGoal(id);
}

/**
 * Put a goal in the archive. Nothing is deleted and nothing is hidden.
 *
 * THE DIFFERENCE FROM `finishGoal`, which is worth stating because the two are adjacent
 * in this file and used to be the same thing: finishing is the goal's own time running
 * out, a state the app puts it in and which a new goal is offered instead of; archiving
 * is the reader filing something away and being able to take it back. An archived goal
 * keeps every exercise, every report and every attachment, appears in the archive page,
 * and starts nothing new -- but `unarchive` puts it back exactly as it was, which is
 * not something a finished goal offers.
 *
 * Archiving does not free an active slot on its own -- the goal leaves the active list
 * the moment `archivedAt` is set, so it does -- but it does not bring a replacement
 * either. `archiveAndSucceed` is the pair, and the page calls that one.
 */
export async function archive(id) {
    return archiveGoal(id);
}

/**
 * Take a goal out of the archive, back into the active list.
 *
 * REFUSED AT THE GOAL LIMIT, and this is the one place the limit has to be enforced
 * twice. `createGoal` is the obvious one; this is the one that is easy to forget,
 * because taking a goal out of the archive is not creating anything and so does not
 * look like it. It is: an unarchived goal is an active goal, it appears on the home
 * page with a Start button, and the cap exists to keep that page readable. Refusing
 * says what to do -- archive or finish one of the others, which writes a successor into
 * the freed slot and makes room by itself.
 *
 * NOT REFUSED ON THE GROUND THAT THE GOAL IS FINISHED. A goal that was finished and
 * then archived comes back finished, exactly as `unarchiveGoal` has always left it;
 * the archive is a place, not a state, and a goal in it may be either.
 */
export async function unarchive(id) {
    const slots = await goalSlots();
    if (slots.full) throw new ScheduleError("too_many_goals", { slots });
    return unarchiveGoal(id);
}

/**
 * The goal that takes the place of one just closed: same plan, same material, nothing
 * carried over.
 *
 * WHY IT IS WRITTEN RATHER THAN ASKED FOR. Closing a goal frees a slot under
 * `MAX_ACTIVE_GOALS`, and the reader who closed it did it because they are going on
 * with the same subject -- that is what finishing a plan means. Making them go and
 * type the four numbers again, and re-attach the shelves they had already chosen, to
 * fill the gap the app just made is work the app already knows the answer to. So the
 * successor is created at once, and it is created USABLE: the same numbers, the same
 * groups, the same individually-picked questions.
 *
 * WHAT IS NOT CARRIED OVER, and each omission is deliberate:
 *
 *   exercises  They belong to the goal that produced them -- their item rows hold the
 *              frozen text of the questions they asked, and their attempt log is what
 *              that goal's report counts. A successor that inherited them would report
 *              another plan's sitting as its own. Its history starts empty, which is
 *              what a new plan means.
 *   progress   `learned` is derived from the attempt log rather than stored, so there
 *              is nothing to copy and nothing stale to copy: the successor is asked
 *              the same questions again and is scored on this round's answers.
 *
 * THE TITLE IS THE SAME TITLE, and the same one the history section already shows with
 * a "finished" badge beside it. Two rounds of one plan are two goals with one name;
 * numbering them would put a number in the reader's way every time they looked at the
 * home page, and would still not say which round they were in as clearly as the badge
 * on the old one does.
 *
 * `null` WHEN THERE IS NO ROOM, rather than a refusal. Nothing is lost by not creating
 * it: the slot count is asked for again on the next close, and a reader who made three
 * goals in a row has three of them and did not want a fourth.
 */
export async function succeedGoal(previous) {
    if (!previous) return null;
    const slots = await goalSlots();
    if (slots.full) return null;

    const created = await createGoalRecord({
        title: previous.title,
        description: previous.description ?? "",
        newPerExercise: previous.newPerExercise,
        reviewDepth: previous.reviewDepth,
        intervalDays: previous.intervalDays,
        durationDays: previous.durationDays
    });

    // The material, through the same two writes the picker's checkboxes use -- and
    // from `goalRefsFor` rather than from the raw reference rows. That read resolves
    // each reference to something that still exists, so a goal pointing at a group
    // deleted since is copied without it rather than with a reference nothing can
    // resolve; copying the raw rows would hand the successor a question count that is
    // a number about rows rather than about questions.
    const refs = await goalRefsFor(previous.id);
    if (refs.groups.length) {
        await addGoalRefs(created.id, "group", refs.groups.map((g) => g.id));
    }
    if (refs.questionIds.length) {
        await addGoalRefs(created.id, "question", refs.questionIds);
    }
    return created;
}

/**
 * Archive a goal and put its successor in the slot it leaves.
 *
 * The two are ONE CALL because the second is not optional and not the reader's job:
 * `archiveGoal` alone would leave the device with one fewer goal than it had a moment
 * ago and a reader who had to notice. Both writes are asked for in sequence rather
 * than in one transaction on purpose -- the archive is the one that must happen, and a
 * successor that fails to be created is a gap the reader can fill, whereas a successor
 * created for an archive that did not happen is two goals where there was one.
 *
 * @returns {Promise<{goal: object, next: object|null}>}
 */
export async function archiveAndSucceed(id) {
    const archived = await archiveGoal(id);
    return { goal: archived, next: await succeedGoal(archived) };
}

/**
 * Finish a goal and put its successor in the slot it leaves. See `archiveAndSucceed`
 * for why the two are one call.
 *
 * @returns {Promise<{goal: object, next: object|null}>}
 */
export async function finishAndSucceed(id) {
    const closed = await finishGoal(id);
    return { goal: closed, next: await succeedGoal(closed) };
}

/**
 * The archive page's data: the archived goals, newest first, with the counts its
 * rows show.
 *
 * The counts are read here rather than in the page so that the archive and the home
 * page cannot disagree about how much is in an archived goal. `questions` is a join,
 * not a count of rows that belonged to the goal, and it is zero for a goal nothing was
 * ever attached to -- which is a goal that was archived without being used, and saying
 * so with a number is more useful than saying so with a warning.
 */
export async function archivedGoals() {
    const goals = await listArchivedGoals();
    return Promise.all(goals.map(async (goal) => {
        const [exercises, refs, allQuestions] = await Promise.all([
            listExercises(goal.id),
            goalRefsFor(goal.id),
            listQuestions()
        ]);
        const material = questionsForGoal({ groups: refs.groups, questionIds: refs.questionIds, allQuestions });
        const summary = summarize({ goal, exercises, questions: material, attempts: await listAllAttempts() });
        return {
            goal,
            exercises: exercises.length,
            completed: exercises.filter((x) => x.completedAt).length,
            questions: material.length,
            learned: summary.progress.learned,
            accuracy: summary.accuracy
        };
    }));
}

