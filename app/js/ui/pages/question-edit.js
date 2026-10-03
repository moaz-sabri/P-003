// The question editor.
//
// The whole of it is the option list, so that is what the page is built around.
// Two rules in it:
//
//   * TWO OPTIONS MINIMUM, SIX MAXIMUM, ENFORCED BY THE BUTTONS AND NOT ONLY BY
//     THE VALIDATOR. The validator refuses a question with one option, but the
//     button that removes the last option is not there — a rule the reader can
//     only find out by trying it and being told afterwards is a worse rule than
//     one they cannot break.
//
//   * SWITCHING TO "EXACTLY ONE CORRECT" CLEARS THE OTHERS. It is the same rule
//     the validator enforces, applied at the moment it becomes true rather than
//     at the moment of saving. A question that is visibly broken — two boxes
//     ticked under a heading that says one — is a state the editor should never
//     be able to show, because the reader's only clue would be a red message
//     about a field they are not currently looking at.
//
// Validation errors arrive as a map keyed by field, and the editor underlines
// exactly the row they name. It does not decide which field is wrong — that is
// domain/validation.js, the same code the API runs.

import { h, link, mount } from "../dom.js";
import { head, section, card, destructiveButton } from "../page.js";
import { field, textInput, textareaInput, selectInput, form, submitButton } from "../fields.js";
import * as toast from "../toast.js";
import { t, formatDateTime } from "../../i18n/i18n.js";
import { LIMITS, QUESTION_KINDS } from "../../domain/validation.js";
import * as groups from "../../services/group-service.js";
import * as questions from "../../services/question-service.js";
import * as content from "../../services/goal-content-service.js";
import { go } from "../../app/router.js";

/**
 * @param {object} ctx  the router's context. The id of the question being edited
 *   comes from `ctx.route.params` and not from anywhere else in the context —
 *   `params` is a property OF the matched route, so reading it off the context
 *   directly is a crash on both this screen's two paths, and the `/questions/new`
 *   one is reached by a link a reader taps within a minute of setting the app up.
 *
 * The GOAL and the GROUP come from the query string, not from the context:
 * `/questions/new?goal=abc&group=xyz` means "a new question, in that goal, filed
 * under that group", which is the link every list in the app uses and the only way
 * a question can be created already knowing where it belongs. Without the query the
 * page falls back to the newest goal and the goal's unfiled group, so the bare
 * `/questions/new` link in the nav still works.
 */
export async function render(ctx) {
    const params = ctx?.route?.params ?? {};
    const groupId = ctx?.query?.get("group") ?? null;

    const existing = params.id ? await questions.load(params.id) : null;
    if (params.id && !existing) {
        // A question that a sync merge removed, or an id in a URL that was typed
        // by hand. The not-found page, not a form that would save over nothing.
        return { node: notFound() };
    }

    // NO GOAL IS ASKED FOR, AND NO GOAL IS REQUIRED. Not "the question's own" and not
    // "the newest active one" — neither, because a question has no goal and a goal
    // has no questions, and the only thing between them is a reference the reader
    // makes on the goal's page.
    //
    // The version this replaces asked twice and got it wrong both ways. It read the
    // goal off the URL when there was one and off `snapshot()`'s default of the
    // NEWEST active goal when there was not, then wrote that back onto the question on
    // save — so opening a question from a bookmark, or from the reports page's "needs
    // work" list, filed it under whichever subject happened to be newest, and every
    // answer the reader had ever given it went with it. A "which goal" select existed
    // here for the same reason and was worse: it was a MOVE control wearing a "file
    // under" label, and a reader tidying twenty shared questions between two subjects
    // had to open each one in turn to do it.
    //
    // Both are gone because there is nothing to choose. Sharing a question between two
    // goals is now one tap on each goal, and it cannot be done by accident.
    const [groupList, unfiled] = await Promise.all([groups.list(), groups.unfiled()]);

    // AN ID THAT IS NOT IN THE LIST IS REPLACED BY UNFILED, for both a new question
    // and an existing one. A select whose stored value matches no option shows its
    // FIRST option and reports that as the value on change, so leaving a stale id in
    // would file the question into whichever group happened to be alphabetically
    // first — a question silently changing shelf because its shelf was deleted
    // somewhere else. `null` and `undefined` both mean unfiled, so an existing
    // question written before groups existed lands there too.
    const known = new Set(groupList.map((g) => g.id));
    const requested = existing ? existing.groupId : groupId;
    const groupIdFor = requested && known.has(requested) ? requested : unfiled.id;

    return { node: editor(existing, { groupList, unfiled, groupId: groupIdFor }) };
}

/* -------------------------------- editor --------------------------------- */

