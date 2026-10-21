// When the next exercise may be started.
//
// This is a state machine and not a date comparison, and the test that matters is
// the one where the clock says yes and the answer is still no: an exercise that
// was started and abandoned must be resumed, never replaced. The failure is a
// reader who answers eleven of twenty questions, closes the app for a week, comes
// back, and finds a brand new exercise built from questions they had already seen
// while the first one is still sitting there at 55%.
//
// There is no interval in this state machine, and deliberately: the plan is a fixed
// ten new items plus a review of the last three exercises, whatever day it is, so an
// exercise finished a minute ago does not lock the goal and one from last week does
// not unlock it. An active goal is only ever withheld by the rate cap, and the two
// states that end a goal are the reader's own doing — closing it or archiving it.

import test from "node:test";
import assert from "node:assert/strict";

import {
    SCHEDULE,
    canStartNewExercise,
    latestExercise,
    latestFinished,
    openExercises,
    planSchedule
} from "../app/js/domain/schedule.js";
import { exerciseQuota } from "../app/js/domain/exercise-builder.js";

const GOAL = { id: "g1", status: "active" };
const DAY = 86400000;

/** One exercise. `done` is how many days ago it was finished; `null` leaves it
 *  open, which is the case the state machine used to get wrong. */
const exercise = (number, { done = null, created = 30 } = {}) => ({
    id: `e${number}`,
    goalId: "g1",
    number,
    createdAt: Date.now() - created * DAY,
    completedAt: done === null ? null : Date.now() - done * DAY,
    deletedAt: null
});

test("a device with no goal is its own state", () => {
    // Not an absence of a goal but a state, because the home page has to say
    // something different about "you have not started" and "you have finished".
    const plan = planSchedule({ goal: null, exercises: [] });
    assert.equal(plan.state, SCHEDULE.NO_GOAL);
    assert.ok(!canStartNewExercise(plan));
});

test("a goal with nothing exercised is ready", () => {
    const plan = planSchedule({ goal: GOAL, exercises: [] });
    assert.equal(plan.state, SCHEDULE.READY);
    assert.ok(canStartNewExercise(plan));
});

test("a completed goal builds nothing, whatever the clock says", () => {
    const plan = planSchedule({
        goal: { ...GOAL, status: "completed" },
        exercises: [],
        now: Date.now() + 365 * DAY
    });
    assert.equal(plan.state, SCHEDULE.COMPLETED);
    assert.ok(!canStartNewExercise(plan), "a completed goal offered another exercise");
});

test("an open exercise is reported, and does not block a new one", () => {
    // THE test, and it is the inverse of what it used to assert. There used to be an
    // `IN_PROGRESS` state meaning "an exercise is open, so no second one may be
    // built", and it made a reader who wanted to work through two sessions in one
    // evening unable to — with the only feedback a button that would not press.
    //
    // An open exercise is now a FACT about the goal, reported in `plan.open`, and
    // what bounds a reader queueing forty sessions is the rate cap rather than a
    // lock they cannot see the reason for.
    const stale = {
        id: "e1",
        goalId: "g1",
        number: 1,
        createdAt: Date.now() - 31 * DAY,
        completedAt: null
    };
    const plan = planSchedule({ goal: GOAL, exercises: [stale], now: Date.now() });
    assert.equal(plan.state, SCHEDULE.READY);
    assert.deepEqual(plan.open.map((e) => e.id), ["e1"], "the open exercise was not reported");
    assert.ok(canStartNewExercise(plan), "an open exercise still blocks a second one");

    // Several at once, newest first — a reader with three sessions in front of them
    // has three things, and a card offering one is wrong two times out of three.
    const three = planSchedule({
        goal: GOAL,
        exercises: [exercise(1), exercise(2), exercise(3)],
        now: Date.now()
    });
    assert.deepEqual(three.open.map((e) => e.number), [3, 2, 1]);
    assert.ok(canStartNewExercise(three), "three open exercises still block a fourth");
});

test("the cap is what refuses, and it is the caller's quota", () => {
    // The cap is over the exercises of ONE goal, so `planSchedule` takes it as an
    // argument rather than deriving it: a goal with three fresh exercises of its own
    // and no quota offered is READY; the same three put through the cap are
    // RATE_LIMITED.
    const three = [exercise(1, { created: 0.2 }), exercise(2, { created: 0.6 }), exercise(3, { created: 1.1 })];
    assert.equal(planSchedule({ goal: GOAL, exercises: three }).state, SCHEDULE.READY);

    const blocked = planSchedule({ goal: GOAL, exercises: three, quota: exerciseQuota(three) });
    assert.equal(blocked.state, SCHEDULE.RATE_LIMITED);
    assert.ok(!canStartNewExercise(blocked));
    assert.ok(blocked.quota.retryAt > 0, "a refusal with no date to wait for");
    // The open ones are still reported: being over the cap says nothing about the
    // sessions already in progress.
    assert.deepEqual(blocked.open.length, 3);

    // And a quota with room does not refuse, so a stale quota from a page that was
    // left open cannot lock a reader out of an exercise the cap has since cleared.
    assert.equal(planSchedule({ goal: GOAL, quota: exerciseQuota([]) }).state, SCHEDULE.READY);
});

