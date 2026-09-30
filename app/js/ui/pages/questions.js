// The question list.
//
// One row per question, in the reader's order, with the three states that matter:
// never asked, last answer wrong, last answer right. The state is a label and a
// tint and nothing more — this is the screen somebody opens to check "did that
// one stick", and it is not the place to be asked to do anything about it.
//
// Deleting is here rather than only in the editor because a list of two hundred
// questions is where "that one was a typo and I want it gone" is actually
// expressed, and it confirms first.

import { h, link, emptyState, statRow, stat, icon } from "../dom.js";
import { head, card } from "../page.js";
import { confirm } from "../dialog.js";
import * as toast from "../toast.js";
import { t } from "../../i18n/i18n.js";
import { snapshot } from "../../services/goal-service.js";
import * as questions from "../../services/question-service.js";
import { go } from "../../app/router.js";

const STATE_TINT = {
    new: "var(--track)",
    review: "var(--bad-soft)",
    learned: "var(--ok-soft)"
};

export async function render() {
    const { goal } = await snapshot();
    if (!goal) {
        return { node: h("div.stack", null, head("questions.title", null), emptyState(
            t("home.no_goal_heading"), t("home.no_goal_body"),
            link("/goal", t("home.create_goal"), { class: "btn" })
        )) };
    }

    const list = await questions.list(goal.id);
    const node = h("div.stack", null);

    node.appendChild(head(
        "questions.title",
        "questions.subtitle",
        list.length
            ? link("/questions/new", t("questions.add"), { class: "btn" })
            : null
    ));

    if (!list.length) {
        node.appendChild(emptyState(
            t("questions.empty_heading"),
            t("questions.empty_body"),
            link("/questions/new", t("questions.add"), { class: "btn" })
        ));
        return { node };
    }

    const counts = { new: 0, review: 0, learned: 0 };
    for (const q of list) counts[q.state] += 1;

    node.appendChild(card(statRow(
        stat(counts.new, t("questions.state_new")),
        stat(counts.review, t("questions.state_review")),
        stat(counts.learned, t("questions.state_learned"))
    )));

    const stack = h("div.stack-tight");
    for (const question of list) stack.appendChild(rowFor(question));
    node.appendChild(stack);

    return { node };
}

/** One row. The whole row is the tap target — a 20px-tall link beside a long
 *  question is not a thing anybody hits reliably on a phone — and the delete
 *  control is deliberately inside it rather than next to it, so the row's width
 *  does not change when it appears.
 *
 *  THE DELETE CONTROL IS AN ICON, not a typed `×`. The multiplication sign is one
 *  thin glyph at the text size, it sits at the optical centre of whatever line it
 *  lands on, and it is not a shape anybody has agreed means "delete" — a trash
 *  outline or a cross in a circle reads as the control it is at 20px as well as at
 *  200px. The app already draws one (`cross`, in ui/dom.js) for the same reason it
 *  is here rather than a new one. */
function rowFor(question) {
    const stateLabel = t(`questions.state_${question.state}`);

    const row = h("div.card.card-quiet.row-between", {
        style: {
            "border-inline-start": `4px solid ${STATE_TINT[question.state]}`,
            "gap": "var(--space-3)"
        }
    },
    h("div.grow", null,
        link(`/questions/${question.id}`, question.text),
        h("div.row", { style: { "margin-top": "var(--space-1)" } },
            h("span.tiny.muted", { text: stateLabel }),
            h("span.tiny.muted", {
                text: question.kind === "multiple"
                    ? t("questions.kind_multiple")
                    : t("questions.kind_single")
            })
        )
    ),
    h("button.btn.btn-quiet.row-delete", {
        type: "button",
        "aria-label": t("common.delete"),
        onclick: (event) => remove(event, question)
    }, icon("cross", 18))
    );

    return row;
}

async function remove(event, question) {
    const confirmed = await confirm({
        titleKey: "questions.delete_title",
        bodyKey: "questions.delete_body"
    });
    if (!confirmed) return;
    const row = event.currentTarget.closest(".card");
    try {
        await questions.remove(question.id);
        toast.show("questions.delete_done");
        row?.remove();
    } catch (err) {
        toast.error(err);
    }
}