function editor(existing, { groupList, unfiled, groupId }) {
    // The draft is the state. Rows are rebuilt from it, so removing option 2 of 4
    // renumbers what is left and every error message that referred to an index
    // is cleared by the same operation — an index-keyed error map kept alongside
    // a row list is a thing that gets out of step the first time a row is
    // removed in the middle.
    const draft = {
        text: existing?.text ?? "",
        kind: existing?.kind ?? "single",
        // AN EXISTING QUESTION KEEPS ITS GROUP even when the URL names a different
        // one: the query is where a NEW question should be filed, and a link that
        // came from another group's list must not silently re-file a question the
        // reader opened from the question list.
        groupId: groupId ?? unfiled.id,
        options: existing?.options?.map((o) => ({
            id: o.id,
            text: o.text,
            isCorrect: o.isCorrect
        })) ?? [
            { id: null, text: "", isCorrect: true },
            { id: null, text: "", isCorrect: false }
        ]
    };

    const textField = field({
        labelKey: "question.field_text",
        control: textareaInput({ rows: 3, maxlength: LIMITS.TEXT_MAX })
    });
    textField.control.value = draft.text;
    textField.control.addEventListener("input", () => {
        textField.setError(null);
        draft.text = textField.control.value;
    });

    const kindField = field({
        labelKey: "question.field_kind",
        control: selectInput({
            value: draft.kind,
            options: QUESTION_KINDS.map((k) => ({ value: k, labelKey: `question.kind_${k}` }))
        })
    });
    kindField.control.addEventListener("change", () => {
        draft.kind = kindField.control.value;
        if (draft.kind === "single") {
            // Keep the first ticked option and untick the rest. Keeping the first
            // rather than keeping none is the choice that lets somebody fix a
            // multiple-choice question into a single-choice one without having to
            // remember which one was the answer.
            let kept = false;
            for (const option of draft.options) {
                if (option.isCorrect && !kept) kept = true;
                else option.isCorrect = false;
            }
            if (!kept && draft.options.length) draft.options[0].isCorrect = true;
        }
        drawOptions();
    });

    const optionsBox = h("div.stack-tight");
    const optionsError = h("div.field-error", { hidden: true, role: "alert" });
    const rowErrors = new Map();

    /**
     * Which shelf this question is filed on.
     *
     * A SELECT, and not a fixed set of chips: the list is however many groups the
     * reader has made, and a select scrolls when there are fifty of them while a row
     * of fifty chips does not. The unfiled group is IN the list under its own name,
     * because it is a group like any other and a reader moving a question out of a
     * group needs somewhere to move it to that is visible on the same control.
     *
     * THERE IS NO GOAL CONTROL HERE, and its absence is the point rather than a gap.
     * A group is a shelf belonging to nobody; which goals draw on it is a decision
     * made on each goal's own page, and the same shelf can serve three of them. The
     * picker that used to sit here was a "which goal does this question belong to"
     * select, and it could only ever have one answer — a question in one goal — so it
     * was a move control with a filing label on it, and a reader who wanted the same
     * twenty words in two subjects had to open each question and change it.
     */
    const placeField = field({
        labelKey: "question.field_group",
        hintKey: "question.hint_group",
        control: selectInput({
            value: draft.groupId,
            // A reader who has never filed anything still gets one option here — the
            // unfiled shelf, under its own name — and it is created on demand rather
            // than left as an empty select, because a `<select>` with no options is a
            // control that looks broken and says nothing.
            options: groupList.map((g) => ({ value: g.id, label: g.name }))
                .concat([{ value: "", label: t("question.no_group") }])
        })
    });
    placeField.control.addEventListener("change", () => {
        draft.groupId = placeField.control.value || null;
    });

    function drawOptions() {
        optionsError.hidden = true;
        const rows = draft.options.map((option, index) => optionRow(option, index));
        mount(optionsBox,
            h("div.options", { style: { "display": "flex", "flex-direction": "column", gap: "var(--space-2)" } },
                rows),
            h("p.small.muted", { style: { "margin-top": "var(--space-2)" }, text: t("question.option_hint") }),
            addButton(),
            optionsError
        );
    }

    /**
     * One answer: its number, its text, whether it is the answer, and — only
     * above the minimum — the button that removes it.
     *
     * ALL FOUR ON ONE ROW. The remove button used to sit on a second row of its
     * own, full width, under every option: six options meant six extra 44px rows
     * of a screen doing nothing, and the thing the reader is most likely to want
     * — delete the fourth answer they typed by mistake — was the smallest target
     * in the form. Here it is beside the other control for that option, at the
     * same height, and the row is `flex-wrap` so it moves under the box rather
     * than beside it on a 320px screen.
     *
     * THE CORRECT MARK IS VISIBLE, WHICH IS THE WHOLE POINT OF THIS ROW.
     *
     * It used to be a `<button>` whose only state change was `aria-pressed`, and
     * the stylesheet has no `aria-pressed` rule for a button — only for
     * `.option`, which is the exercise page's answer row. So every option looked
     * exactly the same whether or not it was the answer: the reader could tick
     * three options, save, and have no way to tell which three the app stored.
     * It is a real `<input type="checkbox">` now, inside a label that carries the
     * word, and the whole row is tinted — three cues, because the checkbox alone
     * is a 22px target and the tint alone is invisible to a reader who cannot see
     * it.
     */
    function optionRow(option, index) {
        const input = textInput({ value: option.text, maxlength: LIMITS.OPTION_MAX });
        const message = h("div.field-error", { hidden: true, role: "alert" });
        rowErrors.set(index, message);

        input.addEventListener("input", () => {
            option.text = input.value;
            message.hidden = true;
            input.removeAttribute("aria-invalid");
        });

        const checkbox = h("input", { type: "checkbox", checked: option.isCorrect });
        const correctLabel = h("label.option-correct", null,
            checkbox,
            h("span", { text: t("question.option_correct") })
        );

        const row = h("div.option-edit", { dataset: { correct: String(Boolean(option.isCorrect)) } },
            // The position, written down. The options are shown in the order they
            // were typed, always — see `exercise-service.load()` — so "the third
            // one" has to mean the same thing here and on the other device.
            h("span.option-index", { text: String(index + 1) }),
            input,
            correctLabel,
            h("button.btn.btn-quiet.option-remove", {
                type: "button",
                // Not offered below the minimum: see the header.
                hidden: draft.options.length <= LIMITS.OPTIONS_MIN,
                "aria-label": t("question.remove_option"),
                onclick: () => {
                    draft.options.splice(index, 1);
                    drawOptions();
                }
            }, t("question.remove_option"))
        );

        checkbox.addEventListener("change", () => {
            if (draft.kind === "single") {
                // Keep the one that was just ticked and clear the rest. A redraw
                // rather than an attribute write because three other rows are now
                // showing a mark they should not be showing, and there is one rule
                // here rather than four copies of it.
                for (const other of draft.options) other.isCorrect = false;
                option.isCorrect = true;
                drawOptions();
                return;
            }
            option.isCorrect = checkbox.checked;
            row.dataset.correct = String(option.isCorrect);
        });

        return h("div", null, row, message);
    }

    function addButton() {
        return h("button.btn.btn-secondary.btn-block", {
            type: "button",
            hidden: draft.options.length >= LIMITS.OPTIONS_MAX,
            onclick: () => {
                draft.options.push({ id: null, text: "", isCorrect: false });
                drawOptions();
            }
        }, t("question.add_option"));
    }

    const save = submitButton(existing ? "question.save_edit" : "question.save_new");

    const body = form(async () => {
        save.setBusy(true);
        clearErrors();
        const result = await questions.save({
            id: existing?.id,
            text: draft.text,
            kind: draft.kind,
            groupId: draft.groupId,
            options: draft.options
        });
        if (!result.ok) {
            save.setBusy(false);
            showErrors(result.errors);
            return;
        }
        toast.show("toast.question_saved");
        // Back to the list. No goal in the URL, and no group either: the question may
        // have just been filed on a different shelf, and a list filtered by the old
        // one would not contain it — which is the same reason the old link carried
        // `?goal=` and this one carries nothing.
        go("/questions");
    },
    h("div.stack", null,
        kindField.node,
        placeField.node,
        textField.node,
        section("question.field_options", optionsBox),
        save.node
    )
    );

    function clearErrors() {
        textField.setError(null);
        optionsError.hidden = true;
        for (const message of rowErrors.values()) {
            message.hidden = true;
        }
    }

    function showErrors(errors) {
        for (const [fieldName, code] of Object.entries(errors)) {
            if (fieldName === "text") {
                textField.setError(code);
            } else if (fieldName === "kind") {
                kindField.setError(code);
            } else if (fieldName === "options") {
                optionsError.textContent = t(`error.${code}`);
                optionsError.hidden = false;
            } else if (fieldName.startsWith("options.")) {
                const message = rowErrors.get(Number(fieldName.slice(8)));
                if (message) {
                    message.textContent = t(`error.${code}`);
                    message.hidden = false;
                }
            }
        }
    }

    drawOptions();

    const node = h("div.stack", null,
        head(existing ? "question.edit_title" : "question.new_title", null,
            link("/questions", t("common.back"), { class: "btn btn-quiet" })),
        card(body),
        // WHERE THIS QUESTION HAS BEEN ASKED. Only for a question that exists, since
        // it is a question about a question. This is the payoff of an item being a row
        // pointing at a question rather than a column on it: the question has no list
        // of its exercises, and asking for one is a query. The section is below the
        // form because it is a fact ABOUT the question rather than a way to change it.
        existing ? askedInSection(existing) : null,
        existing
            ? destructiveButton("question.delete", {
                titleKey: "questions.delete_title",
                bodyKey: "questions.delete_body"
            }, async () => {
                await questions.remove(existing.id);
                toast.show("questions.delete_done");
                go("/questions");
            })
            : null
    );

    return node;
}

