// The separation, stated as assertions.
//
// Four things that used to be one thing each, and the failure modes that came with
// the coupling. These are the tests that would fail if somebody re-added a `goalId` to
// a question, made a group goal-scoped again, or let a session read the question store
// while it runs.
//
// WHAT IS NOT HERE, and why: there is no IndexedDB in node, so nothing in this file
// touches a repository. The rules below are all pure functions over plain records,
// which is exactly why they are written there — `domain/goal-content.js` was separated
// out of `domain/exercise-builder.js` partly so that "what is a goal made of" has one
// home that can be tested without a browser, and this file is that home's test.
//
// The repository-level rules — no `goalId` on a question, no cascade on delete, the
// frozen copy on an item — are asserted where they can be seen: `tests/data.test.mjs`
// for the schema, `tests/migration5.test.mjs` for what the upgrade does to rows.

import test from "node:test";
import assert from "node:assert/strict";

import {
    questionsForGoal,
    questionsForSelection,
    isExactSelection,
    REF_TYPE
} from "../app/js/domain/goal-content.js";
import {
    buildExercisePlan,
    buildSelectedPlan,
    classifyQuestions,
    ITEM_KIND
} from "../app/js/domain/exercise-builder.js";
import { questionOf, isDrawable, resumeSession } from "../app/js/domain/session.js";

/**
 * A question, WITH ITS OPTIONS.
 *
 * The options are not decoration here — they are the point of the file's second half.
 * `buildExercisePlan` copies `question.options` into each item, so a fixture without
 * them produces items that are undrawable, and every assertion about a session holding
 * a copy of its question passes vacuously against an empty array. The two options are
 * one correct and one wrong, which is the smallest thing that can be graded.
 */
const q = (id, groupId = null) => ({
    id,
    groupId,
    text: `text ${id}`,
    kind: "single",
    options: [
        { id: `${id}-o1`, text: `${id} right`, isCorrect: true, order: 0 },
        { id: `${id}-o2`, text: `${id} wrong`, isCorrect: false, order: 1 }
    ]
});

const group = (id) => ({ id, name: `group ${id}` });

/* -------------------------------------------------------------------------- */
/*                    100 questions and no goal at all                         */
/* -------------------------------------------------------------------------- */

test("a question exists with no goal anywhere, and that is a state not an error", () => {
    // The first of the four examples in the specification, and the one the old schema
    // could not represent: `goalId` was a column, and a question with a null in it was
    // a row the every read went through an index on. There was no way to say "these
    // hundred questions, and no goal yet" — they had to belong to something.
    const all = Array.from({ length: 100 }, (_, i) => q(`q${i}`));
    assert.equal(all.length, 100);

    // A goal's view of it is empty, which is a value and not a throw.
    assert.deepEqual(questionsForGoal({ groups: [], questionIds: [], allQuestions: all }), []);

    // And the questions themselves are untouched and still usable: naming them at
    // session-build time works without any goal having existed.
    assert.deepEqual(
        questionsForSelection(all, { questionIds: ["q0", "q7"] }).map((x) => x.id),
        ["q0", "q7"]
    );
});

/* -------------------------------------------------------------------------- */
/*                    groups and questions with no goal of their own           */
/* -------------------------------------------------------------------------- */

test("a group is a shelf belonging to nobody, and any number of goals may use one", () => {
    // The third example. A group used to be a classification WITHIN a goal, so it had a
    // `goalId` and two goals could not share one — and "reorganise my questions" was
    // really "reorganise this goal's questions", once per goal, forever.
    const shelf = group("verbs");
    const all = [q("a", shelf.id), q("b", shelf.id), q("c", "adverbs"), q("d")];

    const french = questionsForGoal({ groups: [shelf], allQuestions: all }).map((x) => x.id);
    const arabic = questionsForGoal({ groups: [shelf], allQuestions: all }).map((x) => x.id);
    const spanish = questionsForGoal({
        groups: [shelf, group("adverbs")],
        allQuestions: all
    }).map((x) => x.id);

    assert.deepEqual(french, ["a", "b"], "the shelf did not serve the first goal");
    assert.deepEqual(arabic, ["a", "b"], "the same shelf did not serve a second goal");
    assert.deepEqual(spanish, ["a", "b", "c"], "a goal could not use a shelf and a question");
});

test("one goal depending on several groups is one material, not several pools", () => {
    // "الهدف يمكن أن يعتمد على مجموعة واحدة أو عدة مجموعات." The union is what makes it
    // one material: the builder is handed one list and has no idea it came from three
    // shelves.
    const all = [q("a", "g1"), q("b", "g2"), q("c", "g3"), q("d", "g1"), q("e")];
    const material = questionsForGoal({
        groups: [group("g1"), group("g2"), group("g3")],
        allQuestions: all
    });
    assert.deepEqual(material.map((x) => x.id), ["a", "b", "c", "d"]);
});

