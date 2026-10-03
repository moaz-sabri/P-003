// The question library, stated as assertions.
//
// WHAT THIS FILE PROTECTS, and it is one promise rather than several: ADDING A PACK IS
// ADDING A FILE. A set of ready-made questions is a `.json` file in `app/packs`, and
// nothing in the app registers it — no manifest, no import per pack, no entry in a list
// that has to be kept in step with a directory. The rules about what such a file may
// contain are therefore the only thing standing between "drop a file in" and "ship a
// library that throws on a tap", which is why they are a pure module (`domain/pack.js`)
// that node can run without a browser and without the bundle's `require.context`.
//
// SO THE FIRST TEST READS THE REAL DIRECTORY. Every file the app ships is parsed, put
// through `readPack` and `buildCatalog`, and has to come out as a usable pack with
// nothing in the `broken` list. A pack with a typo in it fails here rather than on a
// reader's phone, and the failure names the file — which is the only feedback loop that
// exists for someone whose whole contribution to the library is a new JSON file.
//
// THE IMPORT RULES ARE HERE RATHER THAN IN ANOTHER BECAUSE THEY ARE THE PART THAT CAN BE
// GOT WRONG WITHOUT ANYTHING CRASHING. A pack added twice with the wrong rule either
// duplicates twenty questions on a device — invisible until the list is long — or copies
// nothing and attaches nothing, which looks like success.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
    readPack, buildCatalog, planImport, normalizeQuestion, packIdFromFile,
    PACK_ID, PACK_QUESTIONS_MAX
} from "../app/js/domain/pack.js";
import { validateQuestion, foldText } from "../app/js/domain/validation.js";

/* ------------------------------ the real files ----------------------------- */

const PACK_DIR = new URL("../app/packs/", import.meta.url);

/** Every pack file that ships, parsed. `readdirSync` rather than a hard-coded list is
 *  the whole point of the feature: a file added here is in the app, and a file removed
 *  here is gone, and this file cannot disagree with the directory. */
const FILES = readdirSync(PACK_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
        const file = `./${name}`;
        let raw;
        try {
            raw = JSON.parse(readFileSync(new URL(file, PACK_DIR), "utf8"));
        } catch (err) {
            // A JSON syntax error names the file in node's own message only sometimes,
            // and "the library is broken" without saying WHICH file is not a report.
            assert.fail(`${file} is not valid JSON: ${err.message}`);
        }
        return { file, raw };
    });

/* -------------------------------------------------------------------------- */
/*                  every file that ships is a usable pack                    */
/* -------------------------------------------------------------------------- */

test("every pack file in the app is a usable pack, and none of them is broken", () => {
    assert.ok(FILES.length > 0, "app/packs holds no JSON files at all");

    const { packs, broken } = buildCatalog(FILES);
    assert.deepEqual(broken, [], "a file shipped in app/packs cannot be read");
    assert.equal(packs.length, FILES.length);

    for (const pack of packs) {
        assert.ok(pack.name, `${pack.file} has no name`);
        assert.ok(pack.questions.length > 0, `${pack.file} has no questions`);
    }
});

test("a pack's id is its file name, and ids and names are unique across the library", () => {
    // The id IS THE FILE NAME because the file name is already unique and an id declared
    // inside the file would be a second identity to keep in step. Two packs declaring the
    // same one would collide in a URL, and the loser would be unreachable.
    for (const { file, raw } of FILES) {
        const result = readPack(raw, file);
        assert.equal(result.values.id, packIdFromFile(file));
        assert.match(result.values.id, PACK_ID, `${file} has an id the app cannot route`);
    }

    const { packs } = buildCatalog(FILES);
    assert.equal(new Set(packs.map((p) => p.id)).size, packs.length, "two packs share an id");

    // AND THE NAMES, FOLDED, which `buildCatalog` refuses rather than shows twice. The
    // name is what a reader chooses between and what a copied set's shelf is called, so
    // two sets called the same thing is an ambiguous library and one shelf.
    assert.equal(new Set(packs.map((p) => foldText(p.name))).size, packs.length,
        "two packs have the same name");
});

test("every question in every shipped pack is a question THIS APP WOULD ACCEPT", () => {
    // The claim `domain/pack.js` makes is that a pack question is not a second kind of
    // question with its own rules: it is run through the same `validateQuestion` the
    // editor's form runs. This asserts the consequence on real content — if a pack ever
    // shipped a question the editor would refuse, this fails with the file and the index.
    for (const { file, raw } of FILES) {
        const { values } = readPack(raw, file);
        values.questions.forEach((question, index) => {
            const result = validateQuestion(question);
            assert.ok(result.ok,
                `${file} question ${index} is not a question the editor would accept: `
                + JSON.stringify(result.errors));
        });
    }
});

test("a pack question carries a type and an answer the app can grade", () => {
    for (const { file, raw } of FILES) {
        const { values } = readPack(raw, file);
        values.questions.forEach((question, index) => {
            assert.ok(question.kind === "single" || question.kind === "multiple",
                `${file} question ${index} has no type the app can ask`);
            const correct = question.options.filter((option) => option.isCorrect);
            assert.ok(correct.length >= 1, `${file} question ${index} has no correct option`);
            if (question.kind === "single") {
                assert.equal(correct.length, 1,
                    `${file} question ${index} is single-choice with ${correct.length} answers`);
            }
        });
    }
});

