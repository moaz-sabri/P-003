// Groups: the shelf a question is filed on.
//
// A GROUP ORGANISES QUESTIONS AND NOTHING ELSE. It is not a goal, it is not a
// session, and — since the `goalId` column came off it — it does not belong to a
// goal. What a goal does with a group is point at it, and the point is a `goalRefs`
// row written by goal-content-service.js, not a field on this record.
//
// Three things about the shape, each forced by a case that came up while this was
// being built:
//
//   * A GROUP IS A RECORD, NOT A FIELD. A bare `groupId` on every question cannot
//     answer "which of my questions are in no group at all" — the state every
//     question written before this existed is in, and a state a reader can create on
//     purpose by clearing the picker. It also cannot carry a name, and the name is
//     the entire thing the reader recognises.
//
//   * "NOT FILED" IS A GROUP LIKE ANY OTHER, created on demand by `unfiledGroupFor`.
//     The alternative is a nullable `groupId` with a NULL branch in every reader —
//     the builder, the question list, the group's own question count — and a NULL
//     branch is one more place where the two can disagree. One row with the name
//     "not filed" is the same thing with none of the branches.
//
//   * NOTHING IS DESTROYED BY A GROUP. Deleting one files its questions as unfiled,
//     tombstones the group, and tombstones the goals' references to it. A shelf taken
//     away with the books still on it is the exact failure this design is against,
//     and a shelf shared between three goals is worse: without the last part,
//     deleting it would leave all three quietly short of material they were still
//     drawing from.
//
// `order` is DEVICE-WIDE. A group used to be a classification WITHIN a goal and
// carried a per-goal number; there is one shelf list now, so there is one order.

import { withTx } from "./db.js";
import { STORE } from "./stores.js";
import { newId } from "../domain/id.js";
import { NotFoundError } from "../domain/errors.js";
import { now } from "../domain/time.js";
import { currentDeviceId, touch, live, tombstoneAll } from "./repo-core.js";

/** A group's questions, oldest first. The question list and the "unfiled" view read
 *  this; the group page itself goes through `question-service.list(groupId)`, which
 *  adds the options and the state labels. */
