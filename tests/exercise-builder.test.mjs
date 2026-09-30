// What goes into the next exercise.
//
// The rule with teeth is the review pool: the questions of the last `reviewDepth`
// exercises, oldest exercise first, capped at a multiple of the new count. The
// window is the rule, and the two designs it is not are both plausible and both
// wrong — "everything ever answered wrongly" makes a stuck question permanent
// and starves everything behind it while a question answered correctly can never
// be seen again, and "any question with a wrong answer in the last N exercises"
// makes the same three questions come back every single time and never reaches the
// rest of the material.
//
// The worked example in the goal's own description is the test that matters:
// 5 new per exercise reviewing the last 3 gives 5, 10, 15, 20, and then 20.

import test from "node:test";
import assert from "node:assert/strict";

import {
    ITEM_KIND,
    buildExercisePlan,
    classifyQuestions,
    hasAnythingToAsk,
    nextExerciseNumber,
    reviewCapacity,
    reviewWindow,
    shuffle
} from "../app/js/domain/exercise-builder.js";
import { LIMITS } from "../app/js/domain/validation.js";
import { DEFAULT_NEW_PER_EXERCISE, DEFAULT_REVIEW_DEPTH } from "../app/js/config.js";

/** A deterministic stand-in for Math.random, so a test can pin the order. The
 *  contract is the same as Math.random's: a number in [0,1). A seeded LCG is
 *  used rather than a constant, because a constant makes `shuffle` look like it
 *  works while reversing the list every time. */
function seeded(seed = 1) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

const questions = (...ids) => ids.map((id) => ({ id, goalId: "g1" }));

/** question id → one attempt record, which is all `buildExercisePlan` reads. */
function history(entries) {
    // `[id, correct, answeredAt]` as plain data, not as a destructuring pattern —
    // a default in one of those is an assignment to an undeclared name.
    return new Map(entries.map(([id, correct, answeredAt]) => [
        id,
        { id: `a-${id}`, questionId: id, correct, answeredAt: answeredAt ?? 0 }
    ]));
}

/** The items of one exercise, as `repos.createExercise` would have stored them. */
const exerciseItems = (...questionIds) => questionIds.map((questionId) => ({ questionId }));

test("a question with no attempt is new, one answered right is learned", () => {
    const { fresh, review, learned } = classifyQuestions(
        questions("a", "b", "c"),
        history([["b", true], ["c", false]])
    );
    assert.deepEqual(fresh.map((q) => q.id), ["a"]);
    assert.deepEqual(learned.map((q) => q.id), ["b"]);
    assert.deepEqual(review.map((q) => q.id), ["c"]);
});

/* ------------------------------ the window -------------------------------- */

test("the window is the last `reviewDepth` exercises, oldest first, de-duplicated", () => {
    const goal = { reviewDepth: 3 };
    const window = reviewWindow([
        exerciseItems("a", "b"),
        exerciseItems("b", "c"),
        exerciseItems("d"),
        exerciseItems("e", "f")
    ], goal);

    // The last THREE exercises are items 2, 3 and 4. `a` has fallen out of the
    // window, which is the point of a window; `b` was in two of them and is listed
    // once, because a question asked twice in one exercise is the one thing this
    // app must never do.
    assert.deepEqual(window, ["b", "c", "d", "e", "f"]);
});

test("the window is a number of exercises, not a number of questions", () => {
    // 2 exercises of 5 questions each is a window of ten, not of two. Reading the
    // depth as a count of items is what made an exercise shrink back to the new
    // count the moment the reader had answered everything correctly.
    const wide = reviewWindow([exerciseItems("a", "b", "c", "d", "e")], { reviewDepth: 5 });
    assert.deepEqual(wide, ["a", "b", "c", "d", "e"]);

    // A depth of 1 is the previous exercise only, however many questions it held.
    assert.deepEqual(
        reviewWindow([exerciseItems("a", "b", "c"), exerciseItems("d")], { reviewDepth: 1 }),
        ["d"]
    );
});

