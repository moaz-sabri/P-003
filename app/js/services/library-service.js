// The question library: the packs that ship with this build, and what happens when a
// reader adds one to a goal.
//
// THREE FILES IN, FIVE FUNCTIONS OUT, and the shape of this file is the reason the
// feature needs no configuration: the packs are discovered, not registered. There is no
// list of them here, no manifest, and no import per file — a pack appears in the library
// because a `.json` file was dropped into `app/packs`, and the build puts it in the
// bundle. Adding a set of questions to the app is adding a file.
//
// THE DISCOVERY IS `import.meta.webpackContext`, which is the bundler's answer to "every
// file in this directory, without naming them". It is a call the BUILDER rewrites at
// build time into a lookup table, so it cannot run in node — which is precisely why the
// rules about what a pack may contain live in `domain/pack.js` instead of here. That file
// is pure and is tested directly against the real files on disk, so the guarantee "drop a
// file in and it works" is checked by the test suite rather than by opening a browser.
// The only thing this file does with the bundler is turn a directory into an array of
// parsed JSON, and everything that can be wrong with a pack is caught in code that node
// can run.
//
// WHAT A READER GETS IS THEIR OWN COPY. Not a link, not a subscription, not a record
// that points at a file in the bundle: the questions are written into the `questions`
// store with fresh ids and become ordinary questions — editable in the ordinary editor,
// deletable in the ordinary way, attached to as many goals as they like. That is the
// difference between a library and a remote feed, and it is the reason the pack file
// never has to be fetched again: the device that could not open it is not a device that
// cannot answer questions.
//
// THE ATTACHMENT IS PER QUESTION, NOT PER SHELF, and that is the one decision here worth
// arguing for. A pack's questions are filed on a shelf named after the pack, which is what
// makes them legible in the question list — twenty questions that appeared with no label
// are twenty rows nobody can place. But the GOAL is pointed at the questions themselves,
// not at that shelf, because a shelf is the reader's to rearrange: file a question
// somewhere else, or delete the shelf with them on it, and a goal attached to the shelf
// would silently lose material it was still drawing from. Attaching twenty references is
// twenty rows on the goal's own page, and that is the honest price of a goal whose
// material does not change behind its back.
//
// THE IMPORT IS IDEMPOTENT PER QUESTION, through `planImport`, and the rest of this file
// is just the order of the writes around it. Adding a set to a second goal copies nothing
// and attaches what is already here; adding the same set twice says so rather than
// duplicating twenty rows. What "the same set" means is decided in the domain file, where
// it can be tested, and not here where it would need a database to be tested at all.

import { buildCatalog, planImport, packIdFromFile } from "../domain/pack.js";
import { foldText, validateGroup } from "../domain/validation.js";
import { REF_TYPE } from "../domain/goal-content.js";
import { ValidationError, NotFoundError } from "../domain/errors.js";
import { listGroups, createGroup } from "../data/repo-groups.js";
import { listQuestions, createQuestions } from "../data/repo-questions.js";
import { getGoal, addGoalRefs, listAllGoalRefs, removeGoalRef } from "../data/repo-goals.js";

/**
 * EVERY JSON FILE IN `app/packs`, as parsed modules.
 *
 * `import.meta.webpackContext(dir, {recursive, regExp})` is webpack's answer to "every
 * file in this directory, without naming them", and it is resolved when the BUNDLE is
 * built rather than when this line runs: webpack replaces it with a table of the files
 * that matched, so adding `app/packs/french-verbs.json` and rebuilding puts it in the
 * library with no edit anywhere in this codebase. The regex is `\.json$` and not `.*`
 * because the directory also holds the format's README, and a Markdown file parsed as a
 * pack is a broken pack.
 *
 * IT IS `import.meta.webpackContext` AND NOT `require.context`, and the difference is not
 * a style preference. `require.context` is the CommonJS spelling and this module is an ES
 * module — every other file here is — so webpack does not rewrite it: it is emitted into
 * the bundle verbatim, where `require` is not defined, and the failure is a
 * `ReferenceError` on the first tap that opens the library rather than anything the build
 * complains about. The `import.meta` form is only meaningful to the bundler in both
 * spellings, so using the wrong one here looks exactly like using the right one until the
 * page is opened.
 *
 * A JSON module's value is its default export under webpack's ESM interop, and the
 * module object itself on some configurations, so both spellings are read. `sort()`
 * because `keys()` order is a build detail and a library that reordered itself when the
 * bundler was upgraded would be a library nobody could test.
 */
