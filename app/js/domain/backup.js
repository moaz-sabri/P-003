// The shape of the encrypted backup file.
//
// This file is the part of the backup that decides what goes in and what comes
// out, and it is pure: no IndexedDB, no WebCrypto, no DOM. That is not tidiness
// for its own sake — it is the only way the rules below can be tested at all, and
// the rules below are the whole risk of the feature. A restore writes whatever
// comes out of this file straight into the reader's database, so "what is in a
// backup" is a security question and not a formatting one.
//
// FOUR DECISIONS, and each of them is a decision somebody would get wrong:
//
//   1. THE BACKUP IS SEALED WITH THE DATA KEY ALREADY ON THIS DEVICE. Not with a
//      new key, and not with the Secret Key: `identity-service` throws the master
//      away after deriving, and this app has no way to get it back — not from the
//      database, not from the server, not from this file. The data key is the
//      one secret the device actually holds, and it is the same key every synced
//      record is sealed with, so it is present on any device that has imported
//      the Secret Key. That is also what makes the restore work: new phone,
//      import the key, import the file, done. No second secret to lose.
//   2. THE SYNC FIELDS ARE STRIPPED AND RE-STAMPED. `rev` is the server's number
//      and `dirty` is this device's bookkeeping; neither survives a move to
//      another machine. Restored rows are marked dirty on purpose, so a restored
//      backup pushes to the server and the other devices get it.
//   3. TOMBSTONES ARE KEPT. A row with a `deletedAt` is a deletion that happened
//      before the backup, and dropping it means the question comes back — on this
//      device and, once the restore pushes, on every other one. A backup that
//      cannot represent a delete is a backup that resurrects.
//   4. `meta` AND `keys` ARE NOT IN IT. `meta` is this device's settings, its sync
//      cursor and its device id — another machine's cursor is worse than none, and
//      the language is not the reader's business yet. `keys` holds a non-extractable
//      CryptoKey, which cannot be put in a file at all.
//
// The plaintext that gets sealed is the `tables` map. Everything else in the file
// is either the version or a number a person might want to see without a key.

import { isId } from "./id.js";
import { ImportError } from "./errors.js";

/** What a file says it is. Checked before anything is decrypted. */
export const BACKUP_FORMAT = "recall/backup";

/** The layout version. Bumped when the sealed plaintext changes shape, which is
 *  the only incompatibility worth refusing a file over — a newer version means a
 *  newer derivation or a new payload, and guessing at either loses data quietly. */
export const BACKUP_VERSION = 1;

/**
 * The additional authenticated data of the sealed blob.
 *
 * Its own label, and it has to be: the same data key seals every synced record
 * with the record's own store and id as context. Reusing that would mean a
 * ciphertext could be lifted out of one place and dropped into another — a
 * question body presented as a whole database, or a backup file's contents
 * replayed as a record — and AES-GCM authenticates the context for exactly this.
 */
export const BACKUP_AAD = `recall/backup/v${BACKUP_VERSION}`;

/** Records per store above which a file is refused rather than loaded. A personal
 *  flashcard set does not reach this; a file that does is either not a backup or
 *  is an attempt to make this device allocate until it fails. */
export const BACKUP_MAX_ROWS = 500000;

/** The largest file this will even attempt to parse, in characters. Roughly four
 *  times a 500k-row backup, which is generous, and it is checked BEFORE the JSON
 *  parse so a hostile file cannot make the tab unresponsive. */
export const BACKUP_MAX_CHARS = 64 * 1024 * 1024;

/**
 * The fields that describe a row's journey through SYNC rather than its content.
 *
 * They are the four that would be wrong on another device, and the two that would
 * be actively harmful: a restored `rev` from a different server history would make
 * the merge compare against a number nothing on this side has issued, and a
 * restored `dirty: 0` would leave the restored data sitting on this device with
 * no intention of ever going anywhere.
 */
const SYNC_FIELDS = ["rev", "dirty", "device", "updatedAt"];

/**
 * A row as it goes into a backup.
 *
 * A COPY, with the sync fields dropped and the identity fields kept. `id` is
 * checked rather than trusted: it is the one field nothing downstream can repair,
 * and a row without a usable one is not a row.
 */
export function toBackupRow(row) {
    if (!isRow(row) || !isId(row.id)) return null;
    const out = {};
    for (const [key, value] of Object.entries(row)) {
        if (SYNC_FIELDS.includes(key)) continue;
        out[key] = value;
    }
    return out;
}

/**
 * A row as it comes back out, re-stamped for this device.
 *
 * `rev: 0` and `dirty: 1` are the "never acknowledged, please send me" pair from
 * `repos.touch`, so a restore behaves like a very large local edit: the server
 * upserts it and hands back real revisions. `createdAt` is NOT touched — a
 * question's place in its goal and a goal's place in the history are both decided
 * by when it was created, and restamping that on restore reorders the reader's
 * own list every time they move phones.
 */
