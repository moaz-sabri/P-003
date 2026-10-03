// How many goals may be worked on at once, and what a closed one leaves behind.
//
// The limit and the successor are one design: three goals is what the home page can
// hold, and closing one of them has to put something in the slot it leaves or the
// reader is left with a list shorter than the app promised. So the arithmetic that
// decides whether a fourth goal may exist is separated from the read that counts the
// goals, and that is what these tests ask — `slotsFor` is pure, and the three numbers
// it returns are the same three every screen draws.
//
// What is NOT here is the write. Creating a goal, attaching a successor's material and
// archiving one all need IndexedDB, and there is no fake for it in this suite; what
// they all have in common is this function, and a bug in it would be a bug in all of
// them at once.

import test from "node:test";
import assert from "node:assert/strict";

import { slotsFor } from "../app/js/services/goal-service.js";
import { MAX_ACTIVE_GOALS } from "../app/js/config.js";

test("three goals at a time, and three is a number rather than a mood", () => {
    // A constant rather than a number written at each use: the list page draws it, the
    // create form refuses against it, and the successor checks it before writing. Three
    // of those disagreeing is three different limits.
    assert.equal(MAX_ACTIVE_GOALS, 3);
});

test("the count is an arithmetic fact, and nothing is full until it is", () => {
    assert.deepEqual(slotsFor(0), { used: 0, limit: 3, remaining: 3, full: false });
    assert.deepEqual(slotsFor(1), { used: 1, limit: 3, remaining: 2, full: false });
    assert.deepEqual(slotsFor(2), { used: 2, limit: 3, remaining: 1, full: false });
    assert.deepEqual(slotsFor(3), { used: 3, limit: 3, remaining: 0, full: true });
});

test("more goals than the limit is still reported honestly, and never goes negative", () => {
    // A sync merge can bring a goal written on another device, and a reader who
    // unarchives on one device while archiving on another can be briefly over. What
    // must not happen is `remaining` going below zero and a screen printing "−1 of 3
    // goals left"; the count is reported as it is and the refusal is the same one.
    const over = slotsFor(5);
    assert.equal(over.used, 5);
    assert.equal(over.remaining, 0);
    assert.equal(over.full, true);
});

test("a count that is not a count is zero, not a crash", () => {
    // `listActiveGoals().length` cannot be anything else, but the value crosses a
    // promise boundary and the list page draws it before anything else has run. A NaN
    // here would be `full: false` on a device with three goals, which is the one answer
    // that must never be invented.
    for (const bad of [undefined, null, NaN, -2, "two"]) {
        const slots = slotsFor(bad);
        assert.equal(slots.used, 0, `${String(bad)} became a count of goals`);
        assert.equal(slots.full, false);
    }
    // A fraction is rounded rather than kept: a length is whole, and `2.5 of 3` is a
    // sentence no page should have to print.
    assert.equal(slotsFor(2.5).used, 3);
});