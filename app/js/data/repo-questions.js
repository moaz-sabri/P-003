// Questions and their options.
//
// A QUESTION IS A STANDALONE THING. There is no `goalId` on this record, it is not
// created by a goal, and it can be written with no goal in the app at all. What a
// goal does with it is point at it — a `goalRefs` row written by
// goal-content-service.js — and that row is the reader's decision rather than a
// container the question lives in.
//
// Which means the two reads here that used to take a goal id do not take one any
// more, and the shape of the record followed:
//
//   * `listQuestions()` is the WHOLE list, and "the questions of a goal" is a join
//     assembled in domain/goal-content.js from the references rather than a filter
//     on a column. A question in no goal is on the list rather than invisible.
//   * `listQuestionsInGroups(groupIds)` takes a LIST and the ids are OR'd, not AND'd:
//     a session built from two groups contains the questions of both, which is the
//     whole reason a group exists. `null` returns every question.
//
// `order` IS DEVICE-WIDE rather than per goal. The reader's question list is one
// list, so there is one order for it to be in; an order that meant "position within
// my goal" would have no meaning for a question in no goal at all.

import { withTx } from "./db.js";
import { STORE } from "./stores.js";
import { newId } from "../domain/id.js";
import { NotFoundError } from "../domain/errors.js";
import { now } from "../domain/time.js";
import { currentDeviceId, touch, under, live, tombstoneAll } from "./repo-core.js";
// Imported as well as re-exported, because this file calls `orderOptions` in
// `listAllOptions`. A bare `export … from` does not put the name in this module's
// scope, so without this import that call site is an undefined function — which is
// the kind of mistake that only shows up on a question list.
import { orderOptions } from "../domain/options.js";

export { orderOptions };

/* -------------------------------------------------------------------------- */
/*                                 questions                                   */
/* -------------------------------------------------------------------------- */

export async function getQuestion(id) {
    const row = await withTx(STORE.QUESTIONS, "readonly", (tx, db) => db.get(STORE.QUESTIONS, id));
    if (!row) throw new NotFoundError("question", id);
    return row;
}

/**
 * EVERY question on the device, in the reader's own order.
 *
 * NO GOAL ARGUMENT, and that is the change. A question is a question; it exists
 * before any goal is made, it belongs to no goal, and it can be pointed at by
 * several. So the list that every other read is derived from is the whole list.
 *
 * It reads the `order` index rather than `getAll` + a sort, because this is drawn on
 * the question list, which a reader opens with two hundred rows on it, and an index
 * seek that arrives in order beats a full store read plus a comparator.
 */
