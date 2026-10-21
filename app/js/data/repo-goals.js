// Goals, and the `goalRefs` join table that is the ONLY thing saying a goal and a
// question are related.
//
// TWO SUBJECTS IN ONE FILE, and they are here together because they are two
// directions of one relation. A goal is a plan — why the reader is training and how
// often — and it owns no material. What it draws on is a set of reference rows, some
// naming groups and some naming individual questions, and every question in the app
// asks those rows the same way.
//
// THE SEPARATION IS NOT A REFACTOR, IT IS THE MODEL:
//
//   * `goalRefs` is the only place a goal and a question are related. Before this
//     there was a `goalId` column on the question, and that column was a claim of
//     OWNERSHIP: it made "the questions of a goal" a question about the question
//     table, and it made a goal impossible without questions and a question
//     impossible without a goal. A row in here is a reference rather than a
//     container — the same question can have one for two goals, and neither goal is
//     the owner.
//
//   * It is a TABLE rather than two columns because the relation is many-to-many
//     and the READER is in charge of it. One question in two goals, one goal drawing
//     on four shelves, is not a shape two columns can hold.
//
//   * `order` IS WHEN THE READER ADDED IT, not a number they can rearrange. There is
//     no control for moving a group up and down a goal's list, and adding one would
//     mean deciding what reordering the list even means when the builder draws from
//     all of them at once.
//
//   * THE ID IS DERIVED, NOT MINTED (see `derivedId` in domain/id.js). Two devices
//     can reach the same attachment independently, and a random id would make the
//     merge keep both, so the goal would count a shelf it was attached once.

import { withTx } from "./db.js";
import { STORE } from "./stores.js";
import { newId, derivedId, GOAL_REF_PREFIX } from "../domain/id.js";
import { NotFoundError } from "../domain/errors.js";
import { now } from "../domain/time.js";
import { currentDeviceId, touch, under, live, tombstoneAll } from "./repo-core.js";
import { listAllGroups } from "./repo-groups.js";

/* -------------------------------------------------------------------------- */
/*                                    goals                                    */
/* -------------------------------------------------------------------------- */

export async function getGoal(id) {
    const row = await withTx(STORE.GOALS, "readonly", (tx, db) => db.get(STORE.GOALS, id));
    if (!row) throw new NotFoundError("goal", id);
    return row;
}

/**
 * The goal a page with no goal in its URL is about: the newest active one.
 *
 * THERE CAN NOW BE SEVERAL ACTIVE GOALS, and this is still the right answer for
 * every screen that was written when there could only be one — a deep link opened
 * from a notification, the nav bar, a bookmark. It takes the newest rather than
 * erroring, because "which one" is a question the URL is supposed to answer, and a
 * reader with three goals open in three tabs gets the most recent one in the
 * fourth, which is the least surprising of the possible answers.
 *
 * ARCHIVED GOALS ARE EXCLUDED. An archived goal is one the reader set aside, so a
 * link that lands on one by accident should say so rather than quietly build
 * exercises for it. Pages that DO mean a specific goal take it from the URL and
 * read it with `getGoal`.
 *
 * The index is on `status` rather than on `completedAt` because "is there an active
 * goal" has to be a fast question: every page in the app asks it before deciding
 * what to render.
 */
export async function getActiveGoal() {
    const rows = await withTx(STORE.GOALS, "readonly", (tx, db) =>
        db.byIndex(STORE.GOALS, "status", "active")
    );
    const liveRows = rows.filter((row) => live(row) && !row.archivedAt);
    if (!liveRows.length) return null;
    liveRows.sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
    return liveRows[0];
}

/**
 * Every goal, newest first, completed and archived ones included.
 *
 * ARCHIVED GOALS ARE IN HERE, and that is the point: an archived goal is filed
 * away, not hidden. The pages that want "the goals the reader is working on" ask
 * for something narrower — `listActiveGoals` — and this is the list behind the
 * archive page and the history list, where a goal the reader deliberately set
 * aside has to be able to appear. A reader who archives four goals over two years
 * and then wants the third one back has to be able to find it, and a store that
 * filtered archived rows out of every read would make that impossible without a
 * second query — which is how a rule ends up in two places.
 */