/**
 * The exercises this question has been in.
 *
 * IT IS A LIST AND NOT A COUNT, and the rows say whether the exercise is finished,
 * because "this has been asked twice" and "this is sitting open right now on your
 * phone" call for different responses from a reader deciding whether to revise it.
 * A bare count would hide the second case entirely — the two open exercises and the
 * two finished ones are both "2".
 *
 * AND IT IS NOT A HISTORY OF THIS QUESTION. An exercise the plan drew that happened to
 * include it is here, and one the reader built by naming it is here, and nothing
 * stored distinguishes them. So the heading says "asked in" rather than "your history
 * of this question": the reader is being told which of their sessions carry it, which
 * is the thing they can act on, rather than being shown a story about the question's
 * life that the records cannot support.
 *
 * DRAWN AFTER THE PAGE HAS RENDERED, and the section is left in place with its own
 * empty state if the read fails. A question whose exercise list cannot be read is
 * still a question that can be edited and saved, and an editor that refuses to draw
 * because a side panel failed would be losing the reader's edit over a detail.
 */
function askedInSection(question) {
    const container = h("div.stack-tight");

    // Both facts about this question, read together because they are the two things a
    // reader opens the editor to find out: which sessions have asked it, and which
    // goals train on it. The second is new — a question has no goal, so "which goals
    // use this" is a query and it is the query that replaced a field.
    Promise.all([
        questions.exercisesFor(question.id),
        content.goalsUsingQuestion(question.id)
    ]).then(([list, goals]) => {
        // `mount` rather than `replaceChildren`: the list is a `.map` and the fallback is a
        // one-element array, and the native method takes Nodes only — an array would
        // be printed as "[object HTMLDivElement]". See `mount` in ui/dom.js.
        const parts = [];
        if (goals.length) {
            parts.push(h("p.small.muted", {
                text: t("content.used_by_goals", { n: String(goals.length) })
            }));
            parts.push(h("div.row", { style: { gap: "var(--space-1)", "flex-wrap": "wrap" } },
                ...goals.map((goal) => link(
                    `/goal/${encodeURIComponent(goal.id)}`,
                    goal.title,
                    { class: "chip" }
                ))
            ));
        }
        parts.push(...(list.length
            ? list.map((exercise) => exerciseRow(exercise))
            : [h("p.muted", { text: t("question.never_asked") })]));
        mount(container, ...parts);
    }).catch(() => {
        mount(container, h("p.muted", { text: t("question.asked_unknown") }));
    });

    return section("question.asked_heading", card(container));
}

