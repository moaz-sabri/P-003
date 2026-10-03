// What a goal and a question are allowed to contain, and the rules that say no.
//
// Every form in the app runs its draft through one of the two validators here
// before anything is written, and the API runs the same two validators again
// before anything is stored. That is deliberate duplication: the client copy is
// what produces the per-field messages under a text box, and the server copy is
// what stops a hand-written request from creating a goal with a title of four
// megabytes. Rules that exist in only one of the two places are rules that have
// not been enforced yet.
//
// The validators RETURN a result rather than throwing. A form has four fields
// and can be wrong about three of them; a throw stops at the first one and the
// user fixes them one round trip at a time. So a failure is a map of field to
// code, and the code — not the message — is what reaches the UI, because the
// message is translated and the code is not.
//
// Every code below is an `error.<code>` key in both language tables.

import { ValidationError } from "./errors.js";
import {
    DEFAULT_DURATION_DAYS, DEFAULT_INTERVAL_DAYS, DEFAULT_NEW_PER_EXERCISE, DEFAULT_REVIEW_DEPTH
} from "../config.js";

/** The boundaries, in one place, because the same numbers appear in the form's
 *  input attributes and in the messages and in the server's copy. */
export const LIMITS = {
    TITLE_MAX: 80,
    TEXT_MAX: 500,
    OPTION_MAX: 200,
    OPTIONS_MIN: 2,
    OPTIONS_MAX: 6,
    /** A group's name is drawn on a chip beside every question filed under it, on
     *  a 320px screen, next to the goal it belongs to. A name longer than this is
     *  not a label any more. */
    GROUP_NAME_MAX: 40,
    NEW_PER_EXERCISE_MIN: 1,
    NEW_PER_EXERCISE_MAX: 20,
    /** The most items an exercise the reader NAMED may carry. It exists because a
     *  selection has no natural ceiling: `newPerExercise` bounds the plan, and the
     *  plan is what a selection replaces. "Everything in this goal" is four hundred
     *  questions and an exercise is a sitting — this is the number past which the
     *  session stops being something anybody finishes, and the picker warns before
     *  the reader crosses it rather than the builder refusing afterwards. */
    EXERCISE_ITEMS_MAX: 120,
    REVIEW_DEPTH_MIN: 1,
    REVIEW_DEPTH_MAX: 6,
    INTERVAL_DAYS_MIN: 1,
    INTERVAL_DAYS_MAX: 365,
    DURATION_DAYS_MIN: 1,
    DURATION_DAYS_MAX: 3650,
    /** A search box is not a feature here, but a list of 2000 questions is a real
     *  thing a person can end up with, so pagination is by slice, not by "assume
     *  it fits". */
    PAGE_SIZE: 100
};

/** The two question shapes. Named `single`/`multiple` rather than
 *  `radio`/`checkbox` because the words describe the question, not the control:
 *  the same question can be answered with radio buttons on one screen and with
 *  tap targets on another, and the answer must not change when it does. */
export const QUESTION_KINDS = ["single", "multiple"];

/** Trim, and collapse runs of internal whitespace. Applied to every text field
 *  before it is stored and not just to the one the reader happened to leave a
 *  space in, because "same text?" is decided by comparing two stored strings
 *  and an un-normalised trailing space makes two identical options look
 *  different. */
export function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** The comparison form of a text field: lower case, whitespace collapsed,
 *  Arabic and Latin letterforms folded to their base forms where the platform
 *  can do it. Arabic in particular has four shapes for the same letter, so a
 *  "duplicate option" check that does not fold them lets the same answer in
 *  twice — once typed, once pasted from a source that had already shaped it. */
export function foldText(value) {
    const clean = cleanText(value).toLowerCase();
    if (typeof clean.normalize !== "function") return clean;
    // NFD then drop the combining marks: أ إ آ ؤ ئ → ا و ي. That is the whole of
    // what NFD does for Arabic, and it is enough for the hamza carriers.
    //
    // AND THEN ة → ه AND ى → ي BY HAND, because NFD does NOT do those two and a
    // comment claiming it does is worse than no comment: ة and ه are the same
    // letter in a final position and ة has no decomposition at all, so a
    // "duplicate option" check written on the strength of that comment lets
    // مدرسة and مدرسه both into the same question. The tempting alternative is
    // NFKD, which does fold them — along with every other compatibility
    // character, including the ones that really are different answers, which is a
    // false "duplicate" on a question that was fine. Two named substitutions
    // cannot do that.
    return clean.normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(/ة/g, "ه")
        .replace(/ى/g, "ي");
}