export function fromBackupRow(row, { device, at }) {
    if (!isRow(row) || !isId(row.id)) return null;
    const out = { ...row, updatedAt: at, rev: 0, dirty: 1, device };
    // `deletedAt` is meaningful and must stay a number or null; anything else is a
    // truthiness test waiting to resurrect a deleted question.
    if (typeof out.deletedAt !== "number") out.deletedAt = null;
    return out;
}

function isRow(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The whole `tables` map, in and out.
 *
 * Store names are taken from the CALLER'S list rather than from the file, so a
 * file cannot introduce a store this build has never heard of; and a store the
 * file has nothing for comes back as an empty array rather than being absent, so
 * the restore writes every store it means to write.
 *
 * @param {Record<string, object[]>} tables
 * @param {string[]} storeNames
 * @returns {{tables: Record<string, object[]>, skipped: number}}
 */
export function prepareForBackup(tables, storeNames) {
    const out = {};
    let skipped = 0;
    for (const name of storeNames) {
        const rows = Array.isArray(tables?.[name]) ? tables[name] : [];
        const kept = [];
        for (const row of rows) {
            const clean = toBackupRow(row);
            if (clean) kept.push(clean);
            else skipped += 1;
        }
        out[name] = kept;
        if (kept.length > BACKUP_MAX_ROWS) {
            throw new ImportError("backup_too_large", `${name}: ${kept.length}`);
        }
    }
    return { tables: out, skipped };
}

/**
 * The same, for a file being read.
 *
 * `skipped` is returned rather than thrown, and the caller shows it. A file with
 * one unusable row in it is still the reader's data, and refusing the whole
 * restore over it is worse than restoring the rest and saying so.
 */
export function prepareFromBackup(tables, storeNames, { device, at }) {
    const out = {};
    let skipped = 0;
    for (const name of storeNames) {
        const rows = Array.isArray(tables?.[name]) ? tables[name] : [];
        if (rows.length > BACKUP_MAX_ROWS) {
            throw new ImportError("backup_too_large", `${name}: ${rows.length}`);
        }
        const kept = [];
        for (const row of rows) {
            const restored = fromBackupRow(row, { device, at });
            if (restored) kept.push(restored);
            else skipped += 1;
        }
        out[name] = kept;
    }
    return { tables: out, skipped };
}

/** How many records of each kind a file holds, for the line under the file name. */
export function countsOf(tables) {
    const counts = {};
    let total = 0;
    for (const [name, rows] of Object.entries(tables)) {
        if (!Array.isArray(rows) || !rows.length) continue;
        counts[name] = rows.length;
        total += rows.length;
    }
    return { counts, total };
}

/**
 * The header of a file, checked before anything is decrypted.
 *
 * Order matters and is the order of the questions a reader would ask. Is this a
 * backup at all? Was it made by a version that speaks this shape? Is it for this
 * key? Each has its own message, because "that file could not be imported" for
 * all three is the answer that produces a support ticket.
 */
export function readBackupHeader(parsed, expectedSpaceId) {
    if (!isRow(parsed) || parsed.format !== BACKUP_FORMAT) {
        throw new ImportError("not_a_backup");
    }
    if (parsed.version !== BACKUP_VERSION) {
        throw new ImportError("backup_version", String(parsed.version));
    }
    // The space id is the one derived value that is safe to leave in the clear, and
    // it is the only thing in the file that can be checked without a key. A
    // mismatch means the file belongs to a different Secret Key, and restoring it
    // would write records the server will never accept into a database that is
    // supposed to be one person's.
    if (expectedSpaceId && parsed.spaceId !== expectedSpaceId) {
        throw new ImportError("backup_other_key");
    }
    if (!isRow(parsed.data) || typeof parsed.data.body !== "string") {
        throw new ImportError("not_a_backup");
    }
    return {
        spaceId: parsed.spaceId,
        createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : null,
        appVersion: typeof parsed.appVersion === "string" ? parsed.appVersion : null,
        counts: isRow(parsed.counts) ? parsed.counts : {}
    };
}

/**
 * The name of the file, which is the only part of a backup a reader will ever see
 * without a key. The space prefix is there so that a folder holding three of them
 * can be told apart, and it is six characters of a base64 id — enough to recognise,
 * not enough to be worth guessing at.
 */
export function backupFileName(spaceId, at, extension = "recall") {
    const stamp = new Date(at).toISOString().slice(0, 10);
    const prefix = spaceId ? `${String(spaceId).slice(0, 6)}-` : "";
    return `recall-backup-${prefix}${stamp}.${extension}`;
}
