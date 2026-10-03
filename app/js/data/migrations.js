// The IndexedDB schema, and the one place a store or an index is born.
//
// Migrations are an append-only list. Nothing above version 1 may ever be
// edited: an IndexedDB upgrade only runs the steps whose version is above the
// version the database was opened at, so changing step 1 changes nothing for a
// browser that already ran it, and changes the schema for one that has not —
// which is the definition of a bug that only reproduces on other people's
// devices. A step is corrected by adding version 2.
//
// `stores.js` holds the SAME list of stores and indexes as a plain object, and
// tests/data.test.mjs compares the two. That test exists because this file is
// run by the browser and that one is not: an index added to the registry but
// forgotten here fails only as a slow query on a large goal, and the sync pull
// that needs it is the one that silently takes four seconds per page.

export const DB_VERSION = 5;

/** Bump when the shape of the stored key envelope changes; read back by
 *  services/crypto-service.js to refuse an envelope it cannot open. Mirrors
 *  IDENTITY_VERSION in config.js. */
const IDENTITY_STORE_VERSION = 1;

// Two imports, and both are worth naming as imports rather than repeating the rule.
//
// `derivedId` is the id function for `goalRefs`, and migration 5 must use the SAME
// one the repository uses — an attachment made during the upgrade and the same
// attachment made by hand afterwards have to be one row, not two. `orderOptions` is
// the one definition of how options are ordered, and migration 5 is copying option
// lists into frozen snapshots: a second sort here would be a second rule, on exactly
// the records it has just copied, and the symptom would be an option numbered
// differently in a past report than on the screen it came from.
import { derivedId, GOAL_REF_PREFIX } from "../domain/id.js";
import { orderOptions } from "../domain/options.js";

/* -------------------------------------------------------------------------- */
/*                                  migration 1                                 */
/* -------------------------------------------------------------------------- */

/**
 * Eight stores, grouped by what they mean rather than by when they were added.
 *
 * `goals` `questions` `options` `exercises` `exerciseItems` `attempts`
 *     the data. All of them are plain records with an `id`, and all of them
 *     carry `updatedAt`, `rev`, `device` and `dirty` for sync.
 *
 * `meta`
 *     one row per setting: language, sync cursor, sync configuration, the id of
 *     this device, the last time a backup was exported.
 *
 * `keys`
 *     the identity envelope — one row, holding a NON-EXTRACTABLE CryptoKey. It
 *     is a store of its own rather than a `meta` row because the two have
 *     opposite rules about what may be read: `meta` is free to be dumped into a
 *     bug report, and this may not.
 *
 * There is deliberately NO outbox store. The obvious design — a row per pending
 * write, in a store next to the records — has two writers for one fact, and the
 * fact is "has this record reached the server". A write that lands in the record
 * store and fails to reach the outbox (a crash between two transactions, a quota
 * error, an await that outlived the transaction) is a change that never syncs
 * and never says so; an outbox row whose record write was rolled back pushes a
 * record that does not exist. So each record carries its own `dirty` flag, set
 * inside the same transaction that writes it and cleared inside the transaction
 * that was acknowledged by the server, and there is exactly one place either can
 * be wrong.
 */
