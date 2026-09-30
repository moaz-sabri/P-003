// When may the next exercise be started, and what happens instead.
//
// The rule is one sentence long — one exercise at a time, and the next one opens
// `intervalDays` calendar days after the last one was *finished* — and everything
// hard about it is in the two edges:
//
//   * AN EXERCISE THAT WAS STARTED BUT NOT FINISHED IS NOT ABANDONED. Closing the
//     tab, locking the phone and coming back next week all leave an exercise
//     open. If "when is the next one" only looked at the clock, it would say
//     today is free and happily build a second exercise while half of the first
//     one is still unanswered. So the schedule is a state machine and not a date
//     comparison: an unfinished exercise is the answer, whatever the clock says.
//   * "AFTER IT WAS FINISHED", not after it was created. A goal of forty
//     questions creates exercise 1 on day 1 and, if the interval were measured
//     from creation, exercise 2 could be due on day 1 while exercise 1 was still
//     open. The unlock time is DERIVED HERE, from `completedAt` and the goal's own
//     interval, and it is the same expression `summaryFor` uses — see
//     `exerciseDueAt` for why deriving it is the only way two screens can agree.

import { addDays } from "./time.js";

/** The states a goal's schedule can be in. `no_goal` and `goal_completed` are
 *  states rather than absences because the home page has to say something
 *  different about each of them. */
export const SCHEDULE = {
    NO_GOAL: "no_goal",
    /** A goal, nothing ever exercised, or the interval has elapsed. */
    READY: "ready",
    /** An exercise exists and is not finished. This is the only state in which
     *  building a new one is forbidden. */
    IN_PROGRESS: "in_progress",
    /** An exercise is finished and its interval has not elapsed. */
    WAITING: "waiting",
    /** The goal is closed. History is kept; nothing new is built. */
    COMPLETED: "goal_completed",
    /** The plan's time is up, but the goal was not closed by the reader. Kept apart
     *  from `completed` because the two lead to different pages: a closed goal
     *  offers a new one because it is finished, and an expired one says the time
     *  is up and offers to close it. Both keep every question and every report. */
    EXPIRED: "goal_expired"
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
 * When the next exercise opens: `intervalDays` calendar days after the last
 * exercise was FINISHED.
 *
 * DERIVED, NOT READ. The exercise record carries a `dueAt` written at creation
 * (`repos.createExercise`), and reading that field is what made two screens
 * disagree: the result page counted from `completedAt` and the goal's interval,
 * and the home page counted from a value frozen when the exercise was created. So
 * an exercise created Monday and finished Wednesday showed "opens in 1 day" on the
 * result page and an enabled Start button on the home page, at the same moment.
 *
 * Reading the goal's interval here rather than the stored one is the other half of
 * it. The reader is allowed to change how often they want an exercise; a value
 * frozen at creation ignores the setting they just saved, and the result page —
 * which reads the goal fresh — would say thirty days while the button said now.
 *
 * An exercise with no `completedAt` is open rather than late, so there is no
 * unlock time to report and this is never called with one; the guard is here so a
 * caller that does it anyway gets an answer rather than a date in 1970.
 */
export function exerciseDueAt(exercise, goal) {
    const interval = Number(goal?.intervalDays);
    const days = Number.isFinite(interval) && interval > 0 ? Math.round(interval) : 1;
    const anchor = exercise?.completedAt;
    if (!Number.isFinite(anchor) || anchor <= 0) return 0;
    return addDays(anchor, days);
}

/**
 * When the goal's own time is up: `durationDays` calendar days after it was
 * created.
 *
 * A GOAL WITH NO DURATION NEVER EXPIRES. A record written before this field
 * existed has none, and a plan whose length is unknown has not run out.
 */
export function goalEndsAt(goal) {
    const days = Number(goal?.durationDays);
    if (!Number.isFinite(days) || days <= 0) return null;
    if (!Number.isFinite(goal?.createdAt) || goal.createdAt <= 0) return null;
    return addDays(goal.createdAt, Math.round(days));
}

/** Whether the plan's time is up. A goal the reader closed by hand is not
 *  "expired" — it is finished, and the two say different things on screen. */
export function isExpired(goal, now = Date.now()) {
    if (!goal || goal.status === "completed") return false;
    const endsAt = goalEndsAt(goal);
    return endsAt !== null && now >= endsAt;
}

/**
 * The whole answer to "what should the Exercise button do?", in one value.
 *
 * @param {{goal: object|null, exercises: object[], now?: number}} input
 * @returns {{state: string, exercise?: object, dueAt?: number, endsAt?: number}}
 *   `exercise` is present in `in_progress` (the one to resume) and in `waiting`
 *   (the one that was last finished); `dueAt` is when the next one may start;
 *   `endsAt` is when the plan's own time is up.
 */
export function planSchedule({ goal, exercises = [], now = Date.now() }) {
    if (!goal) return { state: SCHEDULE.NO_GOAL };
    if (goal.status === "completed") return { state: SCHEDULE.COMPLETED, goal };

    // THE TIME BEING UP OUTRANKS EVERYTHING ELSE, INCLUDING AN OPEN EXERCISE.
    //
    // Not because an open exercise should be thrown away — it is not, and the
    // reader can go back and finish it — but because the button on the home page
    // has one meaning, and "your plan is over" is not "start another one". The
    // order matters in the other direction too: a goal the reader closed is
    // `COMPLETED` and never `EXPIRED`, whatever the calendar says.
    const endsAt = goalEndsAt(goal);
    if (endsAt !== null && now >= endsAt) {
        return { state: SCHEDULE.EXPIRED, goal, endsAt };
    }

    const latest = latestExercise(exercises);
    if (!latest) return { state: SCHEDULE.READY, goal, dueAt: 0, endsAt: endsAt ?? undefined };

    if (!latest.completedAt) {
        // Open. Nothing else is even considered — see the header.
        return { state: SCHEDULE.IN_PROGRESS, goal, exercise: latest, dueAt: 0, endsAt: endsAt ?? undefined };
    }

    const dueAt = exerciseDueAt(latest, goal);
    return {
        state: now >= dueAt ? SCHEDULE.READY : SCHEDULE.WAITING,
        goal,
        exercise: latest,
        dueAt,
        endsAt: endsAt ?? undefined
    };
}

/** Whether building a new exercise is permitted right now. Deliberately a
 *  separate question from `state`, because it is the only one the Create button
 *  asks and the only one that may be answered "no" without a message. */
export function canStartNewExercise(plan) {
    return plan.state === SCHEDULE.READY;
}

/**
 * When the exercise being resumed WOULD unlock the next one, had it been finished
 * now. Only ever shown as a hint, and only on the result page while an exercise is
 * still open — the gate itself is `exerciseDueAt`, computed from the real
 * `completedAt`, so this value cannot make the goal unlock early by being shown.
 */
export function projectedDueAt(intervalDays, from = Date.now()) {
    const days = Number(intervalDays);
    return addDays(from, Number.isFinite(days) && days > 0 ? Math.round(days) : 1);
}