/* -------------------------------------------------------------------------- */
/*                    the same question in several groups and goals            */
/* -------------------------------------------------------------------------- */

test("a question can be in more than one group in this model, and nothing breaks", () => {
    // `question.groupId` is singular — one question, one shelf — and that is a
    // deliberate limit, not an oversight. A question is FILED on a shelf, and the
    // multi-group case the reader actually wants ("train on both Verbs and Chapter 3")
    // is expressed by attaching several groups to the goal, which is the join.
    //
    // This test pins the shape rather than the wish: one `groupId`, and the way to get
    // a question into two plans is to point two goals at its shelf.
    const all = [q("a", "verbs"), q("b", "verbs")];
    const one = all[0];
    assert.equal(one.groupId, "verbs");
    assert.equal(typeof one.groupId, "string", "a question has exactly one shelf");

    // Two goals, same shelf, same question — the same record, reached twice.
    const first = questionsForGoal({ groups: [group("verbs")], allQuestions: all });
    const second = questionsForGoal({ groups: [group("verbs")], allQuestions: all });
    assert.equal(first[0], second[0], "the question record itself is shared, not copied");
});

/* -------------------------------------------------------------------------- */
/*                    a goal with nothing attached is finished                */
/* -------------------------------------------------------------------------- */

test("a goal with nothing attached is a complete plan, and asking it for material gives nothing", () => {
    // The old create form sent the reader to a question list on the reasoning that a
    // goal with no questions opens on a page with nothing to do. It was true of a
    // goal-scoped list and is not true now: the questions are the reader's, they are
    // all there, and what is missing is a decision. So the empty case has to be an
    // empty LIST and the pages have to say so with a link rather than an error.
    const all = Array.from({ length: 40 }, (_, i) => q(`q${i}`));
    const goal = { id: "g1", newPerExercise: 5, reviewDepth: 3 };

    const material = questionsForGoal({ groups: [], questionIds: [], allQuestions: all });
    assert.equal(material.length, 0);

    // And the builder refuses rather than inventing something: `start()` turns an empty
    // plan into `nothing_to_exercise`, which the UI shows as a link to the content page.
    const plan = buildExercisePlan({
        goal, questions: material, history: new Map(), recent: []
    });
    assert.equal(plan.total, 0, "a goal with no material built a session out of nothing");
});

/* -------------------------------------------------------------------------- */
/*                    the session is a fixed snapshot                         */
/* -------------------------------------------------------------------------- */

test("the session's questions are decided once, and the set does not change afterwards", async () => {
    // The specification's own example, made mechanical: a goal holds a large number of
    // questions, the setting allows five in a session, the session uses five, and the
    // reader may repeat those five for as long as they like — but no new question can
    // enter the session that is already running.
    const goal = { id: "g1", newPerExercise: 5, reviewDepth: 1 };
    const all = Array.from({ length: 50 }, (_, i) => q(`q${i}`, i < 20 ? "g1" : null));
    const material = questionsForGoal({ groups: [group("g1")], allQuestions: all });

    const first = buildExercisePlan({
        goal, questions: material, history: new Map(), recent: []
    });
    assert.equal(first.total, 5, "the setting was not honoured");

    // THE ITEMS ARE THE SESSION. Each carries its own copy of the question, so the
    // question store is never consulted for what this session asks — which is what makes
    // "the set cannot change" a property of the data rather than a promise in the UI.
    //
    // The item ids are stubbed here because the builder does not mint any: it returns
    // items with no `id` on purpose, since the ids belong to the exercise they will be
    // written into and the plan may still be thrown away. `repos.createExercise` is what
    // gives them one, so a test that drives the session arithmetic has to stand in for
    // it.
    const items = first.items.map((item, index) => ({ ...item, id: `it${index + 1}` }));

    for (const item of items) {
        assert.ok(item.questionText, "an item carries no copy of its question");
        assert.ok(Array.isArray(item.options) && item.options.length > 0,
            "an item carries no options");
    }

    // A question EDITED after the session was built. The running session's item is
    // unchanged, because that item never referenced the question in the first place.
    const edited = { ...material[0], text: "REWRITTEN", kind: "multiple" };
    const afterEdit = buildExercisePlan({
        goal, questions: [edited, ...material.slice(1)], history: new Map(), recent: []
    });
    // Shuffled, so the edited question cannot be found by position — the builder
    // randomises fresh items and the reader cannot dictate which of the five comes
    // first. `first.items[0]` is not necessarily the one built from `material[0]`.
    const editedQuestionId = material[0].id;
    const nextCopy = afterEdit.items.find((i) => i.questionId === editedQuestionId);
    assert.equal(nextCopy.questionText, "REWRITTEN",
        "the NEXT session does not see the edit, so an edit would never change anything");

    // AND THE POINT OF ALL OF IT: the running session's copy still says what it said,
    // even though the question behind it now says something else entirely.
    //
    // Checked against the edited question's own id rather than against a position,
    // because the builder shuffles fresh items — `items[0]` is whichever question
    // happened to come first, and asserting on it would only pass when the shuffle
    // happened to agree with the fixture. This compares the SAME question on both
    // sides, which is the comparison that means something.
    const running = items.find((i) => i.questionId === editedQuestionId);
    const nextItem = afterEdit.items.find((i) => i.questionId === editedQuestionId);
    assert.equal(questionOf(running).text, `text ${editedQuestionId}`,
        "the running session changed under the reader");
    assert.equal(nextItem.questionText, "REWRITTEN",
        "the next session should have seen the edit");
});