function migration1(db) {
    const goals = db.createObjectStore("goals", { keyPath: "id" });
    goals.createIndex("status", "status");
    goals.createIndex("updatedAt", "updatedAt");

    const questions = db.createObjectStore("questions", { keyPath: "id" });
    questions.createIndex("goalId", "goalId");
    questions.createIndex("goalOrder", ["goalId", "order"]);
    questions.createIndex("updatedAt", "updatedAt");
    // `groups` is created by migration 2, which also adds the `groupId` index on
    // `questions`. It is named in the block comment above because it is part of
    // what these stores mean, and it is NOT created here: this step has already run
    // on real devices and migrations.js's header forbids editing it.

    const options = db.createObjectStore("options", { keyPath: "id" });
    options.createIndex("questionId", "questionId");
    options.createIndex("questionOrder", ["questionId", "order"]);
    options.createIndex("updatedAt", "updatedAt");

    const exercises = db.createObjectStore("exercises", { keyPath: "id" });
    exercises.createIndex("goalId", "goalId");
    exercises.createIndex("goalNumber", ["goalId", "number"]);
    exercises.createIndex("updatedAt", "updatedAt");
    // `archivedAt` (migration 3) and `createdAt` (migration 4) are added to this
    // store by later steps, not created here: this step has already run on real
    // devices and migrations.js's header forbids editing it.

    const exerciseItems = db.createObjectStore("exerciseItems", { keyPath: "id" });
    exerciseItems.createIndex("exerciseId", "exerciseId");
    exerciseItems.createIndex("exerciseOrder", ["exerciseId", "order"]);
    // The reverse lookup that makes "which exercises contain this question"
    // answerable without reading every exercise on the device. It is the index
    // the sync merge and the delete-a-question path both need, and neither of
    // them is on a code path that is exercised by hand often enough to notice a
    // missing one.
    exerciseItems.createIndex("questionId", "questionId");
    exerciseItems.createIndex("updatedAt", "updatedAt");

    const attempts = db.createObjectStore("attempts", { keyPath: "id" });
    attempts.createIndex("exerciseId", "exerciseId");
    attempts.createIndex("questionId", "questionId");
    attempts.createIndex("answeredAt", "answeredAt");
    attempts.createIndex("updatedAt", "updatedAt");

    db.createObjectStore("meta", { keyPath: "key" });

    const keys = db.createObjectStore("keys", { keyPath: "id" });
    keys.createIndex("version", "version");
}

/* -------------------------------------------------------------------------- */
/*                                  migration 2                                 */
/* -------------------------------------------------------------------------- */

/**
 * A `groupId` index on `questions`, and nothing else.
 *
 * ONE INDEX, ONE REASON. Questions are filed under a group so that a question can
 * be put into any exercise rather than belonging to the one it was first typed
 * into — and "the questions in this group" is therefore a question the builder
 * asks on every exercise start. Reading it without the index is a full scan of
 * every question on the device, once per start, on the one code path a reader is
 * waiting on.
 *
 * `goalId` STAYS, and is still the primary key path for a question's place in a
 * goal. A group is a classification WITHIN a goal, not a replacement for it: two
 * goals about the same subject have separate question lists, and merging them
 * would put two readers' material in one report.
 *
 * The index is created on the existing store rather than by deleting and
 * recreating it. Recreating would be shorter and would drop every question on
 * every device that had already run version 1, which is exactly the bug this
 * file's header says a step may never introduce. `createIndex` on a live store
 * inside `onupgradeneeded` keeps the rows.
 *
 * Rows written before this version have no `groupId` at all, and that is the
 * right answer for them rather than a default: a question with no group belongs
 * to no group, and the builder treats that as "everything not filed anywhere",
 * which is the state those records were already in.
 */
function migration2(db, tx) {
    // `groups` is created HERE rather than by patching migration 1: a version-1
    // step that already ran on a real device cannot be changed, and editing it to
    // create this store would give a fresh database one schema and an upgraded one a
    // different schema.
    const groups = db.createObjectStore("groups", { keyPath: "id" });
    groups.createIndex("goalId", "goalId");
    groups.createIndex("goalOrder", ["goalId", "order"]);
    groups.createIndex("updatedAt", "updatedAt");
    // `goalRefs` is created by migration 5, which is also where the store list stops
    // matching this one — see the note on the goalRef store there. It is named here
    // because it is part of what these stores mean and it is NOT created here: this
    // step has already run on real devices, and this file's header forbids editing it.

    // The index on an EXISTING store, through the upgrade transaction that `db.js`
    // hands over. There is no `db.addIndexTo("questions", …)`: an object store
    // handle only exists inside a transaction, and this is the only one open.
    //
    // This is also why it is safe. `createIndex` on a live store keeps every row,
    // where deleting the store and rebuilding it would drop every question on the
    // device — and a fresh install runs this step too, against the store migration 1
    // made moments earlier, so both paths are the same code.
    tx.objectStore("questions").createIndex("groupId", "groupId");
}

/* -------------------------------------------------------------------------- */
/*                              archived goals                                  */
/* -------------------------------------------------------------------------- */

