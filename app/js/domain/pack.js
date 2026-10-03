// A question pack: a JSON file that ships with the app and becomes the reader's own
// questions when they add it to a goal.
//
// THE FILE IS THE WHOLE FORMAT, and that is the point of the feature. A set of
// ready-made questions is DATA, not a screen and not a table row: it is a name, a
// sentence about it, and a list of questions with their options, which option is
// right, and whether more than one is. Everything this module reads is in the file,
// and everything it decides is a pure function of a parsed object — which is what
// lets `tests/pack-library.test.mjs` check every file the app ships without a browser
// and without the bundle.
//
// THE ID IS THE FILE NAME, and nothing else. Two packs that declare the same `id` in
// their own contents would be a second source of identity to keep in step with the
// first, and the file name is already unique because it is a path. `arabic-alphabet.json`
// is the pack `arabic-alphabet` on every device that has this build, forever, and a
// file whose name cannot be one is refused rather than silently renamed.
//
// A PACK QUESTION IS A QUESTION. Each one is validated by `validateQuestion` — the
// same function the editor's form runs and the same one the API runs — so "two to six
// options, at least one correct, exactly one for a single-choice question" is a rule
// that exists once in this codebase rather than once per pack file. A pack with a
// question that fails is REFUSED WHOLE rather than imported with a hole in it: the
// alternative is a library that quietly ships an unanswerable question, and the only
// person who ever finds out is the reader who meets it in an exercise.
//
// TWO ANSWER FORMS, normalised to one before anything is validated. The obvious way
// to write "which of these is right" in a data file is to mark it on the option, and
// that is the form this app stores. The other obvious way is to write `"answer": 2` —
// or `[0, 3]` for a multiple-choice question — because that is how a person writes a
// quiz and it is two characters shorter per option. Both are accepted, both are
// converted to `isCorrect` here, and everything downstream sees exactly one shape.
//
// NOTHING IS DRAFTED AND NOTHING IS SHARED. A pack is a template the reader copies
// from, not a subscription: the questions a pack produces are ordinary question
// records on the device, editable in the ordinary editor, deletable in the ordinary
// way, and — like every other question — not owned by anything. See
// `planImport` for what "adding it twice" means, which is the only rule in here that
// is about the reader's history rather than about the file.

import { LIMITS, cleanText, foldText, validateQuestion } from "./validation.js";

/**
 * What a file name has to look like to be a pack id.
 *
 * Lower case, digits, and single hyphens: the id appears in a URL (`/library/<id>`),
 * in an `encodeURIComponent`, and in a `<title>`-free list of labels, and the app has
 * no case-folding anywhere in its routing. A file called `Arabic Alphabet.json` would
 * therefore be a pack whose id is spelled differently on every platform that touches
 * its path, so it is refused at load time with a name the reader could act on rather
 * than normalised behind their back.
 */
export const PACK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The most questions one pack may hold.
 *
 * There is no ceiling on what a person can write, but there IS one on what is useful:
 * `newPerExercise` is at most twenty and a session is a sitting, so a pack of two
 * thousand questions is not material anybody will reach the end of. The number is
 * here rather than in the library service because it is a rule about what a pack IS,
 * and the test that enforces it reads this file.
 */
export const PACK_QUESTIONS_MAX = 200;

/**
 * The id a file gets: its name without the extension.
 *
 * `null` rather than a normalised string when the name cannot be one — the caller
 * reports that as a broken file, because inventing an id for `My Pack.json` would
 * give the pack a name in the URL that no longer matches anything on disk.
 *
 * @param {string} file  a webpack context key such as `./arabic-alphabet.json`
 */
export function packIdFromFile(file) {
    const name = String(file ?? "").split("/").pop().replace(/\.json$/i, "");
    return PACK_ID.test(name) ? name : null;
}

/**
 * Read one pack file into the shape the rest of the app uses.
 *
 * The result is `{ok, errors, values}` rather than a value or a throw, for the reason
 * every validator in this codebase returns that: a pack can be wrong in six ways at
 * once, and a reader who finds out about one of them per rebuild is a maintainer, not
 * a reader. `errors` is keyed the way a form's errors are — `name`, `questions`,
 * `questions.3.options` — so a failure in a file can be pointed at the line that
 * caused it.
 *
 * `values` is present and usable when `ok` is false for everything except the
 * questions themselves: a pack with a missing name has a name invented from its file
 * name in `values`, because a library row has to have something to draw.
 *
 * @param {object} raw   the parsed JSON
 * @param {string} file  where it came from, for the id and for the report
 */