export async function listGoals() {
    const rows = await withTx(STORE.GOALS, "readonly", (tx, db) => db.getAll(STORE.GOALS));
    return rows
        .filter(live)
        .sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
}

/**
 * The goals that are still being worked on: active, and not archived.
 *
 * This is the list every screen that has to choose a goal reads. More than one can
 * be in it — several goals at once is the normal case, up to `MAX_ACTIVE_GOALS` of
 * them — so callers that genuinely need ONE goal ask `getActiveGoal`, which takes
 * the newest, and pages that need all of them iterate.
 *
 * THE LIMIT IS NOT HERE. This read answers what exists and the number of things it
 * returns is not a rule about what may be written; `goal-service` decides that, in
 * `createGoal` and in the successor written when a goal is closed, so that a
 * repository read is never the thing enforcing a product decision.
 */
export async function listActiveGoals() {
    const rows = await withTx(STORE.GOALS, "readonly", (tx, db) =>
        db.byIndex(STORE.GOALS, "status", "active")
    );
    return rows
        .filter((row) => live(row) && !row.archivedAt)
        .sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
}

/** Create a goal. There is no update here: the numbers on a goal change
 *  through `updateGoalPlan`, which is the only place that knows they can. */
export async function createGoal(values) {
    const device = await currentDeviceId();
    const record = touch({
        id: newId("goal"),
        title: values.title,
        description: values.description ?? "",
        status: "active",
        // The plan is the fixed constants in config.js rather than per-goal
        // numbers; they are still stored on the record so a goal written before
        // the constants existed keeps readable values, and validation rewrites
        // any legacy per-goal values the next time it is saved.
        newPerExercise: values.newPerExercise,
        reviewDepth: values.reviewDepth,
        createdAt: now(),
        completedAt: null,
        // `null` and not absent: the archive query is an index read over
        // `archivedAt`, and a row with no such key is not in the index at all,
        // which is a different thing from being in it and sorted at the end.
        archivedAt: null
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
                reviewDepth: values.reviewDepth ?? row.reviewDepth
            }, device);
            return db.put(STORE.GOALS, updated);
        });
    });
    return updated;
}

/**
 * Close a goal. Questions, groups, exercises and attempts are left exactly where
 * they are — this is a goal that is finished, not a goal that is gone.
 *
 * `archivedAt` is NOT set here, and that is the difference between finishing and
 * archiving. Finishing is the goal's own time running out; archiving is the reader
 * filing it away and being able to take it back. A goal the app closed is not one
 * the reader hid, and `unarchiveGoal` would have nothing sensible to undo.
 */
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

/**
 * Remove a goal. THE QUESTIONS AND THE GROUPS BOTH STAY.
 *
 * This used to cascade everything: goal gone, and with it the questions, their
 * options, the groups, the exercises and the attempts. That was written when a
 * question had nowhere else to live — `goalId` was the index every question read
 * went through, so a question whose goal was gone was a row nothing could find.
 *
 * NONE OF THAT IS TRUE ANY MORE, and the cascade is now the bug rather than the
 * behaviour. A question belongs to no goal; a group is a shelf belonging to nobody;
 * what connects a goal to either is a `goalRefs` row, and a row is a reference and
 * not a container. So the questions in a deleted goal are still questions the reader
 * wrote, still answerable, still fileable in a group and still pointable at by a
 * second goal. Destroying them would be destroying the reader's material to punish
 * them for removing a plan.
 *
 * What IS tombstoned: the goal, the references that pointed it at groups and
 * questions, its exercises, their items and their attempts. Those are the goal's
 * own history, and they are kept as rows rather than removed so that a sync
 * tombstone does not bring them back on the other device.
 *
 * The reader is offered ARCHIVE first (goal-service.archive), which does none of
 * this and keeps every report. This function is the "remove it entirely" path, and
 * it exists for a goal created by mistake.
 *
 * Every step is promise chaining rather than `await`: these requests resolve on
 * IndexedDB success events, which keep the transaction alive, whereas a single
 * `await` on anything else ends the transaction and leaves the cascade half
 * applied — which is the failure `data/db.js` exists to prevent.
 */