/**
 * `archivedAt`, and nothing else.
 *
 * "A goal is archived, not deleted and not hidden" is one new field on the goal
 * and no change to the delete path at all. The alternative — a separate
 * `archivedGoals` store — is a second copy of every question, exercise and
 * attempt, and the archiving rule would then exist in two places.
 *
 * `NULL` ON EVERY EXISTING GOAL, INCLUDING COMPLETED ONES. A goal that was
 * finished before this version was installed is in the history and is readable;
 * back-filling `archivedAt` from `completedAt` would be a guess about when the
 * reader started treating it as an archive, and the page this feeds only orders
 * by the date, so a wrong guess is a wrong sort order and nothing else.
 * Completed goals show in the history section instead, which is where they
 * already were.
 *
 * The index is on `archivedAt` rather than on `status` because the query is
 * "which goals are in the archive", and that is a range over the timestamps. It
 * is `null` for every goal that is not archived, and IndexedDB sorts a number
 * before `null`, so `null` rows sit at the end of the index and a bounded scan of
 * the archived ones never has to skip them.
 */
function migration3(db, tx) {
    tx.objectStore("goals").createIndex("archivedAt", "archivedAt");
}

/* -------------------------------------------------------------------------- */
/*                                 migration 4                                  */
/* -------------------------------------------------------------------------- */

/**
 * A `createdAt` index on `exercises`.
 *
 * "Which exercises have I done, most recent first" is now asked about the WHOLE
 * DEVICE rather than one goal, because a reader can have several goals and the
 * history they want to reread is the one they lived through: last Tuesday's
 * vocabulary drill, then Sunday's grammar, not every drill from one goal and then
 * every drill from the other. Reading it by `createdAt` is the difference between
 * an index seek and a scan of every exercise this device has ever built, on the
 * one screen that is asking "what did I do lately".
 *
 * An index and not a field, because `createdAt` is already there and stored; this
 * is only a way to reach it in order.
 */
function migration4(db, tx) {
    tx.objectStore("exercises").createIndex("createdAt", "createdAt");
}

/* -------------------------------------------------------------------------- */
/*                            migration 5: the separation                       */
/* -------------------------------------------------------------------------- */

/**
 * THE FOUR THINGS STOPPED OWNING EACH OTHER.
 *
 * Up to here the shape of the data said a goal owns its questions, a question
 * lives in exactly one goal, and a group is a classification WITHIN a goal. All
 * three were columns: `questions.goalId`, `groups.goalId`, and an index that every
 * read of a question went through. That is a design in which none of the four can
 * exist without the others, and it is the thing this step removes.
 *
 * WHAT CHANGES, and nothing else does:
 *
 *   1. `goalRefs` IS CREATED — a join table, one row per (goal, group) or
 *      (goal, question). This is the ONLY thing that says a goal and a question
 *      are related. It is a table rather than two columns because the relation is
 *      many-to-many and the reader is in charge of it: the same question in two
 *      goals, one goal drawing on four groups, is not a shape two columns can hold.
 *
 *   2. `groups` LOSES ITS `goalId` and becomes an ORGANISATION OF QUESTIONS ONLY.
 *      A group is a shelf; a goal can point at any number of shelves. This is
 *      what makes "a goal may depend on one group or on several" true, and what
 *      stops a group from being a second name for a goal.
 *
 *   3. `questions` LOSES ITS `goalId`. The `goalId` and `goalOrder` indexes go
 *      with it — a composite index on a field the record no longer has is an index
 *      that matches nothing, and leaving it would mean every "the questions of goal
 *      X" read silently returned an empty list rather than failing. A global
 *      `order` index takes its place, because a question still has a position in
 *      the reader's own list — just a device-wide one now, not one per goal.
 *
 *   4. `exercises` AND `exerciseItems` CARRY A FROZEN COPY OF THE QUESTION. An
 *      item stores the question's text, its kind and its options with their
 *      correct marks, written at the moment the exercise is created. This is the
 *      rule "the current session is a fixed snapshot": editing a question
 *      afterwards cannot change what a session is asking, and a report of last
 *      week still shows last week's question rather than today's.
 *
 * WHY A COPY AND NOT A REFERENCE, since the reference was already there and cost
 * nothing:
 *
 * A reference makes the session's content a function of the present state of the
 * question store, which means it is NOT a snapshot. Fix a typo in the wording of
 * question 4 while you are halfway through exercise 3, and the rest of that
 * exercise grades against text the reader has not seen. Delete question 9 — which
 * the old code handled by tombstoning the item, so the question silently vanishes
 * from a session the reader is in the middle of and the count on the progress bar
 * no longer matches what gets asked — and the frozen copy has the same rows, so
 * nothing moves.
 *
 * The cost is real and it is paid on purpose: a question's text is stored once per
 * session it appears in rather than once. Six hundred characters per question per
 * session is nothing next to the alternative, and the alternative is a training
 * session that changes under the reader's hands.
 *
 * `questionId` STAYS on the item, and it is now a HINT rather than a dependency:
 * it is what "which exercises have asked this question" is answered from, and what
 * a reader sees under the editor. Nothing needs the row to exist for the item to
 * work, which is exactly the property that makes the session independent.
 *
 * THE DATA IS MIGRATED, NOT DROPPED. Existing questions keep their text, their
 * options and their order; each one gets a `goalRefs` row for the goal it used to
 * belong to, so a goal that had forty questions still draws on those forty and
 * the reader's history does not silently empty itself. The `groupId` on a question
 * is left alone — filing a question in a group is organisation, and it was never
 * the goal relationship — but a question whose group is a group of ANOTHER goal
 * is not attached to that other goal: one reference row per (goal, question) is
 * written from the question's own old `goalId`, and the group relationship is
 * written separately from the group's own old `goalId`, which is what the reader
 * had.
 */
