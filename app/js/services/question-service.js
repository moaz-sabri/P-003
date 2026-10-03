// Questions and their options.
//
// A QUESTION IS A STANDALONE THING. It has no `goalId`, it is not created by a goal,
// and it can be written with no goal in the app at all. What a goal does with it is
// point at it (see goal-content-service.js), which is a relationship the reader
// chooses rather than a container the question lives in.
//
// That is the whole of the change, and it moved the shape of three things:
//
//   * `list()` takes a GROUP FILTER or nothing. It took a goal id before, and the
//     goal id was not a filter — it decided which questions existed. A screen asking
//     "the questions in this group" and a screen asking "all my questions" are now
//     the same function with an optional argument, and a question that is in no goal
//     is on the list rather than invisible.
//
//   * `save()` takes no goal. The editor's "which goal is this in" picker is GONE,
//     and its absence is the feature: there was no honest version of it, because a
//     question could only be in one goal, so the picker was a "move" control wearing
//     a "file under" label, and a reader moving twenty shared questions between two
//     subjects by opening each one was the behaviour it produced.
//
//   * `states` are still derived from the attempt log and still stored nowhere, for
//     the reason in domain/stats.js: a stored "learned" flag has to be maintained by
//     every write that touches an attempt — including the one the sync merge makes on
//     the other device — and the first of those to be missed shows the reader a
//     question they have answered correctly five times as one they have never seen.
//
// Note what a question being independent costs: there is no longer a single list
// "belonging" to a goal, so a question's state is global. Answering a question well
// in one goal marks it learned in another that uses it. That is the honest reading
// of a shared question — the reader knows it or they do not, and a second copy of
// the same question with a separate progress flag would be two facts about one thing.

import { validateQuestion, assertValid } from "../domain/validation.js";
import {
    listQuestions, listOptions, listAllOptions, orderOptions,
    saveQuestion as saveQuestionRecord, deleteQuestion as deleteQuestionRecord,
    reorderQuestions, getQuestion
} from "../data/repo-questions.js";
import { listExerciseItemsByQuestions, listExercisesForQuestion } from "../data/repo-sessions.js";
import { listGroups } from "../data/repo-groups.js";
import { listAllAttempts } from "../data/repo-sessions.js";
import { latestAttempt } from "../domain/stats.js";
import { questionsForSelection } from "../domain/goal-content.js";

/**
 * The sessions this question has been asked in, newest first.
 *
 * THE PAYOFF OF THE SNAPSHOT, and the reason the schema change was worth making. A
 * question record carries no list of sessions, because an item is a row pointing at a
 * question rather than a column on it — which is exactly what lets the same question
 * be in Tuesday's session and Sunday's with the two records independent. The cost of
 * that is that "where has this been asked?" becomes a query rather than a field, and
 * this is it, reading the `questionId` index that migration 1 put on `exerciseItems`
 * for exactly this.
 *
 * IT IS NOT A HISTORY OF THE QUESTION, and a screen must not present it as one. A
 * session the plan built that happened to include this question is in here, and so is
 * one the reader built by naming it — nothing stored tells those apart, and claiming
 * otherwise would be an assertion about intent no record supports. What a reader can
 * be told honestly is which of their own sessions carry it, and when each was.
 */
export async function exercisesFor(questionId) {
    return listExercisesForQuestion(questionId);
}

/** How many live sessions carry each of these questions.
 *
 *  ONE READ FOR THE WHOLE LIST. The question list can have two hundred rows on it and
 *  needs a count beside the collection; calling the single-question version per row is
 *  two hundred transactions on a screen a reader is waiting for, and each one also
 *  resolves the session records when the caller only wanted a number.
 */