export async function deleteGoal(id) {
    const device = await currentDeviceId();
    await withTx(
        [STORE.GOALS, STORE.GOAL_REFS, STORE.EXERCISES, STORE.EXERCISE_ITEMS, STORE.ATTEMPTS],
        "readwrite",
        (tx, db) => {
            const at = now();

            // THE REFERENCES GO. A goal's link to a group or a question is a claim
            // about what this goal draws on, and the goal is gone, so the claim is.
            // Nothing on the other end is touched: the groups and the questions
            // themselves are NOT this goal's, and that is exactly what the new model
            // says. Deleting a goal removes a plan, not the material it was using.
            const tombstoneRefs = db.byIndex(STORE.GOAL_REFS, "goalId", id)
                .then((rows) => tombstoneAll(db, STORE.GOAL_REFS, rows, device, at));

            // The goal's exercises are its HISTORY — its items, its attempt log, the
            // score of every sitting — and they are kept as rows rather than removed
            // so that a sync tombstone does not bring them back on the other device.
            // A report of a deleted goal is not reachable from the app, but the
            // records are what say it happened.
            const tombstoneExercises = db.byIndex(STORE.EXERCISES, "goalId", id)
                .then((rows) => Promise.all([
                    tombstoneAll(db, STORE.EXERCISES, rows, device, at),
                    ...rows.filter(live).map((x) => db.byIndex(STORE.EXERCISE_ITEMS, "exerciseId", x.id)
                        .then((items) => tombstoneAll(db, STORE.EXERCISE_ITEMS, items, device, at)))
                ]));

            // The attempts are read through the exercises as they were BEFORE this
            // transaction, which is why the exercise read is repeated rather than
            // reusing the one above: by then those rows are tombstoned, and an
            // index read that filters tombstones out would find nothing.
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
                    tombstoneRefs,
                    tombstoneExercises,
                    tombstoneAttempts
                ])
            );
        }
    );
}

/**
 * File a goal away. NOTHING IS DELETED.
 *
 * `archivedAt` is a timestamp and nothing else changes: the questions, the
 * groups, the exercises, the items and every attempt are exactly where they were.
 * That is the difference between archiving and finishing — `completeGoal` closes a
 * goal whose time is up and keeps it too, but it is a state the app puts the goal
 * in; this is a place the READER puts it, and it is reversible.
 *
 * The reader's words: the goal is archived with its report and is neither deleted
 * nor hidden. So it is not hidden: an archived goal is in the archive page with a
 * link to its report, and `listGoals` still returns it. What stops is the building
 * of anything new, which is what `planSchedule` decides from `status`.
 */
export async function archiveGoal(id, at = now()) {
    const device = await currentDeviceId();
    let updated = null;
    await withTx(STORE.GOALS, "readwrite", (tx, db) =>
        db.get(STORE.GOALS, id).then((row) => {
            if (!row) throw new NotFoundError("goal", id);
            if (row.archivedAt) {
                // Idempotent: a stale tab archiving twice must not push the date
                // later, or the archive list reorders itself for no reason.
                updated = row;
                return undefined;
            }
            updated = touch({ ...row, archivedAt: at }, device);
            return db.put(STORE.GOALS, updated);
        })
    );
    return updated;
}

/** Take a goal back out of the archive. `archivedAt: null` is the whole of it,
 *  and the goal's own `status` is untouched — archiving is not finishing, so a
 *  goal that was finished and then archived stays finished when it comes back. */
