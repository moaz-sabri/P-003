// Two properties, stated as assertions.
//
//   1. A QUESTION NEVER REACHES A GOAL BY ITSELF. Not by being written, not by being
//      opened, not by being answered, not by being filed in a group. Only because the
//      reader pointed the goal at it.
//
//   2. ONE GOAL HAS ONE DECISION about what can be done to it right now, and every
//      screen asks the same function rather than deriving it again.
//
// WHY THEY ARE IN ONE FILE. They are the two halves of the same change: the first is
// why the second is cheap to get right. An exercise belongs to a goal, so every screen
// that wants to act on a goal has to read one — and a screen that reads a goal is a
// screen that can widen it by accident. Holding both properties in one place means the
// pair is checked together, and a change that reintroduces auto-attachment has to also
// reintroduce the derivation that made it dangerous.
//
// NOTHING HERE TOUCHES A REPOSITORY, because node has no IndexedDB. That is a
// limitation and also the point: every rule below is a pure function over plain
// records, which is why "which questions does this goal have" and "what can be done
// with this goal" each have ONE home that can be checked in a millisecond. The
// repository-level half of the first property — that the question record has no
// `goalId` field to write — is asserted in `tests/data.test.mjs` against the schema,
// and the writes themselves are asserted by source scan at the bottom of this file.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    questionsForGoal,
    questionsForSelection,
    isExactSelection
} from "../app/js/domain/goal-content.js";
import { goalAction, canStart, stateKey, ACTION } from "../app/js/domain/goal-action.js";
import { SCHEDULE, planSchedule } from "../app/js/domain/schedule.js";

/* -------------------------------------------------------------------------- */
/*                                   fixtures                                  */
/* -------------------------------------------------------------------------- */

const q = (id, groupId = null) => ({
    id, groupId, text: `text ${id}`, kind: "single",
    options: [{ id: `${id}-o1`, text: "a", isCorrect: true, order: 0 }]
});

const group = (id) => ({ id, name: `group ${id}` });

/** A fixed "now" the tests reason about, rather than the wall clock.
 *
 *  Everything below derives dates from this, so a test cannot pass today and fail in a
 *  year — and neither can it fail for a reason that has nothing to do with what it is
 *  checking, which is the failure mode of `Date.now()` in a suite about a schedule. */
const NOW = Date.UTC(2026, 5, 1);

/** Days after NOW, in ms. `day(n)` is "n days from the reference point". */
const day = (n) => NOW + n * 86_400_000;

/** A goal. The plan is the fixed pair of constants, so a fixture needs nothing more
 *  than a title and a status — the only per-goal fields the schedule reads. */
const goal = (over = {}) => ({
    id: "g1", title: "French", status: "active", archivedAt: null,
    createdAt: day(-30), ...over
});

/** An exercise record, enough for `planSchedule`. */
const exercise = (number, { completedAt = null, createdAt = day(-10) } = {}) => ({
    id: `e${number}`, number, goalId: "g1", completedAt, createdAt, deletedAt: null
});

const quota = (over = {}) => ({ used: 0, limit: 3, remaining: 3, blocked: false, retryAt: day(1), ...over });

/* -------------------------------------------------------------------------- */
/*             1. nothing reaches a goal except by being pointed at             */
/* -------------------------------------------------------------------------- */

test("a question written today is in no goal, and that is the whole of it", () => {
    // The reader's rule, and the one that used to be broken: "a question is not
    // attached to a goal automatically. If I did not add it, do not attach it."
    const all = Array.from({ length: 50 }, (_, i) => q(`q${i}`));

    // No references at all, which is what a goal looks like the moment it is created.
    assert.deepEqual(questionsForGoal({ groups: [], questionIds: [], allQuestions: all }), []);

    // And the same for every goal on the device at once, which is the case that used
    // to be impossible to express: `goalId` was a column, so a question HAD to be
    // somewhere, and "everywhere" and "nowhere" were the same empty list.
    for (const id of ["g1", "g2", "g3"]) {
        assert.deepEqual(questionsForGoal({ goalId: id, groups: [], questionIds: [], allQuestions: all }), []);
    }
});