test("a goal with no exercises has an empty window", () => {
    assert.deepEqual(reviewWindow([], { reviewDepth: 3 }), []);
    assert.deepEqual(reviewWindow(undefined, { reviewDepth: 3 }), []);
});

/* ------------------------------ the 5/10/15/20 ------------------------------ */

test("5 new reviewing the last 3 exercises gives 5, then 10, then 15, then 20", () => {
    // The example the goal description gives, run end to end. A pool of "questions
    // answered wrongly" cannot produce it at all: answer everything correctly and
    // exercise 2 is 5 items, because nothing is eligible for review any more.
    const goal = { newPerExercise: 5, reviewDepth: 3, intervalDays: 1 };
    const pool = questions(...Array.from({ length: 30 }, (_, i) => `q${i}`));

    let asked = [];              // ids not yet used as new
    let history_ = new Map();    // every id answered correctly, as they leave `asked`
    const window = [];           // items of the last three exercises
    const totals = [];

    for (let round = 0; round < 6; round++) {
        const plan = buildExercisePlan({
            goal,
            questions: pool,
            history: history_,
            recent: reviewWindow(window, goal),
            rand: seeded(round + 1)
        });
        totals.push(plan.total);

        const ids = plan.items.map((i) => i.questionId);
        // The invariant that matters most, checked at every step: no question twice.
        assert.equal(new Set(ids).size, ids.length, `round ${round} repeated a question`);

        window.push(exerciseItems(...ids));
        if (window.length > 3) window.shift();
        for (const id of ids) history_.set(id, { id: `a-${id}`, questionId: id, correct: true, answeredAt: round });
    }

    assert.deepEqual(totals, [5, 10, 15, 20, 20, 20]);
});

test("a question answered correctly is still reviewed; one answered wrongly is not new", () => {
    const plan = buildExercisePlan({
        goal: { newPerExercise: 2, reviewDepth: 3 },
        questions: questions("n1", "n2", "known", "missed"),
        history: history([["known", true, 1], ["missed", false, 2]]),
        recent: ["known", "missed"],
        rand: seeded()
    });

    // Both are review items. Being right is what puts a question in the window; it
    // is not what takes it out. And the two that were never asked are the new ones.
    assert.equal(plan.newCount, 2);
    assert.equal(plan.reviewCount, 2);
    assert.deepEqual(
        plan.items.filter((i) => i.kind === ITEM_KIND.REVIEW).map((i) => i.questionId),
        ["known", "missed"]
    );
});

test("the review order is the window's order, and the window is not shuffled", () => {
    const plan = buildExercisePlan({
        goal: { newPerExercise: 1, reviewDepth: 6 },
        questions: questions("a", "b", "c", "d"),
        history: history([["a", true, 1], ["b", true, 2], ["c", true, 3], ["d", true, 4]]),
        // Oldest exercise first: `a` has gone longest without being seen, so it is
        // the one that gets refreshed. Its ANSWER time is deliberately the reverse
        // of its window position — the window is the rule, not the mistake.
        recent: ["a", "b", "c", "d"],
        rand: seeded()
    });
    assert.deepEqual(plan.items.map((i) => i.questionId), ["a", "b", "c", "d"]);

    const reversed = buildExercisePlan({
        goal: { newPerExercise: 1, reviewDepth: 6 },
        questions: questions("a", "b", "c", "d"),
        history: history([["a", true, 4000], ["b", true, 3000], ["c", true, 2000], ["d", true, 1000]]),
        recent: ["d", "c", "b", "a"],
        rand: seeded()
    });
    assert.deepEqual(reversed.items.map((i) => i.questionId), ["d", "c", "b", "a"]);
});