export async function unarchiveGoal(id) {
    const device = await currentDeviceId();
    let updated = null;
    await withTx(STORE.GOALS, "readwrite", (tx, db) =>
        db.get(STORE.GOALS, id).then((row) => {
            if (!row) throw new NotFoundError("goal", id);
            if (!row.archivedAt) {
                updated = row;
                return undefined;
            }
            updated = touch({ ...row, archivedAt: null }, device);
            return db.put(STORE.GOALS, updated);
        })
    );
    return updated;
}

/** The archived goals, newest archive first. Read through the `archivedAt` index
 *  rather than `getAll` + a filter, so a device with a hundred goals does not scan
 *  all of them to draw a page that shows three. */
export async function listArchivedGoals() {
    const rows = await withTx(STORE.GOALS, "readonly", (tx, db) =>
        db.byIndex(STORE.GOALS, "archivedAt")
    );
    return rows
        .filter(live)
        .sort((a, b) => b.archivedAt - a.archivedAt || (b.id < a.id ? -1 : 1));
}

/* -------------------------------------------------------------------------- */
/*                                goal references                              */
/* -------------------------------------------------------------------------- */

/**
 * What a goal draws its material from. A ROW PER (GOAL, GROUP) OR (GOAL, QUESTION),
 * and that is the whole of the relation between the four things.
 */
