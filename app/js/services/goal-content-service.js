// Attaching questions and groups to a goal — the join, and nothing else.
//
// This is the service the four-way separation creates, and it is small on purpose.
//
// BEFORE IT, A QUESTION KNEW ITS GOAL. `question.goalId` was a column, so attaching
// a question to a second goal was impossible, removing it from a goal was a deletion,
// and "the questions of a goal" was a filtered read of the question table. Every one
// of those is a form of ownership, and ownership is what this app stopped doing.
//
// Now the relationship is a ROW, and this service is the only thing that writes one.
// Which means the awkward operations are all here rather than spread across the
// question page, the group page and the goal page:
//
//   * attaching a question that is already attached is a no-op rather than a second
//     row, because a second row would put the same question into the goal's material
//     twice and the builder would have to know about it;
//   * detaching is not deleting, and says so;
//   * a group can be attached to three goals at once, because a shelf is a shelf.
//
// IT IS ALSO THE ONLY PATH BY WHICH A QUESTION EVER REACHES A GOAL, and that is worth
// stating as a property of this file rather than of a convention: `addGoalRef` is
// called from exactly two functions, both below, and both are called from exactly one
// screen — the picker on the goal's own page. Nothing else in the app can create a
// reference, so "this question is in that goal" is only ever true because the reader
// said so. A question written today is in no goal at all, and a question written
// before any goal existed never becomes part of one by being opened, edited or used
// in a session.

import {
    listGoalRefs, listRefsTo, addGoalRef, removeGoalRef, goalRefsFor, getGoal
} from "../data/repo-goals.js";
import { listQuestions } from "../data/repo-questions.js";
import { questionsForGoal, REF_TYPE } from "../domain/goal-content.js";

export { REF_TYPE };

/** What a goal is attached to, in the order the reader attached it. */
export async function refsFor(goalId) {
    return listGoalRefs(goalId);
}

/**
 * The questions a goal draws on, in the reader's order, de-duplicated.
 *
 * This is the query that used to be `listQuestions(goalId)` and was a single indexed
 * read. It is now a join, and it lives here so that the goal page, the session
 * builder and the picker all ask it the same way — three copies of "which questions
 * does this goal have" is how a goal page ends up saying 40 while the session it
 * starts has 12.
 *
 * IT WIDENS ONLY THROUGH REFERENCES. `groups` are the shelves the reader attached, so
 * every question filed on one of them is in; `questionIds` are the individual
 * questions the reader attached. A question in neither is not in the goal, however
 * old it is, however many goals exist, and however many sessions have asked it. That
 * is the whole of the separation and it is decided in one function.
 */
export async function questionsFor(goalId) {
    const [refs, all] = await Promise.all([goalRefsFor(goalId), listQuestions()]);
    return questionsForGoal({ groups: refs.groups, questionIds: refs.questionIds, allQuestions: all });
}

/**
 * Attach a group to a goal. Returns the reference, or `null` if it was already
 * attached — and `null` is a real answer rather than a failure, because the button
 * that calls this is a toggle and a toggle that says "nothing happened" when it was
 * already on is worse than one that says so quietly.
 */
export async function attachGroup(goalId, groupId) {
    return addGoalRef(goalId, REF_TYPE.GROUP, groupId);
}

/** Attach one question to a goal, with the same idempotence as `attachGroup`. */
export async function attachQuestion(goalId, questionId) {
    return addGoalRef(goalId, REF_TYPE.QUESTION, questionId);
}

/**
 * Detach one reference. The question or group is NOT touched.
 *
 * THIS IS THE LINE THAT SEPARATES A GOAL FROM ITS MATERIAL, and it is worth being
 * explicit about what it refuses to do. Removing the last thing a goal drew on leaves
 * an empty goal rather than deleting the question; removing a group a second goal also
 * uses leaves that group exactly where it was. A goal is a plan over material, and
 * ending a plan is not the same act as throwing away the things it was a plan for.
 *
 * The reference row is passed in, not the ids, so this cannot be turned into "detach
 * everything matching X" by a caller passing the wrong pair — `removeGoalRef` is the
 * only write and it takes an id.
 */
export async function detach(refId) {
    return removeGoalRef(refId);
}

/**
 * Every id of `refType` this goal has attached, as a set.
 *
 * THE ONLY "IS THIS ATTACHED" ANSWER IN THE APP, and there is deliberately no per-row
 * version of it. A picker with two hundred questions and a tick on each asks "which of
 * these are attached" once, not two hundred times, and the screen that wanted the
 * per-row answer — the question editor — no longer draws a goal control at all.
 */
export async function attachedSet(goalId, refType) {
    const refs = await listGoalRefs(goalId);
    return new Set(refs.filter((r) => r.refType === refType).map((r) => r.refId));
}

/**
 * The goals that use this group, newest first.
 *
 * THE GROUP PAGE ASKS THIS BEFORE OFFERING TO DELETE, and it is the read that makes a
 * group genuinely shared rather than notionally shared. A shelf one goal filed its
 * questions into could be deleted with a shrug; a shelf three goals draw from cannot,
 * and a reader deserves to be told which of the two they are looking at before the
 * delete rather than after it.
 *
 * Newest first because that is the order the caller wants to name them in, and
 * because "used by French, Arabic and Spanish" reads worse than the reverse.
 */
export async function goalsUsingGroup(groupId) {
    const refs = await listRefsTo(REF_TYPE.GROUP, groupId);
    return goalsFor(refs);
}

/** The goals that use this question, by the same rule and for the same reason. */
export async function goalsUsingQuestion(questionId) {
    const refs = await listRefsTo(REF_TYPE.QUESTION, questionId);
    return goalsFor(refs);
}

/**
 * The goals behind a list of reference rows.
 *
 * ONE HELPER FOR BOTH DIRECTIONS, because the two used to be the same seven lines
 * copied down. `goalsUsingGroup` and `goalsUsingQuestion` are the same question about
 * two kinds of thing, and the only thing that differs is which index they read — so
 * the part that resolves goal ids, drops tombstones and orders the answer is written
 * once.
 */
async function goalsFor(refs) {
    if (!refs.length) return [];
    const goals = await Promise.all([...new Set(refs.map((r) => r.goalId))]
        .map((id) => getGoal(id).catch(() => null)));
    return goals
        .filter((g) => g && !g.deletedAt)
        .sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
}