/* -------------------------------------------------------------------------- */
/*                          what a file may contain                          */
/* -------------------------------------------------------------------------- */

const good = (over = {}) => ({
    name: "Verbs",
    description: "",
    subject: "",
    questions: [{
        text: "What does this mean?",
        kind: "single",
        options: [
            { text: "to go", isCorrect: true },
            { text: "to stop", isCorrect: false }
        ]
    }],
    ...over
});

test("a file with no questions is refused, and a file with no name is refused", () => {
    const empty = readPack(good({ questions: [] }), "./empty.json");
    assert.equal(empty.ok, false);
    assert.equal(empty.errors.questions, "empty_pack");

    const nameless = readPack({ questions: [] }, "./nameless.json");
    assert.equal(nameless.ok, false);
    assert.equal(nameless.errors.name, "required");
});

test("one broken question refuses the WHOLE pack rather than shipping a hole", () => {
    // The alternative is a library with an unanswerable question in it, and the only
    // person who finds out is the reader who meets it in an exercise — days later, with
    // no way to tell the app got it wrong rather than them.
    const result = readPack(good({
        questions: [
            good().questions[0],
            {
                text: "Nothing is marked",
                kind: "single",
                options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: false }]
            }
        ]
    }), "./half.json");

    assert.equal(result.ok, false);
    assert.equal(result.errors["questions.1.options"], "need_correct",
        "the failure does not say WHICH question is broken");
});

test("two identical questions in one pack are refused", () => {
    const question = good().questions[0];
    const result = readPack(good({ questions: [question, { ...question }] }), "./twice.json");
    assert.equal(result.ok, false);
    assert.equal(result.errors["questions.1.text"], "duplicate");
});

test("a file name that cannot be an id is refused rather than normalised", () => {
    // `/library/<id>` is the URL, and nothing in this app case-folds a path. A file
    // called `Arabic Alphabet.json` would be a pack whose id is spelled differently
    // depending on who touches its path, so it is refused with a name rather than
    // quietly lower-cased into something the author did not write.
    assert.equal(packIdFromFile("./Arabic Alphabet.json"), null);
    assert.equal(packIdFromFile("./arabic_alphabet.json"), null);
    assert.equal(packIdFromFile("./README.md"), null);
    assert.equal(packIdFromFile("./arabic-alphabet.json"), "arabic-alphabet");
});

test("a pack of more questions than a session could ever ask is refused", () => {
    const question = good().questions[0];
    const many = Array.from({ length: PACK_QUESTIONS_MAX + 1 }, (_, i) => ({
        ...question, text: `Question ${i}`
    }));
    const result = readPack(good({ questions: many }), "./huge.json");
    assert.equal(result.ok, false);
    assert.equal(result.errors.questions, "too_many");
});

/* -------------------------------------------------------------------------- */
/*                         marking the right answer                          */
/* -------------------------------------------------------------------------- */

test("a pack may mark its answer by index instead of on the option", () => {
    // Both spellings exist because both are what a person writing a quiz reaches for,
    // and the file that names an index is not a file with a different answer — it is a
    // file about to be normalised into the one shape the app stores.
    const draft = normalizeQuestion({
        text: "Two of these are fruit",
        kind: "multiple",
        options: [
            { text: "apple" },
            { text: "bread" },
            { text: "banana" },
            { text: "carrot" }
        ],
        answer: [0, 2]
    });

    assert.deepEqual(draft.options.map((o) => o.isCorrect), [true, false, true, false]);
    assert.equal(validateQuestion(draft).ok, true);
});

test("a mark on the option wins over an index that says something else", () => {
    const draft = normalizeQuestion({
        text: "Which one",
        kind: "single",
        options: [{ text: "a" }, { text: "b" }],
        answer: [1]
    });
    assert.deepEqual(draft.options.map((o) => o.isCorrect), [false, true]);

    // A mark ON the indexed option beats the index, in both directions: an explicit
    // `false` is a mark like any other, and reading it as "not specified" would turn a
    // file that deliberately excludes the second option into one that says it is right.
    const excluded = normalizeQuestion({
        text: "Which one",
        kind: "single",
        options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: false }],
        answer: [1]
    });
    assert.deepEqual(excluded.options.map((o) => o.isCorrect), [true, false]);
});

test("a file that marks one option AND gives an index is refused, not resolved", () => {
    // Both end up correct, because neither statement can be preferred without guessing
    // which was the accident — and a single-choice question with two answers cannot be
    // asked. Reporting the contradiction is the whole of the answer: it goes back to
    // whoever wrote the file, where the two lines are.
    const draft = normalizeQuestion({
        text: "Which one",
        kind: "single",
        options: [{ text: "a", isCorrect: true }, { text: "b" }],
        answer: [1]
    });
    assert.deepEqual(draft.options.map((o) => o.isCorrect), [true, true]);
    assert.equal(validateQuestion(draft).errors.options, "need_one_correct");
});

