// Running a session, and the two promises that make it safe.
//
// THE FIRST is the one this file has always made: a session does not have to be
// stored. An attempt log is enough to rebuild it exactly, which only holds if
// `resumeSession` reproduces `advance` step for step — so the tests below run the
// same answers through both paths and compare. If the two ever disagree, a session
// that was interrupted resumes in a state no sequence of answers could have
// produced: a reader asked a question they already answered, or a page with nothing
// on it and no Next button.
//
// THE SECOND is new, and it is the snapshot rule. An item carries its own copy of the
// question — the text, the kind, the options and their correct marks — so what a
// session asks cannot change after it starts. The tests at the bottom hold that: a
// question edited between two items, or deleted outright, leaves the session exactly
// as it was. This is the difference between "a session" and "a link to some questions",
// and without it the promise above is not enough: a session could rebuild perfectly
// from its log and still be asking something the reader was never shown.

import test from "node:test";
import assert from "node:assert/strict";

import {
    advance,
    countKinds,
    currentItem,
    firstPass,
    isDrawable,
    isFinished,
    progress,
    questionOf,
    resumeSession,
    startSession
} from "../app/js/domain/session.js";
import { ITEM_KIND } from "../app/js/domain/exercise-builder.js";

/**
 * The session's items, in the order they were built.
 *
 * `kind` is here because countKinds reads it. The rest — the frozen question — is
 * here because these are SNAPSHOT items now, and a test fixture that left the copy
 * out would be testing a shape the app no longer produces: `questionOf` and
 * `isDrawable` below read those fields, and the tests for them are the reason this
 * file grew them.
 */
const items = (n = 3) => Array.from({ length: n }, (_, i) => ({
    id: `i${i + 1}`,
    order: i,
    kind: i < 2 ? ITEM_KIND.NEW : ITEM_KIND.REVIEW,
    questionId: `q${i + 1}`,
    questionText: `Question ${i + 1}`,
    questionKind: "single",
    options: [
        { id: `q${i + 1}-o1`, text: "right", isCorrect: true, order: 0 },
        { id: `q${i + 1}-o2`, text: "wrong", isCorrect: false, order: 1 }
    ]
}));

/**
 * Answer a list, and produce BOTH the live session and the attempt rows it wrote.
 *
 * One function rather than two, because the rows and the session have to come from
 * the same run: the round on a row is the session's round BEFORE `advance`, and
 * building the two separately is exactly how a test ends up proving nothing. An
 * answer for an item that is not at the head of the queue is skipped, which is
 * what the page does — it only ever offers the current item.
 */
function run(itemsList, answers) {
    const attempts = [];
    let session = startSession(itemsList);
    for (const [itemId, correct] of answers) {
        if (!session.queue.includes(itemId)) continue;
        const round = session.round;
        session = advance(session, { itemId, correct }).session;
        attempts.push({ id: `a${String(attempts.length + 1).padStart(3, "0")}`, itemId, correct, round });
    }
    return { session, attempts };
}

/**
 * The contract between `advance` and `resumeSession`.
 *
 * `passed` is compared as a set, not as a list: the live session appends to it in
 * the order the answers came in and the rebuilt one in the order the items are
 * stored, and those are different orders for the same exercise. Nothing reads
 * `passed` in an order — the counts are what the result page shows — so pinning
 * the order would be pinning an accident.
 */
function sameSession(live, rebuilt) {
    assert.equal(rebuilt.round, live.round, "round");
    assert.deepEqual(rebuilt.queue, live.queue, "queue");
    assert.deepEqual(rebuilt.repeat, live.repeat, "repeat");
    assert.deepEqual([...rebuilt.passed].sort(), [...live.passed].sort(), "passed");
}

test("a fresh session is one round with everything in the queue", () => {
    const session = startSession(items(3));
    assert.deepEqual(session, { round: 1, queue: ["i1", "i2", "i3"], repeat: [], passed: [] });
    assert.ok(!isFinished(session));
    assert.equal(currentItem(session, items(3)).id, "i1");
});

test("a correct answer passes an item, a wrong one waits for another round", () => {
    const list = items(2);
    let session = startSession(list);

    session = advance(session, { itemId: "i1", correct: true }).session;
    assert.deepEqual(session.queue, ["i2"]);
    assert.deepEqual(session.passed, ["i1"]);

    // The wrong answer does not end the question — it parks it, and the queue is
    // what the reader sees next, not the wrong one.
    const wrong = advance(session, { itemId: "i2", correct: false });
    session = wrong.session;
    assert.equal(wrong.repeated, true, "the round did not advance");
    assert.equal(session.round, 2);
    assert.deepEqual(session.queue, ["i2"]);
    assert.deepEqual(session.repeat, []);
    assert.equal(wrong.finished, false, "the exercise ended at 50%");
});