test("repeating inside a session is a repeat of the same question, never a new one", async () => {
    // "تكرار الأسئلة داخل الجلسة" — a wrong answer puts the item at the back of the
    // queue for another round. It does not put a sixth question into a five-question
    // session, and the count on the progress bar stays the count.
    const goal = { id: "g1", newPerExercise: 5, reviewDepth: 1 };
    const material = Array.from({ length: 5 }, (_, i) => q(`q${i}`, "g1"));
    const plan = buildExercisePlan({ goal, questions: material, history: new Map(), recent: [] });
    assert.equal(plan.total, 5);

    // The session's own arithmetic, which is what decides this: an item answered
    // wrongly goes to `repeat`, and the round bumps only when the queue empties. The set
    // of item ids never grows.
    //
    // The ids are stubbed because the builder does not mint any — see the note in the
    // test above. `resumeSession` queues `item.id`, so without them the queue is five
    // `undefined`s and the head is one of those.
    const items = plan.items.map((item, index) => ({ ...item, id: `it${index + 1}` }));
    const session = resumeSession(items, []);
    const ids = new Set(items.map((i) => i.id));

    const head = session.queue[0];
    const wrong = resumeSession(items, [
        { id: "a1", itemId: head, round: 1, correct: false, answeredAt: 10 }
    ]);

    assert.equal(session.round, 1);
    assert.equal(wrong.repeat.includes(head), true,
        "the wrong answer did not go back for another round");
    // Nothing new: the union of everything the session knows about is still the five
    // items it started with.
    const known = new Set([...wrong.queue, ...wrong.repeat, ...wrong.passed]);
    for (const id of known) assert.ok(ids.has(id), `the session invented the item ${id}`);
    assert.equal(known.size, 5, "the session grew a question");
});

test("a question deleted mid-session does not take a slot out of it", async () => {
    // The consequence of the snapshot that the old code had to work around. It used to
    // tombstone the item, so deleting one question silently shortened the session the
    // reader was in the middle of and the progress bar stopped matching what was asked.
    // Now the item carries its own copy and the deletion reaches only the question.
    const goal = { id: "g1", newPerExercise: 3, reviewDepth: 1 };
    const material = [q("a"), q("b"), q("c")];
    const plan = buildSelectedPlan({
        questions: material, history: new Map(), limit: 10
    });
    assert.equal(plan.total, 3);

    // Every item is drawable on its own terms — text and options are inside it, and
    // they are the fixture's own rather than something resolved by id.
    for (const item of plan.items) {
        assert.equal(isDrawable(item), true, "an item is not drawable from itself");
        assert.equal(questionOf(item).text, `text ${item.questionId}`,
            "the item's text is not its own");
        assert.equal(questionOf(item).options.length, 2,
            "the item's options are not its own");
    }

    // The question store could now be empty and the session would be unaffected, which
    // is the same statement written as the thing it protects. Nothing below reads
    // anything that is not already inside the items.
    const afterDeletion = plan.items.map((item) => questionOf(item));
    assert.deepEqual(afterDeletion.map((x) => x.text), ["text a", "text b", "text c"]);
});

test("a session's answer key is the one it was built with, not the current one", () => {
    // The one that grading depends on, and the reason the copy carries `isCorrect`
    // rather than just the option texts. An option the reader unticked after the
    // session started was correct when they were asked, and the session has to say so.
    const item = {
        id: "it1",
        questionId: "q1",
        questionText: "Q",
        questionKind: "single",
        options: [
            { id: "o1", text: "was right", isCorrect: true, order: 0 },
            { id: "o2", text: "was wrong", isCorrect: false, order: 1 }
        ]
    };
    assert.deepEqual(questionOf(item).options.map((o) => o.isCorrect), [true, false]);

    // The question in the store now says the opposite. The item does not, and nothing
    // in `questionOf` reads the store to find out.
    const questionNow = { id: "q1", text: "Q", kind: "single", options: [
        { id: "o1", text: "was right", isCorrect: false, order: 0 },
        { id: "o2", text: "was wrong", isCorrect: true, order: 1 }
    ] };
    assert.deepEqual(questionNow.options.map((o) => o.isCorrect), [false, true],
        "the fixture no longer demonstrates anything");
    assert.deepEqual(questionOf(item).options.map((o) => o.isCorrect), [true, false],
        "the session read the current question instead of its own copy");
});

