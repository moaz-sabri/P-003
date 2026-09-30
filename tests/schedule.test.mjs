// When the next exercise may be started.
//
// This is a state machine and not a date comparison, and the test that matters is
// the one where the clock says yes and the answer is still no: an exercise that
// was started and abandoned must be resumed, never replaced. The failure is a
// reader who answers eleven of twenty questions, closes the app for a week, comes
// back, and finds a brand new exercise built from questions they had already seen
// while the first one is still sitting there at 55%.

import test from "node:test";
import assert from "node:assert/strict";

import {
    SCHEDULE,
    canStartNewExercise,
    exerciseDueAt,
    goalEndsAt,
    isExpired,
    latestExercise,
    planSchedule,
    projectedDueAt
} from "../app/js/domain/schedule.js";
import { addDays } from "../app/js/domain/time.js";

const GOAL = { id: "g1", status: "active", intervalDays: 1, newPerExercise: 5 };
const DAY = 86400000;

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

test("a completed goal builds nothing, however old the interval is", () => {
    const plan = planSchedule({
        goal: { ...GOAL, status: "completed" },
        exercises: [],
        now: Date.now() + 365 * DAY
    });
    assert.equal(plan.state, SCHEDULE.COMPLETED);
    assert.ok(!canStartNewExercise(plan), "a completed goal offered another exercise");
});

test("an unfinished exercise wins over an elapsed interval", () => {
    // THE test. `dueAt` is far in the past, which is what the previous exercise's
    // interval produced; the exercise itself has no `completedAt`. Only the clock
    // says the reader may start again, and only the state machine is allowed to
    // answer.
    const stale = {
        id: "e1",
        goalId: "g1",
        number: 1,
        dueAt: Date.now() - 30 * DAY,
        createdAt: Date.now() - 31 * DAY,
        completedAt: null
    };
    const plan = planSchedule({ goal: GOAL, exercises: [stale], now: Date.now() });
    assert.equal(plan.state, SCHEDULE.IN_PROGRESS);
    assert.equal(plan.exercise.id, "e1", "the exercise to resume is not the one that was left open");
    assert.ok(!canStartNewExercise(plan), "a second exercise was allowed while one was open");
});

test("the interval is measured from when the exercise was FINISHED", () => {
    // `dueAt` is stamped at creation from the previous exercise's completion, which
    // is why an exercise created and finished on the same day cannot unlock the
    // next one on the same day. If the unlock were measured from creation instead,
    // a goal of forty questions would build exercise 2 while exercise 1 was still
    // open and both would be answerable at once.
    const finished = {
        id: "e1", goalId: "g1", number: 1,
        createdAt: Date.now() - 2 * DAY,
        completedAt: Date.now() - 2 * DAY,
        dueAt: Date.now() - DAY
    };

    const before = planSchedule({ goal: GOAL, exercises: [finished], now: Date.now() - 2 * DAY });
    assert.equal(before.state, SCHEDULE.WAITING);
    assert.ok(!canStartNewExercise(before), "the interval was ignored and a new exercise was offered");

    const after = planSchedule({ goal: GOAL, exercises: [finished], now: Date.now() });
    assert.equal(after.state, SCHEDULE.READY);
    assert.ok(canStartNewExercise(after));
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
    // can do it, and the state must not become IN_PROGRESS with `exercise: null` —
    // the exercise page dereferences that.
    const plan = planSchedule({
        goal: GOAL,
        exercises: [{ id: "e1", number: 1, completedAt: null, deletedAt: 12 }],
        now: Date.now()
    });
    assert.equal(plan.state, SCHEDULE.READY);
    assert.equal(plan.exercise, undefined);
});

test("the unlock is measured from when the exercise FINISHED", () => {
    // `undefined` would make `now >= dueAt` false forever and lock the goal
    // permanently; 0 means "immediately", which is what an exercise with no
    // completion time means — and also what a record from a sync that carried no
    // `dueAt` means.
    assert.equal(exerciseDueAt(null, GOAL), 0);
    assert.equal(exerciseDueAt({}, GOAL), 0);
    assert.equal(exerciseDueAt({ completedAt: null }, GOAL), 0);

    // A STORED `dueAt` IS NOT READ. This is the whole test: an exercise created
    // Monday, finished Wednesday, with a stored dueAt of Tuesday must unlock on
    // Thursday — not Tuesday, which is what the home page believed while the result
    // page, counting from Wednesday, said a different day. Two screens, one
    // exercise, two different dates to come back on.
    const stored = { createdAt: 1000, completedAt: 5000, dueAt: 2000 };
    assert.equal(exerciseDueAt(stored, { intervalDays: 1 }), addDays(5000, 1));
    assert.notEqual(exerciseDueAt(stored, { intervalDays: 1 }), stored.dueAt);
});

