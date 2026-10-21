// The question library: the ready-made sets this build ships, and the one decision a
// reader makes on them — which plan gets them.
//
// THIS PAGE IS A CATALOGUE AND NOT AN EDITOR. A set in it is a file in the bundle, is the
// same on every device, and cannot be changed from here. What the reader does is COPY it,
// and everything that means happens on their own questions afterwards: the copies are
// ordinary question records, in the question list, editable, deletable, and attachable to
// as many goals as they like. Nothing on this page is a special kind of question, and
// there is no way to reach a pack's questions through the app other than adding them —
// which is what keeps "a library set" from becoming a second kind of thing the rest of
// the app has to know about.
//
// THE GOAL IS CHOSEN ON THIS PAGE AND NOT PER SET. Adding a set is a decision about a
// PLAN, so the question "which plan" has to be answered once and the same answer used for
// every set on the screen — twelve sets and twelve pickers is a page where the reader has
// to make the same decision twelve times, and the twelfth one is made differently from the
// first because attention is a finite resource. It is carried in `?goal=` rather than in a
// module-level variable for the same reason reports carries one: a link to this page from
// a goal's own page arrives already pointed at that goal, the Back button goes back to a
// page whose state is still there, and a bookmark means something.
//
// THE STATE OF EACH SET IS SHOWN BEFORE IT IS ADDED, because the question a reader has on
// this screen is "have I already got this one?" and the answer is in the database rather
// than in the file. A set with no copies here is new to this device; a set with twelve
// copies and two plans using it is already installed, and adding it again will copy
// nothing and attach what is there. Saying that in advance is the difference between a
// library and a button that duplicates things.
//
// NO SET IS EVER PARTLY COPIED. A file that cannot be read is not in the library at all,
// and if any are, the page says how many rather than hiding the problem: the copies are
// independent records, so a half-copied set would be a shelf with three of its twelve
// questions on it and no way to complete it. Which files failed, and why, is in
// `services/library-service.js`; `tests/pack-library.test.mjs` is what stops one shipping.

import { h, link, icon, emptyState, statRow, stat } from "../dom.js";
import { head, headText, card, section } from "../page.js";
import { selectInput, field } from "../fields.js";
import * as toast from "../toast.js";
import { t } from "../../i18n/i18n.js";
import * as library from "../../services/library-service.js";
import { listHistory } from "../../services/goal-service.js";
import { go } from "../../app/router.js";
import { setCurrentGoal } from "../nav.js";
import { libraryHref, packHref } from "../parts/goal-actions.js";

/* -------------------------------- the list -------------------------------- */

/**
 * Every set this build ships.
 *
 * GOALS ARE READ ONCE AND THE PICKER IS OFFERED EVEN WHEN THE READER CHOSE NO PLAN YET.
 * A reader who opens the library to see what exists, and only then thinks about which goal
 * it is for, has to be able to do that without going somewhere else to find out whether
 * they have any goals — and the picker naming them is how they find out.
 */
export async function render(ctx) {
    const [{ packs, broken }, goals] = await Promise.all([
        library.list(),
        // EVERY goal, not only the active ones. What a reader attaches material to is
        // not a question the page gets to narrow for them: a goal that was finished last
        // month can be finished again, and the page that edits a goal's material says
        // nothing about which ones are allowed to have some. The picker offers what
        // exists.
        listHistory()
    ]);

    const { goalId, pinned } = chosenGoal(ctx?.query?.get("goal") ?? null, goals);
    if (goalId) setCurrentGoal(goalId);

    const node = h("div.stack", null);
    node.appendChild(head("library.title", "library.subtitle"));

    if (broken.length) node.appendChild(brokenNotice(broken.length));

    if (!packs.length) {
        node.appendChild(emptyState(
            t("library.empty_heading"),
            t("library.empty_body"),
            link("/questions/new", t("questions.add"), { class: "btn" })
        ));
        return { node };
    }

    // NO PICKER WITHOUT GOALS. An empty dropdown is a control that can only be set to
    // what it is already set to, which is the thing this file's own picker comment in
    // the question list says not to draw — and the sentence beside it says the real
    // thing anyway, with a link to the screen where the missing goal can be made.
    //
    // AND NO PICKER WHEN A GOAL WAS CHOSEN IN THE URL. A reader who arrived here from a
    // goal's own page already made the choice — "which goal" is answered by the link
    // they followed — and a picker sitting above a list whose buttons all act on that
    // same goal is a control that can only say the thing already said. The link back
    // from a set's own page still carries the goal, so the choice survives the round
    // trip. Browse without one: open `/library` with no query, and the picker returns.
    if (!pinned) {
        if (goals.length) node.appendChild(picker(goalId, goals));
        else node.appendChild(noGoal());
    }

    const list = h("div.stack");
    for (const pack of packs) list.appendChild(packCard(pack, { goalId, goals }));
    node.appendChild(list);

    return { node };
}