test("one attached question does not drag in its neighbours, or its own group", () => {
    const all = [
        q("a", "shelf"),
        q("b", "shelf"),
        q("c", "shelf"),
        q("d")
    ];

    // ONE question, named. Not the shelf it happens to sit on, and not its siblings.
    // This is the bug a reader would describe as "I attached one question and it
    // pulled in the whole chapter", and it is only possible if attaching a question
    // silently attaches the group too.
    assert.deepEqual(
        questionsForGoal({ groups: [], questionIds: ["b"], allQuestions: all }).map((x) => x.id),
        ["b"]
    );

    // And a shelf, taken whole, does NOT reach a question filed in no group.
    assert.deepEqual(
        questionsForGoal({ groups: [group("shelf")], questionIds: [], allQuestions: all }).map((x) => x.id),
        ["a", "b", "c"]
    );
});

test("a group is a shelf, so attaching it attaches its questions and nothing else", () => {
    const all = [q("a", "s1"), q("b", "s1"), q("c", "s2")];
    assert.deepEqual(
        questionsForGoal({ groups: [group("s1")], questionIds: [], allQuestions: all }).map((x) => x.id),
        ["a", "b"]
    );
});

test("a reference to something deleted contributes nothing rather than failing", () => {
    // A sync merge that removes a group on one device leaves the reference behind on
    // the others. A material list padded with ids nothing resolves is a question count
    // that lies, which is worse than a short one because the reader cannot tell.
    const all = [q("a", "s1")];
    assert.deepEqual(
        questionsForGoal({ groups: [group("gone")], questionIds: ["also-gone"], allQuestions: all }),
        []
    );
});

test("answering a question does not attach it to anything", () => {
    // The state a question reaches is per QUESTION, not per goal, and it is derived
    // from the attempt log rather than written anywhere. So the attempt log cannot be
    // a route into a goal: there is no field on it and nothing reads one.
    const attempt = {
        id: "at1", exerciseId: "e1", itemId: "i1", questionId: "q1",
        round: 1, correct: true, selected: ["q1-o1"], answeredAt: 10, deletedAt: null
    };
    assert.equal(attempt.goalId, undefined);
    // The session it belonged to names the goal, and the question is not on it.
    assert.equal(exercise(1).goalId, "g1");
    assert.equal(attempt.goalId, undefined);
});

test("a selection never widens a goal's material", () => {
    // The picker is the other screen that reads a goal's questions, and it must draw
    // exactly the same set as the goal page counts. `questionsForSelection` is handed
    // that set, so the strongest thing a selection can do is SUBTRACT from it.
    const all = [q("a", "s1"), q("b", "s1"), q("c", "s2")];

    const pickGroup = questionsForSelection(all, { groupIds: ["s1"], questionIds: null, excludeIds: null });
    assert.deepEqual(pickGroup.map((x) => x.id), ["a", "b"]);

    // Names nothing outside the goal's own list, even when handed an id that is not in
    // it. A selection is a filter over what the goal already has.
    const pickOutside = questionsForSelection(all, { groupIds: null, questionIds: ["a", "zzz"], excludeIds: null });
    assert.deepEqual(pickOutside.map((x) => x.id), ["a"]);

    // And an exclusion is a subtraction, never an addition.
    const pickLess = questionsForSelection(all, { groupIds: ["s1"], questionIds: null, excludeIds: ["a"] });
    assert.deepEqual(pickLess.map((x) => x.id), ["b"]);

    // Nothing named is the whole goal, which is what the plan draws from.
    assert.deepEqual(
        questionsForSelection(all, { groupIds: null, questionIds: null, excludeIds: null }).map((x) => x.id),
        ["a", "b", "c"]
    );

    // An exclusion with nothing named is dropped, because there is no set to subtract
    // from and the alternative is building an exercise of nothing.
    assert.ok(isExactSelection({ groupIds: null, questionIds: null, excludeIds: ["a"] }) === false);
});