test("the exercise ends only when the queue AND the repeat are empty", () => {
    const list = items(2);
    let session = startSession(list);
    session = advance(session, { itemId: "i1", correct: false }).session;
    const second = advance(session, { itemId: "i2", correct: true });

    // i1 is still wrong and now queued for round 2: one item left, not finished.
    assert.equal(second.finished, false);
    assert.equal(second.session.queue.length, 1);

    const third = advance(second.session, { itemId: "i1", correct: true });
    assert.equal(third.finished, true);
    assert.ok(isFinished(third.session));
    assert.deepEqual([...third.session.passed].sort(), ["i1", "i2"]);
});

test("a wrong answer in the last round costs another whole round", () => {
    // The loop until 100%, which is the entire point: a reader cannot finish an
    // exercise with an item they have never answered correctly.
    const list = items(3);
    const { session } = run(list, [
        ["i1", true], ["i2", false], ["i3", true], ["i2", false], ["i2", true]
    ]);
    assert.ok(isFinished(session), "three rounds of one mistake each did not converge");
    assert.equal(session.round, 3);
    assert.deepEqual([...session.passed].sort(), ["i1", "i2", "i3"]);
});

test("an answer for something not on screen is ignored", () => {
    const list = items(2);
    let session = startSession(list);
    session = advance(session, { itemId: "i1", correct: true }).session;

    // The second tap on Next, or a click that landed after the page moved on. The
    // id is not in the queue, so nothing moves — and, the part that matters, the
    // item is NOT pushed onto `repeat`: appending it there asks a question the
    // reader has already answered right, immediately, and writes a second attempt
    // row for one tap.
    const late = advance(session, { itemId: "i1", correct: false });
    assert.equal(late.session, session, "a stale answer changed the session");
    assert.equal(late.finished, false);
    assert.deepEqual(late.session.repeat, []);

    // Including on a finished session, where it must not restart anything.
    const done = { round: 1, queue: [], repeat: [], passed: ["i1", "i2"] };
    const afterDone = advance(done, { itemId: "i1", correct: true });
    assert.equal(afterDone.session, done);
    assert.equal(afterDone.finished, true);
});

test("answering the item the round bump puts back on screen is an answer", () => {
    // Recorded because it looks like a stale tap and is not one. `advance` ignores
    // an answer for an item that is not in the queue, and the bump branch returns
    // `queue: repeat` — so an item is "not in the queue" in one call and the head of
    // the queue in the next. The second of those is correct: the bump is what shows
    // the question again, and answering it is the whole point of the round.
    const list = items(2);
    let session = startSession(list);
    session = advance(session, { itemId: "i1", correct: true }).session;
    session = advance(session, { itemId: "i2", correct: false }).session;
    assert.equal(session.round, 2, "the round did not move on");
    assert.deepEqual(session.queue, ["i2"]);

    const answered = advance(session, { itemId: "i2", correct: true });
    assert.deepEqual(answered.session.passed, ["i1", "i2"]);
    assert.equal(answered.finished, true);
});

test("an exercise with no items is not finished, it is unanswerable", () => {
    // The predicate that stamps `completedAt`. An open exercise whose every question
    // was deleted has an empty queue, and "the queue is empty" is what "finished"
    // means everywhere else — so without the second half of the check the app logs a
    // completed exercise that asked zero questions and moves the goal's schedule on
    // by a whole interval, having rehearsed nothing.
    const empty = { round: 1, queue: [], repeat: [], passed: [] };
    assert.equal(isFinished(empty, true), true, "an answered exercise must still count as finished");
    assert.equal(isFinished(empty, false), false);
    assert.equal(isFinished({ round: 3, queue: [], repeat: ["i1"], passed: ["i2"] }, false), false);
});

test("resumeSession reproduces the live session exactly", () => {
    // THE test. The same answers, run through `advance` and then thrown away and
    // rebuilt from the attempt log. If these ever differ, an interrupted exercise
    // resumes somewhere the reader has never been.
    const list = items(4);
    const answers = [
        ["i1", true], ["i2", false], ["i3", true], ["i4", false],
        ["i2", true], ["i4", false], ["i4", true]
    ];

    const { session: live, attempts } = run(list, answers);
    sameSession(live, resumeSession(list, attempts));
    assert.ok(isFinished(live));
});