export async function listGoalRefs(goalId) {
    const rows = await withTx(STORE.GOAL_REFS, "readonly", (tx, db) =>
        db.byIndex(STORE.GOAL_REFS, "goalOrder", under(goalId))
    );
    return rows
        .filter(live)
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/**
 * The other direction: every goal that points at this group or this question.
 *
 * This is the query that makes a group a SHELF rather than a goal's private
 * classification, and it is what the group page reads before it offers to delete
 * one. A group two goals draw on cannot be deleted without saying so, and a question
 * in three goals cannot be removed from one of them without the other two noticing.
 */
export async function listRefsTo(refType, refId) {
    const rows = await withTx(STORE.GOAL_REFS, "readonly", (tx, db) =>
        db.byIndex(STORE.GOAL_REFS, "ref", IDBKeyRange.only([refType, refId]))
    );
    return rows.filter(live);
}

/**
 * Point a goal at a group or at a question.
 *
 * IDEMPOTENT, and deliberately so. This is called from a checkbox, a checkbox is
 * tapped more than once, and "attach, then attach again" that produced two rows
 * would put the same question into the goal's own material twice — which the
 * builder would have to de-duplicate, so the duplicate would become a rule in two
 * places. The existing reference is returned unchanged instead.
 */
export async function addGoalRef(goalId, refType, refId) {
    const existing = await listRefsTo(refType, refId);
    if (existing.some((ref) => ref.goalId === goalId)) return null;
    const siblings = await listGoalRefs(goalId);
    const device = await currentDeviceId();
    const record = touch({
        id: derivedId(GOAL_REF_PREFIX, goalId, refType, refId),
        goalId,
        refType,
        refId,
        order: siblings.reduce((max, r) => Math.max(max, r.order + 1), 0),
        createdAt: now(),
        deletedAt: null
    }, device);
    await withTx(STORE.GOAL_REFS, "readwrite", (tx, db) => db.put(STORE.GOAL_REFS, record));
    return record;
}

/**
 * Point a goal at MANY questions or one group at once.
 *
 * `addGoalRef` above is the single-reference write and everything it guarantees holds
 * here: the id is DERIVED from (goal, refType, refId), so two devices reaching the same
 * attachment independently produce the same row and the merge keeps one, and attaching
 * something twice is a no-op rather than a second row.
 *
 * IT EXISTS FOR THE ONE CALLER THAT HAS MORE THAN ONE THING TO ATTACH, which is a
 * question pack. Adding a set of twenty is twenty references, and through the single
 * write that is twenty transactions each re-reading the goal's whole reference list to
 * find the next `order` — and twenty moments in time in which a sync push carries half
 * the set. Here it is one transaction, one read of the table, and positions assigned
 * from one running maximum.
 *
 * THE WHOLE REFERENCE TABLE IS READ ONCE rather than `listRefsTo` per id, because the
 * idempotence check needs to know what this goal already has and the answer is in the
 * rows themselves. A device with a few hundred references reads them all in one indexed
 * sweep, which is cheaper than a hundred transactions and is a single moment — so a
 * reference cannot be written twice by a merge that arrived halfway through the read.
 *
 * @param {string} goalId
 * @param {string} refType
 * @param {string[]} refIds
 * @returns {Promise<object[]>} the rows this call wrote; the ones already there are not in it
 */
export async function addGoalRefs(goalId, refType, refIds) {
    const wanted = [...new Set((refIds ?? []).filter(Boolean))];
    if (!wanted.length) return [];

    const all = await listAllGoalRefs();
    const mine = new Set(
        all.filter((ref) => ref.goalId === goalId && ref.refType === refType).map((ref) => ref.refId)
    );
    const rows = all.filter((ref) => ref.goalId === goalId);
    let order = rows.reduce((max, r) => Math.max(max, r.order + 1), 0);

    const device = await currentDeviceId();
    const at = now();
    const written = [];

    await withTx(STORE.GOAL_REFS, "readwrite", (tx, db) => {
        const writes = wanted.filter((id) => !mine.has(id)).map((refId) => {
            const record = touch({
                id: derivedId(GOAL_REF_PREFIX, goalId, refType, refId),
                goalId,
                refType,
                refId,
                order: order++,
                createdAt: at,
                deletedAt: null
            }, device);
            written.push(record);
            return db.put(STORE.GOAL_REFS, record);
        });
        return Promise.all(writes);
    });

    return written;
}

/** Take a reference away. The question or group it named is NOT touched: a reference
 *  is a relationship, and removing a relationship destroys nothing. */
export async function removeGoalRef(id) {
    const device = await currentDeviceId();
    let updated = null;
    await withTx(STORE.GOAL_REFS, "readwrite", (tx, db) =>
        db.get(STORE.GOAL_REFS, id).then((row) => {
            if (!row || row.deletedAt) return undefined;
            updated = touch({ ...row, deletedAt: now() }, device);
            return db.put(STORE.GOAL_REFS, updated);
        })
    );
    return updated;
}

/** Every live reference on the device.
 *
 * ONE READ FOR THE WHOLE TABLE, and it exists for the screens that need a count
 * ACROSS goals rather than within one: "how many of my questions is any goal using?"
 * is a question about the collection, and asking it per row is one transaction per
 * row on a list that can hold two hundred. `listRefsTo` is the per-thing version and
 * is the right read when the thing is already named.
 */
export async function listAllGoalRefs() {
    const rows = await withTx(STORE.GOAL_REFS, "readonly", (tx, db) => db.getAll(STORE.GOAL_REFS));
    return rows.filter(live);
}

/**
 * Every reference a goal has, with what it points at resolved.
 *
 * The join is done HERE rather than by the pages, because the resolution has a rule
 * in it: a reference to a group whose questions are also referenced one by one must
 * not yield those questions twice. `questionsForGoal` in domain/goal-content.js
 * decides that; this only assembles the parts, and returns the groups and the
 * question ids separately so the caller can apply its own order and its own
 * de-duplication.
 *
 * A reference to something that has been deleted is DROPPED. It is not an error and
 * it is not a tombstone cascade: a sync merge that removes a group on one device
 * leaves the reference behind on the others, and a goal whose material list is
 * padded with ids nothing can resolve is a goal whose question count is a lie.
 *
 * @returns {Promise<{groups: object[], questionIds: string[]}>}
 */
export async function goalRefsFor(goalId) {
    const [refs, groups] = await Promise.all([listGoalRefs(goalId), listAllGroups()]);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const groupRefs = [];
    const questionIds = [];
    for (const ref of refs) {
        if (ref.refType === "group") {
            const group = byId.get(ref.refId);
            if (group) groupRefs.push(group);
        } else if (ref.refType === "question") {
            questionIds.push(ref.refId);
        }
    }
    return { groups: groupRefs, questionIds };
}
