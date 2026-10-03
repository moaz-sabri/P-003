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
    buildSelectedPlan,
    classifyQuestions,
    exerciseQuota,
    hasAnythingToAsk,
    nextExerciseNumber,
    reviewCapacity,
    reviewWindow,
    shuffle
} from "../app/js/domain/exercise-builder.js";
// The three functions that answer "what does this selection mean" moved to
// goal-content.js, beside `questionsForGoal`. They are tested here because they were
// always tested here, and because a test file that followed the code would leave the
// rules about a reader's explicit pick unverified while the rules about the plan grew
// new assertions.
import {
    isExactSelection,
    questionsForGoal,
    questionsForSelection
} from "../app/js/domain/goal-content.js";
import { LIMITS } from "../app/js/domain/validation.js";
import {
    DEFAULT_NEW_PER_EXERCISE, DEFAULT_REVIEW_DEPTH,
    EXERCISE_WINDOW_DAYS, MAX_EXERCISES_PER_WINDOW
} from "../app/js/config.js";

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

/* -------------------------------------------------------------------------- */
/*                                  groups                                     */
/* -------------------------------------------------------------------------- */

// These three were `questionsForGroups`, which filtered a list a goal already owned.
// The question they answered — "which questions is a set of groups worth?" — is now
// answered by `questionsForGoal`, because a goal's groups are REFERENCES rather than
// a filter over its own rows, and a group the goal is not pointed at brings in
// nothing at all.

test("a goal with no references has no questions", () => {
    // The state a brand-new goal is in, and the one the create form leaves it in. It
    // must be an empty list rather than an error or a fall back to "every question",
    // because a goal that points at nothing is a complete plan with nothing attached
    // and the home page's answer to it is a link, not a crash.
    const all = questions("a", "b", "c");
    assert.deepEqual(questionsForGoal({ groups: [], questionIds: [], allQuestions: all }), []);
    assert.deepEqual(questionsForGoal(), []);
});

test("a goal pointed at a group gets that group's questions and no others", () => {
    const all = [
        { id: "a", groupId: "g1" },
        { id: "b", groupId: "g2" },
        { id: "c", groupId: "g1" }
    ];
    // OR, not AND: a goal pointed at two groups draws on both, which is the entire
    // reason a goal can depend on more than one.
    assert.deepEqual(
        questionsForGoal({ groups: [{ id: "g1" }, { id: "g2" }], allQuestions: all }).map((q) => q.id),
        ["a", "b", "c"]
    );
    assert.deepEqual(
        questionsForGoal({ groups: [{ id: "g1" }], allQuestions: all }).map((q) => q.id),
        ["a", "c"]
    );
});

test("a question in no group is NOT pulled in by pointing at a group", () => {
    // THIS IS THE OPPOSITE OF THE OLD RULE, and it is the single most important
    // behavioural change in the join.
    //
    // `questionsForGroups` folded every unfiled question into every group selection,
    // on the reasoning that material the reader had never filed is not something
    // picking a shelf should be allowed to hide. That was right when a group was a
    // filter WITHIN a goal: the goal's questions were the pool and the group chose
    // from them.
    //
    // It is wrong now. A goal points at shelves and at individual questions, and
    // nothing is in its pool until it points at it. Folding the unfiled in would mean
    // a reader who attached "Chapter 3" to a goal silently got every question they
    // had never organised -- which is a different plan from the one they described,
    // and the more alarming one because the count on the goal page would not match
    // what the session asks.
    const all = [
        { id: "a", groupId: "g1" },
        { id: "b", groupId: null },
        { id: "c" },
        { id: "d", groupId: "g2" }
    ];
    assert.deepEqual(
        questionsForGoal({ groups: [{ id: "g1" }], allQuestions: all }).map((q) => q.id),
        ["a"]
    );
});