export async function listQuestions() {
    const rows = await withTx(STORE.QUESTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.QUESTIONS, "order")
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/**
 * The questions of one or more groups, in the reader's own order.
 *
 * The order is the device's, not the group's. Two groups are not two lists the
 * reader arranged against each other; a session interleaves them by the order the
 * questions were typed in, so moving a question up moves it up in every session it
 * appears in, and there is one answer to "where does this sit".
 */
export async function listQuestionsInGroups(groupIds) {
    const all = await listQuestions();
    if (!groupIds || !groupIds.length) return all;
    const wanted = new Set(groupIds);
    return all.filter((q) => q.groupId && wanted.has(q.groupId));
}

/** A group's questions, oldest first. The question list filters by this. */
export async function listGroupQuestions(groupId) {
    const rows = await withTx(STORE.QUESTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.QUESTIONS, "groupId", groupId)
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/**
 * Write a question and its options as one change.
 *
 * Options are matched to the stored ones BY ID, and an option the form did not
 * send is tombstoned rather than dropped. Matching by id is why the edit form
 * has to carry the ids of the options it did not change: without them the whole
 * set would be replaced on every save, and every attempt that recorded a
 * selection would end up pointing at an option that no longer exists.
 *
 * The position is assigned only for a new question, and it is assigned BEFORE the
 * transaction opens rather than inside it — reading the last `order` and then
 * writing with it needs two transactions, and doing the read inside the
 * write would mean an `await` in the middle of one.
 */
export async function saveQuestion({ id, text, kind, options, groupId = null }) {
    const device = await currentDeviceId();
    const position = id ? undefined : await nextQuestionOrder();
    let result = null;

    await withTx([STORE.QUESTIONS, STORE.OPTIONS], "readwrite", (tx, db) => {
        const existing = id ? db.get(STORE.QUESTIONS, id) : Promise.resolve(null);
        return existing.then((row) => {
            const questionId = row?.id ?? id ?? newId("question");
            const at = now();
            const question = touch({
                id: questionId,
                // NO `goalId`. The question does not belong to a goal; a goal points at
                // it through a `goalRefs` row, and that row is the reader's decision
                // rather than a field that exists whether they made it or not. A
                // question can therefore be created with no goal in the app at all,
                // which is the state every question was written in before a goal
                // existed and the state most of a reader's questions are in.
                text,
                kind,
                // WHICH GROUP FILES THIS QUESTION — and the change that makes a
                // question independent of any one exercise.
                //
                // IT IS `null` FOR A QUESTION IN NO GROUP, and that is a real
                // state rather than "not set yet": the builder offers those
                // questions to every exercise, which is what a question the reader
                // never filed should mean. A question written before groups
                // existed has no `groupId` at all, and is in exactly that state.
                groupId: groupId ?? row?.groupId ?? null,
                // `packId` IS PROVENANCE, NOT CONTENT, and the editor cannot change it.
                //
                // It is carried on the question record so that "the questions of this
                // pack are already on this device" is a question the DATABASE can
                // answer rather than one a second copy of the pack file has to guess at
                // from the text. Nothing in this file reads it and nothing in the app
                // draws it; `library-service` reads it when a pack is added a second
                // time, and that is all. It is preserved here rather than dropped
                // because the alternative is that editing a question the reader copied
                // from a library quietly makes the app forget where it came from, which
                // is what makes a second add copy it all over again.
                packId: row?.packId ?? null,
                // A question's place in the list is set when it is created and by
                // `reorderQuestions` alone. Taking an `order` from a form means a
                // stale tab could move a question somebody has just reordered.
                order: row ? row.order : position,
                createdAt: row?.createdAt ?? at,
                deletedAt: row?.deletedAt ?? null
            }, device);

            return db.byIndex(STORE.OPTIONS, "questionId", questionId).then((stored) => {
                const kept = new Map(stored.map((o) => [o.id, o]));
                const keptIds = new Set();
                const writes = [db.put(STORE.QUESTIONS, question)];

                options.forEach((option, index) => {
                    const reused = option.id && kept.get(option.id);
                    const optionId = reused ? option.id : newId("option");
                    keptIds.add(optionId);
                    writes.push(db.put(STORE.OPTIONS, touch({
                        id: optionId,
                        questionId,
                        text: option.text,
                        isCorrect: Boolean(option.isCorrect),
                        // A kept option keeps its place even if the reader moved it
                        // within the question; reordering options inside a question
                        // is not a thing the app offers, and re-indexing them on
                        // every save would scramble the answer key in the report.
                        order: reused ? reused.order : index,
                        createdAt: reused?.createdAt ?? at,
                        deletedAt: null
                    }, device)));
                });

                for (const option of stored) {
                    if (keptIds.has(option.id) || option.deletedAt) continue;
                    writes.push(db.put(STORE.OPTIONS, touch({ ...option, deletedAt: at }, device)));
                }

                result = { question };
                return Promise.all(writes);
            });
        });
    });

    return result;
}

/**
 * Write MANY new questions, and their options, in ONE transaction.
 *
 * THIS IS NOT A LOOP AROUND `saveQuestion`, and it is here because importing a ready-made
 * set is the first thing in this app that creates a known number of questions at once. A
 * set of twenty questions written through `saveQuestion` is twenty transactions, and each
 * one re-reads the whole `order` index to find its position — so the write is forty reads
 * and twenty commits where one of each would do, on the tap a reader is waiting through
 * after choosing a set. It is also twenty separate moments in time: a sync push fired
 * halfway through would carry a pack whose first six questions exist and whose shelf does
 * not.
 *
 * CREATE-ONLY, which is why it is a separate function rather than a flag on `saveQuestion`.
 * Everything `saveQuestion` does that this does not is there for the EDIT path — matching
 * options by id, tombstoning the ones a form removed, keeping a position the reader has
 * arranged — and none of it applies to a draft that has never been saved: there are no
 * stored options to match, nothing to tombstone, and no position to keep. Two functions
 * with one job each is shorter than one function with a mode, and the edit path's rules
 * stay where they are read.
 *
 * NO VALIDATION. The drafts arrive from `library-service` already through
 * `domain/pack.js`, which ran `validateQuestion` on each one — the same rule the editor's
 * form runs. A repository that checked would be a second place the rule lives, which is
 * the thing `repo-core.js` opens by forbidding.
 *
 * `order` CONTINUES THE DEVICE'S LIST and does not restart at zero. A question's place in
 * the list is its own, device-wide, and a pack's questions are typed after everything
 * already there rather than in front of it — which is what makes an imported question sit
 * at the end of the question list, where a reader who has just added it will look.
 *
 * @param {{text: string, kind: string, groupId?: string|null,
 *          packId?: string|null, options: {text: string, isCorrect: boolean}[]}[]} drafts
 * @returns {Promise<{id: string, index: number}[]>} what was written, in draft order
 */
export async function createQuestions(drafts) {
    const list = drafts ?? [];
    if (!list.length) return [];

    const device = await currentDeviceId();
    const at = now();
    // Read BEFORE the transaction opens, for the same reason `saveQuestion` does: the
    // position is data the write needs, and reading it inside would be an `await` in the
    // middle of one.
    let next = await nextQuestionOrder();

    const written = [];
    await withTx([STORE.QUESTIONS, STORE.OPTIONS], "readwrite", (tx, db) => {
        const writes = [];
        for (const [index, draft] of list.entries()) {
            const id = newId("question");
            written.push({ id, index });
            writes.push(db.put(STORE.QUESTIONS, touch({
                id,
                text: draft.text,
                kind: draft.kind,
                groupId: draft.groupId ?? null,
                packId: draft.packId ?? null,
                order: next++,
                createdAt: at,
                deletedAt: null
            }, device)));

            draft.options.forEach((option, place) => {
                writes.push(db.put(STORE.OPTIONS, touch({
                    id: newId("option"),
                    questionId: id,
                    text: option.text,
                    isCorrect: Boolean(option.isCorrect),
                    order: place,
                    createdAt: at,
                    deletedAt: null
                }, device)));
            });
        }
        return Promise.all(writes);
    });

    return written;
}

/**
 * Remove a question and its options. NOTHING ELSE IS TOUCHED.
 *
 * This function used to reach into open exercises and tombstone the items pointing
 * here, on the reasoning that "a session cannot ask a question that no longer
 * exists". That reasoning was a consequence of items being REFERENCES, and it is
 * the single change the snapshot removes: an item carries its own copy of the
 * question, so an exercise that has already been built can still be finished after
 * the question is deleted.
 *
 * Which is the right answer rather than merely a convenient one. A reader halfway
 * through a session who realises one question was a typo deletes it, and the
 * session they are in does not lose a question out from under them — the item count
 * on the progress bar still matches what gets asked, and the question that was on
 * screen is still the question they were asked.
 *
 * The two things that DO still go are the question and its options, and the
 * references other goals held to it. A `goalRefs` row is a relationship, and this
 * relationship is over: leaving it would put a tombstoned id into a goal's material
 * list, where it would count towards "how many questions does this goal have" and
 * then contribute nothing. The goal itself, its groups and its other questions are
 * not touched.
 */
export async function deleteQuestion(id) {
    const device = await currentDeviceId();
    await withTx(
        [STORE.QUESTIONS, STORE.OPTIONS, STORE.GOAL_REFS],
        "readwrite",
        (tx, db) => {
            const at = now();
            return db.get(STORE.QUESTIONS, id).then((row) => {
                if (!row || row.deletedAt) return undefined;
                return Promise.all([
                    db.put(STORE.QUESTIONS, touch({ ...row, deletedAt: at }, device)),
                    db.byIndex(STORE.OPTIONS, "questionId", id)
                        .then((opts) => tombstoneAll(db, STORE.OPTIONS, opts, device, at)),
                    db.byIndex(STORE.GOAL_REFS, "ref", IDBKeyRange.only(["question", id]))
                        .then((refs) => tombstoneAll(db, STORE.GOAL_REFS, refs, device, at))
                ]);
            });
        }
    );
}

/**
 * Move questions. Takes the full ordered list of ids; anything missing from it
 * is tombstoned, because the list came from a page that had just read them all
 * and a question that vanished from it did so by being deleted.
 *
 * DEVICE-WIDE, which is what the single question list means. There is no per-goal
 * arrangement to preserve any more, and offering one would imply a question has a
 * different place depending on which goal you are looking through.
 */
export async function reorderQuestions(orderedIds) {
    const device = await currentDeviceId();
    await withTx(STORE.QUESTIONS, "readwrite", (tx, db) => {
        const wanted = new Set(orderedIds);
        return db.byIndex(STORE.QUESTIONS, "order").then((rows) => {
            const writes = rows.filter(live).map((row) => {
                const at = wanted.has(row.id) ? orderedIds.indexOf(row.id) : -1;
                if (at === row.order) return null;
                if (at === -1) return db.put(STORE.QUESTIONS, touch({ ...row, deletedAt: now() }, device));
                return db.put(STORE.QUESTIONS, touch({ ...row, order: at }, device));
            }).filter(Boolean);
            return Promise.all(writes);
        });
    });
}

/** The order number a new question gets: after everything that is already on the
 *  device, including the tombstoned rows. Reusing a deleted row's number would put
 *  two questions on the same `order` and make the list order depend on the index
 *  cursor's tie-breaking rather than on the reader's arrangement. */
async function nextQuestionOrder() {
    const rows = await withTx(STORE.QUESTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.QUESTIONS, "order")
    );
    return rows.reduce((max, r) => Math.max(max, (r.order ?? 0) + 1), 0);
}

/* -------------------------------------------------------------------------- */
/*                                  options                                    */
/* -------------------------------------------------------------------------- */

export async function listOptions(questionId) {
    const rows = await withTx(STORE.OPTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.OPTIONS, "questionOrder", under(questionId))
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/**
 * The options of many questions at once, each list already in the order they
 * were typed.
 *
 * THE SORT IS NOT COSMETIC. This reads through the `questionOrder` index, and an
 * index over one field orders rows that tie on it by primary key — for an
 * option that is a random uuid, so the same question came back in a different
 * order on every call. Reading it that way and sorting afterwards gives the same
 * answer, and reading it that way WITHOUT sorting gives a different order on every
 * call, which is the bug this function had.
 *
 * ONE ARRAY PER QUESTION, not one row per question. `Promise.all` over the index
 * reads gives an array of arrays — one per question — and `flatMap` with
 * `orderOptions` inside it is what turns each of those into an ordered list. A
 * `flat()` followed by a `map` over the rows is off by one level and hands
 * `orderOptions` a single option, which is an object with no `filter` on it.
 */
export async function listAllOptions(questionIds) {
    if (!questionIds.length) return [];
    const groups = await withTx(STORE.OPTIONS, "readonly", (tx, db) =>
        Promise.all(questionIds.map((qid) => db.byIndex(STORE.OPTIONS, "questionOrder", under(qid))))
    );
    return groups.flatMap((group) => orderOptions(group));
}