test("two devices with the same records build the same exercise", () => {
    // What happens after a sync merge, and what makes the same goal produce two
    // different exercises from the same state. Nothing in the review half is
    // random and nothing in it is sorted afterwards.
    const first = buildExercisePlan({
        goal: { newPerExercise: 1, reviewDepth: 6 },
        questions: questions("b", "a", "c"),
        history: history([["b", true, 500], ["a", true, 500]]),
        recent: ["b", "a"],
        rand: seeded()
    });
    const second = buildExercisePlan({
        goal: { newPerExercise: 1, reviewDepth: 6 },
        questions: questions("a", "b", "c"),
        history: history([["a", true, 500], ["b", true, 500]]),
        recent: ["b", "a"],
        rand: seeded()
    });
    assert.deepEqual(first.items.map((i) => i.questionId), second.items.map((i) => i.questionId));
    // `c` was never asked, so it is the new item; the review half is the window's
    // order verbatim, and the questions array is not what put it there.
    assert.deepEqual(first.items.map((i) => i.questionId), ["c", "b", "a"]);
    assert.deepEqual(first.items.map((i) => i.kind), [ITEM_KIND.NEW, ITEM_KIND.REVIEW, ITEM_KIND.REVIEW]);
});

test("the review cap is a multiple of the new count, not a fixed number", () => {
    // 5 new × depth 3 = 15. The failure this prevents is a goal asking for 5 new
    // and 15 reviews being given 20 reviews, which is twice the reading for the
    // same return — and reviewDepth 3 meaning "three items" rather than "three
    // times as much", which makes a goal with 20 new ask for 60 reviews.
    assert.equal(reviewCapacity({ newPerExercise: 5, reviewDepth: 3 }), 15);
    assert.equal(reviewCapacity({ newPerExercise: 2, reviewDepth: 3 }), 6);
    assert.equal(reviewCapacity({ newPerExercise: 20, reviewDepth: 1 }), 20);

    // Absurd values are clamped rather than obeyed: the numbers come from a synced
    // record, and one device's out-of-range value must not be able to build a
    // thousand-item exercise on another.
    assert.equal(reviewCapacity({ newPerExercise: 9999, reviewDepth: 9999 }),
        LIMITS.NEW_PER_EXERCISE_MAX * LIMITS.REVIEW_DEPTH_MAX);
    assert.equal(reviewCapacity({}), Math.ceil(DEFAULT_NEW_PER_EXERCISE * DEFAULT_REVIEW_DEPTH));
    assert.equal(reviewCapacity(null), Math.ceil(DEFAULT_NEW_PER_EXERCISE * DEFAULT_REVIEW_DEPTH));
});

/* -------------------------------- the plan -------------------------------- */

test("a plan holds the new count first, then the review count", () => {
    const plan = buildExercisePlan({
        goal: { newPerExercise: 4, reviewDepth: 2 },
        questions: questions("n1", "n2", "n3", "n4", "r1", "r2"),
        history: history([["r1", true, 10], ["r2", true, 20]]),
        recent: ["r1", "r2"],
        rand: seeded(7)
    });

    assert.equal(plan.total, 6);
    assert.equal(plan.newCount, 4);
    assert.equal(plan.reviewCount, 2);
    assert.deepEqual(plan.items.slice(0, 4).map((i) => i.kind), Array(4).fill(ITEM_KIND.NEW));
    assert.deepEqual(plan.items.slice(4).map((i) => i.kind), Array(2).fill(ITEM_KIND.REVIEW));

    // Orders are contiguous from zero, because the queue resumes in stored order
    // and a gap would mean a reader who closes the app on item 4 comes back to
    // nothing.
    assert.deepEqual(plan.items.map((i) => i.order), [0, 1, 2, 3, 4, 5]);

    // Shuffled is not "left in the order they arrived": the point of injecting a
    // random source is that the same question does not sit in the same position in
    // every exercise the reader ever opens.
    const shuffledNew = plan.items.slice(0, 4).map((i) => i.questionId);
    assert.notDeepEqual(shuffledNew, ["n1", "n2", "n3", "n4"]);
});

test("a question is never both new and reviewed in one exercise", () => {
    // The window and the fresh pool are disjoint by construction — a question in
    // the window has been asked, so it has an attempt and is not fresh — but the
    // exclusion is written out anyway, because the consequence of getting it wrong
    // is a question asked twice in one session, counted twice and reported as two
    // answers.
    const plan = buildExercisePlan({
        goal: { newPerExercise: 20, reviewDepth: 6 },
        questions: questions("a", "b", "c"),
        // `a` is in the window AND would be new if the window were ignored.
        history: history([["b", true], ["c", true]]),
        recent: ["a", "a", "b"],
        rand: seeded()
    });
    const ids = plan.items.map((i) => i.questionId);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids.filter((id) => id === "a").length, 1);
});