test("a question named directly joins the groups without being counted twice", () => {
    // The union is a SET for a reason: a question attached both by its shelf and by
    // itself is one question, and the builder must never see it twice -- a session
    // that shows the reader the same question in a row reads as a broken app.
    const all = [
        { id: "a", groupId: "g1" },
        { id: "b", groupId: "g2" }
    ];
    const got = questionsForGoal({
        groups: [{ id: "g1" }],
        questionIds: ["a", "b"],
        allQuestions: all
    }).map((q) => q.id);
    assert.deepEqual(got, ["a", "b"]);
    assert.equal(new Set(got).size, got.length, "a question came back twice");
});

test("a reference to something deleted contributes nothing", () => {
    // A sync merge that removes a group on one device leaves the reference behind on
    // the others until the delete propagates. Padding the material list with ids
    // that resolve to nothing is how a goal ends up claiming forty questions and
    // asking thirty-eight.
    //
    // The live group here is `g2`, not `g1`, so the expectation is `[a]` BECAUSE the
    // question was named directly -- the dead references are what must be ignored, and
    // an implementation that ignored live ones as well would pass a weaker test.
    const all = [{ id: "a", groupId: "g2" }];
    assert.deepEqual(
        questionsForGoal({
            groups: [{ id: "gone" }, { id: "g2" }],
            questionIds: ["also-gone", "a"],
            allQuestions: all
        }).map((q) => q.id),
        ["a"]
    );
    // And with nothing live pointed at, the answer is nothing at all -- not a
    // fall-through to the whole question list, which would be the worst version of
    // this bug: a goal that points at a deleted shelf would train on everything.
    assert.deepEqual(
        questionsForGoal({ groups: [{ id: "gone" }], questionIds: ["also-gone"], allQuestions: all }),
        []
    );
});

test("the order is the reader's own, whatever order things were attached in", () => {
    // Attaching a group after a question does not send the group's questions to the
    // end of the list. The reader's arrangement is one thing and the attachment order
    // is another, and a session that reordered itself as they arranged their shelves
    // would be answering a question they were not asked.
    const all = [
        { id: "a", groupId: "g2" },
        { id: "b", groupId: "g1" },
        { id: "c", groupId: "g2" }
    ];
    assert.deepEqual(
        questionsForGoal({ groups: [{ id: "g2" }], questionIds: ["b"], allQuestions: all })
            .map((q) => q.id),
        ["a", "b", "c"]
    );
});

test("a group selection feeds the plan, and the plan asks for nothing outside it", () => {
    const goal = { id: "g1", newPerExercise: 2, reviewDepth: 2 };
    const filed = [
        { id: "a", groupId: "g1" },
        { id: "b", groupId: "g2" },
        { id: "c", groupId: "g1" },
        { id: "d", groupId: "g1" }
    ];
    const chosen = questionsForGoal({ groups: [{ id: "g1" }], allQuestions: filed });
    const plan = buildExercisePlan({
        goal,
        questions: chosen,
        history: new Map(),
        recent: [],
        rand: seeded(7)
    });
    assert.equal(plan.total, 2, "the plan built more than the group asked for");
    for (const item of plan.items) {
        assert.ok(item.questionId !== "b",
            "the exercise asked a question from a group that was not picked");
    }
});

/* -------------------------------------------------------------------------- */
/*                            naming the questions                              */
/* -------------------------------------------------------------------------- */

const filed = (rows) => rows.map(([id, groupId]) => ({ id, groupId: groupId ?? null }));

test("no selection at all is the plan, and a selection is not", () => {
    // The distinction the whole feature turns on: the reader said, or the app decided.
    assert.equal(isExactSelection({}), false);
    assert.equal(isExactSelection({ groupIds: null, questionIds: null }), false);
    assert.equal(isExactSelection({ groupIds: [], questionIds: [] }), false);
    assert.equal(isExactSelection({ groupIds: ["g1"] }), true);
    assert.equal(isExactSelection({ questionIds: ["q1"] }), true);
});

