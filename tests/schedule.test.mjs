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
    latestFinished,
    openExercises,
    planSchedule,
    projectedDueAt
} from "../app/js/domain/schedule.js";
import { addDays } from "../app/js/domain/time.js";
import { exerciseQuota } from "../app/js/domain/exercise-builder.js";

const GOAL = { id: "g1", status: "active", intervalDays: 1, newPerExercise: 5 };
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

test("a completed goal builds nothing, however old the interval is", () => {
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
        dueAt: Date.now() - 30 * DAY,
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

test("an open exercise is never the anchor for the interval", () => {
    // The interval is measured from the last FINISHED exercise, and the newest
    // exercise is not necessarily that one. Anchoring on the newest meant an
    // exercise with no `completedAt` gave `dueAt = 0`, so the goal never waited —
    // and a reader with one abandoned session and a one-day interval could start a
    // new exercise every time they opened the app.
    const abandoned = planSchedule({
        goal: GOAL,
        exercises: [exercise(2, { done: 0.5, created: 3 }), exercise(3)],
        now: Date.now()
    });
    assert.equal(abandoned.state, SCHEDULE.WAITING,
        "the goal waited on nothing and offered an exercise a minute after one was finished");
    assert.equal(abandoned.exercise.number, 2, "the interval was measured from the open exercise");
    assert.deepEqual(abandoned.open.map((e) => e.number), [3],
        "the open exercise was lost while the finished one anchored the interval");

    // And with only an open exercise there is nothing to count from, so the goal is
    // ready — which is right, and is what the rule above depends on.
    const onlyOpen = planSchedule({ goal: GOAL, exercises: [exercise(1)], now: Date.now() });
    assert.equal(onlyOpen.state, SCHEDULE.READY);
    assert.equal(latestFinished([exercise(1)]), null);
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

test("a goal made this morning has no date to be refused with", () => {
    // THE REPORTED BUG, stated as the rule that prevents it. The allowance used to be
    // counted over every exercise on the device, so a goal created this morning —
    // with none of its own — inherited another goal's spent cap and opened on "the next
    // one opens in 1d 12h" over a Start button that the service then refused. Nothing
    // about that sentence was true of the goal it was printed on.
    //
    // The two halves of the fix, in the order they matter: the quota a goal is handed
    // is counted from ITS OWN exercises, and a goal with none has nothing to wait for.
    const fresh = planSchedule({ goal: { ...GOAL, id: "g2" }, exercises: [], quota: exerciseQuota([]) });
    assert.equal(fresh.state, SCHEDULE.READY);
    assert.equal(fresh.dueAt, 0, "a goal with no exercises was given a date to come back on");
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

test("waiting outranks the cap, because it has a date and the cap does not need one", () => {
    const finished = exercise(1, { done: 0 });
    const fresh = [finished, exercise(2, { created: 0.1 }), exercise(3, { created: 0.2 }), exercise(4, { created: 0.3 })];
    const plan = planSchedule({ goal: GOAL, exercises: fresh, quota: exerciseQuota(fresh) });
    assert.equal(plan.state, SCHEDULE.WAITING,
        "the cap was shown where the goal's own interval had the clearer answer");
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
    // can do it, and the state must not be a resume pointing at nothing — the
    // exercise page reads `plan.open`, and an empty list is the honest answer.
    const plan = planSchedule({
        goal: GOAL,
        exercises: [{ id: "e1", number: 1, completedAt: null, deletedAt: 12 }],
        now: Date.now()
    });
    assert.equal(plan.state, SCHEDULE.READY);
    assert.deepEqual(plan.open, []);
    assert.equal(plan.exercise, undefined);
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
test("an archived goal builds nothing, however fresh its interval is", () => {
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
    assert.equal(plan.exercise, undefined,
        "the archived goal handed back an exercise to resume");
});
