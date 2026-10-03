// The question list: every question, in the reader's own order.
//
// THIS PAGE HAS NO GOAL IN IT, and that is the change. It used to open on "the
// questions of this goal" and take a `?goal=` on every link, which meant the list a
// reader saw depended on which subject they happened to be looking at — and a
// question could be in exactly one of those lists, so writing a question meant
// choosing a subject at the moment of writing it.
//
// Now there is one list. The group chips filter it, the state labels describe each
// question's own history, and what a goal trains on is a separate decision made on
// the goal's own page. A reader with two hundred questions in three subjects sees
// two hundred questions here, and attaches each subject's questions to the goals
// that cover them.
//
// The two things that were a goal's are now global, and both are honest global
// answers rather than a scope that leaked:
//
//   * THE STATE — new, to review, learned — is per question and derived from the
//     attempt log. A shared question is one thing the reader knows or does not, so
//     getting it right in one session marks it right everywhere. A per-goal flag on
//     it would mean the same twenty words could be "learned" in French and "never
//     asked" in Arabic, which is two answers to one question.
//
//   * THE "ASKED IN" COUNT — how many of this list's questions have been in a
//     session at all — is likewise global, and it is the number that matters on this
//     screen: the reader is asking "is this material thoroughly covered?", which is a
//     question about the collection.
//
// The group filter is a row of chips under the heading, and it is a filter rather than
// a folder because a question's group is a property of the question, not a place it
// lives. "Show me the verbs" and "show me everything not filed yet" are the same
// question asked with a different group, and there is one list underneath either way
// — which is what makes the count on the chip meaningful: it is a count of that list,
// not of a separate collection that has drifted from it.

import { h, link, emptyState, statRow, stat, icon } from "../dom.js";
import { head, card } from "../page.js";
import { confirm } from "../dialog.js";
import * as toast from "../toast.js";
import { t } from "../../i18n/i18n.js";
import * as questions from "../../services/question-service.js";
import * as content from "../../services/goal-content-service.js";
import { go } from "../../app/router.js";

const STATE_TINT = {
    new: "var(--track)",
    review: "var(--bad-soft)",
    learned: "var(--ok-soft)"
};

export async function render(ctx) {
    // The group filter is the ONLY query this page reads, and a group id that does
    // not resolve is IGNORED rather than refused: a sync merge can tombstone the
    // group a bookmark names, and a reader following an old link should get their
    // questions rather than a "not found".
    const wanted = ctx?.query?.get("group") ?? null;

    const [counts, list] = await Promise.all([questions.counts(), questions.list()]);
    const groupRows = counts.filter((row) => row.group);
    const selected = groupRows.find((row) => row.group.id === wanted)?.group ?? null;
    const shown = selected ? list.filter((q) => q.groupId === selected.id) : list;

    const node = h("div.stack", null);
    node.appendChild(head(
        "questions.title",
        "questions.subtitle",
        link("/questions/new", t("questions.add"), { class: "btn" })
    ));

    // The chips, when there is something to choose between. One group and no filter
    // is not a filter, so the row is not drawn at all — a row of one chip that is
    // always on is a control that says nothing.
    if (groupRows.length > 1) {
        node.appendChild(card(chipRow(groupRows, selected, counts)));
    }

    if (!shown.length) {
        node.appendChild(emptyState(
            selected
                ? t("questions.group_empty_heading", { name: selected.name })
                : t("questions.empty_heading"),
            selected
                ? t("questions.group_empty_body", { name: selected.name })
                : t("questions.empty_body"),
            // TWO WAYS OUT, because "add one" is a request to type and a reader with an
            // empty list has not necessarily decided to type. The library is the way in
            // for someone who wants a subject covered rather than one question written,
            // and it is offered HERE — the page a reader lands on — because the moment a
            // reader is told they have no questions is the moment that offer is worth
            // anything.
            h("div.row", null,
                link(selected
                    ? `/questions/new?group=${encodeURIComponent(selected.id)}`
                    : "/questions/new",
                t("questions.add"), { class: "btn" }),
                link("/library", t("library.browse"), { class: "btn btn-secondary" })
            )
        ));
        return { node };
    }

    const tally = { new: 0, review: 0, learned: 0 };
    for (const q of shown) tally[q.state] += 1;

    node.appendChild(card(statRow(
        stat(tally.new, t("questions.state_new")),
        stat(tally.review, t("questions.state_review")),
        stat(tally.learned, t("questions.state_learned"))
    )));

    // HOW MANY GOALS USE THIS LIST — one line above the rows rather than a badge per
    // row, because the reader's question is about the collection ("is this material
    // actually in use, or did I write it and never use it?") and not about any one
    // question. Zero is left off entirely: a question in no goal is not a question
    // with a disappointing history, and a `0` on every row of a fresh install reads
    // as a fault.
    const inUse = await countGoalsUsing(shown);
    if (inUse > 0) {
        node.appendChild(h("p.small.muted", {
            style: { "margin-top": "var(--space-2)" },
            text: t("questions.used_by", { n: String(inUse) })
        }));
    }

    // And how many sessions have asked them at all — the other half of the same
    // question. A question in no goal has never been asked, so these two counts
    // answer "written, used, and practised" without the reader having to work out
    // which of the three states a row is in.
    const asked = await questions.askedInCounts(shown.map((q) => q.id));
    const everAsked = asked.size;
    if (everAsked) {
        node.appendChild(h("p.small.muted", {
            style: { "margin-top": "var(--space-2)" },
            text: t("questions.asked_in_n", { n: String(everAsked) })
        }));
    }

    const stack = h("div.stack-tight");
    for (const question of shown) stack.appendChild(await rowFor(question));
    node.appendChild(stack);

    return { node };
}