const context = import.meta.webpackContext("../../packs", {
    recursive: false,
    regExp: /\.json$/
});

/** Every file, as the entry `buildCatalog` takes: the key is what the id is derived from. */
function files() {
    return context.keys().sort().map((file) => {
        const module = context(file);
        return { file, raw: module?.default ?? module };
    });
}

/**
 * The library as this build ships it: the packs that can be read, and what is wrong with
 * the ones that cannot.
 *
 * Not cached, and deliberately: it is three small objects turned into three small objects,
 * and a cache here would be a second thing to invalidate when someone adds a pack mid
 * session (which they cannot, but the instinct to write the cache comes from a world where
 * they could). What IS worth not re-reading is the DATABASE, and `list()` below reads that
 * once for every pack rather than once per pack.
 *
 * @returns {{packs: object[], broken: {file: string, errors: Record<string,string>}[]}}
 */
export function catalog() {
    return buildCatalog(files());
}

/**
 * Every pack, with what this device has already done with it.
 *
 * `copies` is how many of the pack's questions are on this device, and `goals` is which
 * plans draw on them. Both are read ONCE for the whole list — the question store and the
 * reference table — and then indexed by `packId`, because this page can hold twenty packs
 * and a per-pack read would be forty transactions on the screen a reader opened to
 * choose something.
 *
 * A goal counts for a pack if it points at one of the pack's questions OR at a shelf the
 * pack's questions are filed on. The second half matters after a reader has tidied up: a
 * goal attached to the shelf still trains on those questions whatever happened to the
 * individual rows, and a list that said "not used by any goal" about a goal that is
 * building exercises from these questions would be lying.
 */
export async function list() {
    const { packs, broken } = catalog();
    const [questions, refs] = await Promise.all([listQuestions(), listAllGoalRefs()]);

    // packId -> {copies, shelves, goals}
    const state = new Map(packs.map((pack) => [pack.id, {
        copies: 0,
        shelves: new Set(),
        goals: new Set()
    }]));

    /** Which pack a question on this device came from, by its id.
     *
     *  The reference table names questions by id and a question can only have come from
     *  one pack, so an id-keyed map answers "which set is this reference for" in one
     *  lookup — rather than a per-pack scan of the question list for every row. */
    const sourceOf = new Map();
    for (const question of questions) {
        const row = state.get(question.packId);
        if (!row) continue;
        row.copies += 1;
        sourceOf.set(question.id, question.packId);
        if (question.groupId) row.shelves.add(question.groupId);
    }

    for (const ref of refs) {
        if (ref.refType === REF_TYPE.QUESTION) {
            const packId = sourceOf.get(ref.refId);
            if (packId) state.get(packId).goals.add(ref.goalId);
            continue;
        }
        for (const [packId, row] of state) {
            if (row.shelves.has(ref.refId)) row.goals.add(ref.goalId);
        }
    }

    return {
        broken,
        packs: packs.map((pack) => ({
            ...pack,
            copies: state.get(pack.id).copies,
            goals: [...state.get(pack.id).goals]
        }))
    };
}

/**
 * One pack, by id.
 *
 * A file that EXISTS but cannot be read is an error with a reason rather than a "not
 * found": the reader followed a link to a set that is in this build, and telling them it
 * is not here would send them looking for a version of the app that has it. Each reason
 * the reader can be shown is a case below — the codes come from `domain/pack.js`, and
 * every one of them has a string in both languages because this is where it is used.
 *
 * @throws {NotFoundError} no such file in this build
 * @throws {ValidationError} the file is here and is not readable
 */