export function readPack(raw, file = "") {
    const errors = {};
    const id = packIdFromFile(file);
    if (!id) errors.id = "bad_file_name";

    const source = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
    if (!source.name && !source.questions) errors.name = "required";

    // The pack's name becomes a GROUP's name when the pack is added — the shelf its
    // questions are filed on — so it is held to the group's limit rather than given a
    // limit of its own. One bound, one place it is checked, and no shelf in this app
    // whose name is a different length from every other shelf's.
    const name = cleanText(source.name);
    if (!name) errors.name = "required";
    else if (name.length > LIMITS.GROUP_NAME_MAX) errors.name = "too_long";

    // The description is free text and is only ever drawn on a card, so it is held to
    // the question limit rather than the group one: a shelf name is a label on a chip
    // beside every question, a description is a paragraph under a title.
    const description = cleanText(source.description);
    if (description.length > LIMITS.TEXT_MAX) errors.description = "too_long";

    // `subject` is data, not a key. It is what the pack is ABOUT — "اللغة العربية",
    // "English language" — and it is drawn as the reader's file wrote it, because a
    // subject named in one language and rendered in another is how a library ends up
    // with two shelves that say the same thing in different scripts.
    const subject = cleanText(source.subject);

    const rawQuestions = Array.isArray(source.questions) ? source.questions : [];
    if (!rawQuestions.length) errors.questions = "empty_pack";
    else if (rawQuestions.length > PACK_QUESTIONS_MAX) errors.questions = "too_many";

    const questions = [];
    const seenText = new Map();

    rawQuestions.slice(0, PACK_QUESTIONS_MAX).forEach((entry, index) => {
        const draft = normalizeQuestion(entry);
        const result = validateQuestion(draft);
        // PREFIXED WITH THE INDEX so a broken file says which question is broken. The
        // codes themselves are the ones the editor produces, so there is one vocabulary
        // for "this question is wrong" and not one per screen that can find out.
        for (const [key, code] of Object.entries(result.errors)) {
            if (!(`questions.${index}.${key}` in errors)) {
                errors[`questions.${index}.${key}`] = code;
            }
        }

        // TWO IDENTICAL QUESTIONS IN ONE PACK is refused for the reason two identical
        // options inside one question are: the reader is asked the same thing twice,
        // and a session that draws both looks broken. The match is on the folded text
        // for the reason `validateQuestion` folds its option check — an Arabic pack
        // with two hamza spellings of the same question has one question, not two.
        if (result.ok) {
            const key = foldText(result.values.text);
            if (seenText.has(key)) {
                errors[`questions.${index}.text`] = "duplicate";
            } else {
                seenText.set(key, index);
            }
        }

        questions.push(result.values);
    });

    return {
        ok: Object.keys(errors).length === 0,
        errors,
        values: { id: id ?? "", file, name: name || id || "", description, subject, questions }
    };
}

/**
 * One pack question, whichever way it marked its right answer.
 *
 * `"answer": 2` and `"answer": [0, 3]` are turned into `isCorrect` on the options they
 * point at, and anything that is not an index into the options is IGNORED rather than
 * guessed at: a pack with `"answer": "b"` is a file that does not say what it means,
 * and `validateQuestion` will then report `need_correct`, which is a true statement
 * about it. A file that silently guessed which option a letter meant would be a
 * library with a wrong answer key in it.
 *
 * THE PRECEDENCE IS PER OPTION, and it is worth being exact because "the mark wins" is
 * true and "the mark wins everywhere" is not: an option that carries `isCorrect` is
 * believed, and only an option with no mark at all falls back to the index. So a file
 * that marks one option AND gives an index is not resolved in favour of either — both end
 * up correct, and a single-choice question is then refused by `validateQuestion` as
 * `need_one_correct`. That is the right outcome for a file that contradicts itself: the
 * contradiction goes back to whoever wrote it rather than being resolved by guessing which
 * of the two statements was the accident.
 */
export function normalizeQuestion(entry) {
    const source = (entry && typeof entry === "object") ? entry : {};
    const options = Array.isArray(source.options) ? source.options : [];
    const answers = source.answer ?? source.correct ?? null;
    const wanted = new Set(
        (Array.isArray(answers) ? answers : [answers])
            .map((n) => (typeof n === "number" ? n : Number(n)))
            .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length)
    );

    // `kind` is passed through whatever the file said, INCLUDING something that is not
    // a kind: `validateQuestion` defaults it to `single` and reports `not_a_kind`, and
    // that report is the truth about the file. Defaulting it here as well would turn a
    // misspelled type into a pack that looks fine and asks single-choice questions.
    return {
        text: source.text,
        kind: source.kind,
        options: options.map((option, index) => {
            const one = (option && typeof option === "object") ? option : {};
            return {
                text: one.text,
                // PER OPTION, and deliberately so. A mark on the option is believed and
                // only a bare option falls back to the index — see the note above on what
                // happens when a file says both.
                isCorrect: one.isCorrect !== undefined ? Boolean(one.isCorrect) : wanted.has(index)
            };
        })
    };
}

