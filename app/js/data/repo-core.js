// What every repository needs and nothing else owns: this device's identity, the
// five sync fields, a tombstone filter, and the three tables that are not records
// the reader has (settings, key material, and the sync bookkeeping itself).
//
// WHY THIS IS A FILE. It used to be the top of `data/repos.js`, which was 1,496
// lines holding every read and every write for ten stores. That is not a size
// anybody objects to in itself — it is that a change to the sync merge and a change
// to the question editor were edits in the same file, four hundred lines apart, with
// no boundary between them. The split is by SUBJECT rather than by layer, so each
// file is one store's whole vocabulary and the imports say which store a caller is
// touching.
//
//   repo-core       this file — identity, `touch`, tombstones, meta, keys, sync
//   repo-goals      goals and the `goalRefs` join table
//   repo-questions  questions and their options
//   repo-groups     groups, the shelves
//   repo-sessions   exercises, their items, and the attempt log
//
// Two rules run through all five, and neither of them is a preference:
//
//   * NO REPOSITORY VALIDATES, AND NO REPOSITORY DERIVES. `createGoal` does not know
//     what a goal is allowed to look like, and `listAttempts` does not know what
//     "learned" means. Validation is domain/validation.js and the schedule and the
//     counts are domain/, and both are pure functions over plain objects — which is
//     why they can be tested without a browser and why the API can run the same ones.
//     A repository that started computing would be a place where the rule exists
//     twice and can disagree.
//
//   * DELETION IS A TOMBSTONE. `deletedAt` is set and the row is kept. A delete
//     that removed the row would be undone by the next sync, on the other device,
//     silently: the question would be back in the list with no way to tell that it
//     had ever been removed. So every read filters tombstones out and sync carries
//     them.
//
// Every write goes through `touch()`, which sets `updatedAt`, `dirty` and `device` in
// the SAME transaction as the record itself. That is the whole reason there is no
// outbox store: two writers for the same fact is a fact that will eventually disagree
// with itself.

import { withTx } from "./db.js";
import { META_KEY, STORE, KEY_IDENTITY } from "./stores.js";
import { newDeviceId, isId } from "../domain/id.js";
import { now } from "../domain/time.js";

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
 * `rev` is preserved rather than reset: it is the server's number, and zeroing it
 * would make the server re-issue a revision the pull cursor has already seen. A
 * locally created record has no `rev` at all and lands on 0, which is exactly what
 * "never acknowledged" means. */
export function touch(record, device) {
    return {
        ...record,
        updatedAt: now(),
        rev: record.rev ?? 0,
        device: device ?? record.device,
        dirty: 1
    };
}

/** `key` as an IDB range covering every composite-key row under it, i.e. every
 * `[goalId, order]` whatever the order is.
 *
 * The upper bound is `[key, []]` because IndexedDB compares arrays
 * lexicographically and an array sorts after every number — so `[goalId, 7]` is
 * below `[goalId, []]`, and the prefix `[goalId]` is below both. Written as
 * `IDBKeyRange.only(goalId)` this would match NOTHING, which is a mistake worth
 * naming: `only` compares the whole key, and the whole key is a pair. */
export function under(prefix) {
    return IDBKeyRange.bound([prefix], [prefix, []]);
}

/** The one predicate every read applies. Named because "and it is not a tombstone"
 * repeated in thirty places is thirty chances to forget it in one of them. */
export const live = (row) => row && !row.deletedAt;

/** Tombstone every live row of a store. Shared rather than written per store because
 *  "delete a cascade" is the same seven lines whatever it is cascading over, and
 *  three copies of it is two chances to write it with one store's tombstone left off. */
export function tombstoneAll(db, storeName, rows, device, at) {
    return Promise.all(rows.filter(live).map((row) =>
        db.put(storeName, touch({ ...row, deletedAt: at }, device))
    ));
}

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
