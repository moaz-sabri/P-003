// Everything the app is willing to tell you, computed from the attempt log.
//
// These functions have one job in common: they must not invent state that the log
// does not say. A report that reads 100% because a question was deleted, or an
// activity chart that draws a straight line across a fortnight in which nothing
// happened, is worse than no report — it is the thing a reader uses to decide
// whether the app is working.

import test from "node:test";
import assert from "node:assert/strict";

import {
    accuracy,
    dailyActivity,
    latestAttempt,
    progress,
    summarize,
    weakest
} from "../app/js/domain/stats.js";
import { dayKey, startOfDay } from "../app/js/domain/time.js";

const qs = (...ids) => ids.map((id) => ({ id, goalId: "g1" }));

/** An attempt row. `at` is a local timestamp so the daily buckets line up with the
 *  machine's own days rather than UTC ones.
 *
 *  `exerciseId` is not decoration: `summarize` scopes a goal's accuracy to the
 *  attempts of THAT goal's exercises, because both callers hand it the whole
 *  attempt log of the device. An attempt with no exercise is an attempt nobody
 *  owns, and is not counted for anybody. */
function attempt(questionId, correct, at, id = null, exerciseId = "e1") {
    return {
        id: id ?? `a-${questionId}-${at}`,
        exerciseId,
        questionId,
        correct,
        answeredAt: at
    };
}

function at(daysAgo, hour = 12) {
    const d = new Date(startOfDay(Date.now()) - daysAgo * 86400000);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
}

test("latestAttempt keeps the newest answer per question, breaking ties by id", () => {
    const history = latestAttempt([
        attempt("q1", false, 1000, "a"),
        attempt("q1", true, 2000, "b"),
        attempt("q2", true, 1500, "c")
    ]);
    assert.equal(history.get("q1").correct, true);
    assert.equal(history.get("q2").correct, true);

    // Two devices offline inside the same millisecond. Without a tie-break the
    // winner would depend on the order the merge happened to deliver, and a
    // question could flip between learned and unlearned on every subsequent sync.
    const tieA = latestAttempt([attempt("q", false, 5, "aaa"), attempt("q", true, 5, "bbb")]);
    const tieB = latestAttempt([attempt("q", true, 5, "bbb"), attempt("q", false, 5, "aaa")]);
    assert.equal(tieA.get("q").id, "bbb");
    assert.equal(tieB.get("q").id, "bbb");
});

test("progress is over the whole goal, and does not move backwards", () => {
    // The home page draws this meter next to "3 / 10". A denominator of "the ones I
    // have seen" put 100% beside the number 3 and asked the reader to reconcile
    // them — and it made the meter go DOWN as they worked: answering a question
    // wrongly moved it out of `learned`, which raised the seen count and lowered
    // the percentage.
    const history = new Map([
        ["q1", { correct: true }], ["q2", { correct: false }], ["q3", { correct: true }]
    ]);
    const p = progress(qs("q1", "q2", "q3", "q4", "q5"), history);
    assert.deepEqual(
        { total: p.total, seen: p.seen, fresh: p.fresh, learned: p.learned, review: p.review },
        { total: 5, seen: 3, fresh: 2, learned: 2, review: 1 }
    );
    // Two learned out of five questions in the goal, not out of three seen.
    assert.equal(p.percent, 40);
    // The "of what you have been shown" figure is still available, and is the one
    // the reports page wants: two of the three things actually asked.
    assert.equal(p.seenPercent, 67);

    // Nothing attempted is 0, not a division by zero.
    assert.equal(progress(qs("q1"), new Map()).percent, 0);
    // And a goal whose every question is answered correctly is 100 whatever its size.
    const all = new Map(qs("q1", "q2").map((q) => [q.id, { correct: true }]));
    assert.equal(progress(qs("q1", "q2"), all).percent, 100);

    // The monotonicity, which is the part a reader would notice: getting one
    // previously-correct answer wrong must not raise the score.
    const before = progress(qs("q1", "q2", "q3"), new Map([
        ["q1", { correct: true }], ["q2", { correct: true }], ["q3", { correct: true }]
    ])).percent;
    const after = progress(qs("q1", "q2", "q3"), new Map([
        ["q1", { correct: true }], ["q2", { correct: false }], ["q3", { correct: true }]
    ])).percent;
    assert.ok(after < before, `progress went up after a wrong answer: ${before} then ${after}`);
});