function migration5(db, tx) {
    // THE JOIN TABLE. One store, two kinds of row, and the kind is a field rather
    // than two stores: "what does this goal draw on" is ONE question, and a reader
    // asking it wants one answer — "four groups and six questions" — not two lists
    // to hold in their head side by side.
    //
    // `goalOrder` and `ref` are the two directions the app reads it, and both are
    // needed on every screen that shows the relation: the goal page lists a goal's
    // references in the order they were added, and the group page has to answer
    // "which goals use this group" without scanning every goal on the device.
    const goalRefs = db.createObjectStore("goalRefs", { keyPath: "id" });
    goalRefs.createIndex("goalId", "goalId");
    goalRefs.createIndex("goalOrder", ["goalId", "order"]);
    goalRefs.createIndex("ref", ["refType", "refId"]);
    goalRefs.createIndex("updatedAt", "updatedAt");

    // A GROUP IS A SHELF AND A SHELF IS NOT A GOAL. The two indexes that made it one
    // are deleted, and a global `order` takes their place so the reader's own
    // arrangement of their shelves survives: the questions in a group are still in
    // the order they were typed, and now the groups themselves are too.
    //
    // Deleting an index keeps every row. This is the same fact migration 2's header
    // is about, and it is the reason a goal can stop owning its groups without
    // costing a single question.
    const groups = tx.objectStore("groups");
    groups.deleteIndex("goalId");
    groups.deleteIndex("goalOrder");
    groups.createIndex("order", "order");

    // AND THE SAME FOR A QUESTION, whose place in a goal is now a row in `goalRefs`
    // rather than a field. `order` is global because the reader's question list is
    // now one list: there is no second goal's list for a question to be ordered
    // within, and an order that meant "position within my goal" would have no
    // meaning for a question in no goal at all.
    const questions = tx.objectStore("questions");
    questions.deleteIndex("goalId");
    questions.deleteIndex("goalOrder");
    questions.createIndex("order", "order");

    // EVERY READ IS ISSUED UP FRONT, AND NOTHING IS `await`ed.
    //
    // A version-change transaction commits the moment the event loop gets control
    // back with no request in flight, and a promise that has to be awaited between two
    // batches of requests is exactly that moment. So the rule this step follows is the
    // one `data/db.js` exists to enforce: issue all the reads, chain the writes off
    // them, and never let a `then` be the only thing keeping the transaction alive.
    //
    // ALL SIX READS GO IN ONE BATCH — five stores plus this device's own id — because
    // a nested read inside a `.then` is a second batch, and a second batch is where a
    // transaction is most likely to be found already committed. The device id is read
    // HERE rather than through `repos.currentDeviceId()` for a second reason: that call
    // opens its own transaction, and `db.transaction` inside `onupgradeneeded` throws
    // `InvalidStateError` in every engine, on every install including a fresh one.
    //
    // A failure anywhere in the chain aborts the version change, and the browser
    // retries the upgrade from version 4 — which is the only safe behaviour for a step
    // that is rewriting the shape of every record in the database. That is why nothing
    // here is best-effort and why there is no partial-success path.
    const READS = [
        ["goals", "getAll"],
        ["questions", "getAll"],
        ["groups", "getAll"],
        ["exercises", "getAll"],
        ["exerciseItems", "getAll"],
        ["options", "getAll"]
    ];

    const data = { device: null };
    // SEVEN, NOT SIX. The device `get` below is a request too and counts towards the
    // same total — and getting this wrong is silent rather than loud, because the
    // counter would reach zero one read early and the rewrite would run against rows
    // that had not arrived yet: no errors, and goals that came out unattached.
    let pending = READS.length + 1;

    for (const [storeName, method] of READS) {
        const request = tx.objectStore(storeName)[method]();
        request.onsuccess = () => {
            data[storeName] = request.result;
            if (--pending === 0) rewrite(data);
        };
        request.onerror = () => { try { tx.abort(); } catch { /* already aborting */ } };
    }

    // This device's own id, for the `device` field on every row written below. It
    // arrives separately because it is a `get` rather than a `getAll`, and it is
    // issued immediately — not from inside a `.then` — for the same reason as the
    // batch above.
    const deviceRequest = tx.objectStore("meta").get("device");
    deviceRequest.onsuccess = () => {
        data.device = typeof deviceRequest.result?.value === "string" && deviceRequest.result.value
            ? deviceRequest.result.value
            : null;
        if (--pending === 0) rewrite(data);
    };
    deviceRequest.onerror = () => { try { tx.abort(); } catch { /* already aborting */ } };

    /** The whole rewrite, as one synchronous function over data already in hand. */
    function rewrite(all) {
        const at = Date.now();
        // THE DEVICE FALLS BACK TO A CONSTANT rather than being left null. `device`
        // breaks ties in the sync merge between two records with the same `updatedAt`,
        // and a null compares as the empty string against every real device id — so a
        // null would lose every tie against every other device rather than win some.
        // `migration` is a string no installation mints, which is exactly the property
        // wanted from a tie-break value that did not come from an installation.
        const device = all.device ?? "migration";

        // ONE REFERENCE ROW PER (GOAL, QUESTION), taken from the question's own old
        // `goalId`. The alternative — writing a row for every question in every goal
        // that shares one of its groups — would attach a reader's Arabic questions
        // to their French goal because both mention a group called "Week 1", which
        // is a guess dressed as a migration.
        const refRows = [];
        const refKeys = new Set();

        // THE ID IS DERIVED, NOT MINTED — `derivedId`, the same function the
        // repository uses when a reader attaches something after the upgrade.
        //
        // It has to be the same function, not merely a similar one. An attachment made
        // during the upgrade and the same attachment made by hand on another device
        // that has not upgraded yet must produce the SAME row, or the goal ends up with
        // the same shelf attached twice once both devices are on this version. The
        // pre-upgrade writer cannot know this function exists, so what it wrote is what
        // the derived id must match — and a random id has no such value.
        const addRef = (goalId, refType, refId, order) => {
            if (!goalId || !refId) return;
            const id = derivedId(GOAL_REF_PREFIX, goalId, refType, refId);
            if (refKeys.has(id)) return;
            refKeys.add(id);
            refRows.push({
                id,
                goalId,
                refType,
                refId,
                order,
                createdAt: at,
                deletedAt: null,
                updatedAt: at,
                rev: 0,
                device,
                // DIRTY, so these travel to the other device on the next sync. A
                // reference that stayed local would leave the goal pointing at nothing
                // everywhere else, and the first symptom would be a session that draws
                // nothing on a second phone with no message about it.
                dirty: 1
            });
        };

        for (const question of all.questions) {
            addRef(question.goalId, "question", question.id, 0);
        }
        for (const group of all.groups) {
            addRef(group.goalId, "group", group.id, 0);
        }

        const refStore = tx.objectStore("goalRefs");
        for (const row of refRows) refStore.put(row);

        // The question rows themselves: `goalId` is REMOVED rather than left at null,
        // and the two indexes that read it are gone from the schema above. A field
        // that is always null is a field that answers "which goal is this in" with a
        // confident, wrong, universal no.
        const questionStore = tx.objectStore("questions");
        for (const question of all.questions) {
            // `updatedAt` IS MOVED TO NOW, deliberately, and this is the one place in
            // this file where an existing row's timestamp is not preserved.
            //
            // The row is not merely reshaped here — the relation it used to carry has
            // been rewritten into `goalRefs`, which is a different row. So this copy is
            // genuinely new content, and it has to be newer than what any other device
            // still holds, or the merge would resolve a conflict it should not be
            // resolving: the other device's old-shaped question would look newer, win,
            // and put `goalId` back on a question whose index no longer exists to read
            // it. A reshaped record that stops syncing is worse than a record that is
            // rewritten twice.
            //
            // `dirty: 1` for the same reason: the new shape has to reach the other
            // device for the removal of `goalId` to be true there too.
            const next = { ...question, goalId: undefined, updatedAt: at, dirty: 1 };
            delete next.goalId;
            questionStore.put(next);
        }

        // And the groups, same reasoning. The reader's own order is kept exactly as
        // it was — the numbers were per goal before, and the reader arranged each
        // goal's shelves deliberately, so the first shelf of the first goal stays
        // first. Two groups that both sat at `order: 0` are now tied, and the
        // repositories break that tie by id, which is stable and identical on every
        // device.
        const groupStore = tx.objectStore("groups");
        for (const group of all.groups) {
            // Same reasoning as the question rows above: reshaped, therefore newer,
            // therefore dirty.
            //
            // The `order` is kept exactly as it was. The numbers were per goal before
            // and the reader arranged each goal's shelves deliberately, so the first
            // shelf of the first goal stays first rather than being renumbered into a
            // new order the reader did not choose. Two groups that both sat at
            // `order: 0` are now tied, and the repositories break that tie by id —
            // which is stable and identical on every device.
            const next = { ...group, goalId: undefined, updatedAt: at, dirty: 1 };
            delete next.goalId;
            groupStore.put(next);
        }

        // THE FROZEN COPIES, written inline from the reads already in hand.
        //
        // The options were read in the batch above, alongside the questions and the
        // items, precisely so this loop is synchronous. The version this step started
        // as read the options in a second `.then` nested inside the first, which
        // depended on the transaction still being open when the outer chain settled —
        // true in Chrome, not something to rely on for the one step that rewrites every
        // record in the database. Everything a row needs is now in `all`, so there is no
        // request left to make and no window in which the transaction could close.
        const byQuestion = new Map();
        for (const option of all.options) {
            if (!byQuestion.has(option.questionId)) byQuestion.set(option.questionId, []);
            byQuestion.get(option.questionId).push(option);
        }
        const questions = new Map(all.questions.map((q) => [q.id, q]));

        // The options in the order they were typed, tombstones dropped. A frozen copy
        // that carried a deleted option would put a row on screen with no text and no
        // mark, and the reader would be asked to answer a question that offers a blank.
        //
        // `orderOptions` rather than this file's own sort, for the reason the rest of the
        // app uses it: the option order is a rule with one definition, and a second
        // definition in a migration is one that can disagree with the app's on exactly
        // the records it just copied — and the symptom would be a question whose third
        // option is numbered second in a past report and third on screen.
        const optionsFor = (questionId) => orderOptions(byQuestion.get(questionId) ?? []);

        const itemStore = tx.objectStore("exerciseItems");
        for (const item of all.exerciseItems) {
            const question = questions.get(item.questionId);
            if (!question) {
                // AN ITEM WHOSE QUESTION IS GONE. Left exactly as it was, carrying no
                // frozen copy, and NOT deleted.
                //
                // Deleting the row was the alternative and it is worse in two ways at
                // once. It would take the item count off the progress bar of a session
                // the reader may be in the middle of, so the bar and the number of
                // questions to come would stop agreeing. And an item with no text is
                // undrawable but not harmless: `isDrawable` in domain/session.js reports
                // it as false, so the session page shows its not-found screen rather than
                // a blank question, and the reader is told the session cannot be run
                // rather than being handed one fewer question with no explanation.
                //
                // The pre-migration code tombstoned items in OPEN exercises for a
                // question that was deleted, so the common case here has no row at all
                // and this branch is nearly always a tombstone arriving from another
                // device. Whatever survives is left for the reader to finish or to
                // abandon.
                continue;
            }
            const copied = optionsFor(question.id).map((o) => ({
                id: o.id,
                text: o.text,
                isCorrect: Boolean(o.isCorrect),
                order: o.order
            }));
            itemStore.put({
                ...item,
                // The snapshot. Three fields, and the third is the one that makes this
                // a snapshot rather than a denormalised read: the ANSWER KEY.
                //
                // Without it, an option that was correct when this session was built
                // and has been un-ticked since would still be graded against the old
                // mark — and that is the correct behaviour here, which is exactly why the
                // copy is stored rather than looked up. The reader was shown this
                // question, with this mark, and a past session's report has to describe
                // what they were asked, not what the question has since become.
                questionText: question.text,
                questionKind: question.kind,
                options: copied,
                // DIRTY, because a reshaped item has to reach the other device or the
                // snapshot exists on one phone and not the other — and the one without it
                // draws from the live question store, which is the behaviour this whole
                // change removes. `updatedAt` moves with it, for the reason given on the
                // question rows above.
                updatedAt: at,
                dirty: 1
            });
        }
    }
}

