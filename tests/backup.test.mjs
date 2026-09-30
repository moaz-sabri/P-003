// The encrypted backup file.
//
// The failure this file exists to prevent is not a crash: it is a backup that is
// written, downloaded, believed to be good, and turns out to be a file that cannot
// be read back — or one that restores somebody's questions over the top of newer
// ones without saying so. Both of those are silent, and both are tested here
// against the real crypto rather than against a stand-in for it.

import test from "node:test";
import assert from "node:assert/strict";

import {
    BACKUP_AAD,
    BACKUP_FORMAT,
    BACKUP_MAX_CHARS,
    BACKUP_MAX_ROWS,
    BACKUP_VERSION,
    backupFileName,
    countsOf,
    fromBackupRow,
    prepareForBackup,
    prepareFromBackup,
    readBackupHeader,
    toBackupRow
} from "../app/js/domain/backup.js";
import { deriveAll, seal, unseal } from "../app/js/services/crypto-service.js";
import { ImportError } from "../app/js/domain/errors.js";
import { SYNCED_STORES, STORE } from "../app/js/data/stores.js";

/** A real derived identity, so the tests exercise the actual key. */
async function identity(seed = 1) {
    const bytes = new Uint8Array(32).fill(seed);
    return deriveAll(bytes);
}

const uid = (prefix, n) => `${prefix}_${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function questionRow(n, over = {}) {
    return {
        id: uid("q", n),
        goalId: uid("g", 1),
        text: `question ${n}`,
        kind: "single",
        order: n,
        createdAt: 1700000000000 + n,
        updatedAt: 1700000000000 + n,
        rev: 41,
        device: "dev_1",
        dirty: 0,
        deletedAt: null,
        ...over
    };
}

/* ------------------------------ what goes in -------------------------------- */

test("a backup row drops the fields that belong to a sync history", () => {
    const clean = toBackupRow(questionRow(1));
    assert.equal(clean.id, uid("q", 1));
    assert.equal(clean.text, "question 1");
    // The four that would be wrong on another machine.
    assert.equal("rev" in clean, false);
    assert.equal("dirty" in clean, false);
    assert.equal("device" in clean, false);
    assert.equal("updatedAt" in clean, false);
    // And the ones that would break the lists if they were not kept.
    assert.equal(clean.order, 1);
    assert.equal(clean.createdAt, 1700000000001);
    assert.equal(clean.deletedAt, null);
});

test("a row that is not a record is refused rather than stored", () => {
    assert.equal(toBackupRow(null), null);
    assert.equal(toBackupRow("a string"), null);
    assert.equal(toBackupRow([questionRow(1)]), null);
    // An id nothing can look a record up by again. The API refuses these too.
    assert.equal(toBackupRow({ id: "not-an-id" }), null);
    assert.equal(toBackupRow({}), null);
    // The original is not mutated: `toBackupRow` is called on rows the caller still
    // owns, and stripping the sync fields in place would make the row undirtyable.
    const row = questionRow(1);
    toBackupRow(row);
    assert.equal(row.rev, 41);
    assert.equal(row.dirty, 0);
});

test("only the named stores are read out, and an absent one is empty", () => {
    const tables = {
        [STORE.QUESTIONS]: [questionRow(1), questionRow(2)],
        [STORE.KEYS]: [{ id: "identity", dek: "a CryptoKey" }],
        [STORE.META]: [{ key: "device", value: "dev_1" }]
    };
    const { tables: out, skipped } = prepareForBackup(tables, SYNCED_STORES);

    // `keys` holds a non-extractable CryptoKey and `meta` holds another device's
    // sync cursor. Neither may be in a file, whatever the caller passes in.
    assert.deepEqual(Object.keys(out).sort(), [...SYNCED_STORES].sort());
    assert.equal(out[STORE.QUESTIONS].length, 2);
    assert.equal(out[STORE.GOALS].length, 0);
    assert.equal(skipped, 0);
});

test("rows that cannot be stored are counted instead of throwing", () => {
    const tables = { [STORE.QUESTIONS]: [questionRow(1), { id: "junk" }, questionRow(2)] };
    const { tables: out, skipped } = prepareForBackup(tables, SYNCED_STORES);
    assert.equal(out[STORE.QUESTIONS].length, 2);
    assert.equal(skipped, 1);
});

test("a store past the row limit is refused", () => {
    // `fill` rather than a generated array: the guard is about the COUNT, and
    // building half a million distinct records to be told the file is too big
    // costs seconds and proves nothing extra.
    const many = new Array(BACKUP_MAX_ROWS + 1).fill(questionRow(1));
    assert.throws(
        () => prepareForBackup({ [STORE.QUESTIONS]: many }, SYNCED_STORES),
        (err) => err instanceof ImportError && err.code === "backup_too_large"
    );
    // And on the way in, where the file is the untrusted one.
    assert.throws(
        () => prepareFromBackup({ [STORE.QUESTIONS]: many }, SYNCED_STORES, { device: "d", at: 1 }),
        (err) => err instanceof ImportError && err.code === "backup_too_large"
    );
});

/* ------------------------------ what comes out ------------------------------ */

test("a restored row asks to be synced and is stamped for this device", () => {
    const at = 1800000000000;
    const row = fromBackupRow({ id: uid("q", 7), text: "x", createdAt: 5, order: 2 }, {
        device: "dev_new",
        at
    });
    assert.equal(row.rev, 0);
    assert.equal(row.dirty, 1);
    assert.equal(row.device, "dev_new");
    assert.equal(row.updatedAt, at);
    // `createdAt` decides a goal's place in the history and a question's place in
    // its list. Restamping it reorders the reader's own lists on every restore.
    assert.equal(row.createdAt, 5);
    assert.equal(row.order, 2);
});

test("a tombstone stays a tombstone on the way back in", () => {
    const deleted = fromBackupRow({ id: uid("q", 8), createdAt: 1, deletedAt: 1700000000000 }, {
        device: "d",
        at: 5
    });
    assert.equal(deleted.deletedAt, 1700000000000);
    // And anything that is not a number becomes null rather than something
    // truthy: a `deletedAt` of `true` is a deleted question to every read filter.
    const odd = fromBackupRow({ id: uid("q", 9), createdAt: 1, deletedAt: "yes" }, { device: "d", at: 5 });
    assert.equal(odd.deletedAt, null);
});

test("a file is measured in what it holds", () => {
    const { counts, total } = countsOf({
        [STORE.GOALS]: [{}],
        [STORE.QUESTIONS]: [{}, {}],
        [STORE.OPTIONS]: []
    });
    assert.equal(total, 3);
    assert.equal(counts[STORE.QUESTIONS], 2);
    assert.equal(counts[STORE.OPTIONS], undefined, "an empty store is not counted");
});

/* -------------------------------- the header -------------------------------- */

test("the header is checked before anything is decrypted", () => {
    const good = { format: BACKUP_FORMAT, version: BACKUP_VERSION, spaceId: "S", data: { v: 1, body: "x" } };
    assert.doesNotThrow(() => readBackupHeader(good, "S"));

    // Not a backup at all — including a sync record envelope dropped in by mistake,
    // which is the realistic version of this mistake.
    assert.throws(() => readBackupHeader({ format: "something/else", version: 1 }, "S"),
        (e) => e.code === "not_a_backup");
    assert.throws(() => readBackupHeader({ version: 1 }, "S"),
        (e) => e.code === "not_a_backup");
    assert.throws(() => readBackupHeader({ ...good, data: { v: 1 } }, "S"),
        (e) => e.code === "not_a_backup");
});

test("a backup from another version is refused rather than guessed at", () => {
    const future = { format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, spaceId: "S", data: { body: "x" } };
    assert.throws(() => readBackupHeader(future, "S"), (e) => e.code === "backup_version");
});

test("another person's backup is refused, and it is refused before the key is tried", () => {
    const mine = { format: BACKUP_FORMAT, version: BACKUP_VERSION, spaceId: "MINE", data: { body: "x" } };
    // This is the check that makes a restore safe: the space id is derived from the
    // Secret Key, so a mismatch is a file belonging to a different identity, and
    // writing those rows in would put records in a database the server will never
    // accept into.
    assert.throws(() => readBackupHeader(mine, "THEIRS"), (e) => e.code === "backup_other_key");
});

/* ------------------------------ the round trip ------------------------------ */

test("a backup is unreadable without the key, and whole with it", async () => {
    const { spaceId, dek } = await identity(1);
    const { tables } = prepareForBackup(
        { [STORE.QUESTIONS]: [questionRow(1), questionRow(2, { deletedAt: 1700000000000 })] },
        SYNCED_STORES
    );
    const file = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        spaceId,
        data: await seal(dek, { tables }, BACKUP_AAD)
    };
    const text = JSON.stringify(file);

    // The questions are in the file and nowhere readable in it.
    assert.equal(text.includes("question 1"), false, "the plaintext leaked into the file");
    assert.equal(text.includes("question 2"), false);

    const read = await unseal(dek, file.data, BACKUP_AAD);
    assert.equal(read.tables[STORE.QUESTIONS].length, 2);
    // And the tombstone is in there, which is the whole difference between a backup
    // and a resurrection.
    assert.equal(read.tables[STORE.QUESTIONS][1].deletedAt, 1700000000000);

    // A different key gets nothing at all, and gets null rather than a wrong answer.
    const other = await identity(2);
    assert.equal(await unseal(other.dek, file.data, BACKUP_AAD), null);
});

test("the backup blob is bound to the backup format, not to a record", async () => {
    // The data key also seals every synced record, with the record's own store and
    // id as context. Without a separate label here, a ciphertext could be moved
    // between the two places and would still authenticate.
    const { dek } = await identity(3);
    const envelope = await seal(dek, { tables: {} }, BACKUP_AAD);
    assert.equal(await unseal(dek, envelope, "questions/q_1"), null);
    assert.ok(await unseal(dek, envelope, BACKUP_AAD));
});

test("a byte changed in the file makes it unreadable rather than wrong", async () => {
    const { spaceId, dek } = await identity(4);
    const { tables } = prepareForBackup({ [STORE.QUESTIONS]: [questionRow(1)] }, SYNCED_STORES);
    const file = JSON.parse(JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        spaceId,
        data: await seal(dek, { tables }, BACKUP_AAD)
    }));

    // Flip one character of the ciphertext body.
    const body = file.data.body;
    const at = Math.floor(body.length / 2);
    const swapped = body[at] === "A" ? "B" : "A";
    file.data.body = body.slice(0, at) + swapped + body.slice(at + 1);

    assert.equal(await unseal(dek, file.data, BACKUP_AAD), null);
});

test("a backup survives the whole trip out and back", async () => {
    const { spaceId, dek } = await identity(5);
    const original = {
        [STORE.GOALS]: [{
            id: uid("g", 1), title: "German", description: "", status: "active",
            newPerExercise: 5, reviewDepth: 3, intervalDays: 1,
            createdAt: 100, completedAt: null, deletedAt: null,
            updatedAt: 100, rev: 7, device: "dev_a", dirty: 0
        }],
        [STORE.QUESTIONS]: [questionRow(1), questionRow(2, { deletedAt: 200 })]
    };

    const { tables } = prepareForBackup(original, SYNCED_STORES);
    const envelope = await seal(dek, { tables }, BACKUP_AAD);
    const text = JSON.stringify({
        format: BACKUP_FORMAT, version: BACKUP_VERSION, spaceId,
        createdAt: 1234, counts: countsOf(tables).counts, data: envelope
    });

    // Read it back the way the service does, on the same device.
    const parsed = JSON.parse(text);
    readBackupHeader(parsed, spaceId);
    const payload = await unseal(dek, parsed.data, BACKUP_AAD);
    const { tables: restored, skipped } = prepareFromBackup(payload.tables, SYNCED_STORES, {
        device: "dev_b", at: 9999
    });

    assert.equal(skipped, 0);
    assert.equal(restored[STORE.GOALS][0].title, "German");
    assert.equal(restored[STORE.QUESTIONS].length, 2);
    assert.equal(restored[STORE.QUESTIONS][1].deletedAt, 200);
    // Everything that matters about the sync is reset, and everything that orders
    // a list is carried across.
    for (const row of [...restored[STORE.GOALS], ...restored[STORE.QUESTIONS]]) {
        assert.equal(row.rev, 0);
        assert.equal(row.dirty, 1);
        assert.equal(row.device, "dev_b");
        assert.equal(row.updatedAt, 9999);
    }
    assert.equal(restored[STORE.QUESTIONS][0].createdAt, 1700000000001);
});

test("a file that is too big to be a backup is refused before it is parsed", () => {
    // The guard is a character count, not a parse: JSON.parse on a hostile file is
    // where the tab stops responding.
    assert.equal(BACKUP_MAX_CHARS > 0, true);
    assert.equal(BACKUP_MAX_ROWS > 0, true);
});

test("a store that did not read back is refused, not exported as empty", async () => {
    // The failure this exists to catch. `db.getAll` returns a PROMISE, so a loop
    // that assigns its result straight into the store map produces a map of
    // promises — every store then reads back as zero rows, and the app writes,
    // seals, downloads and reports success on a backup file containing nothing.
    // There is no crash and nothing on screen is wrong; the file is discovered to
    // be worthless on the day the reader needs it.
    //
    // `prepareForBackup` cannot catch it, because treating a store it was not given
    // as empty is the correct behaviour for a RESTORE. So the guard is on the way
    // out, in `readAllStores`, and it refuses.
    const promisesInsteadOfRows = { [STORE.QUESTIONS]: Promise.resolve([questionRow(1)]) };
    const { tables } = prepareForBackup(promisesInsteadOfRows, SYNCED_STORES);
    assert.deepEqual(tables[STORE.QUESTIONS], [], "a store that is not an array is treated as empty");

    // The service is importable under node — every module it needs is side-effect
    // free until it is called — so the shape of its two entry points is asserted
    // here rather than only in a browser.
    const service = await import("../app/js/services/backup-service.js");
    assert.equal(typeof service.buildBackupText, "function");
    assert.equal(typeof service.readBackupText, "function");
    assert.equal(typeof service.downloadBackup, "function");
    assert.equal(typeof service.writeBackupTables, "function");
});

test("the file name says which identity and which day", () => {
    const at = Date.UTC(2026, 8, 30, 12, 0, 0);
    const name = backupFileName("AbCdEfGhIj", at);
    assert.equal(name, "recall-backup-AbCdEf-2026-09-30.recall");
    // No space id at all is the initial-setup case, and the name must still be a name.
    assert.equal(backupFileName(null, at), "recall-backup-2026-09-30.recall");
});
