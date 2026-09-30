// When to sync without being asked.
//
// Sync is optional and must never be in the way, so this file does the smallest
// possible thing: a debounce after a local write, an interval while the tab is
// open, and an attempt when the tab comes back to the foreground. There is no
// write queue here — the dirty flags on the records ARE the queue (see
// data/repos.js), so a run that never happens costs a run, not data.
//
// Three things it deliberately does not do:
//
//   * It does not sync on `unload`. The event does not reliably fire on a phone
//     being swiped away, the payload would have to be built in a handler with no
//     time left, and every record is already on disk. Sync on the next open.
//
//   * It does not sync while the tab is hidden. A background timer that fires on a
//     phone is a timer that fires on battery, on a metered connection, and at
//     three in the morning. The records wait.
//
//   * It does not retry on a schedule of its own. The backoff lives in
//     sync-service.js, because a failure count that lived here would be reset by
//     every navigation.

import { syncNow } from "../services/sync-service.js";
import { SYNC_INTERVAL_MS, SYNC_EVENT_DEBOUNCE_MS } from "../config.js";

let debounceTimer = null;
let intervalTimer = null;
let started = false;

/**
 * Tell the scheduler a record changed. Called by the repositories that write —
 * through the bus rather than by importing this, so that a repository has no
 * opinion about whether a network is involved.
 */
export function notifyWrite() {
    if (!started) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    // A batch of questions added one at a time is ten writes in two seconds, and
    // ten sync runs would be ten full push/pull cycles for the same records.
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        syncNow({ reason: "write" }).catch(() => {});
    }, SYNC_EVENT_DEBOUNCE_MS);
}

/** Start the scheduler. Safe to call once; calling it twice would leave two
 *  intervals fighting over the same `running` flag in sync-service. */
export function startFlush() {
    if (started) return;
    started = true;

    intervalTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
            syncNow({ reason: "interval" }).catch(() => {});
        }
    }, SYNC_INTERVAL_MS);

    document.addEventListener("visibilitychange", () => {
        // Coming back is the moment a run is most likely to succeed and most
        // likely to be free: the reader has just opened the app and is looking at
        // it. One attempt, not a burst.
        if (document.visibilityState === "visible") {
            syncNow({ reason: "visible" }).catch(() => {});
        }
    });

    window.addEventListener("online", () => {
        syncNow({ reason: "online" }).catch(() => {});
    });
}

export function stopFlush() {
    started = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    debounceTimer = null;
    intervalTimer = null;
}