test("resumeSession survives an interruption at every single point", () => {
    // A tab dies at an arbitrary moment, so every prefix of the answer sequence is
    // a state the reader can actually be in. Checked exhaustively rather than with
    // a couple of examples because the interesting prefixes are the ones right
    // after a round bump.
    const list = items(3);
    const answers = [["i1", false], ["i2", true], ["i3", true], ["i1", true]];

    for (let cut = 0; cut <= answers.length; cut++) {
        const { session: live, attempts } = run(list, answers.slice(0, cut));
        // The attempts are handed over reversed — a sync merge delivers rows in
        // neither the order they were made nor reliably in key order — so the log's
        // own ordering cannot be what resumeSession is allowed to rely on.
        const rebuilt = resumeSession(list, attempts.slice().reverse());

        sameSession(live, rebuilt);
        // The two must also agree about whether the exercise is over: a page that
        // says finished over a queue that is not empty is a skipped question, and
        // the reverse is an exercise that cannot be finished.
        assert.equal(isFinished(rebuilt), isFinished(live), `finish diverged after ${cut} answers`);
        assert.ok(currentItem(rebuilt, list) !== null || isFinished(rebuilt),
            `resumed session at ${cut} answers has nothing to answer and is not finished`);
    }
});

test("every sequence of right and wrong answers rebuilds identically", () => {
    // The strongest form of the contract: for three items and up to seven taps,
    // EVERY possible pattern of right and wrong answers is run live, written to an
    // attempt log, thrown away and rebuilt. A round bump happens somewhere in most
    // of these, and the bump is the step with no row recording it.
    const list = items(3);
    let sessions = 0;
    let bumps = 0;

    for (let bits = 0; bits < 128; bits++) {
        // The answer sequence has to be generated BY the machine, not written out
        // by hand: every tap answers whatever is at the head of the queue, which is
        // a different item in every run.
        let sim = startSession(list);
        const answers = [];
        for (let step = 0; step < 7 && !isFinished(sim); step++) {
            const itemId = sim.queue[0];
            const correct = Boolean(bits & (1 << step));
            answers.push([itemId, correct]);
            sim = advance(sim, { itemId, correct }).session;
        }
        const live = run(list, answers);
        if (live.session.round > 1) bumps += 1;
        sessions += 1;
        sameSession(live.session, resumeSession(list, live.attempts));
        assert.equal(isFinished(resumeSession(list, live.attempts)), isFinished(live.session));
    }
    // And the sweep actually exercised both kinds of state, so a run that silently
    // tested nothing cannot pass.
    assert.ok(bumps > 20, `only ${bumps} of ${sessions} runs reached a second round`);
});

test("an item passed in an earlier round is not asked again", () => {
    // The round-1 attempt for i1 has no companion in round 2, because i1 is never
    // asked in round 2. Reading only the current round puts it back in the queue, so
    // an exercise interrupted in its second round starts again from the top and the
    // round counter climbs for work that is already done.
    const list = items(3);
    const { attempts } = run(list, [["i1", true], ["i2", false], ["i3", true], ["i2", true]]);
    const rebuilt = resumeSession(list, attempts);

    assert.equal(rebuilt.round, 2);
    assert.deepEqual(rebuilt.queue, []);
    assert.deepEqual(rebuilt.repeat, []);
    assert.deepEqual([...rebuilt.passed].sort(), ["i1", "i2", "i3"]);
    assert.ok(isFinished(rebuilt));
});

test("an item still waiting to repeat is queued, not passed", () => {
    // i2 was answered wrongly in round 1 and has not been reached in round 2. It
    // belongs at the front of the queue — "0 left" while one question is still
    // unanswered is how an exercise page stays open after everything was tapped
    // once.
    const list = items(3);
    const { attempts } = run(list, [["i1", true], ["i2", false], ["i3", true]]);
    const rebuilt = resumeSession(list, attempts);

    assert.equal(rebuilt.round, 2);
    assert.deepEqual(rebuilt.queue, ["i2"]);
    assert.equal(progress(rebuilt, 3).remaining, 1);
    assert.ok(!isFinished(rebuilt));
    assert.equal(currentItem(rebuilt, list).id, "i2");
});

test("an exercise with no attempts resumes as a brand new one", () => {
    // The sync-merge case: a second device pulled the exercise and its items but
    // not yet the attempts. It must not open an exercise that is already half
    // done, and it must not crash on an undefined attempts argument.
    const list = items(2);
    assert.deepEqual(resumeSession(list), startSession(list));
    assert.deepEqual(resumeSession(list, []), startSession(list));
});

