// The IndexedDB schema, and the one place a store or an index is born.
//
// Migrations are an append-only list. Nothing above version 1 may ever be
// edited: an IndexedDB upgrade only runs the steps whose version is above the
// version the database was opened at, so changing step 1 changes nothing for a
// browser that already ran it, and changes the schema for one that has not —
// which is the definition of a bug that only reproduces on other people's
// devices. A step is corrected by adding version 2.
//
// `stores.js` holds the SAME list of stores and indexes as a plain object, and
// tests/data.test.mjs compares the two. That test exists because this file is
// run by the browser and that one is not: an index added to the registry but
// forgotten here fails only as a slow query on a large goal, and the sync pull
// that needs it is the one that silently takes four seconds per page.

export const DB_VERSION = 1;

/** Bump when the shape of the stored key envelope changes; read back by
 *  services/crypto-service.js to refuse an envelope it cannot open. Mirrors
 *  IDENTITY_VERSION in config.js. */
const IDENTITY_STORE_VERSION = 1;

/* -------------------------------------------------------------------------- */
/*                                  migration 1                                 */
/* -------------------------------------------------------------------------- */

/**
 * Eight stores, grouped by what they mean rather than by when they were added.
 *
 * `goals` `questions` `options` `exercises` `exerciseItems` `attempts`
 *     the data. All of them are plain records with an `id`, and all of them
 *     carry `updatedAt`, `rev`, `device` and `dirty` for sync.
 *
 * `meta`
 *     one row per setting: language, sync cursor, sync configuration, the id of
 *     this device, the last time a backup was exported.
 *
 * `keys`
 *     the identity envelope — one row, holding a NON-EXTRACTABLE CryptoKey. It
 *     is a store of its own rather than a `meta` row because the two have
 *     opposite rules about what may be read: `meta` is free to be dumped into a
 *     bug report, and this may not.
 *
 * There is deliberately NO outbox store. The obvious design — a row per pending
 * write, in a store next to the records — has two writers for one fact, and the
 * fact is "has this record reached the server". A write that lands in the record
 * store and fails to reach the outbox (a crash between two transactions, a quota
 * error, an await that outlived the transaction) is a change that never syncs
 * and never says so; an outbox row whose record write was rolled back pushes a
 * record that does not exist. So each record carries its own `dirty` flag, set
 * inside the same transaction that writes it and cleared inside the transaction
 * that was acknowledged by the server, and there is exactly one place either can
 * be wrong.
 */
function migration1(db) {
    const goals = db.createObjectStore("goals", { keyPath: "id" });
    goals.createIndex("status", "status");
    goals.createIndex("updatedAt", "updatedAt");

    const questions = db.createObjectStore("questions", { keyPath: "id" });
    questions.createIndex("goalId", "goalId");
    questions.createIndex("goalOrder", ["goalId", "order"]);
    questions.createIndex("updatedAt", "updatedAt");

    const options = db.createObjectStore("options", { keyPath: "id" });
    options.createIndex("questionId", "questionId");
    options.createIndex("questionOrder", ["questionId", "order"]);
    options.createIndex("updatedAt", "updatedAt");

    const exercises = db.createObjectStore("exercises", { keyPath: "id" });
    exercises.createIndex("goalId", "goalId");
    exercises.createIndex("goalNumber", ["goalId", "number"]);
    exercises.createIndex("updatedAt", "updatedAt");

    const exerciseItems = db.createObjectStore("exerciseItems", { keyPath: "id" });
    exerciseItems.createIndex("exerciseId", "exerciseId");
    exerciseItems.createIndex("exerciseOrder", ["exerciseId", "order"]);
    // The reverse lookup that makes "which exercises contain this question"
    // answerable without reading every exercise on the device. It is the index
    // the sync merge and the delete-a-question path both need, and neither of
    // them is on a code path that is exercised by hand often enough to notice a
    // missing one.
    exerciseItems.createIndex("questionId", "questionId");
    exerciseItems.createIndex("updatedAt", "updatedAt");

    const attempts = db.createObjectStore("attempts", { keyPath: "id" });
    attempts.createIndex("exerciseId", "exerciseId");
    attempts.createIndex("questionId", "questionId");
    attempts.createIndex("answeredAt", "answeredAt");
    attempts.createIndex("updatedAt", "updatedAt");

    db.createObjectStore("meta", { keyPath: "key" });

    const keys = db.createObjectStore("keys", { keyPath: "id" });
    keys.createIndex("version", "version");
}

export const MIGRATIONS = [
    { version: 1, name: "initial", apply: migration1, identityVersion: IDENTITY_STORE_VERSION }
];

/* -------------------------------------------------------------------------- */
/*                                 shape of a row                               */
/* -------------------------------------------------------------------------- */

/**
 * Every synced record has the same five extra fields, whatever its own are.
 *
 *   updatedAt  epoch ms of the last local write. The sync merge takes the larger
 *              one, so this is the clock of the device that last touched it.
 *   rev        the server's revision, or 0 while the record has never been
 *              acknowledged. Only ever moved by the sync layer.
 *   device     a random id generated by this installation. The tie-break when two
 *              records have the same `updatedAt`: two phones writing inside the
 *              same millisecond is ordinary, and without a fixed order that
 *              comparison has to invent one from whatever order the two
 *              requests happened to arrive in, which means the two devices could
 *              keep disagreeing about the winner on every subsequent merge.
 *   dirty      0 or 1. Set in the same transaction as the write; cleared in the
 *              transaction that the server acknowledged.
 *   deletedAt  epoch ms, or absent. Deletion is a tombstone and not a removal,
 *              because a delete that does not travel reappears on the other
 *              device as if it never happened — and reappears silently, with the
 *              question back in the list.
 */
export const COMMON_FIELDS = ["updatedAt", "rev", "device", "dirty", "deletedAt"];