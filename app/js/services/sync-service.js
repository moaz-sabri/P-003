// Sync: the same data on two devices, and nothing the server can read.
//
// A run is three steps — open, push, pull — and every one of them can fail
// without the app caring, because the local database is the source of truth and
// not the server. A run that fails leaves the dirty flags exactly where they
// were, so the next run sends the same records again. That is the whole
// durability argument: there is no queue to lose, no acknowledgement to lose,
// and no state in which the server holds a record the device has forgotten.
//
// The four things that are easy to get wrong here, and are therefore written
// down rather than left to the shape of the code:
//
//   * THE `busy` FLAG MUST BE RELEASED IN A `finally`. It is set once at the top
//     and every path out of this function runs the same `finally`, including the
//     ones that throw. An early `return` before the flag is set is fine; a
//     missing release is not, and it turns sync into a no-op that the UI still
//     reports as running.
//
//   * A RUN IS TIMED OUT, NOT JUST FAILED. app/net.js gives every request a
//     deadline for exactly this reason: a connection that is accepted and then
//     answers nothing leaves the await suspended forever, the `finally` never
//     runs, and every later attempt finds the flag still set.
//
//   * THE BACKOFF IS ON `failures`, NOT ON THE CLOCK. A device that has been
//     offline for a week should try the moment it comes back, not wait out a
//     backoff that was earned while it was somewhere with no signal.
//
//   * AN UNREADABLE INCOMING RECORD IS SKIPPED, NOT APPLIED AND NOT DELETED. If
//     a record cannot be decrypted — it was sealed with a different key, or the
//     bytes came back truncated — the local copy is left alone. Overwriting it
//     with nothing would delete a question the reader still has.

import { request } from "../app/net.js";
import { seal, unseal, authKeyHex } from "./crypto-service.js";
import { getIdentity } from "./identity-service.js";
import { setState } from "../app/bus.js";
import { META_KEY, SYNCED_STORES } from "../data/stores.js";
import { listDirty, markPushed, applyRemote, getMeta, setMeta } from "../data/repos.js";
import { SYNC_PUSH_BATCH, SYNC_PULL_LOOP_MAX } from "../config.js";
import { SyncError } from "../domain/errors.js";
import { isId } from "../domain/id.js";

const SYNCED = new Set(SYNCED_STORES);

/** The two headers every call carries. Inlined into each request rather than
 *  passed around, and never written anywhere — the auth key is the one value in
 *  this file that must not appear in a log, a stack trace or an error message. */
function headersFor(identity) {
    return {
        "X-Space": identity.spaceId,
        "X-Key": authKeyHex(identity.authKey)
    };
}

/* ------------------------------- settings -------------------------------- */

const EMPTY_CONFIG = { enabled: false, baseUrl: "" };

/** Normalised into a same-origin PATH.
 *
 *  A reader typing "https://their-server.example" into a box is being kind, and
 *  it is the one path by which every question in this app could be sent to a
 *  host of their choosing. The API is mounted under this origin — that is what
 *  the same-origin policy and the CSP's `connect-src 'self'` already enforce —
 *  so the setting is trimmed to a path and anything else is refused rather than
 *  quietly rewritten. A trailing slash is removed so the paths built below never
 *  produce a double slash. */
export function normaliseBaseUrl(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
    if (!raw.startsWith("/")) return null;
    const withoutTrailing = raw.replace(/\/+$/, "");
    return withoutTrailing === "" ? "" : withoutTrailing;
}

export async function getConfig() {
    const stored = await getMeta(META_KEY.SYNC_CONFIG).catch(() => null);
    const config = { ...EMPTY_CONFIG, ...(stored?.value ?? {}) };
    return { ...config, baseUrl: normaliseBaseUrl(config.baseUrl) ?? "" };
}

/** @returns {Promise<{ok: boolean, config: object}>} ok is false when the URL
 *  was refused, which is a different thing from "saved". */