test("currentItem is null at the end and never an unknown id", () => {
    const list = items(1);
    const session = advance(startSession(list), { itemId: "i1", correct: true }).session;
    assert.equal(currentItem(session, list), null);
    // A queue naming an item the exercise does not have — a deleted question whose
    // tombstone has not synced — returns null rather than throwing on screen.
    assert.equal(currentItem({ queue: ["gone"] }, list), null);
});

test("progress counts the repeat as still unanswered", () => {
    // "0 left" with a wrong answer still pending is how an exercise page stays open
    // after the reader has answered everything once.
    const list = items(4);
    const { session } = run(list, [["i1", true], ["i2", false], ["i3", true], ["i4", true]]);

    const shown = progress(session, 4);
    assert.equal(shown.remaining, 1);
    assert.equal(shown.done, 3);
    assert.equal(shown.total, 4);
    assert.equal(shown.percent, 75);
    // Round 2, because answering i4 emptied the queue while i2 was still waiting to
    // repeat — and i2 is about to be asked again.
    assert.equal(shown.round, 2);

    // And at the end it reads 100%, not 99% from a rounding of 3/4.
    const all = run(list, [["i1", true], ["i2", true], ["i3", true], ["i4", true]]);
    assert.equal(progress(all.session, 4).percent, 100);
    // A zero-item exercise is 0 rather than a division by zero.
    assert.equal(progress(startSession([]), 0).percent, 0);
});

test("countKinds counts items, not rows", () => {
    // An exercise of three items where i2 was answered wrongly and then rightly
    // produces FOUR rows for THREE questions. Counting rows printed "3 new
    // questions" beside a header saying the exercise asked two, and neither figure
    // had a way to be checked against the other.
    const list = items(3);   // i1, i2 new; i3 review
    const attempts = [
        { id: "a1", itemId: "i1", round: 1, correct: true },
        { id: "a2", itemId: "i2", round: 1, correct: false },
        { id: "a3", itemId: "i2", round: 2, correct: true },
        { id: "a4", itemId: "i3", round: 1, correct: true }
    ];
    assert.deepEqual(countKinds(list, attempts), {
        new: 2, review: 1, newCorrect: 2, reviewCorrect: 1, firstTotal: 3, firstCorrect: 2
    });

    // i2 ended right, so it counts as right — the same "latest wins" rule the
    // session itself is rebuilt by.
    assert.equal(countKinds(list, attempts).new, 2);
    // An attempt for an item this exercise does not have counts as nothing: there
    // is no question behind it, so there is no question to have got right.
    const orphan = countKinds(list, [...attempts, { id: "a5", itemId: "nope", round: 1, correct: false }]);
    assert.equal(orphan.new + orphan.review, 3);
});

test("firstPass is the score, and it is not the average of every tap", () => {
    // One question shown five times until it stuck, and two known first time: three
    // questions, two right to begin with, and seven answers. The all-rounds figure
    // is 71% and hides the only thing the exercise existed to find.
    const list = [{ id: "i1" }, { id: "i2" }, { id: "i3" }];
    const attempts = [
        { id: "a1", itemId: "i1", round: 1, correct: true, answeredAt: 1000 },
        { id: "a2", itemId: "i2", round: 1, correct: true, answeredAt: 2000 },
        { id: "a3", itemId: "i3", round: 1, correct: false, answeredAt: 3000 },
        { id: "a4", itemId: "i3", round: 2, correct: false, answeredAt: 4000 },
        { id: "a5", itemId: "i3", round: 3, correct: false, answeredAt: 5000 },
        { id: "a6", itemId: "i3", round: 4, correct: false, answeredAt: 6000 },
        { id: "a7", itemId: "i3", round: 5, correct: true, answeredAt: 7000 }
    ];

    const out = firstPass(list, attempts);
    assert.equal(out.asked, 3);
    assert.equal(out.correct, 2);
    assert.equal(out.wrong, 1);
    assert.equal(out.reasks, 4);
    assert.equal(out.percent, 67);
    assert.deepEqual(out.wrongItemIds, ["i3"]);

    // An exercise abandoned half way is scored on what was asked, not on what it
    // would have contained — otherwise the reader is marked down for a question
    // they never saw.
    const partial = firstPass(list, attempts.slice(0, 2));
    assert.equal(partial.asked, 2);
    assert.equal(partial.percent, 100);
    assert.equal(partial.reasks, 0);
    assert.deepEqual(partial.wrongItemIds, []);

    // An attempt of an item this exercise does not have is not a question.
    const stray = firstPass(list, [...attempts, { id: "a8", itemId: "ghost", round: 1, correct: false, answeredAt: 8000 }]);
    assert.equal(stray.asked, 3);
    assert.equal(stray.reasks, 5);

    // An exercise with nothing in it is 100% rather than a division by zero, and
    // says it asked nothing.
    assert.deepEqual(firstPass([], []), {
        asked: 0, correct: 0, wrong: 0, reasks: 0, percent: 100, wrongItemIds: []
    });
});
/* -------------------------------------------------------------------------- */
/*                            the snapshot rule                                 */
/* -------------------------------------------------------------------------- */

