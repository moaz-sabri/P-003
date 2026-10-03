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

/** The states a goal's schedule can be in. `no_goal`, `goal_completed` and
 *  `goal_archived` are states rather than absences because the home page has to say
 *  something different about each of them. */
export const SCHEDULE = {
    NO_GOAL: "no_goal",
    /** A goal, nothing ever exercised, or the interval has elapsed. */
    READY: "ready",
    /** An exercise is finished and its interval has not elapsed. */
    WAITING: "waiting",
    /** The reader has started too many exercises of THIS goal too recently. Checked
     *  AFTER `waiting`, because a goal waiting for its own interval has a date to
     *  give the reader and the cap does not need one — the cap's date is when this
     *  goal's oldest exercise leaves the window, and that is a real date too, but a
     *  goal waiting for its own interval is the earlier of the two. */
    RATE_LIMITED: "rate_limited",
    /** The goal is closed. History is kept; nothing new is built. */
    COMPLETED: "goal_completed",
    /** The goal is in the archive — filed away by the reader, not finished.
     *  Distinct from `completed` because it is REVERSIBLE and because it is not an
     *  ending: an archived goal still answers every report, and the reader can take
     *  it back out. A page that drew it as "finished" would be telling the reader
     *  something had ended when they had only put it away. */
    ARCHIVED: "goal_archived",
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
 *  This is what the interval is measured from, and it is deliberately not
 *  `latestExercise`. With several exercises open at once, "the last one" is an
 *  exercise the reader has not finished, which has no completion time to count from
 *  — so an anchor of zero, so a permanently unlocked goal, so a reader with one
 *  abandoned session and a one-day interval who could start a new exercise every
 *  time they opened the app. */
export function latestFinished(exercises) {
    let best = null;
    for (const e of exercises) {
        if (e.deletedAt || !e.completedAt) continue;
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
 * `quota` IS PASSED IN rather than computed here, and that is the shape the rule
 * forces. The cap is over the exercises started for THIS GOAL — one allowance each,
 * so that a reader with three goals is not refused by a goal they have not touched —
 * so it could be derived from the goal's own `exercises`, but computing it here
 * would make the pages that ask this question read a second time. The caller reads
 * it once and hands it in; this function stays a pure answer about one goal.
 *
 * @param {{goal: object|null, exercises: object[], quota?: object|null, now?: number}} input
 * @returns {{state: string, exercise?: object, open: object[], dueAt?: number,
 *            endsAt?: number, quota?: object|null}}
 *   `open` is every exercise still in progress, newest first — a fact about the goal,
 *   reported alongside the state and never the reason one is refused. `exercise` is
 *   the last one FINISHED; `dueAt` is when the next one may start; `endsAt` is when
 *   the plan's own time is up.
 */
export function planSchedule({ goal, exercises = [], quota = null, now = Date.now() }) {
    if (!goal) return { state: SCHEDULE.NO_GOAL, open: [] };
    if (goal.status === "completed") return { state: SCHEDULE.COMPLETED, goal, open: [] };
    // ARCHIVED IS CHECKED BEFORE `status`, and before anything else, because it is
    // the reader's own instruction rather than the goal's condition. An archived
    // goal may also be completed — the two are independent — and the archive is the
    // one that answers "may anything new be built", because the reader is the one
    // who put it away.
    if (goal.archivedAt) return { state: SCHEDULE.ARCHIVED, goal, open: [] };

    // THE TIME BEING UP OUTRANKS EVERYTHING ELSE, INCLUDING AN OPEN EXERCISE.
    //
    // Not because an open exercise should be thrown away — it is not, and the
    // reader can go back and finish it — but because the button on the home page
    // has one meaning, and "your plan is over" is not "start another one". The
    // order matters in the other direction too: a goal the reader closed is
    // `COMPLETED` and never `EXPIRED`, whatever the calendar says.
    const endsAt = goalEndsAt(goal);
    if (endsAt !== null && now >= endsAt) {
        return { state: SCHEDULE.EXPIRED, goal, open: [], endsAt };
    }

    const open = openExercises(exercises);
    const tail = { goal, open, endsAt: endsAt ?? undefined, quota };

    // THE INTERVAL IS MEASURED FROM THE LAST FINISHED EXERCISE, and the newest
    // exercise is not necessarily that one. It used to be `latestExercise`, and with
    // several exercises open at once that is an exercise with no `completedAt` — so
    // `exerciseDueAt` returned 0, the goal never waited, and a reader with one
    // abandoned session and a one-day interval could start a new exercise every time
    // they opened the app.
    const finished = latestFinished(exercises);
    if (finished) {
        const dueAt = exerciseDueAt(finished, goal);
        if (now < dueAt) {
            // WAITING IS RETURNED BEFORE THE CAP IS LOOKED AT, and that ordering is the
            // whole of what makes the two states readable. A goal waiting for its own
            // interval has a DATE to give the reader; the cap is about how fast this
            // goal has been worked, and a sentence about it would send them away for a
            // window and have them meet exactly the same thing.
            return { ...tail, state: SCHEDULE.WAITING, exercise: finished, dueAt };
        }
    }

    // THE CAP IS CHECKED WHENEVER THE INTERVAL HAS ELAPSED, and not only on a goal that
    // has never been finished.
    //
    // It used to be the last line before `READY`, reachable only when `finished` was
    // null — so a goal whose interval had elapsed was reported READY no matter how many
    // exercises this device had started in the last two days. Every screen then drew a
    // live Start button over a goal the schedule would refuse, and the refusal arrived
    // from `start()` as a toast rather than as the state the button should have been
    // drawn from. It is the exact bug this module's own header describes happening
    // between two screens, except both screens were reading this one function.
    if (quota?.blocked) return { ...tail, state: SCHEDULE.RATE_LIMITED };

    if (finished) return { ...tail, state: SCHEDULE.READY, exercise: finished, dueAt: exerciseDueAt(finished, goal) };

    // Nothing has ever been finished, so there is no interval to wait out — an open
    // exercise does not anchor one.
    return { ...tail, state: SCHEDULE.READY, dueAt: 0 };
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