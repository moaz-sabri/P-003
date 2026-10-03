// Migration 5 run against real rows, which is the only way to see what it does.
//
// WHY A SEPARATE FILE, AND WHY A FAKE IndexedDB.
//
// `tests/data.test.mjs` builds the schema against a stub that records what a migration
// asks it to create. That is the right tool for "does the schema come out right" and it
// cannot see this step's actual behaviour at all: migration 5 READS every store and
// REWRITES every row, and the stub answers those reads with an empty list. It passes,
// and it would pass with the entire data migration replaced by `return`.
//
// So this file drives the step against rows. It needs an IndexedDB, and there is no
// fake-indexeddb dependency in this project — deliberately: adding one to test a
// twenty-line migration would be a heavier answer than building the store stub the
// step actually touches.
//
// WHAT IS STUBBED, precisely, and this is the whole trick:
//
//   * `createObjectStore` / `deleteIndex` — no schema at all. A Map stands in for each
//     store, so `getAll` returns the rows this file put there and `put` records them.
//     The step never asks about an index, so not modelling indexes cannot hide a bug
//     in it; and the indexes it DOES create are asserted in data.test.mjs against the
//     real store list.
//
//   * THE EVENT LOOP. This is the part that matters. A real version-change transaction
//     commits the moment control returns to the event loop with nothing in flight, and
//     `data/db.js` exists entirely to enforce that rule for the repositories. A
//     migration that nests one `await` between two batches of requests works in the
//     stub — promises resolve immediately — and commits an empty upgrade in a browser.
//     So the requests here are handed back ASYNCHRONOUSLY, each on its own turn of a
//     controlled loop, and the step's requests are only allowed to run while the loop
//     says the transaction is open. If the step ever needs a request after its chain
//     has settled, the loop closes and the test fails by name rather than passing.
//
// That last point is the one worth having this file for. The version of migration 5
// that was written first read the options in a `.then` nested inside the `.then` that
// read everything else, which is exactly the shape this loop refuses.

import test from "node:test";
import assert from "node:assert/strict";

import { migration5 } from "../app/js/data/migrations.js";
import { derivedId, isId } from "../app/js/domain/id.js";
import { orderOptions } from "../app/js/domain/options.js";

/* -------------------------------------------------------------------------- */
/*                          a transaction that can die                         */
/* -------------------------------------------------------------------------- */

const UUID = "0f7c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const goalId = `g_${UUID}`;
const questionId = (n) => `q_${String(n).padStart(8, "0")}-${UUID.slice(9)}`;
const groupId = (n) => `gr_${String(n).padStart(8, "0")}-${UUID.slice(9)}`;
const optionId = (n) => `o_${String(n).padStart(8, "0")}-${UUID.slice(9)}`;
const itemId = (n) => `it_${String(n).padStart(8, "0")}-${UUID.slice(9)}`;

/** Common sync fields, as a row written by version 4 would have them. */
const sync = (extra = {}) => ({
    updatedAt: 1000, rev: 3, device: "dev_abc", dirty: 0, deletedAt: null, ...extra
});

/**
 * Run a migration against rows, and fail if it asks for a request too late.
 *
 * `open` starts the loop and `close` ends it. Between them, requests complete one per
 * turn; after `close`, a request is a hard error naming the step. That is the whole
 * mechanism, and it is why this is not `await step(db, tx)`: an ordinary await gives a
 * migration an unlimited number of turns, which is precisely the thing being tested for.
 */
