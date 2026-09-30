// The few values that are the same everywhere, and the defaults a device starts
// with.
//
// Everything a release can change lives here rather than in the module that uses
// it, so `grep` for a number finds the one place it is defined. Two of them are
// checked by tests: APP_VERSION against package.json, and the service worker's
// cache name — a worker whose cache name does not move cannot evict the previous
// release, which is the bug that file's first comment is about.

export const DB_NAME = "recall";
export const DB_VERSION = 1;
export const APP_NAME = "Recall";
export const APP_VERSION = "1.0.0";

/* ------------------------------- identity ------------------------------- */

// 32 bytes of entropy. Not 16, and not 24: this single value is the user's only
// credential, the only thing standing between somebody with the database file
// and every question in it, and the only copy of itself. There is no recovery
// flow to fall back on, so the size is chosen for that rather than for
// convenience. See domain/secret-key.js for how it is written down.
export const SECRET_KEY_BYTES = 32;

/** Bumped when the stored key envelope changes shape. */
export const IDENTITY_VERSION = 1;

/* ------------------------------- the plan ------------------------------- */

// The defaults a goal form starts with. They are DEFAULTS and nothing else: the
// numbers are read from the goal record on every exercise, so changing them
// here changes what a new goal proposes and never what an existing one does.
export const DEFAULT_NEW_PER_EXERCISE = 5;
export const DEFAULT_REVIEW_DEPTH = 3;
export const DEFAULT_INTERVAL_DAYS = 1;

/**
 * How long a goal lasts, in days, when the form does not say otherwise.
 *
 * A goal is meant to be finished rather than kept forever — "learn 300 words in
 * three months" is a plan with an end — and the end is what stops the app asking
 * the same five questions for a year. Ninety days is the default because it is
 * long enough to see whether the plan is working and short enough that finishing
 * is a thing that happens. It is NOT a lock: a goal that runs out says so and
 * keeps everything, and the reader closes it and starts the next one.
 */
export const DEFAULT_DURATION_DAYS = 90;

/** How long before a backup file is considered stale, in days. */
export const BACKUP_REMINDER_DAYS = 30;

/* --------------------------------- sync --------------------------------- */

/**
 * Where the sync cursor and the sync settings live.
 *
 * Not here. They are `meta` keys, and the registry of `meta` keys is
 * data/stores.js — a misspelled key is a setting that silently never saves, and
 * two registries of the same strings is exactly how one of them drifts. The
 * numbers below are the tunables, which have no other home.
 */

/** Records per push request, and the loop cap on pulling pages back. */
export const SYNC_PUSH_BATCH = 100;
export const SYNC_PULL_LOOP_MAX = 50;

/** How often sync runs on its own while the app is open. */
export const SYNC_INTERVAL_MS = 30000;

/** How long after a local write before sync is asked to run. */
export const SYNC_EVENT_DEBOUNCE_MS = 5000;

/**
 * How long one HTTP request to the sync API may hang before it is given up on.
 *
 * This is not a politeness setting, it is the thing that keeps sync ALIVE. A
 * request that never settles — a captive portal that accepts the connection and
 * answers nothing, a half-open TCP connection, a phone that walks out of range
 * mid-request — leaves the sync run suspended forever, because the flag that
 * keeps two runs from overlapping is only released in the `finally` of a call
 * that never returns. Every later attempt then finds sync "busy" and does
 * nothing, silently, until the tab is reloaded. The interval keeps firing and
 * the app keeps showing "syncing" while nothing is being synced at all.
 *
 * 20s is well inside the server's own slow-path budget and well above a slow
 * connection, and the failure is mapped to the same `network` code a real network
 * error produces — so the backoff that already exists takes over unchanged.
 */
export const SYNC_REQUEST_TIMEOUT_MS = 20000;
