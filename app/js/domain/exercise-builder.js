// Turning a goal and its questions into the next exercise.
//
// The rules, and the reasoning behind each one:
//
//   * AN EXERCISE IS `newPerExercise` NEW ITEMS PLUS UP TO
//     `ceil(newPerExercise × reviewDepth)` REVIEWED ONES. The cap is a multiple
//     of the new count on purpose: a review item is worth exactly one new item,
//     so a goal asking for five new questions per day and a goal allowing
//     fifteen reviews per day is asking for twice the work for the same return,
//     and the number that keeps the two goals doing the same amount of reading
//     is 15 — which is why reviewDepth 3 is the default rather than 3 being a
//     literal count of items.
//
//   * THE REVIEW POOL IS THE QUESTIONS OF THE LAST `reviewDepth` EXERCISES. It
//     is not "everything ever answered wrongly", and the difference is the whole
//     behaviour of the app. With the defaults — 5 new, review the last 3 — the
//     exercises come out at 5, then 10, then 15, then 20, and stay at 20, which
//     is the plan a reader is asked for when they set a goal. A pool of
//     "questions whose last answer was wrong" produces a different number every
//     time for a reason nobody can predict: a question answered CORRECTLY leaves
//     the pool and can never be reviewed again, so a reader who knows their
//     material sees every exercise shrink back to `newPerExercise` and the
//     repetition the goal was built on silently stops happening. Worse, the
//     questions they got wrong are permanent members, so a handful of stuck ones
//     keep the review slots full forever and everything behind them starves.
//
//   * A QUESTION CANNOT BE BOTH. Anything taken as new is removed from the review
//     pool, and the pool is de-duplicated, because a question appearing twice in
//     one exercise is the one thing a spaced-repetition app must never do — the
//     reader would meet it twice in a row and conclude the app is broken.
//
//   * A QUESTION ANSWERED CORRECTLY IS STILL A REVIEW CANDIDATE. It is removed
//     from NEW and it is not removed from REVIEW; being right is what puts it in
//     the window, not what takes it out of it.
//
// Nothing here is random unless it is given a random source. The shuffle takes
// an injected `rand`, so a test can pin the order and the same question does not
// appear in the same position in every exercise the reader ever opens.

import { LIMITS } from "./validation.js";
import { DEFAULT_NEW_PER_EXERCISE, DEFAULT_REVIEW_DEPTH } from "../config.js";

/** What one attempt says about one question, once the record is reduced to the
 *  only two fields this module needs. */
export const ITEM_KIND = { NEW: "new", REVIEW: "review" };

/**
 * Split the questions into the three states the whole app is built on.
 *
 * `history` maps question id → its most recent attempt. The map is built by
 * stats/latestAttempt(), and building it here instead would mean every caller
 * with a list of attempts in hand had to know the "latest wins" rule.
 *
 * Deleted questions are dropped by the caller — this function decides which
 * state a question is in, not whether it exists.
 *
 * @returns {{fresh: object[], review: object[], learned: object[]}}
 */
export function classifyQuestions(questions, history) {
    const fresh = [];
    const review = [];
    const learned = [];
    for (const q of questions) {
        const last = history?.get(q.id);
        if (!last) fresh.push(q);
        else if (last.correct) learned.push(q);
        else review.push(q);
    }
    return { fresh, review, learned };
}

/** Fisher–Yates, over an injected random source. `rand` is a function returning
 *  a number in [0,1), the same contract as Math.random, so a test passes a
 *  seeded stand-in and a page passes nothing. */
export function shuffle(list, rand = Math.random) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/** How many review items one exercise may carry. */
export function reviewCapacity(goal) {
    const per = clamp(goal?.newPerExercise, LIMITS.NEW_PER_EXERCISE_MIN, LIMITS.NEW_PER_EXERCISE_MAX, DEFAULT_NEW_PER_EXERCISE);
    const depth = clamp(goal?.reviewDepth, LIMITS.REVIEW_DEPTH_MIN, LIMITS.REVIEW_DEPTH_MAX, DEFAULT_REVIEW_DEPTH);
    return Math.ceil(per * depth);
}

function clamp(value, min, max, fallback) {
    const n = Number(value);
    // AN EMPTY FIELD IS NOT ZERO. `Number("")` is 0, not NaN, so a numeric input
    // the reader cleared and then saved arrived here as a real 0 and was clamped
    // up to the MINIMUM — silently turning "5 new per exercise" into 1, with no
    // error and nothing on screen to say so. A form that sends an empty string is
    // asking for the default, and the default is what the goal form pre-filled.
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
        return fallback;
    }
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * The review window: the question ids of the last `reviewDepth` exercises, oldest
 * exercise first, de-duplicated.
 *
 * The ORDER is the window's order and nothing else — oldest first, so the question
 * that has gone longest without being seen is the one that gets refreshed, and a
 * question that has just been seen inside the window is at the back of the queue
 * for it. It is not sorted afterwards and it is not shuffled: two devices that
 * have merged the same records must build the same exercise, and `Math.random`
 * cannot promise that.
 *
 * @param {{questionId: string}[][]} itemsByExercise  items of each exercise,
 *   oldest exercise first
 */