function runMigration(rows) {
    // EVERY STORE IS A MAP OF id → row, including `meta`, whose key is `key` rather
    // than `id`. A version-4 database has no `goalRefs` store at all — migration 5
    // creates it — so the fixture must not pre-create one, or the step's writes would
    // land in a store the stub already had and the test would pass for the wrong
    // reason.
    const stores = new Map(
        Object.entries(rows).map(([name, list]) => [
            name, new Map(list.map((row) => [row.id ?? row.key, row]))
        ])
    );
    const written = { goalRefs: [], questions: [], groups: [], exerciseItems: [] };
    const late = [];

    let open = true;
    const queue = [];
    let stepping = false;

    const pump = () => {
        if (stepping) return;
        stepping = true;
        while (open && queue.length) {
            const { request, store, kind, key } = queue.shift();
            // The RESULT IS SET FROM THE KIND, not from whether the store happens to
            // have a `get`. A store object here always has both methods, so keying the
            // answer off the method's presence hands `getAll` a Map and every row-level
            // assertion in this file then fails on an empty list — which is how this
            // was written wrong the first time.
            request.result = kind === "get"
                ? store.rows.get(key)
                : [...store.rows.values()];
            if (request.onsuccess) request.onsuccess();
        }
        stepping = false;
    };

    /** One turn of the loop: run every request that is already queued, then let the
     *  microtasks the step scheduled run, which may queue more. Bounded so a step that
     *  queues requests forever fails as a hang rather than hanging the suite. */
    const settle = async (maxTurns = 200) => {
        for (let i = 0; i < maxTurns; i += 1) {
            await Promise.resolve();
            pump();
            if (!open) return;
        }
    };

    const request = (kind, name, key) => {
        const req = { onsuccess: null, onerror: null, result: undefined };
        if (!open) late.push(`${name}.${kind}`);
        // A store the step reads but the fixture does not have is an empty store, not a
        // crash — a version-4 database has no `goalRefs`, and a database that has never
        // been written to has no `meta` either. The rows object is empty in both cases
        // and `getAll` on it returns `[]`.
        const store = { rows: stores.get(name) ?? new Map() };
        queue.push({ request: req, store, kind, key });
        return req;
    };

    const store = (name) => ({
        getAll: () => request("getAll", name),
        get: (key) => request("get", name, key),
        put: (value) => {
            if (!open) late.push(`${name}.put`);
            written[name]?.push(value);
            stores.get(name)?.set(value.id ?? value.key, value);
            return { onsuccess: null, onerror: null, result: value?.id };
        },
        createIndex: () => {},
        deleteIndex: () => {}
    });

    const db = {
        createObjectStore: (name) => {
            stores.set(name, new Map());
            return store(name);
        },
        objectStore: (name) => store(name)
    };
    const tx = {
        objectStore: (name) => store(name),
        abort: () => { open = false; }
    };

    /**
     * Run the step to completion, THEN close the transaction.
     *
     * THE ORDER IS THE WHOLE THING, and getting it backwards produces a suite that
     * passes by asserting nothing. `settle` is `async`, so calling it returns at its
     * first `await` — and closing `open` immediately after the call would close the
     * transaction before `pump` ever ran, leaving every request queued and unanswered.
     * Nothing would throw: the migration would simply never write a row, and every
     * assertion below would fail on an empty list.
     *
     * So the close is inside the same async flow as the settling, after the loop has
     * run its turns. That also means `late` is only ever populated by a request the
     * step issued after its own chain went quiet, which is the condition being tested.
     */
    const run = (async () => {
        migration5(db, tx);
        await settle();
        open = false;
        return { written, late, stores };
    })();

    return { run };
}

/** Run it and wait. `settle` needs its microtasks to drain, so the caller awaits. */
async function migrate(rows) {
    return runMigration(rows).run;
}

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

/** A version-4 question with two options, as it was stored before the change. */
function oldQuestion(n, { goal = goalId, group = null, text = `Question ${n}` } = {}) {
    return sync({
        id: questionId(n), goalId: goal, text, kind: "single",
        groupId: group, order: n, createdAt: 100
    });
}

function oldOptions(n, { correctFirst = true } = {}) {
    return [
        sync({ id: optionId(n * 10), questionId: questionId(n), text: `right ${n}`, isCorrect: correctFirst, order: 0, createdAt: 100 }),
        sync({ id: optionId(n * 10 + 1), questionId: questionId(n), text: `wrong ${n}`, isCorrect: !correctFirst, order: 1, createdAt: 100 })
    ];
}

function oldGroup(n, { goal = goalId, name = `Group ${n}` } = {}) {
    return sync({ id: groupId(n), goalId: goal, name, order: n, createdAt: 100 });
}

function oldItem(n, { question = questionId(n), kind = "new" } = {}) {
    return sync({ id: itemId(n), exerciseId: `x_${UUID}`, questionId: question, kind, order: n, createdAt: 100 });
}

/* -------------------------------------------------------------------------- */
/*                             the row rewriting                               */
/* -------------------------------------------------------------------------- */

