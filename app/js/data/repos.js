// Every read and every write, in one file.
//
// Two rules run through all of it:
//
//   * NO REPOSITORY VALIDATES, AND NO REPOSITORY DERIVES. `saveGoal` does not
//     know what a goal is allowed to look like, and `listAttempts` does not know
//     what "learned" means. Validation is domain/validation.js and the schedule
//     and the counts are domain/, and both are pure functions over plain objects
//     — which is why they can be tested without a browser and why the API can
//     run the same ones. A repository that started computing would be a place
//     where the rule exists twice and can disagree.
//
//   * DELETION IS A TOMBSTONE. `deletedAt` is set and the row is kept. A delete
//     that removed the row would be undone by the next sync, on the other
//     device, silently: the question would be back in the list with no way to
//     tell that it had ever been removed. So every read filters tombstones out
//     and sync carries them.
//
// Every write goes through `touch()`, which sets `updatedAt`, `dirty` and
// `device` in the SAME transaction as the record itself. That is the whole
// reason there is no outbox store: two writers for the same fact is a fact that
// will eventually disagree with itself.

import { withTx } from "./db.js";
import { META_KEY, STORE, KEY_IDENTITY } from "./stores.js";
import { newId, newDeviceId, isId } from "../domain/id.js";
import { NotFoundError } from "../domain/errors.js";
import { addDays, now } from "../domain/time.js";

/* -------------------------------------------------------------------------- */
/*                                   device                                    */
/* -------------------------------------------------------------------------- */

/** Cached for the life of the page. It cannot change without the database being
 *  deleted, and a page that outlives that has bigger problems. */
let deviceId = null;

/** This installation's id, created on first use. */
export async function currentDeviceId() {
    if (deviceId) return deviceId;
    const row = await getMeta(META_KEY.DEVICE);
    if (typeof row?.value === "string" && row.value) {
        deviceId = row.value;
        return deviceId;
    }
    const id = newDeviceId();
    await setMeta(META_KEY.DEVICE, id);
    deviceId = id;
    return id;
}

/** The five sync fields, applied to a record about to be written.
 *
 * `rev` is preserved rather than reset: it is the server's number, and zeroing
 * it would make the server re-issue a revision the pull cursor has already seen.
 * A locally created record has no `rev` at all and lands on 0, which is exactly
 * what "never acknowledged" means. */
function touch(record, device) {
    return {
        ...record,
        updatedAt: now(),
        rev: record.rev ?? 0,
        device: device ?? record.device,
        dirty: 1
    };
}

/** `key` as an IDB range covering every composite-key row under it, i.e. every
 *  `[goalId, order]` whatever the order is.
 *
 * The upper bound is `[key, []]` because IndexedDB compares arrays
 * lexicographically and an array sorts after every number — so `[goalId, 7]` is
 * below `[goalId, []]`, and the prefix `[goalId]` is below both. Written as
 * `IDBKeyRange.only(goalId)` this would match NOTHING, which is a mistake worth
 * naming: `only` compares the whole key, and the whole key is a pair. */
function under(prefix) {
    return IDBKeyRange.bound([prefix], [prefix, []]);
}

const live = (row) => row && !row.deletedAt;

/* -------------------------------------------------------------------------- */
/*                                    meta                                     */
/* -------------------------------------------------------------------------- */

/** A setting. Returns `null` rather than throwing when it is not set, because
 *  "not set" is the normal state of most of these and a caller that has to
 *  distinguish it from an error will get it wrong. */
export async function getMeta(key) {
    return withTx(STORE.META, "readonly", (tx, db) => db.get(STORE.META, key));
}

export async function setMeta(key, value) {
    return withTx(STORE.META, "readwrite", (tx, db) =>
        db.put(STORE.META, { key, value, updatedAt: now() })
    );
}

export async function removeMeta(key) {
    return withTx(STORE.META, "readwrite", (tx, db) => db.remove(STORE.META, key));
}

/** A bundle of settings in one read. The app asks for half a dozen of them on
 *  every navigation and one transaction per answer is one transaction per
 *  navigation, for no reason.
 *
 *  An ARRAY as the query is a key RANGE, so this is one request for exactly the
 *  keys asked for — not a scan of the whole store and not one request per key. */
