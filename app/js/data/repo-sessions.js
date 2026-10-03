// Exercises, their items, and the attempt log.
//
// THREE STORES AND ONE IDEA: an exercise is a SNAPSHOT. Every item carries a frozen
// copy of the question it is asking — its text, its kind, and its options with their
// correct marks — written at the moment the exercise was created. Nothing here ever
// reads a question again to find out what a session is asking.
//
// WHY A COPY AND NOT A REFERENCE, since `questionId` is still on the item and cost
// nothing:
//
// A reference makes the session's content a function of the present state of the
// question store, which means it is NOT a snapshot. Fix a typo in the wording of
// question 4 while you are halfway through exercise 3, and the rest of that exercise
// grades against text the reader has not seen.
//
// The cost is real and it is paid on purpose: a question's text is stored once per
// session it appears in rather than once. Six hundred characters per question per
// session is nothing next to the alternative, and the alternative is a training
// session that changes under the reader's hands.
//
// `questionId` STAYS on the item, and it is a HINT rather than a dependency: it is
// what "which exercises have asked this question" is answered from, and what a
// reader sees under the editor. Nothing needs the question row to exist for the item
// to be drawable, which is exactly the property that makes the session independent.
//
// THE OPTION IDS IN A FROZEN COPY ARE THE REAL ONES, not fresh ones. The attempt log
// records what was tapped by id, and a report of this exercise has to be able to
// resolve those ids against what was on screen at the time — a copy with its own ids
// would make every past report read "you picked nothing".

import { withTx } from "./db.js";
import { STORE } from "./stores.js";
import { newId } from "../domain/id.js";
import { NotFoundError } from "../domain/errors.js";
import { addDays, now } from "../domain/time.js";
import { currentDeviceId, touch, under, live } from "./repo-core.js";
import { openExercises } from "../domain/schedule.js";

export { openExercises };

/* -------------------------------------------------------------------------- */
/*                                 exercises                                   */
/* -------------------------------------------------------------------------- */

export async function getExercise(id) {
    const row = await withTx(STORE.EXERCISES, "readonly", (tx, db) => db.get(STORE.EXERCISES, id));
    if (!row) throw new NotFoundError("exercise", id);
    return row;
}

/** A goal's exercises, oldest first — the order the reader met them in. Read
 *  through the composite `goalNumber` index, so the answer arrives in number order
 *  and the sort below only breaks ties. */
export async function listExercises(goalId) {
    const rows = await withTx(STORE.EXERCISES, "readonly", (tx, db) =>
        db.byIndex(STORE.EXERCISES, "goalNumber", under(goalId))
    );
    return rows.filter(live).sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : 1));
}

/**
 * Write an exercise and its items together.
 *
 * `items` is `{questionId, kind, order, questionText, questionKind, options}`. The
 * consequence is the rule the whole design turns on — the question set of an
 * exercise cannot change after it starts. Editing a question, re-filing it, or
 * deleting it changes what a LATER exercise draws and leaves this one exactly as it
 * was, which is what "the current session is a fixed snapshot" has to mean if it is
 * to mean anything at all.
 *
 * `dueAt` is decided HERE, at creation, and never recomputed. The interval is read
 * from the goal record, which the reader can change at any time; if the due date
 * were derived at the moment the exercise finished, a goal whose interval was
 * widened mid-exercise would retroactively unlock its next exercise differently on
 * each device. The page and the schedule both derive their answer instead — see
 * `exerciseDueAt` in domain/schedule.js.
 *
 * `groupIds`, `questionIds` AND `excludeIds` ARE THE READER'S SELECTION, kept as a
 * record of what they asked for rather than as an input to anything. The items are
 * what make the exercise; these three say WHY those items are what they are, which is
 * the difference between "exercise 7" and "exercise 7, the irregular verbs, except
 * those four". They are written even when the exercise was built by the plan and
 * nothing was named, as `null` rather than absent, so a reader who opens a past
 * exercise and sees an empty selection is told the plan built it rather than being
 * left to guess.
 */