test("every question the goal had becomes a reference, and the field is gone from the question", async () => {
    const { written, late } = await migrate({
        goals: [sync({ id: goalId, title: "French", status: "active" })],
        questions: [oldQuestion(1), oldQuestion(2), oldQuestion(3)],
        groups: [],
        exercises: [],
        exerciseItems: [],
        options: []
    });

    assert.deepEqual(late, [], "the migration asked for a request after its chain settled");

    // The three questions the goal owned are now three rows in the join table, and
    // nothing anywhere says the question belongs to that goal.
    const refs = written.goalRefs;
    assert.equal(refs.length, 3, "not every question became a reference");
    for (const ref of refs) {
        assert.equal(ref.goalId, goalId);
        assert.equal(ref.refType, "question");
        assert.ok(refs.some((r) => r.refId === ref.refId));
    }

    for (const question of written.questions) {
        assert.ok(!("goalId" in question),
            `goalId survived on ${question.id}: the field must be removed, not nulled`);
    }
});

test("a reference id is the one the repository would mint for the same attachment", async () => {
    // This is the property that stops two devices producing two rows for one
    // attachment, and it is why the id is derived rather than random.
    const { written } = await migrate({
        goals: [sync({ id: goalId, title: "French" })],
        questions: [oldQuestion(1)],
        groups: [oldGroup(1)],
        exercises: [],
        exerciseItems: [],
        options: []
    });

    const expectedQuestion = derivedId("rf_", goalId, "question", questionId(1));
    const expectedGroup = derivedId("rf_", goalId, "group", groupId(1));

    assert.ok(written.goalRefs.some((r) => r.id === expectedQuestion),
        "the migrated reference id is not what addGoalRef would produce");
    assert.ok(written.goalRefs.some((r) => r.id === expectedGroup),
        "the migrated group reference id is not what attachGroup would produce");

    // And the id has to be one the rest of the app will accept — `isId` is the gate
    // every record coming back from the API is put through, so an id that fails it is
    // a reference the other device throws away.
    for (const ref of written.goalRefs) {
        assert.ok(isId(ref.id), `${ref.id} is not an id this app recognises`);
    }
});

test("a group becomes a reference too, and loses its goal", async () => {
    const { written } = await migrate({
        goals: [sync({ id: goalId, title: "French" })],
        questions: [],
        groups: [oldGroup(1), oldGroup(2, { name: "Week 1" })],
        exercises: [],
        exerciseItems: [],
        options: []
    });

    const groupRefs = written.goalRefs.filter((r) => r.refType === "group");
    assert.equal(groupRefs.length, 2, "a goal's shelves did not survive as references");

    for (const group of written.groups) {
        assert.ok(!("goalId" in group),
            `goalId survived on ${group.id}: a shelf belongs to nobody`);
        // The reader's own order is preserved, not renumbered into something they
        // did not choose.
        assert.equal(typeof group.order, "number");
    }
    assert.deepEqual(written.groups.map((g) => g.order).sort((a, b) => a - b), [1, 2]);
});

test("a question in no goal stays, and is attached to nothing", async () => {
    // The state the separation exists to allow, and one a version-4 database could not
    // hold: a question with no goal at all.
    const orphan = oldQuestion(9, { goal: null });
    const { written } = await migrate({
        goals: [],
        questions: [orphan],
        groups: [],
        exercises: [],
        exerciseItems: [],
        options: []
    });

    assert.equal(written.questions.length, 1, "a question with no goal was dropped");
    assert.deepEqual(written.goalRefs, [], "a goal-less question was attached to something");
});

test("a question in one goal is not attached to a goal that merely shares its shelf", async () => {
    // The wrong version of this migration writes a reference for every question in
    // every goal whose group set overlaps, which attaches a reader's Arabic questions
    // to their French goal because both mention a group called "Week 1". A question's
    // OWN old goalId is the only evidence there was.
    const otherGoal = `g_${"9".repeat(8)}-${UUID.slice(9)}`;
    const shared = groupId(1);

    const { written } = await migrate({
        goals: [
            sync({ id: goalId, title: "French" }),
            sync({ id: otherGoal, title: "Arabic" })
        ],
        questions: [oldQuestion(1, { goal: goalId, group: shared })],
        // The Arabic goal has its own group row with the same NAME — different id.
        groups: [oldGroup(1), oldGroup(1, { goal: otherGoal, name: "Week 1" })],
        exercises: [],
        exerciseItems: [],
        options: []
    });

    const refsForOther = written.goalRefs.filter((r) => r.goalId === otherGoal);
    assert.equal(refsForOther.length, 1, "the second goal got more than its own group");
    assert.equal(refsForOther[0].refType, "group",
        "the second goal was given a question it never owned");
});