export async function listGroupQuestions(groupId) {
    const rows = await withTx(STORE.QUESTIONS, "readonly", (tx, db) =>
        db.byIndex(STORE.QUESTIONS, "groupId", groupId)
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/**
 * Every group on the device, in the reader's own order.
 *
 * Read through the `order` index rather than `getAll` + a sort, for the reason the
 * same index exists on `questions`: this is drawn on the group list and on the
 * question list's chip row, and an index seek that arrives in order beats a full
 * store read plus a comparator.
 */
export async function listGroups() {
    const rows = await withTx(STORE.GROUPS, "readonly", (tx, db) =>
        db.byIndex(STORE.GROUPS, "order")
    );
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/** Every live group, ordered the same way. A separate name from `listGroups` on
 *  purpose: both exist, both are used, and merging them would mean one caller
 *  silently starts paying for a sort the other never needed. */
export async function listAllGroups() {
    const rows = await withTx(STORE.GROUPS, "readonly", (tx, db) => db.getAll(STORE.GROUPS));
    return rows.filter(live).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

export async function getGroup(id) {
    const row = await withTx(STORE.GROUPS, "readonly", (tx, db) => db.get(STORE.GROUPS, id));
    if (!row) throw new NotFoundError("group", id);
    return row;
}

/** The position a new group gets: after everything already on the device,
 *  tombstones included — the same rule `nextQuestionOrder` uses, for the same
 *  reason. */
async function nextGroupOrder() {
    const rows = await withTx(STORE.GROUPS, "readonly", (tx, db) =>
        db.getAll(STORE.GROUPS)
    );
    return rows.reduce((max, r) => Math.max(max, (r.order ?? 0) + 1), 0);
}

/** A group is only ever created by its reader naming it, so there is no default
 * name to fall back to and an unnamed one is refused rather than invented. */
export async function createGroup({ name }) {
    const device = await currentDeviceId();
    const order = await nextGroupOrder();
    const record = touch({
        id: newId("group"),
        name,
        order,
        createdAt: now(),
        deletedAt: null
    }, device);
    await withTx(STORE.GROUPS, "readwrite", (tx, db) => db.put(STORE.GROUPS, record));
    return record;
}

/** Rename a group. The order is not editable, for the reason it is not editable
 *  on a question: a form that can move a row is a form a stale tab can move it
 *  back from. */
export async function renameGroup(id, name) {
    const device = await currentDeviceId();
    let updated = null;
    await withTx(STORE.GROUPS, "readwrite", (tx, db) =>
        db.get(STORE.GROUPS, id).then((row) => {
            if (!row) throw new NotFoundError("group", id);
            updated = touch({ ...row, name }, device);
            return db.put(STORE.GROUPS, updated);
        })
    );
    return updated;
}

/**
 * The group a question with no group goes into.
 *
 * Created ON DEMAND and found by name, so two calls on one device do not produce
 * two unfiled groups: a second one would split the questions between them and
 * either would look empty. The name is compared folded, for the reason
 * `validateQuestion` folds its duplicate-option check — a reader who typed the
 * same name in Arabic with a different hamza form has not made two groups.
 *
 * Named in the reader's own language rather than in the code's: the string is
 * data the reader sees on the question list, and a row called "unfiled" in an
 * Arabic app is a row nobody recognises. It is passed in rather than read from
 * i18n here, because this file is data and importing the translation tables into
 * the data layer is how a repository ends up deciding what a word means.
 */
export async function unfiledGroupFor(name) {
    const device = await currentDeviceId();
    const groups = await listGroups();
    const wanted = String(name ?? "").replace(/\s+/g, " ").trim();
    const existing = wanted ? groups.find((g) => g.name === wanted) : null;
    if (existing) return existing;

    const order = await nextGroupOrder();
    const record = touch({
        id: newId("group"),
        name: wanted,
        order,
        createdAt: now(),
        deletedAt: null
    }, device);
    await withTx(STORE.GROUPS, "readwrite", (tx, db) => db.put(STORE.GROUPS, record));
    return record;
}

/**
 * Remove a group, and file its questions as unfiled.
 *
 * THE QUESTIONS ARE KEPT AND THE GROUP IS TOMBSTONED. Deleting a shelf with the
 * books still on it is the thing this whole design is against: the reader asked for
 * questions to stop belonging to one exercise, and a group that took its questions
 * with it would put them back in exactly the position they were moved out of —
 * invisible, unattributable, and gone from every future exercise.
 *
 * So the questions are REASSIGNED rather than deleted. They go to the unfiled group
 * if the caller found one, and stay where they are if it did not — a question with
 * no `groupId` is a question in no group, which the builder treats as available to
 * every exercise. Both outcomes put the question back in front of the reader, which
 * is the whole point.
 */
export async function deleteGroup(id, { unfiledId = null } = {}) {
    const device = await currentDeviceId();
    await withTx([STORE.GROUPS, STORE.QUESTIONS, STORE.GOAL_REFS], "readwrite", (tx, db) => {
        const at = now();
        return db.get(STORE.GROUPS, id).then((row) => {
            if (!row || row.deletedAt) return undefined;

            return db.byIndex(STORE.QUESTIONS, "groupId", id).then((rows) => {
                const writes = rows
                    .filter(live)
                    .map((q) => db.put(STORE.QUESTIONS, touch({
                        ...q,
                        // `null`, not a deletion. See the note above: a question in
                        // no group is one the builder will offer to every exercise,
                        // which is where it has to end up.
                        groupId: unfiledId
                    }, device)));
                writes.push(db.put(STORE.GROUPS, touch({ ...row, deletedAt: at }, device)));
                // The references naming this group go in the same transaction, so a
                // goal cannot be left pointing at a shelf that no longer exists. A
                // group is shared now — that is the point of the change — and a
                // shared thing deleted out from under one of its users is the failure
                // this line exists to prevent.
                writes.push(
                    db.byIndex(STORE.GOAL_REFS, "ref", IDBKeyRange.only(["group", id]))
                        .then((refs) => tombstoneAll(db, STORE.GOAL_REFS, refs, device, at))
                );
                return Promise.all(writes);
            });
        });
    });
}