export function read(packId) {
    const { packs, broken } = catalog();
    const found = packs.find((pack) => pack.id === packId);
    if (found) return found;

    const bad = broken.find((entry) => packIdFromFile(entry.file) === packId);
    if (bad) throw badPack(Object.values(bad.errors)[0]);

    throw new NotFoundError("pack", packId);
}

/** A pack file that is present and unreadable, as the error the reader is shown.
 *
 *  The codes are CASES rather than one interpolated code because `error.<code>` is looked
 *  up by the string the error carries, and a code built at runtime from a map is a key
 *  nothing in the tables can be checked against — which is how a screen ends up rendering
 *  `error.empty_pack` to a reader while the check that exists to prevent exactly that
 *  reports everything is fine. Each case below therefore has a literal in it, a string in
 *  both tables, and a message that says what is actually wrong. */
function badPack(code) {
    switch (code) {
        case "empty_pack": return new ValidationError("pack", "empty_pack");
        case "duplicate_pack": return new ValidationError("pack", "duplicate_pack");
        case "bad_file_name": return new ValidationError("pack", "bad_file_name");
        default: return new ValidationError("pack", "bad_pack");
    }
}

/**
 * Copy a pack's questions onto this device and point `goalId` at them.
 *
 * THE ORDER IS THE WHOLE OF THIS FUNCTION, and each step is where it is because of what
 * it would cost to be wrong:
 *
 *   1. read the pack, and fail before anything is written — a half-imported pack is a
 *      shelf with three of its twelve questions on it and no way to say why;
 *   2. read the goal, and refuse a goal that is gone, for the same reason;
 *   3. plan the import against what is already here, so the copies that exist are
 *      REUSED rather than made twice;
 *   4. create the shelf ONLY if there is something to put on it, because an empty shelf
 *      named after a pack is a row in the reader's group list that means nothing;
 *   5. write the missing questions in one transaction;
 *   6. attach every one of them — the new and the reused — to the goal.
 *
 * A failure in step 5 leaves nothing behind, because the shelf is a shelf and the
 * questions are the questions. A failure in step 6 leaves the questions on the device and
 * unattached, which is recoverable from the goal's own page by ticking them, and is
 * reported rather than hidden: the toast says what happened.
 *
 * @returns {Promise<{pack: object, group: object|null, created: number,
 *                    reused: number, total: number}>}
 */
export async function addToGoal(packId, goalId) {
    const pack = read(packId);
    const goal = await getGoal(goalId).catch(() => null);
    if (!goal || goal.deletedAt) throw new NotFoundError("goal", goalId);

    const plan = planImport(pack, await listQuestions());

    let group = null;
    const created = [];
    if (plan.create.length) {
        group = await shelfFor(pack.name);
        created.push(...await createQuestions(plan.create.map((question) => ({
            text: question.text,
            kind: question.kind,
            options: question.options,
            groupId: group.id,
            // Provenance, and the only reason a second add of the same pack knows it is
            // the same pack. See `saveQuestion` and `planImport`.
            packId: pack.id
        }))));
    }

    const ids = [...plan.reuse.map((entry) => entry.id), ...created.map((entry) => entry.id)];
    await addGoalRefs(goalId, REF_TYPE.QUESTION, ids);

    return {
        pack,
        group,
        total: plan.total,
        created: created.length,
        reused: plan.reuse.length
    };
}