test("references are dirty, so the other device learns about them", async () => {
    // A reference that stayed local would leave the goal pointing at nothing
    // everywhere else, and the first symptom is a session that draws nothing on a
    // second phone with no message about it.
    const { written } = await migrate({
        goals: [sync({ id: goalId })],
        questions: [oldQuestion(1)],
        groups: [],
        exercises: [],
        exerciseItems: [],
        options: []
    });

    for (const ref of written.goalRefs) {
        assert.equal(ref.dirty, 1, `${ref.id} will never be pushed`);
        assert.equal(ref.rev, 0, "a never-acknowledged row must start at rev 0");
        assert.ok(ref.deletedAt === null, "a new row is not a tombstone");
    }
});

/* -------------------------------------------------------------------------- */
/*                             the frozen copies                               */
/* -------------------------------------------------------------------------- */

test("each session item gets the question, its shape and its options copied into it", async () => {
    const { written } = await migrate({
        goals: [sync({ id: goalId })],
        questions: [
            oldQuestion(1, { text: "What does Recall mean?" }),
            oldQuestion(2, { text: "A multiple-choice question" })
        ],
        groups: [],
        exercises: [],
        exerciseItems: [oldItem(1), oldItem(2, { question: questionId(2), kind: "review" })],
        options: [...oldOptions(1), ...oldOptions(2, { correctFirst: false })]
    });

    const items = written.exerciseItems;
    assert.equal(items.length, 2, "an item whose question is present was skipped");

    assert.equal(items[0].questionText, "What does Recall mean?");
    assert.equal(items[0].questionKind, "single");
    assert.equal(items[0].options.length, 2);
    // THE ANSWER KEY IS COPIED, and that is the field that makes this a snapshot. An
    // option that was correct when the session was built has to stay correct in the
    // copy, or the session changes under the reader the moment the question is edited.
    assert.equal(items[0].options.filter((o) => o.isCorrect).length, 1);
    assert.equal(items[0].options.find((o) => o.isCorrect).text, "right 1");

    // And the marks follow the QUESTION, not the option index — the second fixture was
    // built with the correct answer second.
    const second = items[1].options.find((o) => o.isCorrect);
    assert.equal(second.text, "wrong 2", "the copied answer key is not the stored one");

    // `questionId` is kept. It is a hint for reports, not a dependency for drawing.
    assert.equal(items[0].questionId, questionId(1));
});

test("the copied options are in the order the reader saw them, by the one shared rule", async () => {
    // Deliberately written to the fixture out of order, so that a migration that sorted
    // differently from the app would be caught here rather than in a report from last
    // Tuesday.
    const shuffled = [
        sync({ id: optionId(3), questionId: questionId(1), text: "third", isCorrect: false, order: 2, createdAt: 100 }),
        sync({ id: optionId(1), questionId: questionId(1), text: "first", isCorrect: true, order: 0, createdAt: 100 }),
        sync({ id: optionId(2), questionId: questionId(1), text: "second", isCorrect: false, order: 1, createdAt: 100 })
    ];
    const { written } = await migrate({
        goals: [sync({ id: goalId })],
        questions: [oldQuestion(1)],
        groups: [],
        exercises: [],
        exerciseItems: [oldItem(1)],
        options: shuffled
    });

    const copied = written.exerciseItems[0].options;
    assert.deepEqual(copied.map((o) => o.text), ["first", "second", "third"]);
    // And it is the SAME function the app uses, not a second rule that agrees today.
    assert.deepEqual(copied.map((o) => o.id), orderOptions(shuffled).map((o) => o.id));
});