test("naming questions adds to a group, it does not replace it", () => {
    // "Chapter 3 and these two from Chapter 1" is one request. Either half winning
    // alone would be answering a question the reader did not ask.
    const all = filed([["a", "g1"], ["b", "g2"], ["c", "g1"], ["d", "g2"]]);
    assert.deepEqual(
        questionsForSelection(all, { groupIds: ["g1"], questionIds: ["b"] }).map((q) => q.id),
        ["a", "b", "c"],
        "the named question outside the group was dropped"
    );
});

test("a group selection on this screen does NOT drag in the unfiled questions", () => {
    // The opposite of the old rule, and deliberately so.
    //
    // This function runs on the picker, where the list it is given is ALREADY the
    // goal's material — the join has happened by the time anything here runs. So
    // folding unfiled questions in would add questions the reader cannot see on the
    // screen above the button, and the count at the bottom would be counting rows that
    // are not drawn. It used to fold them in because the list used to be a whole goal's
    // questions and the group was choosing within it; now the group has already chosen,
    // and the only question left is which of the rows in front of the reader to keep.
    const all = filed([["a", "g1"], ["b", null], ["c", "g1"], ["d", "g2"]]);
    assert.deepEqual(
        questionsForSelection(all, { groupIds: ["g1"] }).map((q) => q.id),
        ["a", "c"]
    );
});

test("a question that is both in a group and ticked appears once", () => {
    // One question, one row. Filtering the goal's list rather than concatenating a
    // group pool and a named list is what guarantees it: a question in both halves
    // cannot be appended to itself.
    const all = filed([["a", "g1"], ["b", "g1"], ["c", null]]);
    assert.deepEqual(
        questionsForSelection(all, { groupIds: ["g1"], questionIds: ["b", "c"] }).map((q) => q.id),
        ["a", "b", "c"]
    );
});

test("questions alone are exactly those questions, in the goal's order", () => {
    // Clicking in the order they appear must not change the exercise, because a
    // selection carried in a URL or a repeat has no click order at all.
    const all = filed([["a", null], ["b", null], ["c", null]]);
    assert.deepEqual(
        questionsForSelection(all, { questionIds: ["c", "a"] }).map((q) => q.id),
        ["a", "c"]
    );
});

test("an empty selection is the whole goal, not an empty exercise", () => {
    // `[]` must not mean "these zero questions" — `start()` passes null for "nothing
    // picked" and an empty array for the same thing, and only one of them may fall
    // through to the plan.
    const all = filed([["a", "g1"], ["b", "g2"]]);
    assert.deepEqual(questionsForSelection(all, {}).map((q) => q.id), ["a", "b"]);
    assert.deepEqual(questionsForSelection(all, { groupIds: [] }).map((q) => q.id), ["a", "b"]);
});

/* -------------------------------- the plan --------------------------------- */

test("a named exercise asks every question that was named, past the new-item cap", () => {
    // The cap that shapes a PLANNED exercise does not apply here. A reader who ticks
    // eight questions with `newPerExercise` at 5 asked for eight, and being given five
    // is an exercise they did not choose.
    const goal = { id: "g1", newPerExercise: 5, reviewDepth: 3 };
    const all = questions("a", "b", "c", "d", "e", "f", "g", "h");
    const plan = buildSelectedPlan({
        questions: questionsForSelection(all, { questionIds: all.map((q) => q.id) }),
        history: new Map()
    });
    assert.equal(plan.total, 8, "the plan capped a selection the reader made");
    assert.equal(plan.newCount, 8);
    assert.equal(plan.reviewCount, 0);
});

test("a named exercise is in the goal's order and is not shuffled", () => {
    // Shuffling is right for fresh questions that arrived by typing order and wrong
    // for ones the reader has already arranged on a screen.
    const all = questions("a", "b", "c", "d", "e");
    const plan = buildSelectedPlan({
        questions: questionsForSelection(all, { questionIds: ["e", "c", "a"] }),
        history: new Map()
    });
    assert.deepEqual(plan.items.map((i) => i.questionId), ["a", "c", "e"]);
    assert.deepEqual(plan.items.map((i) => i.order), [0, 1, 2]);
});