export async function setConfig(patch) {
    const current = await getConfig();
    const next = { ...current, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, "baseUrl")) {
        const normalised = normaliseBaseUrl(patch.baseUrl);
        if (normalised === null) return { ok: false, config: current };
        next.baseUrl = normalised;
    }
    await setMeta(META_KEY.SYNC_CONFIG, next);
    setState({ syncMode: next.enabled && next.baseUrl ? "on" : "off" });
    return { ok: true, config: next };
}

export async function isReady() {
    const config = await getConfig();
    if (!config.enabled || !config.baseUrl) return false;
    try {
        await getIdentity();
        return true;
    } catch {
        return false;
    }
}

/* --------------------------------- state --------------------------------- */

let running = false;
let failures = 0;
let blockedUntil = 0;

export function isSyncing() {
    return running;
}

async function readCursor() {
    const stored = await getMeta(META_KEY.SYNC_CURSOR).catch(() => null);
    const value = stored?.value ?? {};
    return { rev: Number.isFinite(value.rev) ? value.rev : 0 };
}

async function writeCursor(rev) {
    await setMeta(META_KEY.SYNC_CURSOR, { rev });
}

/** How many records are waiting to go out, for the settings page and the home
 *  screen. Counts all six stores rather than the one the next push would read,
 *  because "4 waiting" must not turn into "0 waiting" while three stores' worth
 *  is still unsent because the push loop stopped at the batch boundary. */
export async function pendingCount() {
    let total = 0;
    for (const store of SYNCED_STORES) {
        total += (await listDirty(store, Number.MAX_SAFE_INTEGER)).length;
    }
    setState({ syncPending: total });
    return total;
}

/* ---------------------------------- run ---------------------------------- */

/**
 * One sync run.
 *
 * @param {{reason?: string}} [options] recorded nowhere but the console's
 *   absence — nothing here logs, because nothing here may.
 * @returns {Promise<{ok: boolean, reason?: string, pushed?: number, pulled?: number}>}
 */
export async function syncNow({ reason = "manual" } = {}) {
    if (running) return { ok: false, reason: "busy" };
    if (Date.now() < blockedUntil) return { ok: false, reason: "backoff" };

    const config = await getConfig();
    if (!config.enabled || !config.baseUrl) return { ok: false, reason: "off" };

    let identity;
    try {
        identity = await getIdentity();
    } catch {
        return { ok: false, reason: "no_identity" };
    }

    running = true;
    setState({ syncStatus: "running", syncError: null });

    try {
        // Opening first. It is the cheapest way to find out that this server does
        // not know this space, or that the key is wrong — and finding that out
        // before pushing turns "why did my questions not arrive" from a mystery
        // into one message.
        await request(`${config.baseUrl}/api/space/open`, {
            method: "POST",
            headers: headersFor(identity)
        });

        const pushed = await pushAll(config, identity);
        const pulled = await pullAll(config, identity);

        failures = 0;
        blockedUntil = 0;
        const lastSyncAt = Date.now();
        setState({ syncStatus: "ok", syncError: null, lastSyncAt });
        await setMeta(META_KEY.SYNC_LAST_AT, lastSyncAt).catch(() => {});
        return { ok: true, pushed, pulled };
    } catch (err) {
        const code = err instanceof SyncError ? err.code : "sync_failed";
        failures += 1;
        // Exponential, capped at five minutes. See the header: the point is that
        // the FIRST failure backs off far enough to stop hammering and the count
        // resets on any success, so a device that comes back online does not
        // wait out a penalty earned somewhere it had no signal.
        const wait = Math.min(5 * 60 * 1000, 2 ** failures * 3000);
        blockedUntil = Date.now() + wait;
        setState({ syncStatus: "error", syncError: code });
        return { ok: false, reason: code };
    } finally {
        // Before anything else, and unconditionally. See the header.
        running = false;
        await pendingCount().catch(() => {});
    }
}

