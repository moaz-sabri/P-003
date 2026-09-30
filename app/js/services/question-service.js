// Questions and their options.
//
// The list is the reader's arrangement, so the order is a field and not a
// timestamp. Two things about saving an edit are worth stating:
//
//   * AN EXISTING QUESTION KEEPS ITS POSITION. `saveQuestion` in data/repos.js
//     assigns `order` only when the question is new. The alternative — taking the
//     order from the form — means a second tab that has been open since before a
//     reorder saves an unrelated edit and silently puts the question back where
//     it was.
//
//   * A QUESTION IN AN OPEN EXERCISE IS NOT EDITABLE INTO A DIFFERENT SHAPE.
//     It is: the answer key is compared against the options as they are NOW, so
//     editing the options of a question that is half-asked changes what the
//     remaining answers mean. The app does not block this — the reader may well
//     want to fix a typo — but the change is a normal record write, it syncs,
//     and the attempt log records what was tapped, so the report still shows what
//     was actually answered. That is the whole reason attempts store `selected`.

import { validateQuestion, assertValid } from "../domain/validation.js";
import {
    listQuestions, listOptions, listAllOptions, saveQuestion as saveQuestionRecord,
    deleteQuestion as deleteQuestionRecord, reorderQuestions, getQuestion
} from "../data/repos.js";
import { questionStates } from "./goal-service.js";

/** A goal's questions with their options and their states, in the reader's
 *  order. One call so the list is drawn from one consistent read — options for a
 *  question that has just been deleted on another device are not a state a
 *  screen should be able to be in. */
export async function list(goalId) {
    // The questions are read once and used for both halves. Reading them twice —
    // once for the states and once for the option lookups — opens a window in
    // which a sync merge deletes a question, and the screen then draws a row
    // whose options belong to a question that is not in the list.
    const [{ questions, states }, options] = await Promise.all([
        questionStates(goalId),
        listQuestions(goalId).then((qs) => listAllOptions(qs.map((q) => q.id)))
    ]);

    const byQuestion = new Map();
    for (const option of options) {
        if (!byQuestion.has(option.questionId)) byQuestion.set(option.questionId, []);
        byQuestion.get(option.questionId).push(option);
    }

    return questions.map((question) => ({
        ...question,
        options: (byQuestion.get(question.id) ?? []).sort((a, b) => a.order - b.order),
        state: states.get(question.id) ?? "new"
    }));
}

/** One question with its options, for the edit form. `null` rather than a throw
 *  when it is gone: an edit form for a question that a sync merge removed should
 *  render the not-found page, and the page decides that. */
export async function load(id) {
    try {
        const [question, options] = await Promise.all([
            getQuestion(id),
            listOptions(id)
        ]);
        if (question.deletedAt) return null;
        return { ...question, options };
    } catch {
        return null;
    }
}

/** Create or update. `draft` is `{id?, text, kind, options: [{id?, text, isCorrect}]}`.
 *
 *  The returned `errors` map is keyed by `text`, `options` or `options.<index>`,
 *  which is what the form underlines.
 *
 *  The validator returns cleaned options WITHOUT their ids, because an id is not
 *  part of what a person typed. They are put back on here, by position, because
 *  the repository needs them: an option that is saved as new every time gets a
 *  fresh id on every edit, and every attempt that recorded a tap on the old one
 *  ends up pointing at an option that no longer exists — so a report of "what did
 *  I answer" slowly fills up with blanks. The mapping is by index and is only
 *  safe because the validator does not add, drop or reorder options; it only
 *  edits them. */
export async function save(goalId, draft) {
    const result = validateQuestion(draft);
    if (!result.ok) return { ok: false, errors: result.errors };

    const options = result.values.options.map((option, index) => ({
        ...option,
        id: draft.options?.[index]?.id ?? null
    }));

    const record = await saveQuestionRecord({
        id: draft.id,
        goalId,
        text: result.values.text,
        kind: result.values.kind,
        options
    });
    return { ok: true, question: record.question };
}

/** Remove a question. See data/repos.js for why the cascade also touches open
 *  exercises and why finished ones are left alone. */
export async function remove(id) {
    await deleteQuestionRecord(id);
}

/** Save a new arrangement. */
export async function reorder(goalId, orderedIds) {
    await reorderQuestions(goalId, orderedIds);
}

export { assertValid, listOptions };