test("the interval is the goal's, so changing it changes the unlock", () => {
    const finished = { completedAt: 5000 };
    // The reader sets "every 30 days" and saves; the pending unlock follows. A value
    // frozen at creation ignores the setting they just saved, and the result page —
    // which reads the goal fresh — would say thirty days while the button said now.
    assert.equal(exerciseDueAt(finished, { intervalDays: 30 }), addDays(5000, 30));
    assert.notEqual(
        exerciseDueAt(finished, { intervalDays: 30 }),
        exerciseDueAt(finished, { intervalDays: 1 })
    );
    // A goal record that arrived with no interval, or with nonsense in it, is one
    // day rather than 1970 and rather than an interval of zero.
    assert.equal(exerciseDueAt(finished, {}), addDays(5000, 1));
    assert.equal(exerciseDueAt(finished, { intervalDays: 0 }), addDays(5000, 1));
    assert.equal(exerciseDueAt(finished, { intervalDays: "soon" }), addDays(5000, 1));
});

test("a goal whose time is up says so, and keeps everything", () => {
    // The plan had a length, so the app has to notice it ran out. The questions,
    // the exercises and the reports are all still there — nothing is deleted, and
    // the state is its own so the home page can say "the time is up" rather than
    // either "start another one" or "closed".
    const created = Date.UTC(2026, 0, 1);
    const past = addDays(created, 90);
    const goal = { ...GOAL, createdAt: created, durationDays: 90 };

    const before = planSchedule({ goal, exercises: [], now: addDays(created, 89) });
    assert.equal(before.state, SCHEDULE.READY);
    assert.equal(before.endsAt, past);

    const after = planSchedule({ goal, exercises: [], now: past });
    assert.equal(after.state, SCHEDULE.EXPIRED);
    assert.equal(after.endsAt, past);
    assert.equal(after.exercise, undefined);

    // And it outranks an open exercise, because the button on the home page has one
    // meaning: the exercise is not thrown away, the reader can go back to it.
    const open = planSchedule({
        goal,
        exercises: [{ id: "e1", number: 1, completedAt: null }],
        now: past
    });
    assert.equal(open.state, SCHEDULE.EXPIRED);
});

test("a goal the reader closed is finished, not expired", () => {
    // Two states and two sentences. A goal closed by hand says "this goal is
    // closed"; a goal whose time ran out says "the time is up" and offers to close
    // it. Reporting the second as the first tells the reader they did something.
    const goal = { ...GOAL, createdAt: 0, durationDays: 1, status: "completed" };
    const plan = planSchedule({ goal, exercises: [], now: addDays(0, 400) });
    assert.equal(plan.state, SCHEDULE.COMPLETED);
});

test("a goal with no duration never expires", () => {
    // A record written before the field existed has none, and a plan whose length
    // is unknown has not run out. Treating a missing number as zero would end
    // every such goal the day after it was created.
    const goal = { ...GOAL, createdAt: 0 };
    assert.equal(goalEndsAt(goal), null);
    assert.equal(isExpired(goal, addDays(0, 4000)), false);
    assert.equal(planSchedule({ goal, exercises: [], now: addDays(0, 4000) }).state, SCHEDULE.READY);
    assert.equal(planSchedule({ goal, exercises: [], now: addDays(0, 4000) }).endsAt, undefined);

    // Nonsense in the field is the same as none of it, and not "expired yesterday".
    assert.equal(isExpired({ ...GOAL, createdAt: 0, durationDays: 0 }, 1), false);
    assert.equal(isExpired({ ...GOAL, createdAt: 0, durationDays: "soon" }, 1), false);
    // A goal with no creation time cannot have run out either.
    assert.equal(goalEndsAt({ ...GOAL, durationDays: 30 }), null);
});

test("projectedDueAt is only ever a hint", () => {
    // It says when the next exercise WOULD unlock if the open one were finished
    // now. The gate is `exerciseDueAt`, computed from the real `completedAt`, so
    // showing this value cannot move the goal's schedule earlier.
    const from = Date.now();
    assert.equal(projectedDueAt(3, from), addDays(from, 3));
    assert.equal(projectedDueAt(0, from), addDays(from, 1));
    assert.equal(projectedDueAt(undefined, from), addDays(from, 1));
});