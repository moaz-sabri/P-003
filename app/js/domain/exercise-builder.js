// Turning a goal and its questions into the next exercise.
//
// The rules, and the reasoning behind each one:
//
//   * AN EXERCISE IS `NEW_PER_EXERCISE` NEW ITEMS PLUS UP TO
//     `NEW_PER_EXERCISE × REVIEW_DEPTH` REVIEWED ONES. Both numbers are the
//     fixed plan in config.js — ten new questions and a review of the last
//     three exercises — and they used to be numbers every goal carried and
//     every goal form let the reader change. They are constants now because a
//     fixed plan is one less decision per goal and one less plan to display.
//     The review cap is a multiple of the new count on purpose: a review item
//     is worth exactly one new item, so an exercise that introduces ten
//     questions also has room for up to thirty reviews — which is why
//     `REVIEW_DEPTH` is 3 rather than 3 being a literal count of items.
//
//   * THE REVIEW POOL IS THE QUESTIONS OF THE LAST `REVIEW_DEPTH` EXERCISES. It
//     is not "everything ever answered wrongly", and the difference is the whole
//     behaviour of the app. The exercises come out at 10, then 20, then 30, and
//     stay at 30 for as long as the questions last — a pool of "questions whose
//     last answer was wrong" produces a different number every time for a reason
//     nobody can predict: a question answered CORRECTLY leaves the pool and can
//     never be reviewed again, so a reader who knows their material sees every
//     exercise shrink back to `NEW_PER_EXERCISE` and the repetition the plan is
//     built on silently stops happening. Worse, the questions they got wrong are
//     permanent members, so a handful of stuck ones keep the review slots full
//     forever and everything behind them starves.
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
import {
    NEW_PER_EXERCISE, REVIEW_DEPTH, MAX_EXERCISES_PER_WINDOW, EXERCISE_WINDOW_DAYS
} from "../config.js";

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

/** How many review items one exercise may carry: the review depth as a multiple
 *  of the new count, because a review item is worth exactly one new item. Both
 *  numbers are the fixed plan, so this is a constant too — and it is still a
 *  function rather than a number so the plan reads in one place. */
export function reviewCapacity() {
    return Math.ceil(NEW_PER_EXERCISE * REVIEW_DEPTH);
}

/**
 * The review window: the question ids of the last `REVIEW_DEPTH` exercises, oldest
 * exercise first, de-duplicated.
 *
 * The ORDER is the window's order and nothing else — oldest first, so the question
 * that has gone longest without being seen is the one that gets refreshed, and a
 * question that has just been seen inside the window is at the back of the queue
 * for it. It is not sorted afterwards and it is not shuffled: two devices that
 * have merged the same records must build the same exercise, and `Math.random`
 * cannot promise that.
 *
 * The depth used to be a goal's own number; it is the `REVIEW_DEPTH` constant now,
 * read here so that changing the plan changes this one place and nowhere else.
 *
 * @param {{questionId: string}[][]} itemsByExercise  items of each exercise,
 *   oldest exercise first
 */
