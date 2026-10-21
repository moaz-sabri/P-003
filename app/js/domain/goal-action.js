// What can be done with this goal right now -- one answer, one place.
//
// THE DUPLICATION THIS REMOVES. Three screens used to derive this independently:
// the home page built its own buttons from `planSchedule`, the old `/exercise`
// screen built the same buttons again from the same values, and the goal page built a
// third set. They agreed on the day they were written and disagreed the day a state
// was added to one of them. The symptom a reader could see was a Start button that
// was dead on the home page and alive on the exercise screen, or a card that said
// "ready" above a list of rows that said nothing could be started.
//
// So the numbers are read once (goal-service's `overview`) and turned into a decision
// HERE, and every screen renders that decision rather than making it. It is a pure
// function over plain values, which is why it can be tested without a browser -- and
// why a test can enumerate every state without opening a page for each one.
//
// IT IS PURE AND IT SAYS WHAT IT IS NOT. It reads a `plan` (from schedule.js), the
// number of attached questions, and the open exercises, and it never reads a store.
// A decision that could query something is a decision that can differ between two
// screens in the same breath.

import { SCHEDULE } from "./schedule.js";

/** What the goal page and the home page do about it.
 *
 *  NO_GOAL          there is no goal. Only the empty state reaches this.
 *  CLOSED           finished or archived. Nothing new is built; everything written is
 *                   still there and still readable.
 *  NO_MATERIAL      ready, and the goal is pointed at nothing. NOT AN ERROR and not a
 *                   half-made plan: it is a complete plan with nothing attached, and
 *                   the only thing to offer is the decision of what to attach.
 *  RESUME           ready, with at least one exercise open. Resuming is not automatic
 *                   -- a reader who came to work through a new set tonight is not the
 *                   same person as one finishing yesterday's, and the records cannot
 *                   tell them apart.
 *  RESUME_OR_START  ready, nothing open. One button.
 *  RATE_LIMITED     this goal has been worked too fast: three exercises of it started
 *                   inside the window, so a fourth would not leave time to do it. It is
 *                   about THIS goal's own exercises and nothing else — a reader with
 *                   three goals is not refused by one they have not opened.
 *
 * WAITING is not in this list. There used to be a "this goal's interval has not
 * elapsed" action with a date to display, and it is gone with the interval: a plan
 * without an interval never waits, and nothing else withholds an exercise from a goal
 * that is open. */
export const ACTION = {
    NO_GOAL: "no_goal",
    CLOSED: "closed",
    NO_MATERIAL: "no_material",
    RESUME: "resume",
    RESUME_OR_START: "resume_or_start",
    RATE_LIMITED: "rate_limited"
};

/** Whether building a new exercise is permitted, as one function of one decision.
 *
 *  IT TAKES THE WHOLE DECISION rather than the `action` string, because that is what a
 *  caller has in hand and because the point of the function is that a screen asking it
 *  gets the same answer as the button it would have drawn.
 *
 *  A `switch` rather than a `Set` of the allowed states because the states that allow
 *  it are not the states that show a Start BUTTON -- `RESUME` shows both a resume and a
 *  start, `NO_MATERIAL` shows neither -- and a second list next to this one is a second
 *  thing to keep in step. */
export function canStart(decision) {
    return decision?.action === ACTION.RESUME_OR_START || decision?.action === ACTION.RESUME;
}

/**
 * @param {object} input
 * @param {object|null} input.plan        from `planSchedule`
 * @param {number} input.materialCount    questions attached to this goal
 * @param {object[]} input.open           exercises still in progress, newest first
 * @param {object|null} input.quota       this goal's allowance, from `exerciseQuota` over
 *                                        its own exercises
 * @returns {{action: string, open: object[], quota?: object|null, hasMaterial?: boolean}}
 */
export function goalAction({ plan, materialCount = 0, open = [], quota = null } = {}) {
    const state = plan?.state ?? SCHEDULE.NO_GOAL;
    const tail = { open, quota, hasMaterial: materialCount > 0 };

    if (state === SCHEDULE.NO_GOAL) return { ...tail, action: ACTION.NO_GOAL };

    // CLOSED IS ONE ANSWER FOR TWO STATES, deliberately. "This goal is closed" and
    // "this goal is in the archive" differ in the WORD on screen -- and that word
    // comes from `plan.state`, which is carried through -- but they do not differ
    // in what can be DONE, which is nothing new. (There used to be a third state,
    // "the plan's time is up", in here; it went with the plan length.)
    if (state === SCHEDULE.COMPLETED || state === SCHEDULE.ARCHIVED) {
        return { ...tail, action: ACTION.CLOSED };
    }

    if (state === SCHEDULE.RATE_LIMITED) {
        return { ...tail, action: ACTION.RATE_LIMITED };
    }

    // READY. Three questions left, and they are asked in this order because each one
    // excludes a case the next one would answer wrongly.
    //
    //   1. IS THERE ANYTHING TO ASK? A goal with nothing attached cannot draw a
    //      session, so a Start button over an empty material list is a button that
    //      will refuse for a reason the screen does not show. It is NOT an error and
    //      the goal is NOT half-made: it is a complete plan with nothing pointed at
    //      it, and the two things to offer are "attach some of what you have" and
    //      "write something new".
    //
    //   2. ARE THERE OPEN EXERCISES? Several may be open at once, and the home page
    //      offers a resume button for each. Resuming is not automatic, so this
    //      decision is "offer both", not "resume".
    //
    //   3. OTHERWISE: one button.
    if (materialCount === 0) return { ...tail, action: ACTION.NO_MATERIAL };
    if (open.length) return { ...tail, action: ACTION.RESUME };
    return { ...tail, action: ACTION.RESUME_OR_START };
}

/**
 * Which state phrase a list row shows beside a goal's title: a `goal.state_*` suffix.
 *
 * It is here rather than in the pages that draw it because the phrase is built out of
 * the decision and a sentence assembled by a page is a sentence the other page
 * assembles differently. "One open" and "ready" are both true at once when a reader
 * has an exercise open AND the goal is ready to start another, so the row prints both,
 * joined by the caller -- and printing only the first is how a goal that is ready to
 * start looks unavailable.
 *
 * @param {{action: string}} action
 * @returns {"quota"|"no_material"|"closed"|"ready"}
 */
export function stateKey(action) {
    if (action.action === ACTION.RATE_LIMITED) return "quota";
    if (action.action === ACTION.NO_MATERIAL) return "no_material";
    if (action.action === ACTION.CLOSED) return "closed";
    return "ready";
}