// The few values that are the same everywhere, and the defaults a device starts
// with.
//
// Everything a release can change lives here rather than in the module that uses
// it, so `grep` for a number finds the one place it is defined. Two of them are
// checked by tests: APP_VERSION against package.json, and the service worker's
// cache name — a worker whose cache name does not move cannot evict the previous
// release, which is the bug that file's first comment is about.

export const DB_NAME = "recall";
export const DB_VERSION = 5;
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

/* -------------------------------------------------------------------------- */
/*                                   exercises                                 */
/* -------------------------------------------------------------------------- */

/**
 * How many exercises ONE goal may START inside a rolling window, and how long
 * that window is.
 *
 * THE CAP IS ON THE RATE, NOT ON HOW MANY MAY BE OPEN, AND NOT ON HOW MANY GOALS
 * EXIST. It used to be one open exercise at a time, which meant a reader who wanted to
 * work through two sessions in one evening could not, and the only feedback was a
 * button that would not press. Several exercises may now be open at once; what is
 * bounded is how fast new ones can be started, which is the thing that actually
 * protects a reader from queueing forty sessions they will never reach.
 *
 * PER GOAL, NOT PER DEVICE. The allowance was one between all of the reader's goals,
 * which made a goal created this morning open on "the next one opens in 1d 12h" because
 * another goal had been worked hard — a sentence about somebody else's exercises,
 * printed above a Start button on a goal that had never been started. Three each is
 * also the only reading of the number that survives being drawn next to several goals.
 *
 * THREE IN TWO DAYS. Two is a real number rather than a round one, and it is the
 * smallest number that lets a reader finish a session on one evening and start the
 * next one after a day off — which is what `DEFAULT_INTERVAL_DAYS = 1` already
 * invites them to do. A cap of one would contradict the interval it sits beside.
 */
export const MAX_EXERCISES_PER_WINDOW = 3;

/** The window those three are counted over. A SLIDING window, not a calendar day:
 *  a calendar reset hands out five sessions to a reader who finished one at 23:50
 *  and started four at 00:05, which is the opposite of what the number is for. */
export const EXERCISE_WINDOW_DAYS = 2;

/**
 * How many goals may be worked on at once.
 *
 * THREE, AND NOT "AS MANY AS YOU LIKE". A goal is a plan with its own schedule, its
 * own exercises and its own report, and past three the home page stops being a page a
 * person reads: it becomes a list they scroll to find the one they meant. The cap is
 * what makes "the next exercise" on the home page an answer rather than a queue.
 *
 * IT IS NOT A QUOTA ON MATERIAL. Questions belong to no goal, so three goals and two
 * hundred questions is a perfectly ordinary device, and archiving or finishing one to
 * make room for another loses nothing at all.
 *
 * CLOSING A GOAL FREES A SLOT, and `goal-service`'s successor writes into it at once:
 * a reader who archives a goal to start another does not have to go and make one.
 */
export const MAX_ACTIVE_GOALS = 3;

/* -------------------------------------------------------------------------- */
/*                              goals and exercises                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether a goal may be closed while exercises of its own are still open.
 *
 * `false`, and it is a rule rather than a consequence. An open exercise belongs to
 * its goal's history: the report of that goal is where its attempts are counted
 * and where its questions were drawn from. Closing the goal would move the goal's
 * questions out of reach — "the question is not deleted with the goal" is the
 * rule this app now follows — while leaving the exercise behind with nowhere to
 * be resumed, so a reader halfway through would have to either abandon it or
 * reopen a goal they had finished on purpose.
 *
 * Archiving is the answer for a goal with open exercises, and it costs nothing:
 * the goal keeps its questions, its exercises and its report, and no new exercise
 * is built.
 */
export const CLOSE_REQUIRES_NO_OPEN_EXERCISES = true;

/**
 * Whether an exercise may be repeated on demand, with the same questions.
 *
 * `true`, and it is the default because "غلق بالاضافة، ويمكن إعادة التمرين بنفس
 * الكلمات متى شئت" is a requirement rather than a feature to be weighed. An
 * exercise is a set of questions, not a scarce event: a reader who wants to run
 * the same twenty questions again on Sunday has said something about how they
 * want to revise, and an app that says "come back in 14 days" has refused to read
 * it.
 *
 * A repeat is a NEW exercise with the SAME items — its own attempt log, its own
 * score, its own entry in the report. Re-opening the old record instead would
 * append the second sitting to the first one's log, so the exercise would show a
 * score over both and a first-try figure the reader cannot get back, which is the
 * one number on the result page that means anything.
 */
export const EXERCISES_ARE_REPEATABLE = true;

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