test("accuracy is over answers, not over items", () => {
    // A question answered wrong twice and right once is three answers and two of
    // them are misses. Averaging per ITEM lets a reader finish an exercise at 100%
    // with a third of their taps being wrong.
    const rows = [
        attempt("q1", false, 1000), attempt("q1", true, 2000), attempt("q1", true, 3000)
    ];
    assert.deepEqual(accuracy(rows), { total: 3, correct: 2, wrong: 1, percent: 67 });
    assert.deepEqual(accuracy([]), { total: 0, correct: 0, wrong: 0, percent: 0 });
});

test("dailyActivity draws every day in the window, including the empty ones", () => {
    // A gap is information: the app was not opened. A series that skipped empty
    // days draws a straight line across a fortnight in which nothing happened.
    const now = at(0, 18);
    const rows = [attempt("q1", true, at(0, 9)), attempt("q2", false, at(3, 9))];
    const days = dailyActivity(rows, 7, now);

    assert.equal(days.length, 7);
    assert.equal(new Set(days.map((d) => d.key)).size, 7);
    assert.equal(days[6].key, dayKey(now));
    assert.equal(days[6].total, 1);
    assert.equal(days[6].correct, 1);
    assert.equal(days[3].total, 1);
    assert.equal(days[3].correct, 0);
    assert.equal(days[0].total, 0);
    assert.equal(days[0].correct, 0);
    assert.ok(days.every((d) => d.total >= d.correct));

    // An attempt older than the window is not silently attributed to the oldest
    // bar in it, which is what a plain reduce with a default does.
    const older = dailyActivity([attempt("q1", true, at(40, 9))], 7, now);
    assert.ok(older.every((d) => d.total === 0));
});

test("weakest is the questions that were MISSED, worst rate first", () => {
    // A list headed "Needs work" that contains a question nobody has been asked and
    // a question answered five times out of five is not a list of things that need
    // work. Both used to be in it. The questions still to be WRITTEN are counted by
    // the goal's "New" figure instead, which is the honest place for them.
    const questions = qs("never", "half", "always");
    const rows = [
        attempt("half", true, 1000), attempt("half", false, 2000),
        attempt("always", true, 1500), attempt("always", true, 2500)
    ];
    assert.deepEqual(weakest(questions, rows).map((w) => w.questionId), ["half"]);

    // All learned is nothing to report, and "nothing needs work" is the useful answer.
    assert.deepEqual(weakest(questions, [attempt("always", true, 1)]), []);
    assert.deepEqual(weakest(qs("a", "b"), []), []);
});

test("weakest orders by rate, then by how recently it was missed", () => {
    const rows = [
        // 1 of 2, missed first.
        attempt("older", true, 1000), attempt("older", false, 2000),
        // 1 of 2 as well, missed more recently.
        attempt("recent", false, 3000), attempt("recent", true, 9000)
    ];
    // The rates tie at 0.5, so the tie goes to the more recent miss.
    assert.deepEqual(weakest(qs("older", "recent"), rows).map((w) => w.questionId), ["recent", "older"]);

    // A worse rate beats a more recent miss: 0 of 2, missed most recently of all.
    const worse = [...rows, attempt("terrible", false, 9500), attempt("terrible", false, 9600)];
    assert.equal(weakest(qs("older", "recent", "terrible"), worse)[0].questionId, "terrible");

    // An attempt for a question the goal does not contain is dropped rather than
    // becoming a row nothing can ever remove.
    const ghost = weakest(qs("recent"), [...rows, attempt("deleted-elsewhere", false, 9999)]);
    assert.equal(ghost.length, 1);
    assert.equal(ghost[0].questionId, "recent");
});

test("weakest is bounded", () => {
    // Thirty questions, each answered once and wrongly: the list takes `limit` of
    // them rather than all of them, because a page of thirty identical rows is a
    // list rather than a report.
    const questions = qs(...Array.from({ length: 30 }, (_, i) => `q${i}`));
    const rows = questions.map((q, i) => attempt(q.id, false, 1000 + i));
    assert.equal(weakest(questions, rows, 5).length, 5);
    // And the order is deterministic when the rates are equal: most recent first.
    assert.deepEqual(
        weakest(qs("a", "b"), [attempt("a", false, 1000), attempt("b", false, 2000)])
            .map((w) => w.questionId),
        ["b", "a"]
    );
});