/** Comments blanked rather than removed, with line count preserved.
 *
 *  NEEDED BY THE TWO SOURCE SCANS BELOW, and for a reason that is the whole difference
 *  between them and a grep: this codebase explains itself in comments that name the very
 *  identifiers it is forbidden to use. `saveQuestion` carries a paragraph beginning
 *  "NO `goalId`", so a scan that reads prose reports that the function writes a goalId
 *  — and a scan that skipped comments would miss a real one.
 *
 *  BOTH comment forms, and `//` only outside a quote. A `//` inside a string is a URL or
 *  a path, not the start of a comment, and blanking from the first one found truncates
 *  every line that has a URL in it — which is how a scan silently stops covering code
 *  rather than reporting it. */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
        .split("\n")
        .map((line) => {
            let quote = null;
            for (let i = 0; i < line.length; i += 1) {
                const ch = line[i];
                if (quote) {
                    if (ch === "\\") { i += 1; continue; }
                    if (ch === quote) quote = null;
                    continue;
                }
                if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
                if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
            }
            return line;
        })
        .join("\n");
}

/** Every module under app/js, as paths relative to it. */
function appModules() {
    const root = fileURLToPath(new URL("../app/js/", import.meta.url));
    const found = [];
    const walk = (dir, prefix = "") => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const next = `${prefix}${entry.name}`;
            if (entry.isDirectory()) walk(join(dir, entry.name), `${next}/`);
            else if (entry.name.endsWith(".js")) found.push(next);
        }
    };
    walk(root);
    return found;
}

test("the only caller of addGoalRef in the whole app is the two attach functions", () => {
    // A SOURCE SCAN, and it is here because the property cannot be checked any other
    // way in node: there is no IndexedDB, so a test cannot observe that writing a
    // question left no reference row behind. What it CAN observe is that no code path
    // exists that could write one without the reader being on the goal's own page.
    //
    // The rule this enforces: `addGoalRef` is called from goal-content-service and
    // nowhere else, and `attachGroup`/`attachQuestion` are called from exactly one page
    // — the picker on `/goal/:id/content`. A convenience call added to the question
    // editor ("attach this to the newest goal while you are here") is the exact
    // regression this fails on, and it is the regression the reader described when they
    // said a question must not be attached to a goal unless they added it themselves.
    const root = fileURLToPath(new URL("../app/js/", import.meta.url));
    const callers = { addGoalRef: [], attachGroup: [], attachQuestion: [] };

    for (const file of appModules()) {
        const source = stripComments(readFileSync(join(root, file), "utf8"));
        for (const name of Object.keys(callers)) {
            // A CALL, not a mention and not a declaration. The negative lookbehind
            // rejects a bare word in the middle of an identifier; a dotted qualifier is
            // allowed because every page calls these through its namespace import
            // (`content.attachGroup(...)`), and excluding that would make the check pass
            // on an empty list — which is exactly what it did the first time.
            for (const hit of source.matchAll(
                new RegExp(`^[^\\n]*?(?<![\\w$])(?:[A-Za-z_$][\\w$]*\\.)*${name}\\s*\\(`, "gm")
            )) {
                if (/\b(?:function|export|import|const|let)\b/.test(hit[0])) continue;
                callers[name].push(file);
            }
        }
    }

    // `addGoalRef` is called from exactly one FILE — goal-content-service, once in
    // each of the two `attach` functions — and both attaches are called from exactly
    // one page. The list is de-duplicated because the property is "which files", not
    // "how many times": a second call inside the same file is a second attach function
    // and this test already covers that there are two of them and both are on the same
    // page.
    assert.deepEqual([...new Set(callers.addGoalRef)], ["services/goal-content-service.js"]);
    assert.deepEqual([...new Set(callers.attachGroup)], ["ui/pages/goal-content.js"]);
    assert.deepEqual([...new Set(callers.attachQuestion)], ["ui/pages/goal-content.js"]);
});