test("a named exercise reviews what has been answered, including what was right", () => {
    // Naming a question the reader already knows is a deliberate re-ask. Calling it new
    // material would claim credit for teaching them something they had learnt.
    const all = questions("a", "b", "c");
    const plan = buildSelectedPlan({
        questions: all,
        history: history([["a", true, 1], ["b", false, 1]])
    });
    const kindOf = Object.fromEntries(plan.items.map((i) => [i.questionId, i.kind]));
    assert.equal(kindOf.a, ITEM_KIND.REVIEW);
    assert.equal(kindOf.b, ITEM_KIND.REVIEW);
    assert.equal(kindOf.c, ITEM_KIND.NEW);
    assert.equal(plan.newCount, 1);
    assert.equal(plan.reviewCount, 2);
});

test("a question appears once even if it is named twice", () => {
    const all = questions("a", "b");
    const plan = buildSelectedPlan({ questions: [...all, ...all], history: new Map() });
    assert.equal(plan.total, 2, "the same question was put in the exercise twice");
    assert.equal(new Set(plan.items.map((i) => i.questionId)).size, 2);
});

test("a group chip narrows to exactly the rows the chip's own number counts", () => {
    // The chip says "Chapter 3 · 12", and the exercise has twelve questions. That
    // agreement is the whole contract of this screen, and it is NEW: the old rule
    // folded every unfiled question into every group selection, so a chip labelled 12
    // could produce an exercise of fifty-two, and the screen could only be honest by
    // printing a note explaining the discrepancy. There is no discrepancy now — the
    // list handed to this function is already the goal's material, so a group can only
    // ever select from what the reader is looking at.
    const all = filed([
        ...Array.from({ length: 12 }, (_, i) => [`g${i}`, "g1"]),
        ...Array.from({ length: 40 }, (_, i) => [`u${i}`, null]),
        ...Array.from({ length: 8 }, (_, i) => [`o${i}`, "g2"])
    ]);
    const selected = questionsForSelection(all, { groupIds: ["g1"] });
    assert.equal(selected.length, 12, "the chip's own count was not what got selected");
    assert.equal(selected.filter((q) => q.groupId === "g1").length, 12);
    assert.equal(selected.filter((q) => q.groupId === null).length, 0,
        "unfiled questions the reader cannot see were added to the exercise");
    assert.equal(selected.filter((q) => q.groupId === "g2").length, 0, "another group leaked in");
});

test("unticking every question does not stop the group from being asked", () => {
    // The picker offers a checkbox on every reachable row, unfiled included -- a
    // reader's goal may have attached unfiled questions one by one, and those rows are
    // in the material. A reader who unticks them all is saying "not these", not "not
    // the group", so the group they picked must still contribute its own.
    const all = filed([
        ["a", "g1"], ["b", "g1"], ["u", null], ["o", "g2"]
    ]);
    const selected = questionsForSelection(all, { groupIds: ["g1"] });
    assert.deepEqual(selected.map((q) => q.id), ["a", "b"]);
    // And naming the unfiled one alongside the group still works -- which is how a
    // reader trains on one specific unattached question.
    assert.deepEqual(
        questionsForSelection(all, { groupIds: ["g1"], questionIds: ["u"] }).map((q) => q.id),
        ["a", "b", "u"]
    );
});

test("excluding a question beats the group that brought it in", () => {
    // The checkbox on a group-supplied row has to be able to say "not this one", or
    // it is a box that only goes one way. It arrived through the group, so it was
    // never in the named set -- the exclusion is the only record that can take it out.
    const all = filed([["a", "g1"], ["b", "g1"], ["c", null]]);
    assert.deepEqual(
        questionsForSelection(all, { groupIds: ["g1"], excludeIds: ["b"] }).map((q) => q.id),
        ["a"]
    );
});