/** Which plan this page is acting on, and whether the URL named it.
 *
 * THE REQUESTED GOAL WINS IF IT EXISTS, and the newest active one is only the fallback.
 * It matters which way round those are: a link from an archived plan's own page carries
 * that plan's id, and silently pointing the picker at a different plan would mean the
 * reader's next tap attaches twenty questions to a goal they did not choose. So a request
 * that resolves to nothing falls back — a stale bookmark, a goal deleted on another device
 * — and one that resolves to a goal that exists is honoured whatever its status.
 *
 * `pinned` is what decides whether the picker is drawn at all: a goal named in the URL
 * is a choice already made, and the picker would be a second opinion about it. A request
 * that had to fall back was not a real choice, so the picker comes back.
 */
function chosenGoal(requested, goals) {
    const live = new Set(goals.map((goal) => goal.id));
    if (requested && live.has(requested)) return { goalId: requested, pinned: true };
    return {
        goalId: goals.find((goal) => goal.status === "active" && !goal.archivedAt)?.id
            ?? goals[0]?.id
            ?? null,
        pinned: false
    };
}

/** The plan picker. Changing it navigates rather than hiding the choice in a variable,
 *  because every other screen this page links to carries the choice in its URL and a
 *  preview opened from here has to know where it will come back to. */
function picker(goalId, goals) {
    const control = selectInput({
        value: goalId ?? "",
        options: goals.map((goal) => ({ value: goal.id, label: goal.title }))
    });

    control.addEventListener("change", () => {
        go(libraryHref(control.value), { replace: true });
    });

    // THE FIELD COMPONENT, not a hand-built label/select/hint trio. `field()` is what
    // gives the control an id for its `<label for>`, and an empty `for=""` is a label
    // attached to nothing — which is a screen reader announcing a dropdown with no name,
    // on the one control that decides where twenty questions are about to go.
    return field({
        labelKey: "library.pick_goal",
        hintKey: "library.pick_goal_hint",
        control
    }).node;
}

function noGoal() {
    return card(
        h("p.small.muted", { text: t("library.no_goal_body") }),
        link("/goal", t("home.create_goal"), { class: "btn btn-secondary" })
    );
}

/**
 * One set: what it is, what this device already has of it, and the two things a reader
 * can do with it.
 *
 * THE FIGURES ARE ABOUT THE DEVICE, NOT ABOUT THE FILE. "12 questions" is what the set
 * holds; "on this device: 12 questions" with the plans that use it named below it is what
 * has already happened here, and it is that second line which decides whether the Add
 * button is a decision or a duplicate. It is drawn before the button rather than in a
 * toast afterwards, because the toast is gone by the time the reader wonders whether it
 * worked.
 */
function packCard(pack, { goalId, goals }) {
    const byId = new Map(goals.map((goal) => [goal.id, goal]));
    const meta = [t("library.pack_questions", { n: String(pack.questions.length) })];
    if (pack.subject) meta.push(pack.subject);

    const inGoal = Boolean(goalId && pack.goals.includes(goalId));

    const add = h("button.btn", {
        type: "button",
        // The button is refused rather than hidden when there is nothing to add it to.
        // A page of disabled buttons reads as broken; one disabled button with a
        // sentence above it saying there is no goal yet reads as what it is.
        disabled: !goalId,
        onclick: (event) => addToGoal(event.currentTarget, pack, goalId)
    }, t("library.add_button"));

    return card(
        h("h2", { style: { "margin": "0" }, text: pack.name }),
        pack.description ? h("p.small.muted", { text: pack.description }) : null,
        h("div.tiny.muted", { text: meta.join(" · ") }),
        h("div.row", { style: { gap: "var(--space-2)", "margin-top": "var(--space-3)", "flex-wrap": "wrap" } },
            add,
            // "REMOVE FROM THIS GOAL" SITS BESIDE ADD, OFFERED ONLY WHEN THE CHOSEN GOAL
            // ALREADY USES THE SET. Add on an installed set is a no-op that re-points the
            // goal — useful after tidying, but not a change the row should claim — so the
            // one NEW thing a reader can do with a set their goal already has is take it
            // off, and that is the button shown. It is reversible in one tap, so it does
            // not confirm.
            inGoal
                ? h("button.btn.btn-danger", {
                    type: "button",
                    onclick: (event) => removeFromGoal(event.currentTarget, pack, goalId)
                }, t("library.remove_from_goal"))
                : null,
            link(packHref(pack.id, goalId), t("library.preview_button"),
                { class: "btn btn-secondary" })
        ),
        installedLine(pack, byId)
    );
}