export async function getMetaMany(keys) {
    const rows = await withTx(STORE.META, "readonly", (tx, db) => db.getAll(STORE.META, keys));
    const out = {};
    for (const key of keys) out[key] = null;
    for (const row of rows) if (row) out[row.key] = row.value;
    return out;
}

/* -------------------------------------------------------------------------- */
/*                                the identity                                */
/* -------------------------------------------------------------------------- */

/** The stored envelope. `null` when this device has no identity yet. */
export async function getIdentityEnvelope() {
    return withTx(STORE.KEYS, "readonly", (tx, db) => db.get(STORE.KEYS, KEY_IDENTITY));
}

export async function saveIdentityEnvelope(envelope) {
    return withTx(STORE.KEYS, "readwrite", (tx, db) =>
        db.put(STORE.KEYS, { id: KEY_IDENTITY, updatedAt: now(), ...envelope })
    );
}

export async function clearIdentityEnvelope() {
    return withTx(STORE.KEYS, "readwrite", (tx, db) => db.remove(STORE.KEYS, KEY_IDENTITY));
}

/* -------------------------------------------------------------------------- */
/*                                    goals                                    */
/* -------------------------------------------------------------------------- */

export async function getGoal(id) {
    const row = await withTx(STORE.GOALS, "readonly", (tx, db) => db.get(STORE.GOALS, id));
    if (!row) throw new NotFoundError("goal", id);
    return row;
}

/** The one active goal.
 *
 * There can only ever be one, and the index is on `status` rather than on
 * `completedAt` because "there is no active goal" has to be a fast question:
 * every page in the app asks it before deciding what to render. If a bug ever
 * produces two, the newest wins and the older one is left alone rather than
 * deleted — a half-written goal is somebody's typing. */
export async function getActiveGoal() {
    const rows = await withTx(STORE.GOALS, "readonly", (tx, db) =>
        db.byIndex(STORE.GOALS, "status", "active")
    );
    const liveRows = rows.filter(live);
    if (!liveRows.length) return null;
    liveRows.sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
    return liveRows[0];
}

/** Every goal, newest first, completed ones included. This is the history list
 *  behind "Create New Goal" — closed goals are kept, not deleted, because the
 *  questions of a finished goal are usually the reason the next one exists. */
export async function listGoals() {
    const rows = await withTx(STORE.GOALS, "readonly", (tx, db) => db.getAll(STORE.GOALS));
    return rows
        .filter(live)
        .sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
}

/** Create a goal. There is no update here: the three numbers on a goal change
 *  through `updateGoalPlan`, which is the only place that knows they can. */
export async function createGoal(values) {
    const device = await currentDeviceId();
    const record = touch({
        id: newId("goal"),
        title: values.title,
        description: values.description ?? "",
        status: "active",
        newPerExercise: values.newPerExercise,
        reviewDepth: values.reviewDepth,
        intervalDays: values.intervalDays,
        // The end of the plan, in days from creation. Stored rather than derived
        // from a constant at read time so that changing the default later does not
        // silently lengthen or shorten a goal somebody is halfway through.
        durationDays: values.durationDays,
        createdAt: now(),
        completedAt: null
    }, device);
    await withTx(STORE.GOALS, "readwrite", (tx, db) => db.put(STORE.GOALS, record));
    return record;
}

/** Change the plan of a goal. The title and description are NOT editable after
 *  creation: they are the one thing on the goal page that cannot be changed by
 *  accident halfway through reading it. */
export async function updateGoalPlan(id, values) {
    const device = await currentDeviceId();
    let updated = null;
    await withTx(STORE.GOALS, "readwrite", (tx, db) => {
        const existing = db.get(STORE.GOALS, id);
        return existing.then((row) => {
            if (!row) throw new NotFoundError("goal", id);
            updated = touch({
                ...row,
                newPerExercise: values.newPerExercise ?? row.newPerExercise,
                reviewDepth: values.reviewDepth ?? row.reviewDepth,
                intervalDays: values.intervalDays ?? row.intervalDays,
                durationDays: values.durationDays ?? row.durationDays
            }, device);
            return db.put(STORE.GOALS, updated);
        });
    });
    return updated;
}