/**
 * A whole number inside a range, or the fallback when there is nothing to read.
 *
 * AN EMPTY FIELD IS THE FALLBACK, NOT ZERO. `Number("")` is `0` and `Number("  ")`
 * is `0` too, so a numeric field the reader selected and cleared arrived here as a
 * real zero and was clamped straight up to the minimum. Saving a goal form with
 * "new questions per exercise" emptied therefore stored 1 where the field had said
 * 5, with no error, no message, and nothing on the goal page to show it — the
 * change was invisible and permanent. A field with nothing in it is a field
 * asking for the default, and the default is the number the form pre-filled.
 */
/**
 * Record the first thing wrong with a field, and only that.
 *
 * `errors` is a map from a field name to ONE code, because a field is underlined
 * once and has one message under it. Which means a second problem with the same
 * field has nowhere to go — and the version that assigned unconditionally threw
 * away the one the reader had not seen yet, so a question with seven options and
 * nothing ticked reported only "mark one correct" until that was fixed, and two
 * identical 250-character options reported only "these say the same thing" and
 * not that either was too long. Both cost a second save to discover.
 */
function claim(errors, field, code) {
    if (!(field in errors)) errors[field] = code;
}

function intInRange(value, min, max, fallback) {    if (value === null || value === undefined) return fallback;
    if (typeof value === "string" && value.trim() === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/* --------------------------------- goal ---------------------------------- */

/**
 * Check a goal draft.
 *
 * @returns {{ok: boolean, errors: Record<string,string>, values: object}}
 *   `values` is present and usable even when `ok` is false: the numbers are
 *   clamped into range rather than rejected, so a half-typed goal can still be
 *   shown back with its numbers corrected and only its missing title underlined.
 */
export function validateGoal(draft = {}) {
    const errors = {};

    const title = cleanText(draft.title);
    if (!title) errors.title = "required";
    else if (title.length > LIMITS.TITLE_MAX) errors.title = "too_long";

    const description = cleanText(draft.description);
    if (description.length > LIMITS.TEXT_MAX) errors.description = "too_long";

    // Out-of-range numbers are corrected instead of refused. A number field on a
    // phone keyboard produces these by accident — the spinner overshoots, the
    // paste brings a whole paragraph — and refusing the save over an interval
    // that is one day too long teaches people that the field is hostile.
    const newPerExercise = intInRange(
        draft.newPerExercise, LIMITS.NEW_PER_EXERCISE_MIN, LIMITS.NEW_PER_EXERCISE_MAX,
        DEFAULT_NEW_PER_EXERCISE
    );
    const reviewDepth = intInRange(
        draft.reviewDepth, LIMITS.REVIEW_DEPTH_MIN, LIMITS.REVIEW_DEPTH_MAX,
        DEFAULT_REVIEW_DEPTH
    );
    const intervalDays = intInRange(
        draft.intervalDays, LIMITS.INTERVAL_DAYS_MIN, LIMITS.INTERVAL_DAYS_MAX,
        DEFAULT_INTERVAL_DAYS
    );
    const durationDays = intInRange(
        draft.durationDays, LIMITS.DURATION_DAYS_MIN, LIMITS.DURATION_DAYS_MAX,
        DEFAULT_DURATION_DAYS
    );

    return {
        ok: Object.keys(errors).length === 0,
        errors,
        values: { title, description, newPerExercise, reviewDepth, intervalDays, durationDays }
    };
}

/* ------------------------------- question -------------------------------- */

/**
 * Check a question draft: some text, and between two and six options of which at
 * least one is correct.
 *
 * The field names in `errors` are `text`, `options`, `kind`, or `options.<i>`,
 * where the index is the option's position as typed. Position and not a stable
 * id, because the options of a draft that has never been saved do not have ids
 * yet — and matching them by text would underline the wrong box whenever two of
 * them say the same thing, which is exactly when the user most needs to be told
 * which one.
 */
export function validateQuestion(draft = {}) {
    const errors = {};

    const text = cleanText(draft.text);
    if (!text) errors.text = "required";
    else if (text.length > LIMITS.TEXT_MAX) errors.text = "too_long";

    const kind = QUESTION_KINDS.includes(draft.kind) ? draft.kind : "single";
    if (!QUESTION_KINDS.includes(draft.kind)) errors.kind = "not_a_kind";

    const options = Array.isArray(draft.options) ? draft.options : [];
    if (options.length < LIMITS.OPTIONS_MIN) {
        errors.options = "too_few";
    } else if (options.length > LIMITS.OPTIONS_MAX) {
        errors.options = "too_many";
    }

    const cleaned = options.map((o) => ({
        text: cleanText(o?.text),
        isCorrect: Boolean(o?.isCorrect)
    }));

    cleaned.forEach((o, i) => {
        if (!o.text) errors[`options.${i}`] = "required";
        else if (o.text.length > LIMITS.OPTION_MAX) errors[`options.${i}`] = "too_long";
    });

    // Duplicate answers are caught on the folded form, and are reported on every
    // row involved rather than the second one. An option that says the same
    // thing as another one makes the question unanswerable — there is a choice
    // between two identical right answers — and hiding that behind whichever
    // box the reader happens to look at second is a worse way to learn it.
    //
    // AND IT DOES NOT REPLACE WHAT WAS ALREADY WRONG WITH THAT ROW. Two options
    // that are both 250 characters long and identical are two things wrong with
    // one box, and reporting only the second of them meant the reader fixed the
    // duplicate, pressed save, and was then told about the length — two saves to
    // learn two facts about one field. The first error for a key wins, because it
    // was found first and the reader has not seen it yet.
    const seen = new Map();
    cleaned.forEach((o, i) => {
        const key = foldText(o.text);
        if (!key) return;
        if (seen.has(key)) {
            const first = seen.get(key);
            claim(errors, `options.${i}`, "duplicate");
            claim(errors, `options.${first}`, "duplicate");
        } else {
            seen.set(key, i);
        }
    });

    const correctCount = cleaned.filter((o) => o.isCorrect).length;
    if (options.length >= LIMITS.OPTIONS_MIN && correctCount === 0) {
        // `claim` rather than `=`: a question with seven options and nothing ticked
        // is two problems, and the reader was told about only the second one of
        // them until they fixed it and pressed save again.
        claim(errors, "options", "need_correct");
    }
    // A single-choice question with two correct options cannot be answered, and
    // the mistake is invisible on screen: both boxes are ticked and both look
    // right. It is the one combination that has to be refused rather than
    // silently saved and then answered wrong forever.
    if (kind === "single" && correctCount > 1) {
        claim(errors, "options", "need_one_correct");
    }

    return {
        ok: Object.keys(errors).length === 0,
        errors,
        values: { text, kind, options: cleaned }
    };
}

/* --------------------------------- group ---------------------------------- */

/**
 * Check a group's name.
 *
 * A group is only ever created by a reader naming it, so there is no default name
 * to fall back to and an unnamed one is refused rather than invented — the same
 * reason a goal will not do without a title.
 *
 * UNIQUENESS IS DEVICE-WIDE, on the folded form. Two groups with the same name make
 * every picker ambiguous — "Verbs" and a second "Verbs" on the chips above a session
 * are indistinguishable — and the fold is there because an Arabic reader typing the
 * same name in a second hamza form has not made two groups. The caller's own name is
 * not a clash with itself, or renaming "Verbs" to "Verbs" would be refused for being a
 * duplicate of "Verbs"; the caller excludes it by passing the siblings without it.
 *
 * IT USED TO BE UNIQUENESS WITHIN A GOAL, and that was correct exactly as long as a
 * group was a goal's private classification. It is not now, because a group belongs to
 * nobody: a shelf is shared, so a device-wide check is the only one whose result
 * matches what the reader can see. `group-service.create` passes the whole list for
 * exactly this reason, and the second one it would otherwise reject could have been a
 * different goal's group all along.
 *
 * @param {{name: string}} draft
 * @param {string[]} existingNames  the names this group may not take
 */
export function validateGroup(draft = {}, existingNames = []) {
    const errors = {};

    const name = cleanText(draft.name);
    if (!name) errors.name = "required";
    else if (name.length > LIMITS.GROUP_NAME_MAX) errors.name = "too_long";

    if (!errors.name) {
        const wanted = foldText(name);
        if ((existingNames ?? []).some((other) => foldText(other) === wanted)) {
            errors.name = "duplicate_group";
        }
    }

    return { ok: Object.keys(errors).length === 0, errors, values: { name } };
}

/* --------------------------------- assert -------------------------------- */

/**
 * Turn a validator result into the values, or throw.
 *
 * For the call sites that are not a form — the API check on the server, and the
 * import path — where there is no field to underline and "one of these fields is
 * wrong" is not a useful thing to catch.
 *
 * @param {{ok: boolean, errors: Record<string,string>, values: object}} result
 * @param {string} entity
 */
export function assertValid(result, entity) {
    if (result.ok) return result.values;
    const field = Object.keys(result.errors)[0];
    throw new ValidationError(field, result.errors[field] ?? "required");
}