export const MIGRATIONS = [
    { version: 1, name: "initial", apply: migration1, identityVersion: IDENTITY_STORE_VERSION },
    { version: 2, name: "question_groups", apply: migration2, identityVersion: IDENTITY_STORE_VERSION },
    { version: 3, name: "archived_goals", apply: migration3, identityVersion: IDENTITY_STORE_VERSION },
    { version: 4, name: "exercise_created_at", apply: migration4, identityVersion: IDENTITY_STORE_VERSION },
    { version: 5, name: "independent_goals", apply: migration5, identityVersion: IDENTITY_STORE_VERSION }
];

/**
 * Migration 5 on its own, for a migration that reads and rewrites rows.
 *
 * Exported rather than reached through `MIGRATIONS` because the two are verified
 * differently and only one of them can be: `tests/data.test.mjs` runs the whole list
 * against a stub that answers reads with an empty list — which proves the SCHEMA comes
 * out right and says nothing whatever about what the step does to a populated
 * database. `tests/migration5.test.mjs` drives this one against rows.
 *
 * It is exported by name rather than by index for the ordinary reason: an index into a
 * list means every future step changes which one this test is talking about.
 */
export { migration5 };

/* -------------------------------------------------------------------------- */
/*                                 shape of a row                               */
/* -------------------------------------------------------------------------- */

/**
 * Every synced record has the same five extra fields, whatever its own are.
 *
 *   updatedAt  epoch ms of the last local write. The sync merge takes the larger
 *              one, so this is the clock of the device that last touched it.
 *   rev        the server's revision, or 0 while the record has never been
 *              acknowledged. Only ever moved by the sync layer.
 *   device     a random id generated by this installation. The tie-break when two
 *              records have the same `updatedAt`: two phones writing inside the
 *              same millisecond is ordinary, and without a fixed order that
 *              comparison has to invent one from whatever order the two
 *              requests happened to arrive in, which means the two devices could
 *              keep disagreeing about the winner on every subsequent merge.
 *   dirty      0 or 1. Set in the same transaction as the write; cleared in the
 *              transaction that the server acknowledged.
 *   deletedAt  epoch ms, or absent. Deletion is a tombstone and not a removal,
 *              because a delete that does not travel reappears on the other
 *              device as if it never happened — and reappears silently, with the
 *              question back in the list.
 */
export const COMMON_FIELDS = ["updatedAt", "rev", "device", "dirty", "deletedAt"];