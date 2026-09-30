// Time as the app actually needs it: a number, and the rules about how that
// number moves.
//
// Two decisions live here rather than at the call sites, because getting either
// of them wrong is invisible and permanent:
//
//   1. EVERY TIMESTAMP IS EPOCH MILLIECONDS. Not seconds, not an ISO string. The
//      mixing is the bug: a schedule computed in seconds against a date written
//      in milliseconds is 1970 plus fifty years, which does not look like a
//      units bug anywhere — it looks like a database that was imported from
//      another app. One type, one unit, everywhere.
//   2. DAYLIGHT SAVING IS NOT 24 HOURS. `intervalDays` is in *calendar* days, so
//      adding it has to go through the Date constructor and not through
//      arithmetic on the epoch value. A user in Cairo or Berlin who sets a
//      one-day interval would otherwise get their next exercise one hour early
//      in summer and one hour late in winter, and since the shift is exactly
//      the same size as the hour nobody ever reports it.
//
// Formatting is deliberately NOT here. `countdownParts` and friends return
// plain numbers; the words, the locale and the Arabic abbreviations live in
// i18n/i18n.js, which keeps this file pure arithmetic and therefore testable
// under `node --test` without a DOM or an Intl dependency.

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The clock, behind a function so tests can pass their own. */
export function now() {
    return Date.now();
}

/**
 * Midnight local time of the day `ts` falls in.
 *
 * Local, not UTC, on purpose: the daily activity bar in a report has to line up
 * with the user's own notion of "today", and a UTC bucket puts an evening in
 * Cairo into tomorrow's column.
 */
export function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** "YYYY-MM-DD" in local time. Sortable as a string, which is what the daily
 *  series relies on instead of comparing timestamps day by day. */
export function dayKey(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `ts` plus a number of calendar days.
 *
 * Through the Date constructor, for the DST reason in the header. A day is "the
 * same time tomorrow", not "86400000 milliseconds later"; on the two switch-over
 * Sundays of the year those are an hour apart, and the one that matters is the
 * one that makes an exercise unlock at 23:00.
 */
export function addDays(ts, days) {
    const d = new Date(ts);
    d.setDate(d.getDate() + days);
    return d.getTime();
}

/** Whole days between two instants, floored, ignoring the time of day. Both
 *  ends are pushed back to midnight first so 23:50 → 00:10 the next morning
 *  counts as the day it actually is. */
export function wholeDaysBetween(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

/** Whether a moment has arrived. Every "is it time yet" check goes through here
 *  so the comparison direction is written once. */
export function isPast(ts, at = Date.now()) {
    return ts <= at;
}

/** Milliseconds left, never negative — the countdown under a locked button must
 *  not show `-00:04`. */
export function remaining(until, at = Date.now()) {
    return Math.max(0, until - at);
}

/** The last `days` day keys ending with the day `at` falls in, oldest first. */
export function dayRange(at, days) {
    const out = [];
    let cursor = startOfDay(at);
    for (let i = days - 1; i >= 0; i--) out.push(dayKey(addDays(cursor, -i)));
    return out;
}

/**
 * A stopwatch reading: "0:07", "4:31", "1:02:09".
 *
 * Deliberately locale-free and fixed at the separators. This one is a running
 * value that replaces itself in place several times a minute, and a locale that
 * spells a minute as "د 7" would change the string's width on every tick and
 * push the layout around it.
 */
export function formatStopwatch(ms) {
    const total = Math.max(0, Math.floor(ms / SECOND_MS));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * A countdown broken into units, largest non-zero unit first.
 *
 * Returns numbers rather than a string so the caller chooses the words. An
 * English "2d 4h" and an Arabic one do not have the same units in the same
 * order, and a formatter that hard-codes either pair of them pushes that choice
 * into every caller that ever grows a second one.
 *
 * The unit list is only as long as it needs to be: "4h" reads better than
 * "0d 4h", and padding a countdown with a zero makes it look like a value that
 * was computed rather than one that was measured.
 */
export function countdownParts(ms) {
    const total = Math.max(0, Math.floor(ms / SECOND_MS));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    if (days > 0) return { days, hours };
    if (hours > 0) return { hours, minutes };
    if (minutes > 0) return { minutes, seconds };
    return { seconds };
}

/** The units of a countdown, largest first, as `["days", "hours"]`. Used by the
 *  formatter so both sides walk the same order. */
export const COUNTDOWN_UNITS = ["days", "hours", "minutes", "seconds"];

/** Whether a timestamp is a plausible record of a real moment: a finite number,
 *  non-zero, and inside a range that cannot be a units mistake. The window is
 *  2000 → 2100 — which rejects a seconds-valued timestamp from 1970 and a
 *  microsecond-valued one from the far future, the two ways a bug in this app's
 *  clock actually shows up in a record. */
export function isTimestamp(value) {
    return Number.isFinite(value)
        && value >= Date.UTC(2000, 0, 1)
        && value < Date.UTC(2100, 0, 1);
}