async function pushAll(config, identity) {
    let pushed = 0;
    for (const store of SYNCED_STORES) {
        for (let round = 0; round < SYNC_PULL_LOOP_MAX; round++) {
            const dirty = await listDirty(store, SYNC_PUSH_BATCH);
            if (!dirty.length) break;

            const records = [];
            for (const row of dirty) {
                records.push({
                    store,
                    id: row.id,
                    // The one plaintext field in the envelope. The server needs it
                    // to stop sending a tombstone it can recognise; everything
                    // else about the record — including whether it is a question
                    // or an exercise — is inside the ciphertext.
                    deleted: row.deletedAt ? 1 : 0,
                    body: await seal(identity.dek, row, `${store}:${row.id}`)
                });
            }

            const answer = await request(`${config.baseUrl}/api/sync/push`, {
                method: "POST",
                headers: headersFor(identity),
                body: { records }
            });

            const acks = Array.isArray(answer?.acks) ? answer.acks : [];
            // The acknowledgement is applied per store, because that is the unit
            // the dirty flag lives in. Acknowledging a record by id alone would
            // need a lookup, and a lookup that cannot find the row is a record
            // that stays dirty forever.
            const mine = acks
                .filter((ack) => ack && ack.store === store && isId(ack.id))
                .map((ack) => ({ id: ack.id, rev: Number(ack.rev) || 0 }));
            const cleared = await markPushed(store, mine);
            pushed += cleared;

            // Nothing acknowledged means the server did not take the batch. Two
            // rounds of that is enough to conclude it is not going to, and
            // looping SYNC_PULL_LOOP_MAX times on a server that answers 200 with
            // an empty ack list is a busy loop with a network round trip in it.
            if (!cleared) break;
            if (dirty.length < SYNC_PUSH_BATCH) break;
        }
    }
    return pushed;
}

async function pullAll(config, identity) {
    let cursor = await readCursor();
    let pulled = 0;

    for (let round = 0; round < SYNC_PULL_LOOP_MAX; round++) {
        const answer = await request(`${config.baseUrl}/api/sync/pull`, {
            method: "POST",
            headers: headersFor(identity),
            body: { since: cursor.rev, limit: SYNC_PUSH_BATCH }
        });

        const records = Array.isArray(answer?.records) ? answer.records : [];
        if (!records.length) break;

        // Grouped by store so that each store is written in ONE transaction. A
        // record at a time would be correct and would also take twenty
        // transactions for one page on a device that has to write to a phone's
        // flash mid-exercise.
        const byStore = new Map();
        for (const envelope of records) {
            if (!envelope || !SYNCED.has(envelope.store)) continue;
            if (!isId(envelope.id)) continue;

            const plain = await unseal(identity.dek, envelope.body, `${envelope.store}:${envelope.id}`);
            // Skipped, not applied: see the header. An unreadable record must not
            // be able to delete the local copy of itself.
            if (!plain || plain.id !== envelope.id) continue;

            const record = { ...plain, rev: Number(envelope.rev) || plain.rev || 0 };
            if (!byStore.has(envelope.store)) byStore.set(envelope.store, []);
            byStore.get(envelope.store).push(record);
        }

        for (const [store, rows] of byStore) {
            await applyRemote(store, rows);
            pulled += rows.length;
        }

        const nextRev = Number(answer.rev);
        // The cursor only ever moves FORWARD and only to a revision the server
        // named. A response whose `rev` is missing or smaller leaves the cursor
        // where it was, which costs one repeated page on the next run and nothing
        // worse — whereas a cursor that jumped ahead would silently skip every
        // record in between, and a skipped record is data that does not exist on
        // this device and never arrives.
        if (Number.isFinite(nextRev) && nextRev > cursor.rev) {
            cursor = { rev: nextRev };
            await writeCursor(cursor.rev);
        }

        if (answer.more !== true) break;
    }

    return pulled;
}

/** Forget the failure count — after a manual sync, or a settings change, the
 *  backoff earned by the previous configuration is not owed to this one. */
export async function resetBackoff() {
    failures = 0;
    blockedUntil = 0;
}