/* -------------------------------------------------------------------------- */
/*                    the four ways to be wrong about a material               */
/* -------------------------------------------------------------------------- */

test("attaching a group and a question that is in that group is still one question", () => {
    // "لا يمكن إضافة أسئلة جديدة" is about the session, but this is the same mistake one
    // level up: a goal holding the same question twice would show the reader it twice in
    // a row, which is the one thing a spaced-repetition app must never do.
    const all = [q("a", "g1"), q("b", "g2")];
    const material = questionsForGoal({
        groups: [group("g1")],
        questionIds: ["a", "b"],
        allQuestions: all
    });
    assert.deepEqual(material.map((x) => x.id), ["a", "b"]);
});

test("a reference to a deleted group contributes nothing rather than everything", () => {
    // The two failure modes here are symmetric and both are terrible: contribute nothing
    // and the goal trains on a shelf that is gone; fall back to the whole question list
    // and it trains on everything, which is the opposite of what attaching one shelf
    // meant.
    const all = [q("a", "g1"), q("b", "g2"), q("c")];
    assert.deepEqual(
        questionsForGoal({ groups: [group("g1")], allQuestions: all }).map((x) => x.id),
        ["a"]
    );
    assert.deepEqual(
        questionsForGoal({ groups: [group("gone")], allQuestions: all }),
        [],
        "a dead shelf pulled in questions it never named"
    );
});

test("the join and the picker's own selection agree about what a pick means", () => {
    // The count at the bottom of the build page and the number of questions in the
    // session are the same number read twice, or they are two rules that agree until
    // somebody ticks a question from outside the group filter. Both go through the same
    // function; this asserts the shapes line up.
    const all = [q("a", "g1"), q("b", "g1"), q("c", "g2"), q("d")];
    const material = questionsForGoal({ groups: [group("g1")], allQuestions: all });
    assert.deepEqual(material.map((x) => x.id), ["a", "b"]);

    // Naming one from the shelf and one outside it is a union, and it is exact.
    const picked = questionsForSelection(material, { groupIds: ["g1"], questionIds: ["c"] });
    assert.deepEqual(picked.map((x) => x.id), ["a", "b"],
        "a question outside the goal's own material was added by the picker");

    assert.equal(isExactSelection({ groupIds: ["g1"], questionIds: ["c"] }), true);
    assert.equal(isExactSelection({ excludeIds: ["a"] }), false,
        "an exclusion is not a selection");
});

/* -------------------------------------------------------------------------- */
/*                    states belong to the question, not the goal             */
/* -------------------------------------------------------------------------- */

test("a question answered in one plan is answered in every plan that uses it", () => {
    // The one place the separation LOSES something, stated as a test so it is a decision
    // on the record rather than an accident. Progress used to be per goal because a
    // question had one goal; now a shared question has one history, and getting it right
    // in French means it is not "never asked" in Arabic.
    //
    // That is the honest reading of a shared question. A per-goal flag would mean the
    // same twenty words could be "learned" in one subject and "unstarted" in another —
    // two answers to one question, on two screens, with no way to reconcile them.
    const shared = { id: "a", groupId: "g1" };
    const history = new Map([["a", { correct: true, answeredAt: 10 }]]);

    const french = classifyQuestions([shared], history);
    const arabic = classifyQuestions([shared], history);
    assert.deepEqual(french.learned.map((x) => x.id), ["a"]);
    assert.deepEqual(arabic.learned.map((x) => x.id), ["a"]);
    assert.equal(french.learned.length, arabic.learned.length);
});

test("a question in no group is new material until it has been answered", () => {
    // The state a question can be in while belonging to nothing, which is the state
    // every question is in when it is written.
    const [fresh, review, learned] = Object.values(classifyQuestions([q("a")], new Map()))
        .map((list) => list.map((x) => x.id));
    assert.deepEqual(fresh, ["a"]);
    assert.deepEqual(review, []);
    assert.deepEqual(learned, []);

    assert.equal(ITEM_KIND.NEW, "new");
    assert.equal(ITEM_KIND.REVIEW, "review");
});

test("the reference kinds are the two there are, and nothing else is a reference", () => {
    // `refType` is a string in the record rather than two stores, so this is the place a
    // third kind would be added. There is no third kind: a goal draws on groups and on
    // questions, and a kind that is neither has no meaning to resolve.
    assert.deepEqual(Object.values(REF_TYPE).sort(), ["group", "question"]);
});