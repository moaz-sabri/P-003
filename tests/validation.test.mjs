// What a goal and a question are allowed to contain.
//
// The validator is the only thing between a phone keyboard and the database, and
// the tests below are about the mistakes that are not caught by a careless read.
// The worst one is the single-choice question saved with two correct options: it
// looks completely fine on screen — both boxes ticked, both right — and it is
// unanswerable, so it comes back in every review for ever with the reader
// answering it wrong and having no idea why.

import test from "node:test";
import assert from "node:assert/strict";

import {
    LIMITS,
    GROUP_CATEGORIES,
    QUESTION_KINDS,
    assertValid,
    cleanText,
    foldText,
    validateGroup,
    validateGoal,
    validateQuestion
} from "../app/js/domain/validation.js";
import { NEW_PER_EXERCISE, REVIEW_DEPTH } from "../app/js/config.js";

const option = (text, isCorrect = false) => ({ text, isCorrect });

test("cleanText collapses internal whitespace, foldText lower-cases it", () => {
    assert.equal(cleanText("  a   b  "), "a b");
    assert.equal(cleanText("a\n\tb"), "a b");
    assert.equal(cleanText(null), "");
    assert.equal(cleanText(undefined), "");

    // Two stored strings are compared to decide "same text?", so both sides have
    // to be in the same shape. An un-normalised trailing space makes two identical
    // options look different and is how a duplicate slips past.
    assert.equal(foldText(" Hello   World "), "hello world");
    assert.equal(foldText("HELLO WORLD"), cleanText("hello world").toLowerCase());
});

test("foldText folds Arabic letterforms, which arrive already shaped", () => {
    // Arabic has four shapes for the same letter, and the hamza carriers are the
    // obvious pair: the same answer typed once and pasted once from shaped text
    // are two strings unless they are folded.
    assert.equal(foldText("أهلاً"), foldText("اهلا"));
    assert.equal(foldText("أحمد"), foldText("احمد"));
    assert.equal(foldText("مدرسة"), foldText("مدرسه"));
    // And it must not fold characters that are genuinely different.
    assert.notEqual(foldText("علي"), foldText("عlei"));
});

test("a goal needs a title, and its plan is the fixed pair of constants", () => {
    const empty = validateGoal({});
    assert.equal(empty.ok, false);
    assert.equal(empty.errors.title, "required");
    // The plan is still there while the title is wrong, so the form can be
    // shown back with only the missing field underlined.
    assert.equal(empty.values.newPerExercise, NEW_PER_EXERCISE);
    assert.equal(empty.values.reviewDepth, REVIEW_DEPTH);

    assert.equal(validateGoal({ title: "   " }).errors.title, "required");
    assert.equal(validateGoal({ title: "x".repeat(LIMITS.TITLE_MAX + 1) }).errors.title, "too_long");
    assert.equal(validateGoal({ title: "x".repeat(LIMITS.TITLE_MAX) }).ok, true);

    // The plan is fixed, so numbers a legacy draft still carries are DROPPED rather
    // than clamped: a goal saved from now on carries exactly the constants, and the
    // two old plan fields that existed on a stored goal are not read at all.
    const legacy = validateGoal({
        title: "G", newPerExercise: 9999, reviewDepth: 0, intervalDays: -5, durationDays: 999
    });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.values.newPerExercise, NEW_PER_EXERCISE);
    assert.equal(legacy.values.reviewDepth, REVIEW_DEPTH);
    assert.equal(legacy.values.intervalDays, undefined);
    assert.equal(legacy.values.durationDays, undefined);
});

test("a goal reports every wrong field at once", () => {
    // Four fields, three of them wrong: a throw stops at the first one and the
    // reader fixes them one round trip at a time.
    const result = validateGoal({ title: "", description: "y".repeat(LIMITS.TEXT_MAX + 1) });
    assert.deepEqual(Object.keys(result.errors).sort(), ["description", "title"]);
});

test("a question needs text and two to six options", () => {
    assert.equal(validateQuestion({ options: [] }).errors.options, "too_few");
    assert.equal(validateQuestion({}).errors.text, "required");

    const seven = validateQuestion({
        text: "q",
        kind: "single",
        options: [0, 1, 2, 3, 4, 5, 6].map((i) => option(`o${i}`, i === 0))
    });
    assert.equal(seven.errors.options, "too_many");

    // Six is allowed. The limit is a ceiling on what a phone screen can present as
    // tap targets, not a preference.
    const six = validateQuestion({
        text: "q",
        kind: "single",
        options: [0, 1, 2, 3, 4, 5].map((i) => option(`o${i}`, i === 0))
    });
    assert.equal(six.ok, true);

    // Every option reported, so the reader sees which box to fix.
    const blanks = validateQuestion({ text: "q", kind: "single", options: [option(""), option("b")] });
    assert.equal(blanks.errors["options.0"], "required");
    assert.equal(blanks.errors.options, "need_correct");
});

