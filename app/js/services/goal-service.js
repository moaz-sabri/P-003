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
// when the last one was finished, with a device-wide cap on how fast new ones may be
// started. None of that depends on who owns the questions.

import { validateGoal, assertValid } from "../domain/validation.js";
import { planSchedule, SCHEDULE } from "../domain/schedule.js";
import { exerciseQuota } from "../domain/exercise-builder.js";
import { summarize } from "../domain/stats.js";
import { questionsForGoal } from "../domain/goal-content.js";
import { goalAction, ACTION } from "../domain/goal-action.js";
import { InvalidTransitionError } from "../domain/errors.js";
import { CLOSE_REQUIRES_NO_OPEN_EXERCISES } from "../config.js";
import {
    getActiveGoal, listActiveGoals, listArchivedGoals, listGoals, getGoal, goalRefsFor,
    archiveGoal, unarchiveGoal,
    // The three writes, imported here so a page never reaches past this module into
    // the data layer to change a goal. The separation is the point of the service
    // layer: `createGoal` below validates, and the repository neither knows nor cares
    // what a valid goal is.
    createGoal as createGoalRecord, updateGoalPlan, completeGoal
} from "../data/repo-goals.js";
import { listQuestions } from "../data/repo-questions.js";
import {
    listExercises, listAllExercises, listAllAttempts, openExercises
} from "../data/repo-sessions.js";

export { SCHEDULE };
export { ACTION };
export { goalAction };
export { getActiveGoal, listActiveGoals, listArchivedGoals, getGoal, archiveGoal, unarchiveGoal };

export async function listHistory() {
    return listGoals();
}

/* -------------------------------------------------------------------------- */
/*                                 the overview                                */
/* -------------------------------------------------------------------------- */

/**
 * Every active goal, newest first, with everything its page and the home page need.
 *
 * THE DEVICE-WIDE READS HAPPEN ONCE. The exercise list the rate cap counts, and the
 * attempt log every figure below is derived from, are read a single time for the whole
 * page rather than once per goal. With three goals that is two transactions instead of
 * six -- and, the part that matters more, two moments in time rather than three, so the
 * quota on the first card and the quota on the third cannot describe different instants.
 *
 * The per-goal reads (the exercises, the references) are still per goal, because a
 * goal's material and history are its own and there is no read that answers it for
 * several at once.
 */
export async function overviews() {
    const goals = await listActiveGoals();
    if (!goals.length) return [];

    const [deviceExercises, attempts, allQuestions] = await Promise.all([
        listAllExercises(),
        listAllAttempts(),
        listQuestions()
    ]);
    const quota = exerciseQuota(deviceExercises);

    // `Promise.all` over the goals rather than a loop with awaits: three goals is
    // three reads that do not depend on each other, and serialising them would make
    // the home page three times slower for no reason.
    return Promise.all(goals.map(async (goal) => {
        const [exercises, refs] = await Promise.all([
            listExercises(goal.id),
            goalRefsFor(goal.id)
        ]);
        return assemble(goal, exercises, quota, attempts, refs, allQuestions);
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

    const [exercises, deviceExercises, attempts, refs, allQuestions] = await Promise.all([
        listExercises(goal.id),
        listAllExercises(),
        listAllAttempts(),
        goalRefsFor(goal.id),
        listQuestions()
    ]);
    return assemble(goal, exercises, exerciseQuota(deviceExercises), attempts, refs, allQuestions);
}

/**
 * Everything a goal's page and the home page need, in one read.
 *
 * WHAT IS IN IT:
 *
 *   plan      from `planSchedule`, with the device-wide quota already folded in.
 *   quota     the allowance, device-wide -- one between the reader's goals, not one
 *             each, so every goal on the page is handed the SAME object.
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
 * @param {object} quota        the device-wide allowance, already read
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
 * Create a goal. Validated here rather than in the repository so the same rules run
 * on the API, and so the form gets a per-field result instead of an exception.
 *
 * NO QUESTIONS ARE CREATED AND NONE ARE ATTACHED, and the form does not send the
 * reader anywhere to type one. A goal is a plan; the material is attached afterwards,
 * or never, and a goal with nothing attached is finished and valid rather than
 * half-made.
 */
export async function createGoal(draft) {
    const values = assertValid(validateGoal(draft), "goal");
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
 * and starts nothing new -- but `unarchiveGoal` puts it back exactly as it was, which is
 * not something a finished goal offers.
 */
export async function archive(id) {
    return archiveGoal(id);
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