test("summarize leaves out deleted records, and keeps the history that is not deleted", () => {
    const goal = { id: "g1", status: "active" };
    const rows = [
        attempt("live", false, 1000),
        attempt("gone", false, 2000),
        { ...attempt("gone2", false, 3000), deletedAt: 1 }
    ];
    const out = summarize({
        goal,
        exercises: [
            { id: "e1", number: 1, completedAt: 1000 },
            { id: "e2", number: 2, completedAt: null },
            { id: "e3", number: 3, completedAt: 2000, deletedAt: 9 }
        ],
        questions: [{ id: "live", goalId: "g1" }, { id: "gone", goalId: "g1", deletedAt: 4 }],
        attempts: rows
    });

    // The attempt of the DELETED QUESTION still counts: a question that was
    // answered and then removed is part of the history, and a report of last week
    // should still show last week. Only a tombstoned attempt — which is what
    // deleting a whole goal does to all of them — leaves the numbers.
    assert.equal(out.accuracy.total, 2, "a tombstoned attempt was counted");
    assert.equal(out.accuracy.percent, 0);
    assert.equal(out.streakFree.firstAnswerAt, 1000);
    assert.equal(out.streakFree.lastAnswerAt, 2000);

    // The DELETED QUESTION is not in the to-do list, whatever its attempts say —
    // and `live` is in it because it was missed, so the exclusion is doing the work
    // rather than the list simply being empty.
    assert.deepEqual(out.progress, {
        total: 1, fresh: 0, review: 1, learned: 0, seen: 1, percent: 0, seenPercent: 0
    });
    assert.equal(out.exercises.total, 2, "a deleted exercise was counted");
    assert.equal(out.exercises.completed, 1);
    assert.deepEqual(out.weakest.map((w) => w.questionId), ["live"]);
});

test("another goal's answers are not this goal's accuracy", () => {
    // Both callers pass `listAllAttempts()` — every answer on the device. Without
    // the filter a goal created last week reported the accuracy and the answer
    // count of every goal before it, on a page whose "needs work" list was already
    // scoped to this goal: two figures about one goal, counting different things.
    const out = summarize({
        goal: { id: "g2", status: "active" },
        exercises: [{ id: "mine", number: 1, completedAt: 5000 }],
        questions: qs("mine1"),
        attempts: [
            // Wrong, so it is this goal's one question that needs work.
            attempt("mine1", false, 4000, null, "mine"),
            // Ten answers from a goal that has since been closed.
            ...Array.from({ length: 9 }, (_, i) => attempt(`old${i}`, false, 1000 + i, null, "old")),
            // And one whose exercise is not there at all.
            attempt("ghost", true, 4500, null, "vanished")
        ]
    });

    assert.equal(out.accuracy.total, 1, "another goal's answers were counted here");
    assert.equal(out.accuracy.percent, 0);
    assert.equal(out.streakFree.firstAnswerAt, 4000);
    assert.equal(out.streakFree.lastAnswerAt, 4000);
    // The list is scoped too: ten other questions were all missed, and none of
    // them is this goal's problem.
    assert.deepEqual(out.weakest.map((w) => w.questionId), ["mine1"]);
});

test("an exercise deleted with its goal stops counting towards the accuracy", () => {
    // Deleting a goal tombstones its attempts; one that escaped that — a sync
    // merge that delivered the tombstone late — must still not be counted, because
    // the goal it belonged to is not there any more and cannot be answered again.
    // The exercise is gone too, so it is not in the list of this goal's exercises
    // and its attempts belong to nobody.
    const out = summarize({
        goal: null,
        exercises: [],
        questions: [],
        attempts: [attempt("q", true, 1000), { ...attempt("q", false, 2000), deletedAt: 7 }]
    });
    assert.equal(out.accuracy.total, 0);
    assert.equal(out.accuracy.percent, 0);
    assert.equal(out.streakFree.lastAnswerAt, null);
});

test("summarize says nothing rather than something wrong when the log is empty", () => {
    const out = summarize({
        goal: { id: "g1", status: "active" },
        exercises: [], questions: qs("q1", "q2"), attempts: []
    });
    assert.deepEqual(out.streakFree, { firstAnswerAt: null, lastAnswerAt: null });
    assert.equal(out.exercises.lastAt, null);
    assert.equal(out.progress.percent, 0);
    assert.equal(out.accuracy.percent, 0);
    // An empty "needs work" list on a goal nobody has started, and not two rows
    // about questions that have never been asked. The unstarted questions are the
    // goal's "New" count, which is the honest place for them.
    assert.deepEqual(out.weakest, []);
});