export function reviewWindow(itemsByExercise, goal) {
    const depth = clamp(goal?.reviewDepth, LIMITS.REVIEW_DEPTH_MIN, LIMITS.REVIEW_DEPTH_MAX, DEFAULT_REVIEW_DEPTH);
    const window = (Array.isArray(itemsByExercise) ? itemsByExercise : []).slice(-depth);
    const seen = new Set();
    const out = [];
    for (const items of window) {
        for (const item of items ?? []) {
            const id = item?.questionId;
            if (typeof id !== "string" || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}

/**
 * Build the item list for the next exercise.
 *
 * The returned items have no ids: the ids belong to the exercise they will be
 * written into, and minting them here would mean an id exists for a row that
 * might still be thrown away because the schedule changed between the build and
 * the write.
 *
 * Order is decided once, here, and then stored. The queue an interrupted
 * exercise resumes is the same order as the one it was interrupted in, so a
 * reader who closes the app on question 11 comes back to question 11 — not to a
 * freshly shuffled list where question 11 is now somewhere else.
 *
 * @param {{goal: object, questions: object[], history: Map<string, object>,
 *          recent?: string[], rand?: () => number}} input
 *   `recent` is the review window — see `reviewWindow` — and defaults to empty,
 *   which is the correct answer for the first exercise of a goal.
 * @returns {{items: {questionId: string, kind: string, order: number}[],
 *            newCount: number, reviewCount: number, total: number,
 *            freshLeft: number, reviewLeft: number}}
 */
export function buildExercisePlan({ goal, questions, history, recent = [], rand = Math.random }) {
    const { fresh, review, learned } = classifyQuestions(questions, history);

    const perExercise = clamp(
        goal?.newPerExercise,
        LIMITS.NEW_PER_EXERCISE_MIN, LIMITS.NEW_PER_EXERCISE_MAX, DEFAULT_NEW_PER_EXERCISE
    );
    const capacity = reviewCapacity(goal);

    const newItems = fresh.slice(0, perExercise);
    const taken = new Set(newItems.map((q) => q.id));

    // THE WINDOW, FILTERED AND CAPPED — AND FILTERED AGAINST THE NEW ONES.
    //
    // `byId` rather than the question objects: the window arrives as ids (it is
    // built from stored exercise items), and a question in the window that has
    // since been deleted simply is not in `byId` and drops out. A question that
    // has never been answered is in the window only if it was somehow in a past
    // exercise, and it is also not in `fresh` any more, so there is no path by
    // which one question becomes both a new item and a review item.
    const byId = new Map(questions.map((q) => [q.id, q]));
    const reviewItems = [];
    for (const id of recent) {
        if (reviewItems.length >= capacity) break;
        if (taken.has(id)) continue;
        const question = byId.get(id);
        if (!question) continue;
        taken.add(id);
        reviewItems.push(question);
    }

    const items = [
        // Fresh questions ARE shuffled: there is nothing about them to order by,
        // and a reader who adds twenty questions at once should not meet them in
        // the order they were typed.
        ...shuffle(newItems, rand).map((q) => ({ questionId: q.id, kind: ITEM_KIND.NEW })),
        // Reviews are NOT: the window's order is the rule, oldest exercise first.
        ...reviewItems.map((q) => ({ questionId: q.id, kind: ITEM_KIND.REVIEW }))
    ].map((item, order) => ({ ...item, order }));

    return {
        items,
        newCount: newItems.length,
        reviewCount: reviewItems.length,
        total: items.length,
        freshLeft: fresh.length - newItems.length,
        // Reported so the pages can say what is waiting. `learned` is named here
        // rather than discarded: "you have 40 questions, 12 of them not yet
        // answered right" is a sentence a reader can act on, and a plan that
        // silently dropped the number would leave the goal page unable to say it.
        reviewLeft: review.length,
        learnedCount: learned.length
    };
}

/** The next exercise's number.
 *
 *  The maximum is taken over EVERY exercise passed in, tombstones included, and
 *  that is deliberate: a deleted exercise's number must not be handed out again,
 *  or two records claim to be exercise 5 and the history list orders them by
 *  their random ids. `nextQuestionOrder` in repos.js does the same thing for the
 *  same reason. */
export function nextExerciseNumber(exercises) {
    let max = 0;
    for (const e of exercises) if (e.number > max) max = e.number;
    return max + 1;
}

/**
 * Whether there is anything at all to put in an exercise.
 *
 * Checked before building, so an empty goal says "add some questions" instead of
 * opening a zero-item exercise that finishes instantly and counts as a completed
 * exercise — which would then lock the goal for a whole interval, having
 * rehearsed nothing.
 */
export function hasAnythingToAsk(plan) {
    return plan.total > 0;
}