test("at least one option must be correct", () => {
    const none = validateQuestion({ text: "q", kind: "single", options: [option("a"), option("b")] });
    assert.equal(none.errors.options, "need_correct");
});

test("a single-choice question with two correct options is refused", () => {
    // THE case. Both boxes are ticked and both look right on screen, so nothing
    // tells the reader the question cannot be answered — it comes back in every
    // review for ever, answered wrong, with no explanation available.
    const two = validateQuestion({
        text: "q",
        kind: "single",
        options: [option("a", true), option("b", true)]
    });
    assert.equal(two.ok, false);
    assert.equal(two.errors.options, "need_one_correct");

    // The same two options are perfectly fine as a multiple-choice question,
    // because that is what "choose both" means.
    const many = validateQuestion({
        text: "q",
        kind: "multiple",
        options: [option("a", true), option("b", true)]
    });
    assert.equal(many.ok, true);
});

test("an unknown kind is refused rather than guessed at", () => {
    const bad = validateQuestion({ text: "q", kind: "boolean", options: [option("a", true), option("b")] });
    assert.equal(bad.errors.kind, "not_a_kind");
    // The value is still usable so the form can show what it fell back to.
    assert.equal(bad.values.kind, "single");
    assert.deepEqual(QUESTION_KINDS, ["single", "multiple"]);
});

test("duplicate options are reported on every row involved", () => {
    // Underlining only the second box makes the reader fix the one they did not
    // think was wrong and hit the same message again.
    const dupes = validateQuestion({
        text: "q",
        kind: "single",
        options: [option("yes", true), option("no"), option("YES")]
    });
    assert.equal(dupes.errors["options.0"], "duplicate");
    assert.equal(dupes.errors["options.2"], "duplicate");

    // Folded, so case and Arabic shaping do not make a duplicate look distinct.
    const shaped = validateQuestion({
        text: "q",
        kind: "single",
        options: [option("أهلاً", true), option("اهلا ")]
    });
    assert.equal(shaped.errors["options.1"], "duplicate");

    // Whitespace differences are not duplicates: "a b" and "ab" are different
    // answers, and folding them together would refuse a question with two real
    // options in it.
    assert.equal(validateQuestion({
        text: "q",
        kind: "single",
        options: [option("a b", true), option("ab")]
    }).ok, true);
});

test("an option that is too long is caught, and so is the question text", () => {
    const long = validateQuestion({
        text: "x".repeat(LIMITS.TEXT_MAX + 1),
        kind: "single",
        options: [option("y".repeat(LIMITS.OPTION_MAX + 1), true), option("b")]
    });
    assert.equal(long.errors.text, "too_long");
    assert.equal(long.errors["options.0"], "too_long");
});

test("the returned values are cleaned, not the raw draft", () => {
    // What gets stored is the cleaned value. Storing the draft means "same text?"
    // is decided against a string with a trailing space in it forever after.
    const result = validateQuestion({
        text: "  what   is  this?  ",
        kind: "multiple",
        options: [option("  one  ", true), { text: "two", isCorrect: 1 }]
    });
    assert.equal(result.values.text, "what is this?");
    assert.equal(result.values.options[0].text, "one");
    // A truthy non-boolean is still a correct option — the checkbox is the only
    // thing that produces one, but a synced record may hold 0/1.
    assert.equal(result.values.options[1].isCorrect, true);
});

test("two problems with one field report the first one, not the last", () => {
    // `errors` is one code per field, because a field is underlined once. Assigning
    // unconditionally meant the reader was told about the SECOND problem, fixed it,
    // and was then told about the first — two saves to learn two facts about one box.
    const tooManyAndUnmarked = validateQuestion({
        text: "q",
        kind: "single",
        options: Array.from({ length: 7 }, () => ({ text: "same", isCorrect: false }))
    });
    assert.equal(tooManyAndUnmarked.errors.options, "too_many");

    // And the same for a single option row: too long AND a duplicate keeps the
    // length, which is the one the reader has not seen.
    const long = "x".repeat(250);
    const longAndDuplicated = validateQuestion({
        text: "q",
        kind: "single",
        options: [
            { text: long, isCorrect: true },
            { text: long, isCorrect: false }
        ]
    });
    assert.equal(longAndDuplicated.errors["options.0"], "too_long");
    assert.equal(longAndDuplicated.errors["options.1"], "too_long");
});