export function reviewWindow(itemsByExercise) {
    const window = (Array.isArray(itemsByExercise) ? itemsByExercise : []).slice(-REVIEW_DEPTH);
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
 * @param {{questions: object[], history: Map<string, object>,
 *          recent?: string[], rand?: () => number}} input
 *   `recent` is the review window — see `reviewWindow` — and defaults to empty,
 *   which is the correct answer for the first exercise of a goal.
 * @returns {{items: {questionId: string, kind: string, order: number}[],
 *            newCount: number, reviewCount: number, total: number,
 *            freshLeft: number, reviewLeft: number}}
 */
export function buildExercisePlan({ questions, history, recent = [], rand = Math.random }) {
    const { fresh, review, learned } = classifyQuestions(questions, history);

    const perExercise = NEW_PER_EXERCISE;
    const capacity = reviewCapacity();

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

    // THE SNAPSHOT IS BUILT HERE, ONCE, FOR BOTH HALVES, and that is what makes it
    // a property of the exercise rather than of one kind of item.
    //
    // Fresh and review items are the same shape and they go through one function,
    // because the one thing that turns a set of references into a session — that it
    // carries its own copy of each question — has to be true of every item in it. A
    // `new` item built without the copy and a `review` item built with it would be a
    // session that changes under the reader halfway through, and it would do so only
    // for the questions that had been seen before, which is the hardest kind of fault
    // to reproduce by hand.
    //
    // THE OPTIONS ARE SHUFFLED ONCE, HERE, and the shuffle is stored: each option's
    // `order` is rewritten to its place in the shuffled list, so "the third option"
    // means the same thing on every device and after every reload. The option order
    // is therefore fixed the moment the exercise is frozen, which is the one thing
    // that keeps a session from re-shuffling under the reader's hands.
    const freeze = (question, itemKind) => ({
        questionId: question.id,
        kind: itemKind,
        questionText: question.text,
        questionKind: question.kind,
        options: shuffle(question.options ?? [], rand).map((o, i) => ({
            id: o.id,
            text: o.text,
            isCorrect: Boolean(o.isCorrect),
            order: i
        }))
    });

    const items = [
        // Fresh questions ARE shuffled: there is nothing about them to order by,
        // and a reader who adds twenty questions at once should not meet them in
        // the order they were typed.
        ...shuffle(newItems, rand).map((q) => freeze(q, ITEM_KIND.NEW)),
        // Reviews are NOT: the window's order is the rule, oldest exercise first.
        ...reviewItems.map((q) => freeze(q, ITEM_KIND.REVIEW))
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
 * exercise — which would then count as a sitting to the goal, having rehearsed
 * nothing.
 */
export function hasAnythingToAsk(plan) {
    return plan.total > 0;
}

/* -------------------------------------------------------------------------- */
/*                              how many exercises                             */
/* -------------------------------------------------------------------------- */

/**
 * How many exercises of ONE goal may still be STARTED, and when the next one may be.
 *
 * PER GOAL, AND THAT IS THE WHOLE OF THE FIX. The list handed in used to be every
 * exercise on the device, so the allowance was one between all of the reader's goals,
 * and a goal created this morning could open on "the next one opens in 1d 12h" because
 * a DIFFERENT goal had started three exercises in the last two days. Nothing about
 * that was true of the new goal: it had none, and a goal with none is READY. The
 * sentence was about somebody else's work.
 *
 * One allowance each is also the only version of the number that means anything on a
 * screen. "Three in two days" beside three goals reads as three apiece; beside one it
 * reads as three, which is what the reader is being asked to accept.
 *
 * THE RULE IS NOT "ONE AT A TIME". It was, and it is now: several exercises may
 * be open on one goal at the same time, because a reader who wants to work ahead
 * — or who has three exercises' worth of questions waiting and one free evening —
 * should not be told by a state machine that they may not. What is bounded is the
 * RATE, not the concurrency, and the bound is deliberately generous: a cap that
 * stops at one or two is a cap that reads as a bug.
 *
 * A ROLLING WINDOW, NOT A DAILY RESET. "Three a day" implemented as a calendar
 * day means an exercise at 23:50 and two at 00:05 are five exercises inside ten
 * minutes, and a reader who finished yesterday evening finds the app locked
 * until midnight having done nothing wrong. The window is `EXERCISE_WINDOW_DAYS`
 * long and slides, so the limit is a limit on how fast the reader can work
 * through their own material and not a limit on what time it is.
 *
 * The window counts exercises STARTED inside it and not exercises finished inside
 * it. A started-but-abandoned exercise has still been built, and building it is
 * what the cap exists to bound; counting completions instead would let a reader
 * open ten exercises and answer none of them.
 *
 * IT IS THE GOAL'S OWN EXERCISES that are counted, and this function does not know
 * that: it is handed a list and answers about the list. Which list is the caller's
 * decision, and it is the one place in this app where handing it the whole device
 * produces a screen that is true of nothing the reader is looking at.
 *
 * TOMBSTONES DO NOT COUNT, and that is a decision rather than an oversight. A
 * tombstoned exercise is one that is gone from this device, usually because a goal
 * was removed — and counting those would mean that deleting a goal silently spends
 * two days of the reader's allowance with nothing on screen to explain why the Start
 * button stopped working. The cap bounds queued work, and deleted work is not queued.
 *
 * @param {object[]} exercises  the goal's exercises, tombstones included so the
 *   caller does not have to pre-filter and so that the filter is visible HERE.
 * @param {number} now
 */
export function exerciseQuota(exercises, now = Date.now()) {
    const windowMs = EXERCISE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const started = exercises
        .filter((e) => e && !e.deletedAt && Number.isFinite(e.createdAt)
            && e.createdAt <= now && e.createdAt > now - windowMs)
        .sort((a, b) => a.createdAt - b.createdAt);

    const used = started.length;
    const remaining = Math.max(0, MAX_EXERCISES_PER_WINDOW - used);
    // WHEN THE NEXT SLOT FREES, which is the start of the OLDEST exercise in the
    // window plus the window — not the newest, and not "tomorrow". With two
    // exercises started a day apart, the slot frees a day after the FIRST one, and
    // a reader told otherwise waits a day they did not have to.
    const retryAt = remaining > 0 || !started.length
        ? 0
        : started[0].createdAt + windowMs;

    return {
        limit: MAX_EXERCISES_PER_WINDOW,
        windowDays: EXERCISE_WINDOW_DAYS,
        used,
        remaining,
        blocked: remaining === 0,
        retryAt
    };
}

/* -------------------------------------------------------------------------- */
/*                            naming the questions                              */
/* -------------------------------------------------------------------------- */

// The two functions that decide what a selection means — `isExactSelection` and
// `questionsForSelection` — now live in domain/goal-content.js, beside
// `questionsForGoal`.
//
// THEY MOVED BECAUSE THE THING THEY ANSWER MOVED. Both used to be about "the
// goal's questions", which was a list this file was handed; they are now about
// "the goal's references", which is a rule that joins groups to questions, and that
// rule is the same kind of thing as `questionsForGoal`. Keeping them here and the
// join there would put one concept — what a goal is made of — in two files, and the
// build page would import the builder for a question the builder no longer answers.

/**
 * The item list for an exercise the reader NAMED, rather than one the plan drew.
 *
 * EVERY NAMED QUESTION IS AN ITEM. There is no `NEW_PER_EXERCISE` here, no review
 * window, no shuffle of the questions, and none of them may come back later: this
 * function is called once, by the service, immediately before the items are
 * written, and the exercise it produces is the list it returns. Every other way of
 * building an exercise can be re-derived from the goal; this one is a statement
 * the reader made, and the only honest thing to do with it is build exactly it.
 *
 * A QUESTION CAN APPEAR IN AS MANY EXERCISES AS THE READER ASKS FOR, and that is what
 * separates this from the plan: the plan asks "what has not been seen lately", so it
 * never repeats itself, and this asks "what did I name", which has no opinion about
 * last Tuesday. The two are not in tension — an item is a row in `exerciseItems`
 * pointing at a question, not a column on it, so the same question can be on
 * Tuesday's sheet and Sunday's with the two records independent.
 *
 * THE ORDER OF THE QUESTIONS IS THE GOAL'S, WHICH MEANS NO QUESTION SHUFFLE. The
 * plan shuffles fresh questions because they arrived by typing order and a reader
 * who adds twenty at once should not meet them in the order they were typed. Named
 * questions are the opposite case: the reader has already arranged them, on a
 * screen, and reordering them here would make the order they chose invisible while
 * looking exactly like the app being helpful.
 *
 * THE OPTIONS ARE SHUFFLED, ONCE, the same way the plan shuffles them. This is a
 * session like any other, and the one thing every session has in common is that its
 * options were arranged by the app at freeze time and never move again — see `freeze`
 * in `buildExercisePlan` for why the order is stored rather than re-derived.
 *
 * THE KIND IS STILL DECIDED, because the result page reports it. A question never
 * asked is `NEW`; one that has been answered is `REVIEW` — including one answered
 * CORRECTLY, which is the case worth being explicit about: naming a question the
 * reader already knows is a deliberate re-ask, and reporting it as new material would
 * claim credit for teaching them something they had already learnt. It is `REVIEW`
 * because it is not new, which is the only thing the label means.
 *
 * THE ORDER OF THE TYPES ABOVE IS DELIBERATE AND IS NOT SPENT: the kind is decided
 * before the cap is applied, so a cap can drop questions without changing what the
 * survivors are.
 *
 * @param {{questions: object[], history: Map<string, object>,
 *          limit?: number, rand?: () => number}} input
 * @returns {{items: {questionId: string, kind: string, order: number}[],
 *            newCount: number, reviewCount: number, total: number,
 *            truncated: number, names: string[]}}
 */
export function buildSelectedPlan({ questions, history, limit = LIMITS.EXERCISE_ITEMS_MAX, rand = Math.random }) {
    const kept = [];
    const seen = new Set();
    let skipped = 0;

    for (const question of questions ?? []) {
        if (!question || seen.has(question.id)) continue;   // one question, one item
        seen.add(question.id);
        if (kept.length >= limit) { skipped += 1; continue; }
        kept.push(question);
    }

    const items = kept.map((question, order) => ({
        questionId: question.id,
        kind: history?.get(question.id) ? ITEM_KIND.REVIEW : ITEM_KIND.NEW,
        order,
        // THE FROZEN COPY, assembled here rather than in the repository, because this
        // is the last point at which the question and the exercise are in the same
        // place. By the time `createExercise` writes, the builder's `questions` array
        // is the only thing that still knows what these questions said — and the
        // session must be able to answer them without asking the question store at
        // all.
        //
        // `options` is the list the CALLER read, shuffled once here and stored in
        // that order: the `order` on each option is rewritten to its place in the
        // shuffled list, and the `isCorrect` marks are the ones as they are NOW — an
        // exercise built today is graded against the answer key as it stood when it
        // was built, which is what makes it a snapshot rather than a live question
        // with a date on it.
        questionText: question.text,
        questionKind: question.kind,
        options: shuffle(question.options ?? [], rand).map((o, i) => ({
            id: o.id,
            text: o.text,
            isCorrect: Boolean(o.isCorrect),
            order: i
        }))
    }));

    return {
        items,
        newCount: items.filter((i) => i.kind === ITEM_KIND.NEW).length,
        reviewCount: items.filter((i) => i.kind === ITEM_KIND.REVIEW).length,
        total: items.length,
        // How many of what they asked for did not fit. Not `false` and not a silent
        // slice: a reader who names four hundred questions and is given a hundred has
        // been given a different exercise than the one they asked for, and the only
        // honest response to that is to say so.
        truncated: skipped,
        // The text of what was asked for, so the picker and the confirmation say the
        // same sentence without each of them reaching into the question records.
        names: kept.map((q) => q.text)
    };
}