test("an exclusion cannot re-add a question that a group brought in, once unticked", () => {
    // The reversibility that the picker's handler depends on: unticking removes the
    // exclusion, so ticking again puts the question back. If the exclusion outlived
    // the untick the row would come back still empty and the reader would be tapping
    // the same control for ever.
    const all = filed([["a", "g1"], ["b", "g1"]]);
    let selection = { groupIds: ["g1"] };
    assert.deepEqual(questionsForSelection(all, selection).map((q) => q.id), ["a", "b"]);

    selection = { groupIds: ["g1"], excludeIds: ["b"] };          // untick b
    assert.deepEqual(questionsForSelection(all, selection).map((q) => q.id), ["a"]);

    selection = { groupIds: ["g1"], excludeIds: [] };             // tick b again
    assert.deepEqual(questionsForSelection(all, selection).map((q) => q.id), ["a", "b"]);
});

test("unticking everything without naming anything is the plan, not an empty exercise", () => {
    // Two instructions that contradict each other. The fall-through leaves the reader
    // with the next planned exercise -- something they can act on -- rather than an
    // exercise of zero items that finishes instantly and reads as a session they sat
    // through. The exclusions go with it: there is no selection for them to narrow.
    const all = filed([["a", "g1"], ["b", null]]);
    assert.deepEqual(
        questionsForSelection(all, { excludeIds: ["a", "b"] }).map((q) => q.id),
        ["a", "b"]
    );
    assert.equal(isExactSelection({ excludeIds: ["a"] }), false,
        "an exclusion alone must not count as the reader having chosen");
});

test("a named question survives its group being unticked", () => {
    // Picking a group and unticking one of its questions must move the question, not
    // lose it. This is why unticking NAMES the question rather than only excluding it:
    // an exclusion alone would put it back the moment the group went.
    const all = filed([["a", "g1"], ["b", "g1"], ["c", "g2"]]);
    assert.deepEqual(
        questionsForSelection(all, { groupIds: [], questionIds: ["b"] }).map((q) => q.id),
        ["b"]
    );
});

test("a selection larger than a sitting says how much did not fit", () => {
    // Truncated rather than silently sliced: a reader who names four hundred and gets
    // a hundred has been given a different exercise, and the only honest response is
    // to say so.
    const many = questions(...Array.from({ length: LIMITS.EXERCISE_ITEMS_MAX + 7 }, (_, i) => `q${i}`));
    const plan = buildSelectedPlan({ questions: many, history: new Map() });
    assert.equal(plan.total, LIMITS.EXERCISE_ITEMS_MAX);
    assert.equal(plan.truncated, 7);
});

test("the cap drops the LAST questions and keeps the goal's order", () => {
    const many = questions(...Array.from({ length: LIMITS.EXERCISE_ITEMS_MAX + 3 }, (_, i) => `q${i}`));
    const plan = buildSelectedPlan({ questions: many, history: new Map() });
    const ids = plan.items.map((i) => i.questionId);
    assert.equal(ids[0], "q0");
    assert.ok(!ids.includes(`q${LIMITS.EXERCISE_ITEMS_MAX}`));
});

test("a selection of nothing builds nothing, and the service refuses on that", () => {
    // Every named question deleted on another device since the picker drew it. An
    // exercise with no items finishes instantly and reads as a completed session.
    assert.equal(hasAnythingToAsk(buildSelectedPlan({ questions: [], history: new Map() })), false);
    assert.equal(hasAnythingToAsk(buildSelectedPlan({ questions: questions("a"), history: new Map() })), true);
});

/* -------------------------------------------------------------------------- */
/*                              the exercise cap                               */
/* -------------------------------------------------------------------------- */

const DAY = 86400000;