export async function createExercise({
    goalId, number, items, intervalDays,
    groupIds = null, questionIds = null, excludeIds = null
}) {
    const device = await currentDeviceId();
    const at = now();

    const record = touch({
        id: newId("exercise"),
        goalId,
        number,
        createdAt: at,
        groupIds: Array.isArray(groupIds) ? groupIds.slice() : null,
        questionIds: Array.isArray(questionIds) ? questionIds.slice() : null,
        excludeIds: Array.isArray(excludeIds) ? excludeIds.slice() : null,
        // Calendar days, through domain/time's addDays — not `at + n*86400000`.
        // An exercise unlocked by adding a day's milliseconds lands an hour early
        // or late twice a year, and the reader cannot tell that from "the app is
        // broken".
        dueAt: addDays(at, intervalDays),
        completedAt: null,
        deletedAt: null
    }, device);

    const itemRecords = items.map((item, index) => touch({
        id: newId("exerciseItem"),
        exerciseId: record.id,
        questionId: item.questionId,
        kind: item.kind,
        order: item.order ?? index,
        // THE SNAPSHOT. Copied, not referenced, and the answer key with it: an
        // option the reader has since un-ticked was correct when this exercise was
        // built, and grading it against the current marks is what makes a session
        // change under the reader's hands halfway through.
        questionText: item.questionText,
        questionKind: item.questionKind,
        options: (item.options ?? []).map((o) => ({
            id: o.id,
            text: o.text,
            isCorrect: Boolean(o.isCorrect),
            order: o.order
        })),
        createdAt: at,
        deletedAt: null
    }, device));

    await withTx([STORE.EXERCISES, STORE.EXERCISE_ITEMS], "readwrite", (tx, db) =>
        Promise.all([
            db.put(STORE.EXERCISES, record),
            ...itemRecords.map((item) => db.put(STORE.EXERCISE_ITEMS, item))
        ])
    );

    return { exercise: record, items: itemRecords };
}

/** Mark an exercise finished. Idempotent, and only moves forward: an exercise
 *  that already has a `completedAt` is not re-stamped, so a sync merge that
 *  delivers the same record twice cannot push the goal's unlock time later. */
export async function completeExercise(id, at = now()) {
    const device = await currentDeviceId();
    let updated = null;
    await withTx(STORE.EXERCISES, "readwrite", (tx, db) =>
        db.get(STORE.EXERCISES, id).then((row) => {
            if (!row) throw new NotFoundError("exercise", id);
            if (row.completedAt) {
                updated = row;
                return undefined;
            }
            updated = touch({ ...row, completedAt: at }, device);
            return db.put(STORE.EXERCISES, updated);
        })
    );
    return updated;
}

/**
 * Stamp a newly created exercise as a repeat of an earlier one.
 *
 * Its own function because the write cannot join `createExercise`: the id being
 * stamped is the one that call mints, so a record cannot refer to itself until it
 * exists. One field, one write, through `touch` so it is `dirty` like everything
 * else — a repeat recorded only on this device is a repeat the other device cannot
 * see, and its result page would then say "first time" about an exercise the reader
 * has already done.
 */
export async function setSourceExercise(id, sourceId) {
    const device = await currentDeviceId();
    let updated = null;
    await withTx(STORE.EXERCISES, "readwrite", (tx, db) =>
        db.get(STORE.EXERCISES, id).then((row) => {
            if (!row) throw new NotFoundError("exercise", id);
            updated = touch({ ...row, sourceId }, device);
            return db.put(STORE.EXERCISES, updated);
        })
    );
    return updated;
}

/* -------------------------------------------------------------------------- */
/*                                   items                                     */
/* -------------------------------------------------------------------------- */

