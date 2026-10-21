// When may the next exercise be started, and what happens instead.
//
// The rule is one sentence long — an active goal is only ever withheld by how
// fast its exercises may be STARTED (the cap, `RATE_LIMITED`) — and the rest of
// this file is about what that rule is NOT:
//
//   * THERE IS NO INTERVAL. There used to be one — `intervalDays` after the
//     last exercise was finished, with a WAITING state and an unlock date on
//     every screen — and it is gone because the plan it belonged to is gone.
//     The plan is a fixed ten new items plus a review of the last three
//     exercises, whatever day it is, so an exercise finished a minute ago does
//     not lock the goal and one from last week does not unlock it. A finished
//     exercise ends with Continue or Stop, and there is no date to count down.
//
//   * THERE IS NO END DATE. A plan with a fixed length would need a way to run
//     out (an EXPIRED state, a countdown, a goal of "90 days" — all of it gone);
//     a plan without one ends only when the READER closes it or files it away,
//     which is what `COMPLETED` and `ARCHIVED` are.
//
//   * AN EXERCISE THAT WAS STARTED BUT NOT FINISHED IS NOT AN OBSTACLE. Closing
//     the tab, locking the phone and coming back next week all leave an exercise
//     open. Several may be open at once; answering "may another one start?"
//     with "finish the first one" turns something the reader did into something
//     they are punished for. The cap is the only thing that says no, and it
//     counts how fast exercises are STARTED, not whether one is finished.

/** The states a goal's schedule can be in. `no_goal`, `goal_completed` and
 *  `goal_archived` are states rather than absences because the home page has to say
 *  something different about each of them. */
export const SCHEDULE = {
    NO_GOAL: "no_goal",
    /** A goal, and the cap has room. There is no interval to wait out, so this is
     *  the whole of "it may be exercised now". */
    READY: "ready",
    /** The reader has started too many exercises of THIS goal too recently. Checked
     *  on top of `ready` every time: it is the only thing that withholds an exercise
     *  from a goal that is open. */
    RATE_LIMITED: "rate_limited",
    /** The goal is closed. History is kept; nothing new is built. */
    COMPLETED: "goal_completed",
    /** The goal is in the archive — filed away by the reader, not finished.
     *  Distinct from `completed` because it is REVERSIBLE and because it is not an
     *  ending: an archived goal still answers every report, and the reader can take
     *  it back out. A page that drew it as "finished" would be telling the reader
     *  something had ended when they had only put it away. */
    ARCHIVED: "goal_archived"
};

/** The last exercise of a goal — highest number, not most recently created.
 *  The two agree on one device and disagree on two after a sync has merged
 *  devices whose clocks disagree, and the number is the one the app assigns and
 *  therefore the one that means "the one after that". */
export function latestExercise(exercises) {
    let best = null;
    for (const e of exercises) {
        if (e.deletedAt) continue;
        if (!best || e.number > best.number) best = e;
    }
    return best;
}

/**
 * The exercises of a goal that are still open, newest first.
 *
 * A FACT ABOUT THE GOAL, NOT A STATE OF ITS SCHEDULE. There used to be an
 * `IN_PROGRESS` state that meant "an exercise is open, so no second one may be
 * built", and it is gone because it was wrong: it made a reader who wanted to work
 * through two sessions in one evening unable to, and it turned something a reader
 * had done — left a session open — into something they were punished for. Several
 * exercises may be open at once now; what is bounded is how fast new ones can be
 * STARTED, and that is `RATE_LIMITED`.
 */
export function openExercises(exercises) {
    return (exercises ?? [])
        .filter((e) => e && !e.deletedAt && !e.completedAt)
        .sort((a, b) => b.number - a.number || (b.id < a.id ? -1 : 1));
}

/** The last exercise of a goal that was actually FINISHED, highest number.
 *
 *  Deliberately not `latestExercise`: with several exercises open at once, "the
 *  last one" is often an exercise the reader has not finished. This is the one
 *  history and the result page mean by "the last time you finished an exercise".
 */
export function latestFinished(exercises) {
    let best = null;
    for (const e of exercises) {
        if (e.deletedAt || !e.completedAt) continue;
        if (!best || e.number > best.number) best = e;
    }
    return best;
}

/**
 * The whole answer to "what should the Exercise button do?", in one value.
 *
 * `quota` IS PASSED IN rather than computed here, and that is the shape the rule
 * forces. The cap is over the exercises started for THIS GOAL — one allowance each,
 * so that a reader with three goals is not refused by a goal they have not touched —
 * so it could be derived from the goal's own `exercises`, but computing it here
 * would make the pages that ask this question read a second time. The caller reads
 * it once and hands it in; this function stays a pure answer about one goal.
 *
 * @param {{goal: object|null, exercises: object[], quota?: object|null}} input
 * @returns {{state: string, goal?: object, open: object[], quota?: object|null}}
 *   `open` is every exercise still in progress, newest first — a fact about the goal,
 *   reported alongside the state and never the reason one is refused.
 */
export function planSchedule({ goal, exercises = [], quota = null }) {
    if (!goal) return { state: SCHEDULE.NO_GOAL, open: [] };
    if (goal.status === "completed") return { state: SCHEDULE.COMPLETED, goal, open: [] };
    // ARCHIVED IS CHECKED BEFORE `status`, and before anything else, because it is
    // the reader's own instruction rather than the goal's condition. An archived
    // goal may also be completed — the two are independent — and the archive is the
    // one that answers "may anything new be built", because the reader is the one
    // who put it away.
    if (goal.archivedAt) return { state: SCHEDULE.ARCHIVED, goal, open: [] };

    const open = openExercises(exercises);
    const tail = { goal, open, quota };

    // THE CAP IS THE ONLY GATE. There used to be an interval to wait out after a
    // finished exercise and a plan length that could run out; with both gone, an
    // active goal that has not hit the cap is READY, no matter when it was last
    // worked. The cap is checked last so that `open` is still reported beside a
    // refusal — being over it says nothing about the sessions already in progress.
    if (quota?.blocked) return { ...tail, state: SCHEDULE.RATE_LIMITED };

    return { ...tail, state: SCHEDULE.READY };
}

/** Whether building a new exercise is permitted right now. Deliberately a
 *  separate question from `state`, because it is the only one the Create button
 *  asks and the only one that may be answered "no" without a message. */
export function canStartNewExercise(plan) {
    return plan.state === SCHEDULE.READY;
}