/** One exercise, started `daysAgo` days ago and finished the same moment.
 *
 *  THE CLOCK IS READ ONCE, HERE, AND CAPTURED — not on every call. `at()` was
 *  `Date.now() - daysAgo * DAY`, so two calls a few lines apart in one test gave two
 *  different instants, and a test that put `started(1.9)` in a fixture and then
 *  asserted against `started(1.9).createdAt + window` was comparing a timestamp
 *  against itself plus a day, one millisecond out. It failed on whichever run crossed
 *  a millisecond boundary and passed on the ones that did not, which is the worst
 *  failure mode a test has: green until it is not, and nothing about the failure
 *  pointing at the fixture. Everything here is now relative to one `NOW`.
 */
const NOW = Date.now();
const at = (daysAgo) => NOW - daysAgo * DAY;

const started = (daysAgo, number = 1) => ({
    id: `e${number}`,
    goalId: "g1",
    number,
    createdAt: at(daysAgo),
    completedAt: at(daysAgo),
    deletedAt: null
});

test("the cap is generous enough to be a cap and not a wall", () => {
    // A cap of one or two reads as a bug rather than a rule, and it would
    // contradict the one-day interval sitting next to it: a reader told to come
    // back tomorrow and then refused tomorrow has been told two things.
    assert.equal(MAX_EXERCISES_PER_WINDOW, 3);
    assert.equal(EXERCISE_WINDOW_DAYS, 2);
});

test("exercises outside the window do not count, and neither do tombstones", () => {
    const quota = exerciseQuota([started(5), started(9), started(20)]);
    assert.equal(quota.used, 0);
    assert.equal(quota.remaining, 3);
    assert.equal(quota.blocked, false);

    // A tombstoned exercise is one that is GONE from this device, usually because
    // a goal was removed. Counting it would mean deleting a goal silently spends two
    // days of the reader's allowance, with nothing on screen to explain why the
    // Start button stopped working.
    const deleted = { ...started(0.1), deletedAt: at(0.05) };
    assert.equal(exerciseQuota([deleted]).used, 0);
    assert.equal(exerciseQuota([deleted]).remaining, 3);
});

test("the window slides, so it is not a calendar-day reset", () => {
    // Four exercises one day apart: the fourth is refused, and the slot frees one
    // day after the OLDEST one still inside the window -- not after the newest,
    // and not at midnight. An hour past that the oldest has left and a slot frees,
    // which a calendar-day reset would not have done until 00:00.
    const four = [started(0.5, 1), started(1.2, 2), started(1.9, 3), started(2.4, 4)];
    const quota = exerciseQuota(four);
    assert.equal(quota.used, 3);
    assert.equal(quota.blocked, true);
    assert.equal(quota.retryAt, started(1.9).createdAt + EXERCISE_WINDOW_DAYS * DAY);

    const later = exerciseQuota(four, started(1.9).createdAt + EXERCISE_WINDOW_DAYS * DAY + 3600_000);
    assert.equal(later.blocked, false);
    assert.equal(later.remaining, 1);
});

test("three inside the window is exactly three, and the fourth is refused", () => {
    const three = [started(0.2, 1), started(0.6, 2), started(1.1, 3)];
    assert.equal(exerciseQuota(three).blocked, true);
    assert.equal(exerciseQuota(three).remaining, 0);

    // Two is fine -- which is the case that used to be impossible, when one open
    // exercise at a time was the rule.
    assert.equal(exerciseQuota(three.slice(0, 2)).blocked, false);
    assert.equal(exerciseQuota(three.slice(0, 2)).remaining, 1);
});

test("an exercise from the future does not count against the window", () => {
    // Two devices whose clocks disagree can merge a record stamped in the future.
    // Counting it would lock the reader out on the strength of a clock this app
    // does not control.
    const ahead = { id: "e9", createdAt: Date.now() + DAY, deletedAt: null };
    assert.equal(exerciseQuota([ahead, started(0.1)]).used, 1);
});

test("no exercises at all means no wait", () => {
    const quota = exerciseQuota([]);
    assert.equal(quota.used, 0);
    assert.equal(quota.remaining, 3);
    assert.equal(quota.blocked, false);
    assert.equal(quota.retryAt, 0);
});