/**
 * Take a ready-made set OFF a goal: every reference pointing this goal at the set's
 * material, and nothing else.
 *
 * WHAT HAS TO GO, AND WHY BOTH HALVES. `list()` counts a goal for a pack through
 * either of two reference shapes — a reference to one of the pack's questions, or a
 * reference to a shelf the pack's questions are filed on — so removing only the
 * question refs would leave the pack's row still saying "used by this goal" when the
 * goal no longer draws on it (and vice versa). The shelf refs are the ones the reader
 * wrote themselves by attaching the group on the goal's page, and they are removed too
 * because they are refs TO THIS SET's material: the goal's relation to this pack is
 * what the button removes, not the reader's own attachment of a group that happens to
 * contain the same questions.
 *
 * WHAT IS NOT TOUCHED, AND WHY. The questions stay on the device — they are the
 * reader's copies now, filable, editable, attachable to as many goals as they like —
 * and the group stays filed. Only the CONNECTION is removed: a goal that stops drawing
 * on this set loses nothing but the set's questions, which is the honest meaning of
 * "remove from this goal".
 *
 * The goal is read first and refused when it is gone, for the same reason `addToGoal`
 * refuses on a missing goal: a button that removes material from a plan that no longer
 * exists is a button about nothing.
 */
export async function removeFromGoal(packId, goalId) {
    const pack = read(packId);
    const goal = await getGoal(goalId).catch(() => null);
    if (!goal || goal.deletedAt) throw new NotFoundError("goal", goalId);

    // The pack's questions on THIS device, and the shelves they sit on. A question
    // that has been re-filed since the pack was added is still this set's — it carries
    // `packId` — and its new shelf is still where its references point.
    const [questions, refs] = await Promise.all([listQuestions(), listAllGoalRefs()]);
    const shelves = new Set(
        questions
            .filter((q) => q.packId === pack.id && q.groupId)
            .map((q) => q.groupId)
    );

    const mine = refs.filter((ref) => ref.goalId === goalId);
    const wanted = mine.filter((ref) => {
        if (ref.refType === REF_TYPE.QUESTION) {
            return questions.some((q) => q.packId === pack.id && q.id === ref.refId);
        }
        if (ref.refType === REF_TYPE.GROUP) return shelves.has(ref.refId);
        return false;
    });

    // Each removal is a tombstone write of one row; there are far fewer than a pack's
    // questions, so per-row is cheaper than a transaction that re-reads the table.
    await Promise.all(wanted.map((ref) => removeGoalRef(ref.id)));
    return { removed: wanted.length };
}

/**
 * The shelf a pack's questions are filed on, created the first time and found after that.
 *
 * FOUND BY FOLDED NAME rather than by an id stored on the shelf, because the shelf is
 * created from the pack's NAME — a pack has an id from its file name, but that id is a
 * build detail and putting it in front of a reader is how a group called
 * `arabic-alphabet` ends up in a list next to "Verbs". The fold is for the reason
 * `validateQuestion` folds its duplicate check: a reader who re-adds a pack whose file
 * has been corrected in its own language has not made two shelves.
 *
 * AN EXISTING SHELF OF THAT NAME IS REUSED even if the reader made it themselves, which
 * is the honest outcome of the collision rather than a refusal: the pack's questions join
 * the questions already filed there, and both are ordinary questions the reader can move.
 * Refusing would mean a library that cannot be added to a device that happens to have a
 * group called "Verbs", which is a worse answer than a slightly untidy shelf.
 *
 * `validateGroup` is run here for the same reason `group-service.create` runs it: the
 * repository does not decide what a valid name is. It cannot fail on length — `readPack`
 * has already held the pack's name to the group's limit, because the name IS a group's
 * name — and it cannot fail on duplication, because a group of that name was found above
 * rather than missed. The throw is there for the case nobody has found yet.
 */
async function shelfFor(name) {
    const groups = await listGroups();
    const wanted = foldText(name);
    const found = groups.find((group) => foldText(group.name) === wanted);
    if (found) return found;

    const result = validateGroup({ name }, groups.map((group) => group.name));
    if (!result.ok) throw new ValidationError("name", result.errors.name ?? "required");
    return createGroup({ name: result.values.name });
}