/**
 * Take the chosen goal off this set and redraw.
 *
 * REMOVES THE GOAL'S REFERENCES TO THE SET, not the questions themselves: the copies
 * stay on the device, filable and attachable as the reader likes. The page redraws
 * rather than patching its own row, for the same reason `addToGoal` does — removing a
 * set changes what the row says, and a row patched by hand is a row claiming something
 * no read has confirmed.
 */
async function removeFromGoal(button, pack, goalId) {
    button.disabled = true;
    try {
        await library.removeFromGoal(pack.id, goalId);
        toast.show("toast.library_removed");
        go(libraryHref(goalId), { replace: true });
    } catch (err) {
        button.disabled = false;
        toast.error(err);
    }
}

/**
 * What this device already has of a set, and which plans use it.
 *
 * THE PLANS ARE NAMED AND NOT COUNTED. "Used by 1 goals" is what a count beside a
 * plural label says in a language with two plural forms and in one with six, and this
 * app does not build plural tables — so the sentence is dropped rather than made
 * grammatical for one case and wrong for the other. The chips below it are the answer to
 * "which of my plans already has this", which is the question behind the count: with
 * three goals, "1" does not tell a reader which one, and a chip that is a link to that
 * goal does.
 */
function installedLine(pack, goalsById) {
    if (!pack.copies) {
        return h("p.tiny.muted", {
            style: { "margin-top": "var(--space-2)" },
            text: t("library.not_added")
        });
    }

    const used = pack.goals
        .map((id) => goalsById.get(id))
        .filter(Boolean);

    return h("div", { style: { "margin-top": "var(--space-2)" } },
        h("p.tiny.muted", { text: t("library.on_device", { n: String(pack.copies) }) }),
        used.length
            ? h("div.row", { style: { "flex-wrap": "wrap", gap: "var(--space-1)", "margin-top": "var(--space-1)" } },
                ...used.map((goal) => link(`/goal/${encodeURIComponent(goal.id)}`, goal.title,
                    { class: "chip" })))
            : null
    );
}

/**
 * Copy the set onto this device and point the chosen plan at it.
 *
 * THE PAGE REDRAWS RATHER THAN PATCHING ITS OWN ROW, for the same reason the goal's
 * attachment screen does: adding a set changes what the row says ("not on this device
 * yet" becomes "on this device: 12 questions", with the plans using it named), and a row
 * patched by hand is a row claiming something no read has confirmed.
 *
 * THE TOAST SAYS WHICH OF THE TWO THINGS HAPPENED, because they are not the same act. A
 * copy is a change to the device the reader may want to know about; a re-add copied
 * nothing and only attached a second plan to questions they already had, and reporting
 * both as "added" is how a reader ends up with two copies of a set and no idea which tap
 * did it.
 */
async function addToGoal(button, pack, goalId) {
    if (!goalId) return;
    button.disabled = true;
    try {
        const result = await library.addToGoal(pack.id, goalId);
        // Two `if`s and not one call with a ternary: the two messages are the two things
        // that happened, and reading which is which should not depend on remembering
        // what `result.created` was.
        if (result.created) toast.show("library.added");
        else toast.show("library.reused");
        go(libraryHref(goalId), { replace: true });
    } catch (err) {
        button.disabled = false;
        toast.error(err);
    }
}

/* ------------------------------- one set ---------------------------------- */

/**
 * One set, and all of its questions, with the right answers marked.
 *
 * THE PREVIEW SHOWS THE ANSWER KEY, and that is the whole reason this screen exists
 * beside the Add button. A set of twenty questions is twenty records copied into the
 * reader's own list; what they cannot see afterwards — and cannot check before committing
 * to it — is whether the set is any good. A wrong answer in a library set is permanent in
 * the way a mistyped question is permanent: it will be asked, and it will be graded wrong
 * forever, and the reader will have no way to know the app got it wrong rather than them.
 *
 * Marking the right option by colour alone would fail the reader who cannot see colour,
 * so the mark is an icon AND a line under the list saying what it means.
 */