test("a question in the window that has been deleted is dropped, not asked", () => {
    const plan = buildExercisePlan({
        goal: { newPerExercise: 5, reviewDepth: 3 },
        questions: questions("alive"),
        history: history([["alive", true, 1]]),
        recent: ["gone", "alive"],
        rand: seeded()
    });
    assert.deepEqual(plan.items.map((i) => i.questionId), ["alive"]);
    assert.equal(plan.newCount, 0);
    assert.equal(plan.reviewCount, 1);
});

test("a plan reports what it had to leave behind", () => {
    // The goal screen says "17 more new" and "9 more to review", and a number that
    // quietly reads 0 because the pool was capped is a goal that looks finished.
    const plan = buildExercisePlan({
        goal: { newPerExercise: 2, reviewDepth: 1 },
        questions: questions(...Array.from({ length: 5 }, (_, i) => `n${i}`), "r1", "r2", "r3"),
        history: history([["r1", false], ["r2", false], ["r3", false]]),
        recent: ["r1", "r2", "r3"],
        rand: seeded()
    });
    assert.equal(plan.newCount, 2);
    assert.equal(plan.reviewCount, 2);   // ceil(2 × 1)
    assert.equal(plan.freshLeft, 3);
    assert.equal(plan.reviewLeft, 3);    // three not learned, two of which fitted
    assert.equal(plan.total, 4);
});

test("an emptied number on the goal is the default, not the minimum", () => {
    // `Number("")` is 0, so a field the reader cleared and saved used to be
    // clamped up to the minimum: "5 new per exercise" became 1, with no error and
    // nothing on the goal page to show it.
    const plan = buildExercisePlan({
        goal: { newPerExercise: "", reviewDepth: "  " },
        questions: questions("a", "b", "c", "d", "e", "f", "g"),
        history: new Map(),
        rand: seeded()
    });
    assert.equal(plan.newCount, DEFAULT_NEW_PER_EXERCISE);
    assert.equal(reviewCapacity({ newPerExercise: "", reviewDepth: "" }),
        Math.ceil(DEFAULT_NEW_PER_EXERCISE * DEFAULT_REVIEW_DEPTH));
});

test("an empty goal has nothing to ask, and says so before opening an exercise", () => {
    // Opening a zero-item exercise would finish instantly, stamp `completedAt`,
    // and lock the goal for a whole interval having rehearsed nothing.
    const plan = buildExercisePlan({
        goal: { newPerExercise: 5, reviewDepth: 3 },
        questions: [],
        history: new Map(),
        rand: seeded()
    });
    assert.equal(plan.total, 0);
    assert.ok(!hasAnythingToAsk(plan));
    assert.ok(hasAnythingToAsk(buildExercisePlan({
        goal: { newPerExercise: 5 },
        questions: questions("a"),
        history: new Map(),
        rand: seeded()
    })));
});

test("shuffle keeps every element and does not mutate its input", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(input, seeded(3));
    assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(out.slice().sort((a, b) => a - b), input);
    // A length-0 and length-1 list are the two that a naive Fisher–Yates loop
    // handles differently, and both appear in real goals (a one-question exercise).
    assert.deepEqual(shuffle([], seeded()), []);
    assert.deepEqual(shuffle(["x"], seeded()), ["x"]);
});

test("the next exercise number is one past the highest, not the count", () => {
    // Tombstones included: a deleted exercise 3 must not be reused as exercise 3,
    // because its items and attempts are still on disk under that number.
    assert.equal(nextExerciseNumber([]), 1);
    assert.equal(nextExerciseNumber([{ number: 1 }, { number: 2 }]), 3);
    assert.equal(nextExerciseNumber([{ number: 2 }, { number: 7 }, { number: 3 }]), 8);
});