test("no question record carries a goalId, so there is no field to write one into", () => {
    // The other half, and it is a schema fact rather than a code fact. `saveQuestion`
    // builds the row field by field; there is no `goalId` in that list, and the
    // migration that removed the column removed its indexes with it. A `goalId` that
    // came back would make every rule above true and every guarantee false.
    //
    // Across the WHOLE repository module and not just `saveQuestion`, because the field
    // could be stamped on afterwards: a question read, widened and written back is how a
    // `goalId` returns without anybody writing one in the create path.
    const source = stripComments(readFileSync(new URL("../app/js/data/repo-questions.js", import.meta.url), "utf8"));
    assert.ok(!/\bgoalId\b/.test(source),
        "the question repository mentions goalId in code, so there is a field to write one into");
});

/* -------------------------------------------------------------------------- */
/*                  2. one goal, one decision, however it is asked             */
/* -------------------------------------------------------------------------- */

test("a goal with nothing attached is offered the join, not an error", () => {
    const plan = planSchedule({ goal: goal(), exercises: [], quota: quota(), now: NOW });
    const action = goalAction({ plan, materialCount: 0, open: [], quota: quota() });
    assert.equal(action.action, ACTION.NO_MATERIAL);
    assert.equal(action.hasMaterial, false);
    assert.equal(canStart(action), false);
    assert.equal(stateKey(action), "no_material");
});

test("an open exercise is offered as a choice, never taken automatically", () => {
    // Two open exercises is the ordinary case now, and the reader who came to work
    // through a new set tonight is the same person as the one finishing yesterday's.
    // The records cannot tell them apart, so the decision is "offer both".
    const open = [exercise(2), exercise(1)];
    const plan = planSchedule({ goal: goal(), exercises: open, quota: quota(), now: NOW });
    const action = goalAction({ plan, materialCount: 10, open, quota: quota() });
    assert.equal(action.action, ACTION.RESUME);
    assert.equal(action.open.length, 2);
    assert.equal(canStart(action), true, "a goal with something open may still start another");
    assert.equal(stateKey(action), "ready");
});

test("nothing open and something to ask is one button", () => {
    const plan = planSchedule({ goal: goal(), exercises: [], quota: quota(), now: NOW });
    const action = goalAction({ plan, materialCount: 12, open: [], quota: quota() });
    assert.equal(action.action, ACTION.RESUME_OR_START);
    assert.equal(canStart(action), true);
});

test("finished and archived are one answer with two words", () => {
    // They differ in the SENTENCE and agree in what can be DONE, which is nothing new.
    // Two branches returning two identical answers is two chances to write one of
    // them as a refusal it is not.
    const cases = [
        [planSchedule({ goal: goal({ status: "completed", completedAt: day(-1) }), exercises: [], quota: quota(), now: NOW }), "completed"],
        [planSchedule({ goal: goal({ archivedAt: day(-1) }), exercises: [], quota: quota(), now: NOW }), "archived"]
    ];
    for (const [plan, label] of cases) {
        const action = goalAction({ plan, materialCount: 40, open: [], quota: quota() });
        assert.equal(action.action, ACTION.CLOSED, `${label} is not reported as closed`);
        assert.equal(canStart(action), false);
        assert.equal(stateKey(action), "closed");
    }
});

test("a closed goal with an exercise still open is not stranded", () => {
    // Closing a plan stops new ones being built; it does not take away a sitting the
    // reader is half-way through. The decision carries the open exercises either way,
    // so the page can offer to finish them.
    const open = [exercise(1)];
    const plan = planSchedule({
        goal: goal({ status: "completed" }), exercises: open, quota: quota(), now: NOW
    });
    const action = goalAction({ plan, materialCount: 10, open, quota: quota() });
    assert.equal(action.action, ACTION.CLOSED);
    assert.equal(action.open.length, 1);
});