/** One exercise the question has been an item of.
 *
 *  THE "CHOSEN" MARK IS ABOUT THE RECORD, NOT THE READER'S INTENT. An exercise is
 *  marked when it carries a selection — `groupIds` or `questionIds` — which means it
 *  was built by the picker rather than drawn by the plan. It does not mean the reader
 *  picked THIS question on purpose: a question can be in a named group the exercise
 *  took whole. The mark is here because "was this session mine or the app's?" is the
 *  question a reader is asking when they open this list, and the record can answer
 *  the first half of it even though it cannot answer the second.
 */
function exerciseRow(exercise) {
    const chosen = Boolean(exercise.groupIds?.length || exercise.questionIds?.length);

    return h("div.card.card-quiet.row-between", { style: { "gap": "var(--space-2)" } },
        h("div.grow", null,
            link(`/exercise/result?id=${encodeURIComponent(exercise.id)}`,
                t("exercise.row_done", { n: String(exercise.number) })),
            // The DATE, and "open" for one that has not been finished — because a
            // session still sitting open on this device is the row a reader revising
            // this question most needs to notice, and a timestamp alone hides it
            // among a column of dates.
            h("div.tiny.muted", {
                text: exercise.completedAt
                    ? formatDateTime(exercise.completedAt)
                    : t("question.asked_open")
            })
        ),
        chosen ? h("span.tiny.muted", { text: t("question.chosen") }) : null
    );
}

function notFound() {
    return h("div.stack", null,
        head("common.app_name", null),
        h("div.empty", null,
            h("h2", { text: t("error.not_found") }),
            h("p", { text: t("common.back") }),
            link("/questions", t("questions.title"), { class: "btn" })
        )
    );
}