test("assertValid turns a failure into one error the API can return", () => {
    const good = validateQuestion({ text: "q", kind: "single", options: [option("a", true), option("b")] });
    assert.deepEqual(assertValid(good, "question").options.length, 2);

    const bad = validateQuestion({ text: "", kind: "single", options: [] });
    assert.throws(() => assertValid(bad, "question"), (err) => {
        // The field and the CODE, not the message: the message is translated and
        // every catch site in the UI looks up `error.<code>`.
        assert.equal(err.field, "text");
        assert.equal(err.code, "required");
        assert.ok(err instanceof Error);
        return true;
    });
});

test("a missing draft is a failure, not a crash", () => {
    // Every call site passes something, but `validateGoal()` with no argument is
    // one keystroke away in a console and a TypeError on an import is not a
    // validation message a reader can act on.
    assert.equal(validateGoal().ok, false);
    assert.equal(validateQuestion().ok, false);
    assert.doesNotThrow(() => validateQuestion({ options: null }));
});
/* --------------------------------- group ---------------------------------- */

test("a group needs a name", () => {
    assert.equal(validateGroup({}).errors.name, "required");
    assert.equal(validateGroup({ name: "   " }).errors.name, "required");
    assert.equal(validateGroup().ok, false, "a missing draft must be a failure, not a crash");
    assert.equal(validateGroup({ name: "  Verbs  " }).ok, true);
});

test("a group name that is too long for a chip is refused", () => {
    const long = "x".repeat(LIMITS.GROUP_NAME_MAX + 1);
    assert.equal(validateGroup({ name: long }).errors.name, "too_long");
    assert.equal(validateGroup({ name: "x".repeat(LIMITS.GROUP_NAME_MAX) }).ok, true);
});

test("a group's category is one of the fixed ids, or nothing at all", () => {
    // The three shelves a whole shelf can be filed under come from GROUP_CATEGORIES,
    // and the stored value is the id — the translation lives in strings.js, keyed
    // by labelKey — so the free-form test here is the one the picker can actually
    // produce. The order the list is drawn in is the fixed order, not the order
    // groups happen to have been created in.
    assert.deepEqual(GROUP_CATEGORIES.map((c) => c.id), ["education", "sport", "cooking"]);

    assert.equal(validateGroup({ name: "Verbs", category: "education" }).values.category, "education");
    assert.equal(validateGroup({ name: "Verbs", category: "cooking" }).values.category, "cooking");

    // An unknown id and a missing category are the same thing: both become `null`,
    // which is the "no category" heading the grouped list falls back to. Inventing
    // a category for an id the app does not know would file the group under a
    // heading nobody can find.
    assert.equal(validateGroup({ name: "Verbs", category: "languages" }).values.category, null);
    assert.equal(validateGroup({ name: "Verbs", category: "" }).values.category, null);
    assert.equal(validateGroup({ name: "Verbs" }).values.category, null);
    assert.equal(validateGroup({ name: "Verbs" }).ok, true);
});

test("two groups on the device cannot share a name", () => {
    // Two chips both reading "Verbs" on the filter row above a session are
    // indistinguishable, so the second is refused at the point it is created rather
    // than discovered later as a session containing questions from both.
    //
    // "ON THE DEVICE" IS THE CHANGE, and it is a consequence of a group no longer
    // belonging to a goal. Uniqueness used to be checked against the names in one
    // goal's list, which is only correct while a group is a goal's private
    // classification. Now that one shelf can serve three goals, two goals may each
    // have had a "Verbs" and they are genuinely different rows — and refusing the
    // second would stop a reader from filing their Arabic verbs on a shelf of the
    // same name without disturbing their French one. The list passed in is whatever
    // exists, and the service passes the whole device's.
    assert.equal(validateGroup({ name: "Verbs" }, ["Verbs"]).errors.name, "duplicate_group");
    assert.equal(validateGroup({ name: "Verbs" }, ["Nouns"]).ok, true);
    // And an empty device, or one whose only group is this one being renamed, both
    // leave the name available.
    assert.equal(validateGroup({ name: "Verbs" }, []).ok, true);
});

test("a group's name is compared folded, like its options and its goal title", () => {
    // The same Arabic name typed in a second hamza form is not a second group, for
    // the same reason a question cannot have two options that say the same thing.
    assert.equal(
        validateGroup({ name: "�����" }, ["�����"]).errors.name,
        "duplicate_group",
        "ta marbuta and ha were treated as different names"
    );
    // And so is a name that differs only in case or in the spaces inside it.
    assert.equal(validateGroup({ name: "verbs" }, ["Verbs"]).errors.name, "duplicate_group");
    assert.equal(validateGroup({ name: "Big verbs" }, ["big   verbs"]).errors.name, "duplicate_group");
});