export async function askedInCounts(questionIds) {
    const unique = [...new Set((questionIds ?? []).filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await listExerciseItemsByQuestions(unique);
    const out = new Map();
    for (const item of rows) {
        if (!item.deletedAt) {
            out.set(item.questionId, (out.get(item.questionId) ?? 0) + 1);
        }
    }
    return out;
}

/**
 * The questions, with their options, their state and their group.
 *
 * `groupId` NARROWS THE LIST, and `null` means all of them rather than none — the
 * distinction is the whole reason this takes a parameter rather than two functions. A
 * group id means "these questions"; no filter at all means "every question", which is
 * what the page asks for when the reader has not chosen a group, and passing `[]` for
 * that would have been an empty screen with no explanation.
 */
export async function list(groupId = null) {
    // The questions are read once and used for both halves. Reading them twice — once
    // for the states and once for the option lookups — opens a window in which a sync
    // merge deletes a question, and the screen then draws a row whose options belong
    // to a question that is not in the list.
    const all = await listQuestions();
    const questions = groupId ? all.filter((q) => q.groupId === groupId) : all;

    const [{ states }, options, groupList] = await Promise.all([
        statesFor(questions),
        listAllOptions(questions.map((q) => q.id)),
        listGroups()
    ]);

    const byQuestion = new Map();
    for (const option of options) {
        if (!byQuestion.has(option.questionId)) byQuestion.set(option.questionId, []);
        byQuestion.get(option.questionId).push(option);
    }
    const byId = new Map(groupList.map((g) => [g.id, g]));

    return questions.map((question) => ({
        ...question,
        // `orderOptions` rather than a local sort, so the editor's order and this
        // list's order are the same rule and not two rules that agree today.
        options: orderOptions(byQuestion.get(question.id)),
        state: states.get(question.id) ?? "new",
        // The group's NAME as well as its id: the question list draws the name, and a
        // row labelled with a random id is a row nobody can act on.
        group: question.groupId ? (byId.get(question.groupId)?.name ?? "") : null
    }));
}

/** The question counts per group, for the group list and for the picker.
 *
 * A question in no group is counted under `null`, which the caller draws as "not
 * filed" — the state every question written before groups existed is in, and the one a
 * reader most needs to be able to see. */
export async function counts() {
    const [questions, groupList, { states }] = await Promise.all([
        listQuestions(),
        listGroups(),
        statesFor()
    ]);
    const out = new Map(groupList.map((g) => [g.id, { group: g, total: 0, new: 0, review: 0, learned: 0 }]));
    out.set(null, { group: null, total: 0, new: 0, review: 0, learned: 0 });
    for (const q of questions) {
        const row = out.get(q.groupId ?? null);
        if (!row) continue;
        row.total += 1;
        row[states.get(q.id) ?? "new"] += 1;
    }
    return [...out.values()];
}

/** One question with its options, for the edit form. `null` rather than a throw
 * when it is gone: an edit form for a question that a sync merge removed should
 * render the not-found page, and the page decides that. */
export async function load(id) {
    try {
        const [question, options] = await Promise.all([getQuestion(id), listOptions(id)]);
        if (question.deletedAt) return null;
        return { ...question, options };
    } catch {
        return null;
    }
}

/**
 * Create or update. `draft` is `{id?, text, kind, groupId?, options: [{id?, text, isCorrect}]}`.
 *
 * NO GOAL, and the signature is the proof of it. The old one took `(goalId, draft)`
 * and wrote the goal onto the question, which meant a link without a `?goal=` filed
 * the question into whichever goal happened to be newest — a question being MOVED by
 * opening it, which is what the editor's own comment described at length and could
 * not fix while the field was there.
 *
 * The returned `errors` map is keyed by `text`, `options` or `options.<index>`, which
 * is what the form underlines.
 *
 * The validator returns cleaned options WITHOUT their ids, because an id is not part
 * of what a person typed. They are put back on here, by position, because the
 * repository needs them: an option saved as new every time gets a fresh id on every
 * edit, and every attempt that recorded a tap on the old one ends up pointing at an
 * option that no longer exists — so a report of "what did I answer" slowly fills up
 * with blanks. The mapping is by index and is only safe because the validator does not
 * add, drop or reorder options; it only edits them.
 */
export async function save(draft) {
    const result = validateQuestion(draft);
    if (!result.ok) return { ok: false, errors: result.errors };

    const options = result.values.options.map((option, index) => ({
        ...option,
        id: draft.options?.[index]?.id ?? null
    }));

    const record = await saveQuestionRecord({
        id: draft.id,
        text: result.values.text,
        kind: result.values.kind,
        options,
        groupId: draft.groupId ?? null
    });
    return { ok: true, question: record.question };
}

/**
 * Remove a question.
 *
 * IT TAKES NO GOAL AND DESTROYS NO SESSION. See `repos.deleteQuestion`: the question
 * and its options are tombstoned, the goals that named it lose that reference, and
 * every session that already contains it keeps it — because a session carries its own
 * copy of what it is asking, so a reader can delete a question they have just spotted
 * being wrong without the session they are halfway through losing a slot.
 */
export async function remove(id) {
    await deleteQuestionRecord(id);
}

/**
 * Save a new arrangement. The order is device-wide now — one list, so one order.
 *
 * NO CALLER. The question list draws in `listQuestions()` order and offers no
 * drag handle, so this has been unreachable since the reorder control was removed;
 * the repository function behind it (`repo-questions.reorderQuestions`) is kept
 * because a list that cannot be arranged by hand still has an order that was
 * assigned, and the write is what a future control would call.
 */
export async function reorder(orderedIds) {
    await reorderQuestions(orderedIds);
}

/**
 * The questions a selection would supply to a session, for the picker that shows the
 * reader what they are about to be asked.
 *
 * DERIVED THROUGH THE SAME `questionsForSelection` THE BUILDER USES, so the count on
 * the picker is the count the session will have. That is the whole reason this exists
 * rather than the page summing its own checkboxes: the picker counts a selection and
 * the service builds one, and two implementations of "what does this selection mean"
 * agree right up until somebody ticks a question from outside the group filter.
 *
 * THE LIST IS PASSED IN RATHER THAN READ. The picker has its questions in hand — it
 * drew the rows from them — and routing the count through a second read of the same
 * list means two reads that can straddle a sync merge, and the symptom is a count
 * that disagrees with the rows it is counting, which on that screen is the one thing
 * a reader cannot work out for themselves. See `forSelection` below.
 */
export function forSelection(list, selection) {
    return questionsForSelection(list, selection ?? {});
}

/**
 * Every question's state, from the attempt log, as a map.
 *
 * NO GOAL SCOPING, which is the one thing this lost and the one thing it gained
 * nothing by pretending to keep. Before, the states were computed over "the goal's
 * questions" and the goal was also where the attempts came from, so a question's
 * progress was its progress in one subject. Now a question belongs to no goal, so
 * there is nothing to scope by: getting a question right in one session marks it
 * right, and a second goal that uses the same question starts from there.
 *
 * That is the right reading rather than a compromise. A shared question is one thing
 * the reader either knows or does not, and a per-goal flag on it would mean the same
 * twenty words could be "learned" in French and "never asked" in Arabic — two answers
 * to one question, on two screens, with no way for a reader to reconcile them.
 */
export async function statesFor(questions = null) {
    const history = latestAttempt(await listAllAttempts());
    const list = questions ?? await listQuestions();
    const states = new Map();
    for (const question of list) {
        const last = history.get(question.id);
        states.set(question.id, !last ? "new" : last.correct ? "learned" : "review");
    }
    return { questions: list, history, states };
}

export { assertValid, listOptions, listQuestions, orderOptions };