test("an index that names no option is ignored, so the pack is reported as unmarked", () => {
    // NOT GUESSED AT. A file that says `"answer": "b"` does not say what it means, and
    // guessing which option a letter meant is how a library ends up with a wrong answer
    // key in it — which is worse than a file that is refused, because nobody looks.
    const draft = normalizeQuestion({
        text: "Which one",
        kind: "single",
        options: [{ text: "a" }, { text: "b" }],
        answer: ["b"]
    });
    assert.deepEqual(draft.options.map((o) => o.isCorrect), [false, false]);
    assert.equal(validateQuestion(draft).errors.options, "need_correct");
});

test("a type that is not one the app asks is reported rather than defaulted", () => {
    const result = readPack(good({
        questions: [{
            text: "A typed question",
            kind: "essay",
            options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: false }]
        }]
    }), "./essay.json");

    assert.equal(result.ok, false);
    assert.equal(result.errors["questions.0.kind"], "not_a_kind");
});

/* -------------------------------------------------------------------------- */
/*                    what adding a set actually does                        */
/* -------------------------------------------------------------------------- */

const PACK = readPack(good({ questions: [
    {
        text: "First",
        kind: "single",
        options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: false }]
    },
    {
        text: "Second",
        kind: "multiple",
        options: [{ text: "c", isCorrect: true }, { text: "d", isCorrect: true }]
    }
] }), "./verbs.json").values;

/** A question already on the device. `packId` is what makes it a COPY of a set rather
 *  than a question the reader wrote, and `deletedAt` is how a copy stops counting. */
const onDevice = (id, text, extra = {}) => ({
    id, text, kind: "single", groupId: null, packId: null, order: 0,
    createdAt: 1, deletedAt: null, ...extra
});

test("a set this device has never seen is copied whole", () => {
    const plan = planImport(PACK, [onDevice("q0", "Something the reader wrote")]);

    assert.equal(plan.create.length, 2, "a set was not copied whole");
    assert.deepEqual(plan.reuse, []);
    assert.equal(plan.total, 2);
});

test("a set already on this device is copied NOT AT ALL the second time", () => {
    // The case the rule exists for: adding the same set to a SECOND goal. Questions
    // belong to no goal, so the second plan must point at the twelve questions the
    // device already has — and a rule that copied again would leave the reader with two
    // identical sets and no way to tell which one their progress is on.
    const copies = [
        onDevice("q1", "First", { packId: "verbs" }),
        onDevice("q2", "Second", { packId: "verbs" })
    ];
    const plan = planImport(PACK, copies);

    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.reuse.map((entry) => entry.id), ["q1", "q2"]);
});

test("a question the READER wrote is not mistaken for a copy of the set", () => {
    // The reader's own question that happens to say the same thing is a different
    // thing, and it has no `packId`. Treating it as a copy would mean "add the set"
    // silently attaches a question they wrote by hand to a goal instead of the set's.
    const mine = onDevice("q1", "First");
    const plan = planImport(PACK, [mine]);

    assert.equal(plan.create.length, 2);
    assert.deepEqual(plan.reuse, []);
});

test("a copy of a DIFFERENT set is not a copy of this one", () => {
    const elsewhere = onDevice("q1", "First", { packId: "english-basics" });
    const plan = planImport(PACK, [elsewhere]);

    assert.equal(plan.create.length, 2, "another set's question suppressed a copy");
});

test("a copy the reader deleted is copied again", () => {
    // A tombstone is not a question. A reader who deleted one question out of a set they
    // added, and then added the set to another goal, gets a complete set there — which
    // is what "the goal is pointed at the whole set" means.
    const gone = onDevice("q1", "First", { packId: "verbs", deletedAt: 123 });
    const plan = planImport(PACK, [gone]);

    assert.deepEqual(plan.reuse, []);
    assert.equal(plan.create.length, 2);
});

test("every question in a set ends up attached, whether it was copied or reused", () => {
    // The half of the import the plan is FOR. The goal is pointed at the questions, not
    // at the shelf, so the count the goal shows has to be the size of the set whatever
    // the device already had — and a plan that copies a question without attaching it is
    // material on the device that no exercise will ever ask.
    const copies = [onDevice("q1", "First", { packId: "verbs" })];
    const plan = planImport(PACK, copies);

    const attached = [...plan.reuse.map((entry) => entry.id), ...plan.create.map((_, i) => `new${i}`)];
    assert.equal(attached.length, PACK.questions.length);
    assert.equal(new Set(attached).size, PACK.questions.length, "a question would be attached twice");
});

test("a question the reader has edited no longer matches, and the file's wording comes back", () => {
    // STATED RATHER THAN HIDDEN. The copy is recognised by its text, which is what the
    // reader recognises it by, so a question changed on this device is no longer the same
    // question to the pack — and adding the set again puts the set's version back beside
    // it. Both are ordinary questions; the reader can delete either.
    const edited = onDevice("q1", "First, corrected by the reader", { packId: "verbs" });
    const plan = planImport(PACK, [edited]);

    assert.equal(plan.create.length, 2);
    assert.deepEqual(plan.reuse, []);
});