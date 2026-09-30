// Goals: the plan, and the one rule that says when a new one may start.
//
// Everything a page needs about "where am I" comes from `snapshot()`, which
// reads four stores and answers every question the home page has in one call —
// because a home page that asks five questions gets five slightly different
// answers if anything changes between them, and the symptom is a button that
// says "start" while the exercise it would build does not exist.

import { validateGoal, assertValid } from "../domain/validation.js";
import { planSchedule, SCHEDULE, latestExercise } from "../domain/schedule.js";
import { latestAttempt } from "../domain/stats.js";
import { InvalidTransitionError } from "../domain/errors.js";
import {
    getActiveGoal, listGoals, createGoal as createGoalRecord, updateGoalPlan,
    completeGoal, listExercises, listQuestions, listAllAttempts, getGoal
} from "../data/repos.js";

export { SCHEDULE };

export { getActiveGoal };

export async function listHistory() {
    return listGoals();
}

/**
 * Everything the home page and the goal page show.
 *
 * `questions` and `exercises` are read even when there is no goal, because the
 * answer to "is there an open exercise" does not depend on having a goal — it
 * is what stops a reader who has closed their goal from being offered a resume
 * button that leads nowhere.
 */
export async function snapshot() {
    const goal = await getActiveGoal();
    const exercises = goal ? await listExercises(goal.id) : [];
    const questions = goal ? await listQuestions(goal.id) : [];
    const plan = goal ? planSchedule({ goal, exercises }) : { state: SCHEDULE.NO_GOAL };
    return { goal, exercises, questions, plan };
}

/** A goal, its questions and its exercises, for the reports page. */
export async function goalBundle(goalId) {
    const goal = await getGoal(goalId);
    const [exercises, questions] = await Promise.all([
        listExercises(goalId),
        listQuestions(goalId)
    ]);
    return { goal, exercises, questions };
}

/**
 * The question states, as a map the question list and the reports both read.
 *
 * Derived from the attempt log rather than stored on the question, for the reason
 * in domain/stats.js: a stored "learned" flag has to be maintained by every write
 * that touches an attempt — including the one the sync merge makes, on the other
 * device — and the first of those to be missed shows the reader a question that
 * has been answered correctly five times as one that has never been seen.
 *
 * The attempt log is read once and handed back, because the question list and the
 * reports page both need it and reading it twice is the difference between a
 * screen that renders in one transaction and a screen that renders in three.
 */
export async function questionStates(goalId) {
    const [questions, attempts] = await Promise.all([
        listQuestions(goalId),
        listAllAttempts()
    ]);
    const history = latestAttempt(attempts);
    const states = new Map();
    for (const question of questions) {
        const last = history.get(question.id);
        states.set(question.id, !last ? "new" : last.correct ? "learned" : "review");
    }
    return { questions, history, states };
}

/** Create a goal. Validated here rather than in the repository so that the same
 *  rules run on the API, and so that the form gets a per-field result instead of
 *  an exception. */
export async function createGoal(draft) {
    const values = assertValid(validateGoal(draft), "goal");
    const existing = await getActiveGoal();
    if (existing) {
        // Not a race check — a real one would be inside the write transaction —
        // it is a guard against the two places that create a goal both being
        // reachable at once (a stale home page and a fresh goal form). The
        // transaction in the repository is what actually guarantees it.
        throw new InvalidTransitionError("active_goal", "create_goal");
    }
    return createGoalRecord(values);
}

/** Save the three numbers. The title and description are not editable: they are
 *  read rather than edited, and a field that can be changed by accident halfway
 *  through reading the goal page is worse than no field. */
export async function updatePlan(id, draft) {
    const values = assertValid(validateGoal({ title: "x", ...draft }), "goal");
    return updateGoalPlan(id, values);
}

/** Close the current goal. Refused if an exercise is open: finishing a goal with
 *  half an exercise unanswered leaves that exercise in the history of a goal
 *  that no longer has a place to put it, and the reader cannot get back to it
 *  to finish it. */
export async function finishGoal(id) {
    const goal = await getGoal(id);
    if (goal.status === "completed") throw new InvalidTransitionError("completed", "finish_goal");
    const exercises = await listExercises(id);
    const open = latestExercise(exercises);
    if (open && !open.completedAt) throw new InvalidTransitionError("exercise_open", "finish_goal");
    return completeGoal(id);
}

/** The goal the rest of the app is about: the active one, or null. Never a
 *  completed one — the pages that show a completed goal say so explicitly and
 *  show the "Create New Goal" button, which is the only thing that changes. */
export async function requireActiveGoal() {
    const goal = await getActiveGoal();
    return goal ?? null;
}