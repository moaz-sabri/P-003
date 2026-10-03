// Getting the key OUT of the app.
//
// There is exactly one direction: the key is generated, shown, downloaded, and
// then it is not here any more. Nothing in this codebase can read the master back
// — data/crypto-service.js derives a non-extractable key from it and throws the
// bytes away — which is why the only screen that can produce a key file is the
// one that generates the key.
//
// The file is plain text, deliberately. A JSON file with a wrapper, or an
// encrypted export that needs a key to unlock, is a file the reader has to open in
// something and copy out of, at the one moment they are most likely to be doing
// something else. What they need is a file they can put in a cloud folder, mail
// to themselves, or read back off a printed page.
//
// What is NOT in the file is the master key material in a form anything else can
// use: it is the printable string, which is the same string shown on screen, and
// the sync space id as a comment so a person can tell which install a file came
// from when they have three of them.

import { SECRET_KEY_LENGTH, formatSecretKey, normalizeSecretKey } from "../domain/secret-key.js";
import { setMeta, getMeta } from "../data/repo-core.js";
import { META_KEY } from "../data/stores.js";
import { now, wholeDaysBetween } from "../domain/time.js";
import { BACKUP_REMINDER_DAYS } from "../config.js";

/**
 * Hand a file to the browser.
 *
 * An object URL and a synthetic click rather than `window.open`: a popup is
 * blocked unless it is in the click's own stack, and a data: URL of a key is a
 * key in a place the browser and the extension surface both treat casually. The
 * URL is revoked immediately after, which is the part that is easy to leave out —
 * a leaked object URL holds the blob alive for as long as the document is.
 */
export function downloadFile(filename, text, type = "text/plain;charset=utf-8") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked on the next turn of the event loop, not synchronously: revoking
    // before the click has been dispatched cancels the download in some engines.
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The key file's contents. */
export function keyFileText(secretKey, spaceId) {
    return [
        "# Recall — Secret Key",
        "#",
        "# This file is the whole of your account. There is no reset, no recovery",
        "# and no support that can restore it. Keep it somewhere other than this",
        "# device, and keep it somewhere you can read it.",
        "",
        `# Sync space: ${spaceId ?? ""}`,
        "",
        formatSecretKey(secretKey),
        ""
    ].join("\n");
}

export function keyFileName(spaceId) {
    const stamp = new Date(now()).toISOString().slice(0, 10);
    return `recall-key-${spaceId ? `${String(spaceId).slice(0, 6)}-` : ""}${stamp}.txt`;
}

/** Write the key file and remember when, which is what the reminder counts from. */
export async function exportKey(secretKey, spaceId) {
    downloadFile(keyFileName(spaceId), keyFileText(secretKey, spaceId));
    await markBackup();
}

/** When the key file was last downloaded, or null. */
export async function lastBackupAt() {
    const row = await getMeta(META_KEY.LAST_BACKUP_AT).catch(() => null);
    return Number.isFinite(row?.value) ? row.value : null;
}

export async function markBackup() {
    const at = now();
    await setMeta(META_KEY.LAST_BACKUP_AT, at).catch(() => {});
    return at;
}

/**
 * Whether the settings page should say something about the key file.
 *
 * Only when it was never downloaded, or when it has been a long time. The second
 * half is deliberately not a nag about the file being old — the file does not
 * expire — it is a reminder that the thing they would need if they lost this
 * device is a piece of paper rather than a copy of their data, which is true
 * however recently they put it somewhere safe.
 */
export async function needsBackupReminder(at = now()) {
    const last = await lastBackupAt();
    if (last === null) return true;
    return wholeDaysBetween(last, at) >= BACKUP_REMINDER_DAYS;
}

/**
 * Pull a key out of a file the reader chose. Accepts the file this app writes
 * AND a bare key typed somewhere else — because the most likely place for a key
 * to come from is a text message or a note, and a reader who has to move it into
 * a specific format first will not.
 *
 * `normalizeSecretKey` drops every character that is not part of a key, so a
 * file with a stray space, a lowercase key and a comment line at the top reduces
 * to the same string as the screen.
 */
export function keyFromText(text) {
    // THE FILE IS READ LINE BY LINE AND THE FIRST CANDIDATE WINS.
    //
    // This used to be a straight `normalizeSecretKey(text)` over the whole thing,
    // which is correct for a bare key and hopeless for the file this same module
    // writes: `# Recall — Secret Key` and `# This file is the whole of your
    // account` are both stripped down to sequences of letters, so pasting the
    // downloaded file produced a long string of the right alphabet and the wrong
    // length — refused as "not a valid key", with nothing on screen to say that
    // the reader did exactly what the app told them to. Stripping characters
    // cannot distinguish prose from a key; only lines can.
    //
    // `#` starts a comment, a blank line is skipped, and each remaining line is
    // normalised on its own and tried. Lines of exactly the right length are
    // preferred over longer ones, so a file whose prose happens to sit on one line
    // alongside the key still resolves — a bare paste and a pasted file both work,
    // and neither one is the case that has to be handled specially.
    const lines = String(text ?? "").split(/\r?\n/);
    const candidates = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;

        const clean = normalizeSecretKey(trimmed);
        if (clean.length === SECRET_KEY_LENGTH) return clean;
        if (clean.length > 0) candidates.push(clean);
    }

    // No exact line. A key pasted as one long run of groups, or wrapped by a client
    // that reflowed it, is still one key — so the whole non-comment text is tried
    // as a single string, which is what the original implementation did.
    const joined = normalizeSecretKey(
        lines.filter((line) => !line.trim().startsWith("#")).join("")
    );
    if (joined.length === SECRET_KEY_LENGTH) return joined;

    // Nothing of exactly the right length. Return the shortest candidate, so the
    // caller shows the reader something of the right shape rather than nothing.
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0] ?? "";
}