/** Close a goal. Questions, exercises and attempts are left exactly where they
 *  are — this is a goal that is finished, not a goal that is gone. */
export async function completeGoal(id, at = now()) {
    const device = await currentDeviceId();
    let updated = null;
    await withTx(STORE.GOALS, "readwrite", (tx, db) =>
        db.get(STORE.GOALS, id).then((row) => {
            if (!row) throw new NotFoundError("goal", id);
            updated = touch({ ...row, status: "completed", completedAt: at }, device);
            return db.put(STORE.GOALS, updated);
        })
    );
    return updated;
}

/** Tombstone every live row of a store. */
const tombstoneAll = (db, storeName, rows, device, at) =>
    Promise.all(rows.filter(live).map((row) =>
        db.put(storeName, touch({ ...row, deletedAt: at }, device))
    ));

/**
 * Remove a goal and everything that belongs to it.
 *
 * One transaction over every store it touches, and tombstones rather than
 * removals. The size of it is the point: a cascade that is half applied — goal
 * gone, questions still there — leaves questions belonging to nothing, and on a
 * second device they come back and sit at the top of a list with no goal above
 * them.
 *
 * Every step here is promise chaining rather than `await`, and that is a rule of
 * the file rather than a style preference: these requests all resolve on
 * IndexedDB success events, which keep the transaction alive, whereas a single
 * `await` on anything else — a fetch, a timer — ends the transaction and the
 * remaining steps would throw and leave the cascade half applied. `withTx`
 * refuses an `async` callback for the same reason; the difference is that this
 * one would fail loudly, and this one would not.
 */
export async function deleteGoal(id) {
    const device = await currentDeviceId();
    await withTx(
        [STORE.GOALS, STORE.QUESTIONS, STORE.OPTIONS, STORE.EXERCISES,
            STORE.EXERCISE_ITEMS, STORE.ATTEMPTS],
        "readwrite",
        (tx, db) => {
            const at = now();

            const tombstoneQuestions = db.byIndex(STORE.QUESTIONS, "goalId", id)
                .then((rows) => Promise.all([
                    tombstoneAll(db, STORE.QUESTIONS, rows, device, at),
                    ...rows.filter(live).map((q) => db.byIndex(STORE.OPTIONS, "questionId", q.id)
                        .then((opts) => tombstoneAll(db, STORE.OPTIONS, opts, device, at)))
                ]));

            const tombstoneExercises = db.byIndex(STORE.EXERCISES, "goalId", id)
                .then((rows) => Promise.all([
                    tombstoneAll(db, STORE.EXERCISES, rows, device, at),
                    ...rows.filter(live).map((x) => db.byIndex(STORE.EXERCISE_ITEMS, "exerciseId", x.id)
                        .then((items) => tombstoneAll(db, STORE.EXERCISE_ITEMS, items, device, at)))
                ]));

            // The attempts come last and are read through the exercises as they
            // were BEFORE this transaction, which is why the exercise read is
            // repeated here rather than reusing the one above: by then the
            // exercise rows are already tombstoned, and an index read that
            // filters tombstones out would find nothing.
            const tombstoneAttempts = db.byIndex(STORE.EXERCISES, "goalId", id)
                .then((rows) => Promise.all(rows.map((x) =>
                    db.byIndex(STORE.ATTEMPTS, "exerciseId", x.id)
                        .then((list) => tombstoneAll(db, STORE.ATTEMPTS, list, device, at))
                )));

            return db.get(STORE.GOALS, id).then((goal) =>
                Promise.all([
                    goal && !goal.deletedAt
                        ? db.put(STORE.GOALS, touch({ ...goal, deletedAt: at }, device))
                        : undefined,
                    tombstoneQuestions,
                    tombstoneExercises,
                    tombstoneAttempts
                ])
            );
        }
    );
}

/* -------------------------------------------------------------------------- */
/*                                  questions                                  */
/* -------------------------------------------------------------------------- */

export async function getQuestion(id) {
    const row = await withTx(STORE.QUESTIONS, "readonly", (tx, db) => db.get(STORE.QUESTIONS, id));
    if (!row) throw new NotFoundError("question", id);
    return row;
}