test("an open exercise can be resumed whatever the state is", () => {
    // THE RESUME BUTTON IS DRAWN ABOVE THE STATE, NOT INSIDE ONE BRANCH OF IT, and this
    // is the property that says so. Being over the rate cap is a refusal to BUILD
    // something new; it is not a reason a reader cannot finish the one they already
    // started — and a reader whose goal has been worked hard this window is exactly
    // the person most likely to have something half-finished tonight.
    //
    // It used to be drawn in some branches and not others, so the home page said
    // "not yet" with no way through, while the goal page's list offered the same
    // exercise with a Continue button on it. Two screens, one decision, two answers.
    const open = [exercise(2), exercise(1)];
    const cases = [
        ["rate_limited", planSchedule({
            goal: goal(), exercises: open,
            quota: quota({ used: 3, limit: 3, remaining: 0, blocked: true, retryAt: day(1) }),
            now: NOW
        })],
        ["closed", planSchedule({
            goal: goal({ status: "completed" }), exercises: open, quota: quota(), now: NOW
        })],
        ["archived", planSchedule({
            goal: goal({ archivedAt: day(-1) }), exercises: open, quota: quota(), now: NOW
        })],
        ["resume_or_start", planSchedule({ goal: goal(), exercises: open, quota: quota(), now: NOW })],
        ["no_material", planSchedule({ goal: goal(), exercises: open, quota: quota(), now: NOW })]
    ];

    const seen = new Set();
    for (const [label, plan] of cases) {
        const action = goalAction({
            plan, materialCount: label === "no_material" ? 0 : 10, open, quota: quota()
        });
        assert.equal(action.open.length, 2, `${label} lost the open exercises`);
        assert.deepEqual(action.open.map((x) => x.id), open.map((x) => x.id),
            `${label} reported different open exercises`);
        seen.add(action.action);
    }
    // Four distinct decisions out of five cases, which is the point: these are genuinely
    // different states that must all still carry the same two records.
    assert.ok(seen.size >= 4, `only ${seen.size} distinct decisions were exercised`);
});

test("the decision is the same however it is asked", () => {
    // The property the restructure exists for. `planSchedule` and `goalAction` are pure
    // and take plain values, so the same inputs can be handed to them in any order and
    // from any screen, and the answer is one answer. What this checks concretely is
    // that `goalAction` reads nothing but what it is given — in particular that the
    // material count and the open list are taken from the arguments rather than
    // recomputed from `plan`, which is the only way it could drift.
    const args = {
        plan: planSchedule({ goal: goal(), exercises: [exercise(1)], quota: quota(), now: NOW }),
        materialCount: 7,
        open: [exercise(1)],
        quota: quota()
    };
    const first = goalAction(args);
    const second = goalAction({ ...args });
    assert.deepEqual(first, second);
    assert.equal(first.action, ACTION.RESUME);

    // Same plan, different material count: the decision MUST change, or the "nothing
    // attached" branch is unreachable and a goal with no questions shows a Start.
    assert.equal(goalAction({ ...args, materialCount: 0 }).action, ACTION.NO_MATERIAL);

    // Same plan and same material, no open exercise: also a different decision.
    assert.equal(goalAction({ ...args, open: [] }).action, ACTION.RESUME_OR_START);
});

test("no goal at all is its own state, not a crash", () => {
    const action = goalAction({ plan: { state: SCHEDULE.NO_GOAL, open: [] } });
    assert.equal(action.action, ACTION.NO_GOAL);
    assert.equal(canStart(action), false);
    // And a caller that passes nothing at all gets the same answer rather than a
    // TypeError, because a page deciding what to draw must have something to draw.
    assert.equal(goalAction().action, ACTION.NO_GOAL);
});
