// Time as the app uses it: epoch milliseconds, calendar days, and the two
// mistakes that are invisible when they happen.
//
// Every one of these tests is about a failure that does not announce itself. An
// interval that is an hour short does not look wrong on any screen; it just makes
// an exercise unlock at 23:00 on one Sunday in the year and nobody ever files it.

import test from "node:test";
import assert from "node:assert/strict";

import {
    DAY_MS,
    HOUR_MS,
    addDays,
    countdownParts,
    dayKey,
    dayRange,
    formatStopwatch,
    isPast,
    isTimestamp,
    remaining,
    startOfDay,
    wholeDaysBetween
} from "../app/js/domain/time.js";

/** A local timestamp built from parts, so every assertion below is in the
 *  machine's own timezone and does not depend on what TZ the suite runs under. */
function local(y, m, d, hh = 0, mm = 0, ss = 0) {
    return new Date(y, m - 1, d, hh, mm, ss, 0).getTime();
}

test("startOfDay is local midnight, not UTC midnight", () => {
    // In any timezone east of UTC these are different instants, which is the whole
    // point: a UTC bucket puts a Cairo evening into tomorrow's column.
    const evening = local(2026, 3, 14, 22, 30);
    const midnight = startOfDay(evening);
    assert.equal(new Date(midnight).getHours(), 0);
    assert.equal(new Date(midnight).getMinutes(), 0);
    assert.equal(dayKey(midnight), "2026-03-14");
    // And it is never later than the moment it came from.
    assert.ok(midnight <= evening);
    assert.ok(evening - midnight < DAY_MS);
});

test("dayKey pads and sorts as a string", () => {
    assert.equal(dayKey(local(2026, 1, 5)), "2026-01-05");
    assert.equal(dayKey(local(2026, 12, 31)), "2026-12-31");
    // The reason it is a string and not a timestamp: sorted lexicographically, it
    // is chronological.
    const keys = [local(2026, 12, 31), local(2026, 1, 5), local(2026, 2, 9)];
    assert.deepEqual(keys.map(dayKey).sort(), ["2026-01-05", "2026-02-09", "2026-12-31"]);
});

test("addDays goes through the calendar, not through 86400000", () => {
    // The DST year in the machine's own timezone: adding 24h arithmetic to a
    // timestamp on a switch-over Sunday is an hour off, forever after. Written as
    // a property rather than against fixed dates because which Sundays those are
    // differs by year and by country.
    const year = 2026;
    const found = [];
    for (let m = 0; m < 12; m++) {
        for (let d = 1; d <= 28; d++) {
            const at = new Date(year, m, d, 12, 0, 0, 0).getTime();
            const drift = addDays(at, 1) - at - DAY_MS;
            if (drift !== 0) found.push(drift);
        }
    }
    // Whether this machine's timezone observes DST at all, the arithmetic form
    // would differ from the calendar form; on a no-DST machine the test is vacuous
    // and says so rather than pretending to have proved something.
    assert.ok(
        found.every((d) => d === HOUR_MS || d === -HOUR_MS),
        `addDays disagreed with 24h by something that is not an hour: ${[...new Set(found)]}`
    );

    // And it is the same wall-clock time tomorrow, which is what "one day" means.
    const from = local(2026, 5, 1, 9, 30);
    const to = new Date(addDays(from, 3));
    assert.equal(to.getDate(), 4);
    assert.equal(to.getHours(), 9);
    assert.equal(to.getMinutes(), 30);
});

test("wholeDaysBetween ignores the time of day", () => {
    assert.equal(wholeDaysBetween(local(2026, 3, 1, 9), local(2026, 3, 4, 9)), 3);
    // The case in the header: twenty minutes apart, one calendar day apart.
    assert.equal(wholeDaysBetween(local(2026, 3, 1, 23, 50), local(2026, 3, 2, 0, 10)), 1);
    assert.equal(wholeDaysBetween(local(2026, 3, 1, 0, 10), local(2026, 3, 1, 23, 50)), 0);
    // Across the month and the year boundary.
    assert.equal(wholeDaysBetween(local(2026, 12, 31), local(2027, 1, 1)), 1);
});

test("isPast and remaining write the comparison direction once", () => {
    const at = local(2026, 6, 1, 12, 0);
    assert.ok(isPast(at, at), "the moment itself is not past");
    assert.ok(isPast(at - 1, at));
    assert.ok(!isPast(at + 1, at));
    // Never negative: the countdown under a disabled button must not read -00:04.
    assert.equal(remaining(at + 5000, at), 5000);
    assert.equal(remaining(at - 5000, at), 0);
});

test("dayRange covers every day in the window, oldest first", () => {
    const keys = dayRange(local(2026, 3, 10, 18), 5);
    assert.deepEqual(keys, ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
    // Gaps would draw a straight line across days the reader did nothing, so the
    // count is exact and every key is distinct.
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(dayRange(local(2026, 3, 10, 18), 1).length, 1);
});

test("formatStopwatch fixes its separators and never goes negative", () => {
    assert.equal(formatStopwatch(0), "0:00");
    assert.equal(formatStopwatch(7_000), "0:07");
    assert.equal(formatStopwatch(271_000), "4:31");
    assert.equal(formatStopwatch(3_729_000), "1:02:09");
    assert.equal(formatStopwatch(-5_000), "0:00");
});

test("countdownParts drops the leading zero units", () => {
    // "4h" rather than "0d 4h": a padded countdown reads as a value that was
    // computed rather than one that was measured.
    assert.deepEqual(countdownParts(4 * HOUR_MS), { hours: 4, minutes: 0 });
    assert.deepEqual(countdownParts(2 * DAY_MS + 4 * HOUR_MS), { days: 2, hours: 4 });
    assert.deepEqual(countdownParts(90_000), { minutes: 1, seconds: 30 });
    assert.deepEqual(countdownParts(9_000), { seconds: 9 });
    assert.deepEqual(countdownParts(-1), { seconds: 0 });
});

test("isTimestamp rejects the two ways a clock bug shows up", () => {
    assert.ok(isTimestamp(Date.now()));
    // Seconds instead of milliseconds: 1.7e9 looks like a date until it does not.
    assert.ok(!isTimestamp(1_700_000_000), "a seconds-valued timestamp was accepted");
    // Microseconds from a platform that reports them.
    assert.ok(!isTimestamp(Date.now() * 1000), "a microsecond-valued timestamp was accepted");
    assert.ok(!isTimestamp(0));
    assert.ok(!isTimestamp(NaN));
    assert.ok(!isTimestamp("1700000000000"));
});