/**
 * Every file in the library, and what is wrong with the ones that cannot be read.
 *
 * THE CATALOG IS BUILT FROM FILES AND IS NEVER PARTLY BUILT. A broken file is not
 * repaired, skipped silently, or imported with a hole in it: it is reported in
 * `broken` and left out of `packs`, so a reader with one malformed set still has the
 * other two, and whoever added the file has a list of what to fix. The one exception
 * is a DUPLICATE NAME, which is refused here rather than in `readPack` because it is
 * only knowable across files — and it is refused because the name is what a reader
 * recognises: two sets called "Verbs" in one library is a shelf the reader cannot
 * tell apart from the other one, and the copy path files questions on a shelf named
 * after the pack.
 *
 * Sorted by name rather than by file name, because the list is read by a person
 * choosing something to learn and names are what they choose between.
 *
 * @param {{file: string, raw: object}[]} entries
 * @returns {{packs: object[], broken: {file: string, errors: Record<string,string>}[]}}
 */
export function buildCatalog(entries = []) {
    const packs = [];
    const broken = [];

    for (const entry of entries) {
        const result = readPack(entry?.raw, entry?.file ?? "");
        if (result.ok) packs.push(result.values);
        else broken.push({ file: entry?.file ?? "", errors: result.errors });
    }

    const byName = new Map();
    for (const pack of packs) {
        const key = foldText(pack.name);
        if (!key) continue;
        if (!byName.has(key)) byName.set(key, pack);
    }
    const kept = packs.filter((pack) => {
        const first = byName.get(foldText(pack.name));
        if (first === pack) return true;
        broken.push({ file: pack.file, errors: { name: "duplicate_pack" } });
        return false;
    });

    kept.sort((a, b) => foldText(a.name).localeCompare(foldText(b.name)));
    return { packs: kept, broken };
}

/**
 * What adding a pack to a goal will actually do, given what is already on the device.
 *
 * THE RULE IS ONE LINE: a question is copied unless this device already holds a copy
 * OF THIS PACK with the same text. Everything else follows from two facts about this
 * app's model.
 *
 * Questions belong to no goal, so the same twelve questions serve a second plan —
 * which is the case the rule exists for. "Add French basics to my Spanish goal" must
 * copy nothing and attach twelve, or the reader ends up with the same question twice
 * on one device and no way to tell the two apart. `packId` is what makes the match
 * exact: a question the reader wrote themselves that happens to say the same thing is
 * NOT a copy, and asking for the pack brings the pack's own version.
 *
 * THE MATCH IS ON TEXT RATHER THAN ON POSITION, because a pack is content that gets
 * corrected. Reordering a file, or fixing a typo in question nine, changes what is at
 * index nine; a rule keyed on the index would then reuse the wrong existing question
 * and never add the corrected one. Text is what the reader recognises, so it is what
 * the copy is recognised by.
 *
 * WHAT THAT COSTS, stated rather than hidden: a question a reader has EDITED no longer
 * matches the file, so adding the pack again puts the original back beside their
 * version. Both are on the device, both are ordinary questions, and the reader can
 * delete either. The alternative — matching on anything the edit preserved — is a
 * second identity for a question that already has an id.
 *
 * @param {object} pack        a pack from `readPack`/`buildCatalog`
 * @param {object[]} existing  the reader's live questions
 * @returns {{create: object[], reuse: {index:number,id:string}[],
 *            steps: {index:number, question:object, existing:object|null}[], total:number}}
 */
export function planImport(pack, existing = []) {
    const have = new Map();
    for (const question of existing ?? []) {
        if (!question?.packId || question.packId !== pack.id) continue;
        if (question.deletedAt) continue;
        const key = foldText(question.text);
        if (key && !have.has(key)) have.set(key, question);
    }

    const create = [];
    const reuse = [];
    const steps = [];

    (pack?.questions ?? []).forEach((question, index) => {
        const found = have.get(foldText(question.text));
        steps.push({ index, question, existing: found ?? null });
        if (found) reuse.push({ index, id: found.id });
        else create.push(question);
    });

    return { create, reuse, steps, total: (pack?.questions ?? []).length };
}