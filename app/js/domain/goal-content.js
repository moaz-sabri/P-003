// What a goal is made of, assembled from references rather than read from a column.
//
// THE JOIN, AND WHY IT IS A FUNCTION AND NOT A REPOSITORY CALL.
//
// Before this, "the questions of a goal" was one indexed read: every question had a
// `goalId`, and the composite `goalOrder` index answered it. It is now a shape the
// reader assembles — a goal points at some groups and some individual questions,
// and the questions it draws on are the union of the two. That union is a rule, not a
// lookup, and the rules it has to satisfy are:
//
//   * A QUESTION IN A NAMED GROUP AND A QUESTION NAMED DIRECTLY IS ONE QUESTION.
//     The builder will not have the same question twice in one session, and if the
//     duplicate reached it the de-duplication would have to exist in the builder as
//     well as here — two places to disagree, which is the failure mode this codebase
//     keeps paying for elsewhere.
//
//   * A REFERENCE TO SOMETHING DELETED CONTRIBUTES NOTHING. A group removed on
//     another device leaves a `goalRefs` row behind on this one until the merge
//     catches up, and a material list padded with ids that resolve to nothing is a
//     question count that lies.
//
//   * THE ORDER IS THE DEVICE'S. The questions come out in the order they were
//     typed, across every group, because a session interleaves them and a reader
//     who moves a question up expects it to move up everywhere.
//
// So the rule lives here, in one pure place, and both the goal page and the session
// builder call it. Nothing in this file knows what a goal is.

/**
 * Which kinds of thing a goal can point at.
 *
 * A STRING IN THE RECORD rather than two stores. The reader's question — "what does
 * this goal draw on?" — has one answer, and a page that had to read two lists and
 * merge them would have two chances to show a count that disagrees with the rows
 * underneath it.
 */
export const REF_TYPE = { GROUP: "group", QUESTION: "question" };

/**
 * The questions a goal draws on, in the reader's order.
 *
 * @param {{groups?: object[], questionIds?: string[], allQuestions?: object[]}} input
 *   `groups` and `questionIds` come from `repos.goalRefsFor` — the references, with
 *   the group records resolved and the question ids not. `allQuestions` is the whole
 *   question list, read once, and is used both to expand the groups and to order the
 *   result and to drop ids that name nothing.
 * @returns {object[]} the questions, in device order, de-duplicated
 */
export function questionsForGoal({ groups = [], questionIds = [], allQuestions = [] } = {}) {
    const byId = new Map(allQuestions.map((q) => [q.id, q]));
    const groupIds = new Set((groups ?? []).map((g) => g.id).filter(Boolean));
    const wanted = new Set();

    // The direct references first, and the groups' questions after, into ONE set: a
    // question named both ways is still one question, and a set is the whole of that
    // rule. The output order comes from `allQuestions` below rather than from the
    // order of insertion here, so a question named directly does not jump to the top
    // of the reader's session because it was attached a different way.
    for (const id of questionIds ?? []) {
        if (byId.has(id)) wanted.add(id);
    }
    for (const question of allQuestions) {
        if (question.groupId && groupIds.has(question.groupId)) wanted.add(question.id);
    }

    // `allQuestions` is already in device order, so filtering it preserves the
    // reader's own arrangement and the result needs no sort of its own — a sort here
    // would be a second ordering rule that agrees with the repository's until the
    // day it does not.
    return allQuestions.filter((q) => wanted.has(q.id));
}

/**
 * The question ids a session selection names, and whether it named anything.
 *
 * THE SAME QUESTION IS ANSWERED IN TWO PLACES IN THE OLD BUILD — `isExactSelection`
 * here and a `groupIds.length || questionIds.length` at each of two call sites — and
 * the two are how a reader who picked both a group and four questions ended up with
 * a picker that said "the same as the plan" while the service built something
 * narrower. One function, and the picker and the builder both ask it.
 *
 * AN EXCLUSION IS NOT A SELECTION. "Everything except these four" is a subtraction
 * from something, and with nothing named there is no set to subtract from. It
 * becomes exact the moment anything is named.
 *
 * @param {{groupIds?: string[]|null, questionIds?: string[]|null,
 *          excludeIds?: string[]|null}} selection
 */
export function isExactSelection({ groupIds = null, questionIds = null } = {}) {
    return Boolean(groupIds?.length || questionIds?.length);
}

/**
 * The questions a selection names, as a SUBSET of the goal's own list.
 *
 * A SELECTION IS A UNION and never a filter of the other half. A reader who picks
 * "Chapter 3" and ticks two questions from Chapter 1 wants both: the group is one
 * half of what they said and the ticks are the other, and either half silently
 * winning is a request answered differently from how it was made.
 *
 * NOTHING NAMED IS THE WHOLE GOAL, and that case has to be first because everything
 * below narrows. `start()` sends `null` for "the plan decides" and the picker sends
 * nothing when the reader has not chosen, and only one of those may mean that.
 * The exclusions are dropped on this path, and that is deliberate rather than an
 * oversight: "everything except these four, and choose nothing" is two instructions
 * that contradict each other, and the reading that leaves the reader with something
 * they can act on is the plan.
 *
 * @param {object[]} questions  the goal's questions, in the reader's order
 * @param {{groupIds?: string[]|null, questionIds?: string[]|null,
 *          excludeIds?: string[]|null}} selection
 */
export function questionsForSelection(questions, selection = {}) {
    const { groupIds = null, questionIds = null, excludeIds = null } = selection;
    const wantedGroups = new Set(groupIds ?? []);
    const wantedQuestions = new Set(questionIds ?? []);
    const unwanted = new Set(excludeIds ?? []);

    if (!wantedGroups.size && !wantedQuestions.size) return questions;

    // ONE PREDICATE over the goal's own list, which is what puts the result in the
    // reader's order without a sort. Concatenating a group pool and a named list
    // would put every named question after every grouped one, so the same selection
    // would give a different "third question" depending on whether one of them also
    // belonged to a group.
    return questions.filter((q) => {
        // The exclusion first: it is the only rule that can take a question back out
        // of a group that would otherwise have included it, and a reader who unticked
        // one has said so explicitly.
        if (unwanted.has(q.id)) return false;
        if (wantedQuestions.has(q.id)) return true;
        if (!wantedGroups.size) return false;
        return q.groupId != null && wantedGroups.has(q.groupId);
    });
}