/** A goal's questions in the order the reader arranged them. */
export async function listQuestions(goalId) {
    const rows = await withTx(STORE.QUESTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.QUESTIONS, "goalOrder", under(goalId))
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/** Every question of a goal INCLUDING tombstones. The sync merge needs them —
 *  an incoming delete for a question this device never had still has to be
 *  recorded, or the next pull brings it back. */
export async function listQuestionsWithDeleted(goalId) {
    const rows = await withTx(STORE.QUESTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.QUESTIONS, "goalOrder", under(goalId))
    );
    return rows.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

export async function listOptions(questionId) {
    const rows = await withTx(STORE.OPTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.OPTIONS, "questionOrder", under(questionId))
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

export async function listAllOptions(questionIds) {
    if (!questionIds.length) return [];
    const rows = await withTx(STORE.OPTIONS, "readonly", (tx, db) =>
        Promise.all(questionIds.map((qid) => db.byIndex(STORE.OPTIONS, "questionId", qid)))
    );
    return rows.flat().filter(live);
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
 * The position is assigned only for a new question, and it is assigned BEFORE
 * the transaction opens rather than inside it — reading the goal's last `order`
 * and then writing with it needs two transactions, and doing the read inside the
 * write would mean an `await` in the middle of one.
 */
export async function saveQuestion({ id, goalId, text, kind, options }) {
    const device = await currentDeviceId();
    const position = id ? undefined : await nextQuestionOrder(goalId);
    let result = null;

    await withTx([STORE.QUESTIONS, STORE.OPTIONS], "readwrite", (tx, db) => {
        const existing = id ? db.get(STORE.QUESTIONS, id) : Promise.resolve(null);
        return existing.then((row) => {
            const questionId = row?.id ?? id ?? newId("question");
            const at = now();
            const question = touch({
                id: questionId,
                goalId,
                text,
                kind,
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
 * Remove a question, its options, and its place in any exercise that has not
 * been finished yet.
 *
 * The items in OPEN exercises are tombstoned because an open exercise is a
 * session the app resumes from its attempt log, and a session cannot ask a
 * question that no longer exists. Items in FINISHED exercises are left exactly
 * where they are: they are part of what happened, the attempt log already points
 * at them, and a report of last week should still be able to show that week.
 */
export async function deleteQuestion(id) {
    const device = await currentDeviceId();
    await withTx(
        [STORE.QUESTIONS, STORE.OPTIONS, STORE.EXERCISE_ITEMS, STORE.EXERCISES],
        "readwrite",
        (tx, db) => {
            const at = now();
            return db.get(STORE.QUESTIONS, id).then((row) => {
                if (!row || row.deletedAt) return undefined;
                return Promise.all([
                    db.put(STORE.QUESTIONS, touch({ ...row, deletedAt: at }, device)),
                    db.byIndex(STORE.OPTIONS, "questionId", id)
                        .then((opts) => tombstoneAll(db, STORE.OPTIONS, opts, device, at)),
                    db.byIndex(STORE.EXERCISE_ITEMS, "questionId", id)
                        .then((items) => Promise.all(items.filter(live).map((item) =>
                            db.get(STORE.EXERCISES, item.exerciseId).then((exercise) => (
                                exercise && exercise.completedAt
                                    ? undefined
                                    : db.put(STORE.EXERCISE_ITEMS, touch({ ...item, deletedAt: at }, device))
                            ))
                        )))
                ]);
            });
        }
    );
}

/** Move questions. Takes the full ordered list of ids; anything missing from it
 *  is tombstoned, because the list came from a page that had just read them all
 *  and a question that vanished from it did so by being deleted. */
export async function reorderQuestions(goalId, orderedIds) {
    const device = await currentDeviceId();
    await withTx(STORE.QUESTIONS, "readwrite", (tx, db) => {
        const wanted = new Set(orderedIds);
        return db.byIndex(STORE.QUESTIONS, "goalId", goalId).then((rows) => {
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

/** The order number a new question gets: after everything that is already in the
 *  goal, including the tombstoned rows. Reusing a deleted row's number would put
 *  two questions on the same `order` and make the list order depend on the index
 *  cursor's tie-breaking rather than on the reader's arrangement. */
async function nextQuestionOrder(goalId) {
    const rows = await withTx(STORE.QUESTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.QUESTIONS, "goalOrder", under(goalId))
    );
    return rows.reduce((max, r) => Math.max(max, r.order + 1), 0);
}

/* -------------------------------------------------------------------------- */
/*                                  exercises                                  */
/* -------------------------------------------------------------------------- */

export async function getExercise(id) {
    const row = await withTx(STORE.EXERCISES, "readonly", (tx, db) => db.get(STORE.EXERCISES, id));
    if (!row) throw new NotFoundError("exercise", id);
    return row;
}

/** A goal's exercises, oldest first — the order the reader met them in. */
export async function listExercises(goalId) {
    const rows = await withTx(STORE.EXERCISES, "readonly", (tx, db) =>
        db.byIndex(STORE.EXERCISES, "goalNumber", under(goalId))
    );
    return rows.filter(live).sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : 1));
}

export async function listExercisesWithDeleted(goalId) {
    const rows = await withTx(STORE.EXERCISES, "readonly", (tx, db) =>
        db.byIndex(STORE.EXERCISES, "goalNumber", under(goalId))
    );
    return rows.sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : 1));
}

/**
 * Write an exercise and its items together.
 *
 * `dueAt` is decided HERE, at creation, and never recomputed. The interval is
 * read from the goal record, which the reader can change at any time; if the due
 * date were derived at the moment the exercise finished, a goal whose interval
 * was widened mid-exercise would retroactively unlock its next exercise
 * differently on each device.
 */
export async function createExercise({ goalId, number, items, intervalDays }) {
    const device = await currentDeviceId();
    const at = now();

    const record = touch({
        id: newId("exercise"),
        goalId,
        number,
        createdAt: at,
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

export async function listItems(exerciseId) {
    const rows = await withTx(STORE.EXERCISE_ITEMS, "readonly", (tx, db) =>
        db.byIndex(STORE.EXERCISE_ITEMS, "exerciseOrder", under(exerciseId))
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
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

export async function listQuestionAttempts(questionId) {
    const rows = await withTx(STORE.ATTEMPTS, "readonly", (tx, db) =>
        db.byIndex(STORE.ATTEMPTS, "questionId", questionId)
    );
    return rows.filter(live).sort((a, b) => a.answeredAt - b.answeredAt || (a.id < b.id ? -1 : 1));
}

/** Every attempt on the device, oldest first. The reports page is the only
 *  caller, and it is a page a person opens deliberately — paging this is a
 *  correctness trap that buys nothing, since accuracy and the daily bars both
 *  want every attempt and there is no per-page variant of either. */
export async function listAllAttempts() {
    const rows = await withTx(STORE.ATTEMPTS, "readonly", (tx, db) => db.getAll(STORE.ATTEMPTS));
    return rows.filter(live).sort((a, b) => a.answeredAt - b.answeredAt || (a.id < b.id ? -1 : 1));
}

/**
 * Record one answer.
 *
 * `selected` is the option ids the reader tapped, kept exactly as tapped —
 * including the wrong ones and including extra ones. It is not recomputed
 * against the current options afterwards: the point of storing it is that a
 * report can say what WAS answered, and re-deriving it from an option list that
 * has since been edited would make the report describe a question that no longer
 * exists in that form.
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

/* -------------------------------------------------------------------------- */
/*                                    sync                                     */
/* -------------------------------------------------------------------------- */

/** Records waiting to be pushed, oldest first.
 *
 * Bounded by `limit` so one enormous push cannot be built in one go — a device
 * that has been offline for a year has thousands of records and the request that
 * carries them has to fit in a body the server will accept. The bound is the
 * `updatedAt` order rather than an arbitrary slice, because two of those records
 * may be a question and its option and an order that splits them produces a
 * server that has an option belonging to a question it does not have. The
 * caller pulls again until the count comes back short. */
export async function listDirty(storeName, limit = 100) {
    const rows = await withTx(storeName, "readonly", (tx, db) => db.getAll(storeName));
    return rows
        .filter((row) => row.dirty === 1)
        .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))
        .slice(0, limit);
}

/** Apply what the server acknowledged.
 *
 * The revisions come FROM the server rather than being counted here. A client
 * that did `rev + 1` would be guessing: revisions are per-space and assigned in
 * the order the server actually stored the rows, so a push of two records at the
 * same millisecond assigns them 41 and 42 in one order, and a client that
 * assumed +1 for both would end up claiming a revision it was never given and
 * silently skip the next page of the pull.
 *
 * Clearing `dirty` happens in the same transaction as each record, so a crash
 * halfway through a batch leaves the rest dirty and they go out again rather than
 * being lost. A record whose `updatedAt` has moved since the push was built is
 * LEFT dirty on purpose: it changed after the bytes went out, so the server does
 * not have the current version and acknowledging it would drop the change.
 *
 * @param {string} storeName
 * @param {{id: string, rev: number}[]} acks
 */
export async function markPushed(storeName, acks) {
    if (!acks.length) return 0;
    return withTx(storeName, "readwrite", (tx, db) => {
        const writes = acks.map((ack) =>
            db.get(storeName, ack.id).then((row) => {
                if (!row || row.dirty !== 1) return undefined;
                if (row.rev > ack.rev) return undefined;   // pushed again since
                return db.put(storeName, { ...row, dirty: 0, rev: ack.rev });
            })
        );
        return Promise.all(writes).then((results) => results.filter(Boolean).length);
    });
}

/**
 * Write a record that came from the server.
 *
 * THE ID IS CHECKED BEFORE THE ROW IS WRITTEN. Sync is the one boundary where a
 * server decides what a record's id is, and an id is the one field the client
 * cannot repair afterwards: a record stored under a key nothing will ever look it
 * up by is a question that is gone, with no error and nothing to notice. The
 * check is in the WRITE rather than in the caller, because `applyRemote` is the
 * only path into the database for a remote record and a guard every caller has to
 * remember is a guard that is eventually forgotten.
 *
 * Last write wins, by `updatedAt` and then by `device`. The stored copy is only
 * replaced when the incoming one is genuinely newer, which is what stops two
 * devices from undoing each other's edits on every sync: without the comparison,
 * whichever device pushed last would overwrite the other, both would notice on
 * their next pull, and a question nobody touched would change text forever.
 */
export async function applyRemote(storeName, incoming) {
    let applied = 0;
    let skipped = 0;
    let refused = 0;
    await withTx(storeName, "readwrite", (tx, db) => {
        const writes = incoming.map((row) => {
            if (!isId(row?.id)) {
                // Counted as refused rather than skipped: skipped means "the stored
                // copy was newer", which is a merge decision, and conflating the two
                // hides a server that has started sending unusable ids.
                refused += 1;
                return undefined;
            }
            return db.get(storeName, row.id).then((local) => {
                if (local && !isNewer(row, local)) {
                    skipped += 1;
                    return undefined;
                }
                applied += 1;
                // `dirty: 0` because the server has this version by definition —
                // it is the version it just handed back.
                return db.put(storeName, { ...row, dirty: 0 });
            });
        });
        return Promise.all(writes);
    });
    return { applied, skipped, refused };
}

/** Whether an incoming record should replace the stored one.
 *
 * `rev` comes first, so a record the server has already assigned a revision to
 * never overwrites a local edit made after that push — that edit is `dirty`, it
 * has never been acknowledged, and its `rev` is still the old one. Comparing
 * `updatedAt` first would get that backwards: a device whose clock is an hour
 * fast produces an edit that looks newer and overwrites the server's copy
 * forever, while a device that is an hour slow never wins anything.
 *
 * When the revisions match — the normal case for two records that have never
 * been pushed — `updatedAt` decides, then `device` breaks the tie. Two devices
 * writing inside the same millisecond is ordinary, and without the device
 * tie-break the winner would depend on the order the two pushes happened to
 * arrive in, which is different on each device. */
export function isNewer(incoming, local) {
    if (incoming.rev !== local.rev) return incoming.rev > local.rev;
    if (incoming.updatedAt !== local.updatedAt) return incoming.updatedAt > local.updatedAt;
    return String(incoming.device ?? "") > String(local.device ?? "");
}