test("a goal with no exercises of its own inherits nothing and is ready", () => {
    // THE REPORTED BUG, stated as the rule that prevents it. The allowance used to be
    // counted over every exercise on the device, so a goal created this morning —
    // with none of its own — inherited another goal's spent cap and refused for work
    // it had not done. The two halves of the fix, in the order they matter: the quota
    // a goal is handed is counted from ITS OWN exercises, and a goal with none has
    // nothing to be refused for.
    const fresh = planSchedule({ goal: { ...GOAL, id: "g2" }, exercises: [], quota: exerciseQuota([]) });
    assert.equal(fresh.state, SCHEDULE.READY);
    assert.ok(canStartNewExercise(fresh));

    // Its own three exercises DO refuse it, which is the difference between a cap and
    // a shared budget: the number is the same either way, and what it is counting is
    // not.
    const own = [exercise(1, { created: 0.2 }), exercise(2, { created: 0.6 }), exercise(3, { created: 1.1 })];
    assert.equal(
        planSchedule({ goal: GOAL, exercises: own, quota: exerciseQuota(own) }).state,
        SCHEDULE.RATE_LIMITED,
        "the cap stopped counting this goal's own exercises, so nothing is bounded"
    );
});

test("an open exercise that was finished at some point stays open until it is", () => {
    // There is no interval to wait out, so a finished exercise is not an obstacle
    // either: the newest exercise being open or closed, the goal is READY until the
    // cap says otherwise. `latestFinished` still says which one was finished, which
    // is what history and the result page mean by "the last time you finished one".
    const onlyOpen = planSchedule({ goal: GOAL, exercises: [exercise(1)], now: Date.now() });
    assert.equal(onlyOpen.state, SCHEDULE.READY);
    assert.equal(latestFinished([exercise(1)]), null);
});

test("the newest exercise is chosen by number, not by creation time", () => {
    // After a sync has merged two devices whose clocks disagree, the newest by
    // `createdAt` is not the newest by `number` — and the number is the one the
    // app assigns, so it is the one that means "the one after that".
    const later = { id: "old-clock-new-number", number: 3, createdAt: 1000, completedAt: null, deletedAt: 0 };
    const earlier = { id: "new-clock-old-number", number: 1, createdAt: 9999999, completedAt: null, deletedAt: 0 };
    assert.equal(latestExercise([earlier, later]).id, "old-clock-new-number");

    // And a tombstoned exercise is not the latest, which is the case that matters
    // after a goal's last exercise was deleted on another device.
    const deleted = { ...later, id: "gone", deletedAt: 5 };
    assert.equal(latestExercise([deleted, earlier]).id, "new-clock-old-number");
});

test("a deleted goal exercises list can still be READY", () => {
    // Deleting every exercise is not something the UI offers, but a sync tombstone
    // can do it, and the state must not be a resume pointing at nothing — the
    // exercise page reads `plan.open`, and an empty list is the honest answer.
    const plan = planSchedule({
        goal: GOAL,
        exercises: [{ id: "e1", number: 1, completedAt: null, deletedAt: 12 }],
        now: Date.now()
    });
    assert.equal(plan.state, SCHEDULE.READY);
    assert.deepEqual(plan.open, []);
});

test("openExercises skips tombstones and orders by number", () => {
    const rows = [
        { id: "gone", number: 9, completedAt: null, deletedAt: 1 },
        { id: "done", number: 8, completedAt: Date.now() },
        { id: "two", number: 2, completedAt: null },
        { id: "one", number: 1, completedAt: null }
    ];
    assert.deepEqual(openExercises(rows).map((e) => e.id), ["two", "one"]);
    assert.deepEqual(openExercises(null), []);
    assert.equal(latestFinished(rows).id, "done");
});

test("a closed goal is finished, however new or old it is", () => {
    // Two states and two sentences for two things a reader can do. A goal closed by
    // hand says "this goal is closed", and it is that state whatever the clock says
    // the plan has been open for — there is no plan length for it to run out of.
    const goal = { ...GOAL, status: "completed" };
    const plan = planSchedule({ goal, exercises: [], now: Date.now() + 400 * DAY });
    assert.equal(plan.state, SCHEDULE.COMPLETED);
    assert.ok(!canStartNewExercise(plan), "a finished goal offered another exercise");
});

test("an archived goal builds nothing, however fresh its work is", () => {
    // Archiving is the READER putting a goal away, and it is a state of its own
    // rather than a flavour of "finished": a finished goal is over, and this one is
    // reversible -- `unarchiveGoal` sets `archivedAt` back to null and the goal
    // builds again. Reporting it as `completed` would tell somebody who had only
    // filed a goal away that they had finished it.
    const goal = { ...GOAL, archivedAt: Date.now() };
    const plan = planSchedule({ goal, exercises: [] });
    assert.equal(plan.state, SCHEDULE.ARCHIVED);
    assert.ok(!canStartNewExercise(plan), "an archived goal offered another exercise");

    // And it is its own state even on a goal that is ALSO completed, because the
    // reader's instruction is the one that answers "may anything new be built".
    const both = planSchedule({
        goal: { ...goal, status: "completed" },
        exercises: [],
        now: Date.now()
    });
    assert.equal(both.state, SCHEDULE.COMPLETED,
        "finishing must still outrank archiving so a finished goal reads as finished");
});

test("an archived goal with open exercises is not resumed either", () => {
    const open = { id: "e1", number: 1, completedAt: null };
    const plan = planSchedule({
        goal: { ...GOAL, archivedAt: Date.now() },
        exercises: [open],
        now: Date.now()
    });
    assert.equal(plan.state, SCHEDULE.ARCHIVED);
});