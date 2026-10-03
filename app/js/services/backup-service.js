// Creating the encrypted backup file, and reading one back.
//
// The format and the rules about what goes in it are domain/backup.js. This file
// is the three things that need a browser: the WebCrypto seal, the IndexedDB
// read and write, and the download.
//
// THE ORDER OF THE RESTORE, and it is not negotiable:
//
//   1. read the file's header, which is the only part not encrypted;
//   2. refuse it unless the space id is this device's;
//   3. decrypt, and refuse unless it decrypts AT ALL — `unseal` returns null for
//      a wrong key, a truncated file and a tampered byte, and all three are the
//      same message to the reader on purpose;
//   4. only then write. Nothing is written before the file is known to be this
//      device's own backup, because a restore is the one operation in this app
//      that overwrites data the reader can see with data they may be restoring
//      over the top of.
//
// Step 4 is also why the writes are chunked rather than done in one transaction.
// A restore is the only unbounded write in the app — a year of daily exercises is
// tens of thousands of rows — and a single IndexedDB transaction that long is
// closed by the browser partway through, which would leave the reader with a
// restore that reported success and a database that is half a backup. Each chunk
// is its own transaction and a chunk that throws stops the restore there, which is
// reported rather than hidden. Re-running it is safe: every write is a put keyed
// by the record's own id.

import { withTx } from "../data/db.js";
import { SYNCED_STORES, STORE } from "../data/stores.js";
import { currentDeviceId } from "../data/repo-core.js";
import { seal, unseal } from "./crypto-service.js";
import { getIdentity } from "./identity-service.js";
import { downloadFile, markBackup } from "./export-service.js";
import { ImportError } from "../domain/errors.js";
import { now } from "../domain/time.js";
import { APP_VERSION } from "../config.js";
import {
    BACKUP_AAD,
    BACKUP_FORMAT,
    BACKUP_MAX_CHARS,
    BACKUP_VERSION,
    backupFileName,
    countsOf,
    prepareForBackup,
    prepareFromBackup,
    readBackupHeader
} from "../domain/backup.js";

/** Records per transaction on the way back in. Small enough that no browser gives
 *  up, large enough that a thousand-row backup is one transaction rather than
 *  one. */
const WRITE_CHUNK = 2000;

/* --------------------------------- creating -------------------------------- */

/**
 * Everything, sealed, as the text of a file.
 *
 * Returns the string rather than downloading it, so the same function is what a
 * test exercises and what the button uses.
 *
 * @param {{spaceId: string, dek: CryptoKey, at?: number}} input
 */
export async function buildBackupText({ spaceId, dek, at = now() }) {
    const raw = await readAllStores(SYNCED_STORES);
    const { tables, skipped } = prepareForBackup(raw, SYNCED_STORES);
    const { counts, total } = countsOf(tables);

    const file = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        // The three fields that are safe in the clear. The space id is derived from
        // the key and identifies it without being it; the date and the app version
        // are what a person looks at when they have four of these in a folder and
        // cannot remember which is which.
        spaceId,
        createdAt: at,
        appVersion: APP_VERSION,
        counts,
        total,
        data: await seal(dek, { tables }, BACKUP_AAD)
    };
    if (skipped) file.skipped = skipped;

    return JSON.stringify(file);
}

/**
 * Every row of every named store, tombstones included.
 *
 * `Promise.all` rather than a loop that assigns into an object, and that is not a
 * style choice. `db.getAll` returns a PROMISE, so a loop that writes it straight
 * into the result object stores the promise, not the rows — and every store then
 * reads back as empty. That is not a crash: it is a backup file that is built,
 * sealed, downloaded, believed to hold the reader's questions, and restores
 * nothing at all. It is the worst shape a failure can take in this app, so the
 * shape is also checked below rather than trusted.
 */
async function readAllStores(storeNames) {
    const rows = await withTx(storeNames, "readonly", (tx, db) =>
        Promise.all(storeNames.map((name) => db.getAll(name)))
    );

    const out = {};
    for (let i = 0; i < storeNames.length; i++) {
        if (!Array.isArray(rows[i])) {
            // Refuse rather than export an empty database. A backup is the one file
            // the reader cannot make again from memory, and a silently empty one is
            // indistinguishable from a good one until the day they need it.
            throw new ImportError("backup_failed", `store ${storeNames[i]} did not read back`);
        }
        out[storeNames[i]] = rows[i];
    }
    return out;
}

/** Build the file and hand it to the browser. */
export async function downloadBackup() {
    const { spaceId, dek } = await getIdentity();
    const at = now();
    const text = await buildBackupText({ spaceId, dek, at });
    downloadFile(backupFileName(spaceId, at), text, "application/json");
    await markBackup();
    return { name: backupFileName(spaceId, at), bytes: text.length };
}