export async function renderPack(ctx) {
    const id = ctx?.route?.params?.id ?? null;
    const requested = ctx?.query?.get("goal") ?? null;
    const goals = await listHistory();
    const { goalId } = chosenGoal(requested, goals);
    if (goalId) setCurrentGoal(goalId);

    let pack = null;
    let problem = null;
    try {
        pack = library.read(id);
    } catch (err) {
        problem = err;
    }

    const node = h("div.stack", null);

    if (!pack) {
        // A file that is in this build and cannot be read is not the same thing as a set
        // that is not here, and the difference is the whole of what the reader can do
        // next: one of them is a bug in the app and the other is a link from an older
        // build. So the reason is shown rather than a bare "not found".
        //
        // THE CODE IS RENDERED AS `error.<code>` WITHOUT CHECKING WHICH KIND OF ERROR IT
        // IS, because that is the contract `domain/errors.js` states: every error carries
        // a code and every code has a string in both tables. Asking "is this a pack
        // problem?" here would be a second opinion about a set of codes that already has
        // one home — and the version that asked was wrong on its first run, comparing the
        // code against the FIELD it was raised for and therefore showing "not found" for
        // every broken file, which is the one answer that sends a reader looking for an
        // app version instead of at the file.
        node.appendChild(headText(t("library.detail_title"),
            link(libraryHref(goalId), t("common.back"), { class: "btn btn-quiet" })));
        node.appendChild(emptyState(
            problem?.code ? t(`error.${problem.code}`) : t("error.not_found"),
            t("library.detail_gone_body"),
            link(libraryHref(goalId), t("library.back_to_library"), { class: "btn" })
        ));
        return { node };
    }

    const single = pack.questions.filter((question) => question.kind !== "multiple").length;

    node.appendChild(headText(pack.name,
        link(libraryHref(goalId), t("common.back"), { class: "btn btn-quiet" })));

    if (pack.description) {
        node.appendChild(h("p.page-sub", { text: pack.description }));
    }

    node.appendChild(card(statRow(
        stat(pack.questions.length, t("library.pack_questions_short")),
        stat(single, t("questions.kind_single")),
        stat(pack.questions.length - single, t("questions.kind_multiple"))
    )));

    const add = h("button.btn", {
        type: "button",
        disabled: !goalId,
        onclick: (event) => addToGoal(event.currentTarget, pack, goalId)
    }, t("library.add_button"));
    node.appendChild(card(
        h("p.small.muted", { text: goalId ? t("library.add_hint") : t("library.no_goal_body") }),
        add,
        goalId ? null : link("/goal", t("home.create_goal"), { class: "btn btn-secondary" })
    ));

    node.appendChild(section("library.preview_heading",
        ...pack.questions.map((question) => questionPreview(question)),
        h("p.tiny.muted", {
            style: { "margin-top": "var(--space-2)" },
            text: t("library.correct_answer_note")
        })
    ));

    return { node };
}

/** One question of a set: its text, its type, and its options with the right one marked.
 *
 *  THE OPTIONS ARE DRAWN IN THE ORDER THE FILE NAMES THEM and not in a stored order, for
 *  the reason the editor's option list gives: a reader comparing this preview against the
 *  source the set came from has to be able to say "the third one" and mean the same thing
 *  on both screens. */
function questionPreview(question) {
    return h("div.card.card-quiet", null,
        h("div.question-text", { text: question.text }),
        h("div.tiny.muted", {
            text: t(question.kind === "multiple" ? "questions.kind_multiple" : "questions.kind_single")
        }),
        h("div.options", { style: { "margin-top": "var(--space-3)" } },
            ...question.options.map((option, index) => h("div.option", {
                style: { cursor: "default" },
                "data-state": option.isCorrect ? "correct" : null
            },
            // The number comes FIRST, as it does in the editor, so "the third one"
            // means the same row on this screen and on the one where the positions are
            // established. The mark then sits immediately left of the answer it marks,
            // which is the thing the row is about.
            h("span.option-index", { text: String(index + 1) }),
            h("span.option-mark", null, option.isCorrect ? icon("check", 14) : ""),
            h("span.grow", { text: option.text })
            ))
        )
    );
}

/* ------------------------------- broken ----------------------------------- */

/**
 * A banner saying some of the sets in this build could not be read.
 *
 * THE COUNT AND NOT THE NAMES, because a name is not something a reader can do anything
 * with: the files are not theirs to fix and there is no second screen listing them. What a
 * reader can be told is that the library is smaller than it should be — which is true, and
 * which they would otherwise work out by noticing a set they were told about is missing.
 */
function brokenNotice(count) {
    return h("div.banner.banner-warn", {
        role: "status",
        text: t("library.broken_line", { n: String(count) })
    });
}

/* --------------------------------- links ---------------------------------- */

// The two link builders live in `parts/goal-actions.js` with `contentHref` and
// `buildHref`, because the thing they carry in the query is a GOAL and the screens that
// link here are a goal's own screens. Writing them here instead would make the same
// `/library?goal=` URL three separate strings.