// Everything above tests the QUEUE � which question is next, and when the session
// ends. What follows tests the other half of what a session is: the questions it is
// asking, which are inside the items and not looked up.

test("an item's question comes from the item, not from the question store", () => {
    // The item is the only input. There is no id to resolve and nothing to fetch, which
    // is the property the whole snapshot rests on: the session page cannot ask the
    // question store what to draw, so it cannot be surprised by what the store says.
    const [item] = items(1);
    const question = questionOf(item);
    assert.equal(question.text, "Question 1");
    assert.equal(question.kind, "single");
    assert.equal(question.id, "q1", "the id is a hint for reports, not a lookup key");
    assert.equal(question.options.length, 2);
    assert.equal(question.options[0].text, "right");
});

test("the option order in the copy is the order the reader saw", () => {
    // "The third option" has to mean the same thing in the editor, in the session, on
    // the other device and in next week's report. The copy keeps each option's stored
    // `order`, and `orderOptions` is the one function that sorts by it.
    const item = {
        questionId: "q1",
        questionText: "Q",
        questionKind: "multiple",
        options: [
            { id: "o3", text: "third", isCorrect: true, order: 2 },
            { id: "o1", text: "first", isCorrect: false, order: 0 },
            { id: "o2", text: "second", isCorrect: false, order: 1 }
        ]
    };
    const question = questionOf(item);
    assert.deepEqual(question.options.map((o) => o.text), ["first", "second", "third"]);
    assert.equal(question.kind, "multiple", "a multiple-choice copy must not read as single");
});

test("an item with no frozen copy is not drawable, and says so by being empty", () => {
    // The one item this app can produce that cannot be asked: one written before the
    // snapshot existed. It must NOT fall back to the live question, because that is
    // precisely the "the session changed under the reader" failure the copy prevents.
    // Empty is the honest answer, and `isDrawable` is what `repeat` filters on.
    const legacy = { id: "i1", questionId: "q1", kind: ITEM_KIND.NEW };
    assert.equal(isDrawable(legacy), false);
    assert.deepEqual(questionOf(legacy).options, []);
    assert.equal(questionOf(legacy).text, "");

    // Text with no options is just as undrawable: a question offering nothing cannot
    // be answered, and rendering it as a question would put a Next button beside an
    // empty list.
    assert.equal(isDrawable({ questionText: "Q", options: [] }), false);
    assert.equal(isDrawable({ questionText: "Q", options: [{ id: "o1", isCorrect: true }] }), true);
});

test("a question kind that is not multiple reads as single", () => {
    // The copy is written by a builder, but it is also written by a migration, and it
    // comes back from sync as whatever the other device stored. An unknown kind must
    // not reach the page as `undefined` and decide its own control: a wrong-kind
    // question that rendered as "tap one answer" when it has two correct options is a
    // question the reader cannot answer correctly.
    assert.equal(questionOf({ questionKind: "multiple" }).kind, "multiple");
    assert.equal(questionOf({ questionKind: "single" }).kind, "single");
    assert.equal(questionOf({}).kind, "single");
    assert.equal(questionOf({ questionKind: "nonsense" }).kind, "single");
});

test("the frozen options are a copy, not the same array", () => {
    // Structural sharing would be the cheaper implementation and the bug: the array
    // would be the question's own, so anything that sorted or spliced it would be
    // editing the question a later session is built from. The builder maps to a new
    // object per option for exactly this reason, and this is the assertion that keeps
    // somebody from "simplifying" it back.
    const source = [{ id: "o1", text: "a", isCorrect: true, order: 0 }];
    const item = {
        questionId: "q1",
        questionText: "Q",
        questionKind: "single",
        options: source.map((o) => ({ ...o }))
    };
    assert.notEqual(questionOf(item).options, source);
    assert.notEqual(questionOf(item).options[0], source[0]);
});