/* --------------------------------- reading --------------------------------- */

/**
 * A file's contents, decrypted, checked against this device, and ready to write.
 *
 * Nothing here touches the database. That separation is what lets the reader be
 * asked to confirm a restore they can still cancel: the expensive and fallible
 * part — the decryption — has already succeeded by the time anybody is shown
 * anything, and nothing has been written yet.
 *
 * @param {string} text
 * @returns {Promise<{spaceId: string, createdAt: number|null, counts: object, tables: object, skipped: number}>}
 */
export async function readBackupText(text) {
    if (typeof text !== "string" || text.length === 0) throw new ImportError("not_a_backup");
    if (text.length > BACKUP_MAX_CHARS) throw new ImportError("backup_too_large");

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new ImportError("not_a_backup", err);
    }

    const { spaceId, dek } = await getIdentity();
    const header = readBackupHeader(parsed, spaceId);

    const payload = await unseal(dek, parsed.data, BACKUP_AAD);
    // Null here is a wrong key, a truncated file, a byte somebody edited, or a
    // file that is a record envelope rather than a backup. The reader cannot tell
    // them apart from the file, and neither can this code, so they get one message.
    if (!payload || typeof payload !== "object") throw new ImportError("backup_unreadable");

    const device = await currentDeviceId();
    const { tables, skipped } = prepareFromBackup(payload.tables, SYNCED_STORES, { device, at: now() });
    const { counts, total } = countsOf(tables);
    if (!total) throw new ImportError("backup_empty");

    return {
        spaceId,
        createdAt: header.createdAt,
        appVersion: header.appVersion,
        counts: header.counts,
        tables,
        skipped
    };
}

/**
 * Write a prepared restore.
 *
 * Sequential, one chunked transaction at a time, and the count of what went in is
 * returned. Every row is a `put` under its own id, so a restore that is run twice
 * lands on the same database rather than doubling it.
 *
 * @param {Record<string, object[]>} tables
 */
export async function writeBackupTables(tables) {
    const device = await currentDeviceId();
    let written = 0;

    for (const name of SYNCED_STORES) {
        const rows = tables[name] ?? [];
        for (let at = 0; at < rows.length; at += WRITE_CHUNK) {
            const chunk = rows.slice(at, at + WRITE_CHUNK).map((row) => ({ ...row, device }));
            // Assigned here rather than in `prepareFromBackup` so that a restore
            // prepared by a screen which was then left open for a minute still goes
            // out under the device id of the moment it is written.
            await withTx(name, "readwrite", (tx, db) => {
                for (const row of chunk) db.put(name, row);
            });
            written += chunk.length;
        }
    }
    return written;
}

/**
 * The whole restore, for the one caller that has already confirmed.
 *
 * Reading and writing are separate functions above because the confirmation
 * belongs between them, not inside them.
 */
export async function restoreBackup(text) {
    const prepared = await readBackupText(text);
    const written = await writeBackupTables(prepared.tables);
    return { written, skipped: prepared.skipped, createdAt: prepared.createdAt, counts: prepared.counts };
}

/**
 * Read a `File` the reader chose.
 *
 * `.text()` rather than a reader stream: a backup is one document, it has to be
 * parsed in one piece anyway, and streaming JSON would add a decoder and a set of
 * partial-failure states to save a copy that a phone's memory has no trouble with.
 */
export async function readBackupFile(file) {
    if (!file) throw new ImportError("not_a_backup");
    return readBackupText(await file.text());
}

/** The record kinds in a backup, in the order a person would say them. Used to
 *  label the confirm dialog without hard-coding store names in the UI.
 *
 *  `goalRefs` is "attachment" rather than "reference" because that is the word the
 *  goal's content page uses for the rows, and a restore dialog is read by the same
 *  person who just tapped "attach". Every store in `SYNCED_STORES` appears here: a
 *  missing entry renders as an empty count, which reads as "this backup has none of
 *  these" rather than "this app forgot about these", and it is the `goalRefs` row
 *  that would go unmentioned — the one kind that is new and easy to leave out of a
 *  list copied from before it existed. */
export const BACKUP_STORE_LABELS = {
    [STORE.GOALS]: "goal",
    [STORE.QUESTIONS]: "question",
    [STORE.GROUPS]: "group",
    [STORE.OPTIONS]: "option",
    [STORE.EXERCISES]: "exercise",
    [STORE.EXERCISE_ITEMS]: "item",
    [STORE.ATTEMPTS]: "answer",
    [STORE.GOAL_REFS]: "attachment"
};