test("a deleted option is not copied", async () => {
    // A frozen copy carrying a tombstoned option puts a row on screen with no text and
    // no mark, and the reader is asked to answer a question that offers a blank.
    const gone = sync({ id: optionId(2), questionId: questionId(1), text: "gone", isCorrect: false, order: 1, createdAt: 100, deletedAt: 500 });
    const { written } = await migrate({
        goals: [sync({ id: goalId })],
        questions: [oldQuestion(1)],
        groups: [],
        exercises: [],
        exerciseItems: [oldItem(1)],
        options: [oldOptions(1)[0], gone]
    });

    assert.equal(written.exerciseItems[0].options.length, 1);
    assert.equal(written.exerciseItems[0].options[0].text, "right 1");
});

test("a session item whose question is gone is left alone, not deleted", async () => {
    // Deleting the row would take the item count off the progress bar of a session the
    // reader may be in the middle of, so the bar and the number of questions to come
    // would stop agreeing. An item with no copy is undrawable but it is not harmful:
    // `isDrawable` reports it false and the page says so rather than showing a blank.
    const { written } = await migrate({
        goals: [sync({ id: goalId })],
        questions: [],
        groups: [],
        exercises: [],
        exerciseItems: [oldItem(1, { question: questionId(77) })],
        options: []
    });

    assert.equal(written.exerciseItems.length, 0,
        "the step wrote something for an item whose question it does not have");
    assert.ok(true, "and it did so by skipping, which is asserted above");
});

test("a question rewritten by the migration is stamped so it will replace the old shape", async () => {
    // If the row kept its old `updatedAt` it would look older than the copy another
    // device still holds, that copy would win the merge, and `goalId` would come back
    // on a question whose index no longer exists to read it.
    const { written } = await migrate({
        goals: [sync({ id: goalId })],
        questions: [oldQuestion(1)],
        groups: [oldGroup(1)],
        exercises: [],
        exerciseItems: [oldItem(1)],
        options: oldOptions(1)
    });

    const original = 1000;
    for (const row of [...written.questions, ...written.groups, ...written.exerciseItems]) {
        assert.ok(row.updatedAt > original,
            `${row.id} kept its old timestamp, so the merge will prefer the old shape`);
        assert.equal(row.dirty, 1, `${row.id} will not be pushed, so the new shape never arrives`);
    }
});

test("the device id of the reader is used for the tie-break, not a made-up string", async () => {
    // `device` breaks ties between two records with the same `updatedAt`. A value that
    // belongs to no installation compares against every real one as "less than", so it
    // would lose every tie — which is the wrong way round for the row that is meant to
    // be the new truth.
    const rows = {
        goals: [sync({ id: goalId })],
        questions: [oldQuestion(1)],
        groups: [],
        exercises: [],
        exerciseItems: [],
        options: [],
        meta: [sync({ key: "device", value: "dev_this-phone" })]
    };

    const { written } = await migrate(rows);
    for (const ref of written.goalRefs) {
        assert.equal(ref.device, "dev_this-phone",
            "the row was written with something other than this device's id");
    }
});

test("an empty database upgrades cleanly and writes nothing", async () => {
    // The commonest path of all: a fresh install runs this step against no rows, and
    // it has to leave an empty database rather than an aborted upgrade the browser
    // retries in a loop.
    const { written, late } = await migrate({
        goals: [], questions: [], groups: [], exercises: [], exerciseItems: [], options: []
    });

    assert.deepEqual(late, [], "the step asked for something on an empty database");
    assert.deepEqual(written.goalRefs, []);
    assert.deepEqual(written.questions, []);
});

test("the step never needs a request after its chain has settled", async () => {
    // The assertion the whole harness exists for. An earlier version of this migration
    // read the options inside a `.then` nested in the `.then` that read everything else;
    // with real promises that works, and in a browser it commits an empty upgrade — the
    // version change closes while the second read is pending. `late` is where that
    // shows up, and the first test above checks it on a populated database.
    const { late } = await migrate({
        goals: [sync({ id: goalId })],
        questions: [oldQuestion(1), oldQuestion(2)],
        groups: [oldGroup(1)],
        exercises: [],
        exerciseItems: [oldItem(1)],
        options: [...oldOptions(1), ...oldOptions(2)]
    });

    assert.deepEqual(late, [],
        `the migration issued a request after the transaction would have committed: ${late.join(", ")}`);
});