/**
 * How many of these questions are attached to at least one goal.
 *
 * ONE READ FOR THE WHOLE LIST. This runs on a list that can have two hundred rows on
 * it, and asking per row would be two hundred transactions on a screen a reader is
 * waiting for. The `goalId` set is built here rather than by each row asking
 * "am I in a goal" — a question the row does not draw anyway, and which would be a
 * per-row read for a figure that is printed once.
 */
async function countGoalsUsing(list) {
    // The question list can be two hundred rows, and the answer is ONE number. So
    // this reads the whole reference table once and answers from that, rather than
    // asking per row — which was two hundred transactions on the screen a reader is
    // waiting on, for a figure printed once at the top.
    const { listAllGoalRefs } = await import("../../data/repo-goals.js");
    const refs = await listAllGoalRefs();
    const wanted = new Set(list.map((q) => q.id));
    const goals = new Set();
    for (const ref of refs) {
        if (ref.refType !== "question" || !wanted.has(ref.refId)) continue;
        goals.add(ref.goalId);
    }
    return goals.size;
}

/** One chip per group, plus "everything". The unfiled group is included by name
 *  rather than as a separate row, because it IS a group — the one every question
 *  written before groups existed is on, and a reader with forty questions and no
 *  groups needs to be told that they have forty unfiled questions rather than be
 *  shown an empty list. */
function chipRow(groupRows, selected, counts) {
    const total = counts.reduce((sum, row) => sum + row.total, 0);

    const all = chip({
        label: t("questions.filter_all", { n: String(total) }),
        active: !selected,
        href: "/questions"
    });

    const chips = groupRows.map((row) => chip({
        label: `${row.group.name} · ${row.total}`,
        active: row.group.id === selected?.id,
        href: `/questions?group=${encodeURIComponent(row.group.id)}`
    }));

    return h("div.chips", null, all, ...chips);
}

function chip({ label, active, href }) {
    return h("a.chip", {
        href,
        "data-link": true,
        "aria-current": active ? "true" : null
    }, label);
}

/** One row. The whole row is the tap target — a 20px-tall link beside a long
 *  question is not a thing anybody hits reliably on a phone — and the delete
 *  control is deliberately inside it rather than next to it, so the row's width
 *  does not change when it appears.
 *
 *  THE DELETE CONTROL IS AN ICON, not a typed `×`. The multiplication sign is one
 *  thin glyph at the text size, it sits at the optical centre of whatever line it
 *  lands on, and it is not a shape anybody has agreed means "delete" — a cross in a
 *  circle reads as the control it is at 20px as well as at 200px. The app already
 *  draws one (`cross`, in ui/dom.js) for the same reason it is here rather than a
 *  new one.
 *
 *  THE LINK CARRIES NO GOAL, which is the thing that makes this row safe. It used to
 *  carry `?goal=` on every link so the editor would not fall back to the newest goal
 *  and file the question there — a defence against a bug that no longer exists,
 *  because there is nowhere for a question to be filed any more. */
async function rowFor(question) {
    const stateLabel = t(`questions.state_${question.state}`);

    const row = h("div.card.card-quiet.row-between", {
        style: {
            "border-inline-start": `4px solid ${STATE_TINT[question.state]}`,
            "gap": "var(--space-3)"
        }
    },
    h("div.grow", null,
        link(`/questions/${encodeURIComponent(question.id)}`, question.text),
        h("div.row", { style: { "margin-top": "var(--space-1)" } },
            h("span.tiny.muted", { text: stateLabel }),
            h("span.tiny.muted", {
                text: question.kind === "multiple"
                    ? t("questions.kind_multiple")
                    : t("questions.kind_single")
            }),
            // The group's name, when the question is filed on one. A question with no
            // group shows nothing rather than a dash: "no group" is not a fact about
            // the question, it is an absence, and drawing it would put a word on every
            // row of a list that is mostly unfiled.
            question.group ? h("span.tiny.muted", { text: question.group }) : null
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
