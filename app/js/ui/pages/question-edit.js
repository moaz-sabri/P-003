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

import { h, link, frag, mount } from "../dom.js";
import { head, section, card, destructiveButton } from "../page.js";
import { field, textInput, textareaInput, selectInput, form, submitButton } from "../fields.js";
import * as toast from "../toast.js";
import { t } from "../../i18n/i18n.js";
import { LIMITS, QUESTION_KINDS } from "../../domain/validation.js";
import { snapshot } from "../../services/goal-service.js";
import * as questions from "../../services/question-service.js";
import { go } from "../../app/router.js";

/**
 * @param {object} ctx  the router's context. The id of the question being edited
 *   comes from `ctx.route.params` and not from anywhere else in the context —
 *   `params` is a property OF the matched route, so reading it off the context
 *   directly is a crash on both this screen's two paths, and the `/questions/new`
 *   one is reached by a link a reader taps within a minute of setting the app up.
 */
export async function render(ctx) {
    const params = ctx?.route?.params ?? {};

    const { goal } = await snapshot();
    if (!goal) {
        return { node: h("div.stack", null, head("question.new_title", null),
            h("p.muted", { text: t("home.no_goal_body") }),
            link("/goal", t("home.create_goal"), { class: "btn" })) };
    }

    const existing = params.id ? await questions.load(params.id) : null;
    if (params.id && !existing) {
        // A question that a sync merge removed, or an id in a URL that was typed
        // by hand. The not-found page, not a form that would save over nothing.
        return { node: notFound() };
    }

    return { node: editor(goal, existing) };
}

/* -------------------------------- editor --------------------------------- */

function editor(goal, existing) {
    // The draft is the state. Rows are rebuilt from it, so removing option 2 of 4
    // renumbers what is left and every error message that referred to an index
    // is cleared by the same operation — an index-keyed error map kept alongside
    // a row list is a thing that gets out of step the first time a row is
    // removed in the middle.
    const draft = {
        text: existing?.text ?? "",
        kind: existing?.kind ?? "single",
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
     * One answer: the text, whether it is the answer, and — only above the
     * minimum — the button that removes it.
     *
     * ALL THREE ON ONE ROW. The remove button used to sit on a second row of its
     * own, full width, under every option: six options meant six extra 44px rows
     * of a screen doing nothing, and the thing the reader is most likely to want
     * — delete the fourth answer they typed by mistake — was the smallest target
     * in the form. Here it is beside the other control for that option, at the
     * same height, and the row is `flex-wrap` so it moves under the box rather
     * than beside it on a 320px screen.
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

        const remove = h("button.btn.btn-quiet.option-remove", {
            type: "button",
            // Not offered below the minimum: see the header.
            hidden: draft.options.length <= LIMITS.OPTIONS_MIN,
            "aria-label": t("question.remove_option"),
            onclick: () => {
                draft.options.splice(index, 1);
                drawOptions();
            }
        }, t("question.remove_option"));

        const box = h("div", null,
            h("div.row.option-row", { style: { "gap": "var(--space-2)", "align-items": "center" } },
                input,
                h("button.btn.btn-secondary", {
                    type: "button",
                    // The check is a separate control from the text box, so it can
                    // be a real checkbox with a real label and the reader never
                    // has to aim at a 20px square to say "this is the answer".
                    "aria-pressed": option.isCorrect ? "true" : "false",
                    style: { "flex": "0 0 auto", "min-width": "5.5rem" },
                    onclick: (event) => {
                        if (draft.kind === "single") {
                            for (const other of draft.options) other.isCorrect = false;
                            option.isCorrect = true;
                            drawOptions();
                            return;
                        }
                        option.isCorrect = !option.isCorrect;
                        event.currentTarget.setAttribute("aria-pressed", option.isCorrect ? "true" : "false");
                    }
                }, t("question.option_correct")),
                remove
            ),
            message
        );
        return box;
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
        const result = await questions.save(goal.id, {
            id: existing?.id,
            text: draft.text,
            kind: draft.kind,
            options: draft.options
        });
        if (!result.ok) {
            save.setBusy(false);
            showErrors(result.errors);
            return;
        }
        toast.show("toast.question_saved");
        go("/questions");
    },
    h("div.stack", null,
        kindField.node,
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