export async function listItems(exerciseId) {
    const rows = await withTx(STORE.EXERCISE_ITEMS, "readonly", (tx, db) =>
        db.byIndex(STORE.EXERCISE_ITEMS, "exerciseOrder", under(exerciseId))
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/**
 * The items of many questions at once — every exercise occurrence of each, tombstones
 * filtered out.
 *
 * THE BATCH FORM OF `listExercisesForQuestion`, and it exists for the question list.
 * That screen draws two hundred rows and needs "how many of my exercises contain
 * this" on each of them; calling the single-question version per row would be two
 * hundred transactions on a page a reader is waiting for.
 *
 * Read through the `questionId` index once per question — one request each, all of
 * them inside a single transaction, so the whole batch is one round of IndexedDB
 * rather than two hundred.
 */
export async function listExerciseItemsByQuestions(questionIds) {
    const unique = [...new Set((questionIds ?? []).filter(Boolean))];
    if (!unique.length) return [];
    const rows = await withTx(STORE.EXERCISE_ITEMS, "readonly", (tx, db) =>
        Promise.all(unique.map((qid) => db.byIndex(STORE.EXERCISE_ITEMS, "questionId", qid)))
    );
    return rows.flat().filter(live);
}

/**
 * Every exercise this question has been an item of, newest first.
 *
 * THE OTHER HALF OF "A QUESTION IS NOT PART OF AN EXERCISE". An item is a row in
 * `exerciseItems` pointing at a question, so the same question can be on three
 * exercises and the three rows are independent — which means the question record
 * itself has no list of them, and this is the query that answers "where has this
 * been asked?" from the `questionId` index that migration 1 put there.
 *
 * IT IS NOT A HISTORY OF THE QUESTION. An exercise that was built by the plan and
 * happened to contain it is in here, and nothing stored tells those apart, so a
 * screen must not present this as one. What it answers is the one the reader asks
 * when they open a question and want to know what to revise: which of their
 * exercises already carry it.
 */
export async function listExercisesForQuestion(questionId) {
    const items = await withTx(STORE.EXERCISE_ITEMS, "readonly", (tx, db) =>
        db.byIndex(STORE.EXERCISE_ITEMS, "questionId", questionId)
    );
    const kept = items.filter(live);
    if (!kept.length) return [];

    const exercises = await withTx(STORE.EXERCISES, "readonly", (tx, db) =>
        Promise.all([...new Set(kept.map((i) => i.exerciseId))]
            .map((id) => db.get(STORE.EXERCISES, id)))
    );
    return exercises
        .filter((e) => e && !e.deletedAt)
        .sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
}

/* -------------------------------------------------------------------------- */
/*                                  attempts                                   */
/* -------------------------------------------------------------------------- */

export async function listAttempts(exerciseId) {
    const rows = await withTx(STORE.ATTEMPTS, "readonly", (tx, db) =>
        db.byIndex(STORE.ATTEMPTS, "exerciseId", exerciseId)
    );
    return rows.filter(live).sort((a, b) => a.answeredAt - b.answeredAt || (a.id < b.id ? -1 : 1));
}

/** Every attempt on the device, oldest first. The reports page and the home page
 *  are the only callers, and they are pages a person opens deliberately — paging
 *  this is a correctness trap that buys nothing, since accuracy and the daily bars
 *  both want every attempt and there is no per-page variant of either. */
export async function listAllAttempts() {
    const rows = await withTx(STORE.ATTEMPTS, "readonly", (tx, db) => db.getAll(STORE.ATTEMPTS));
    return rows.filter(live).sort((a, b) => a.answeredAt - b.answeredAt || (a.id < b.id ? -1 : 1));
}

/**
 * Record one answer.
 *
 * `selected` is the option ids the reader tapped, kept exactly as tapped —
 * including the wrong ones and including extra ones. It is not recomputed
 * against the item's frozen options afterwards: the point of storing it is that a
 * report can say what WAS answered, and re-deriving it from an option list that has
 * since been edited would make the report describe a question that no longer exists
 * in that form.
 */
export async function recordAttempt({ exerciseId, itemId, questionId, round, correct, selected }) {
    const device = await currentDeviceId();
    const record = touch({
        id: newId("attempt"),
        exerciseId,
        itemId,
        questionId,
        round,
        correct: Boolean(correct),
        selected: Array.isArray(selected) ? selected.slice() : [],
        answeredAt: now(),
        deletedAt: null
    }, device);
    await withTx(STORE.ATTEMPTS, "readwrite", (tx, db) => db.put(STORE.ATTEMPTS, record));
    return record;
}
