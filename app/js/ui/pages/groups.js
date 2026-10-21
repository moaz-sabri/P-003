// The group pages: the reader's shelves, and one shelf.
//
// A GROUP ORGANISES QUESTIONS AND NOTHING ELSE. It is not a goal, it is not a
// session, and — since the `goalId` column came off it — it does not belong to a
// goal. A goal is pointed at a group rather than containing one, and the same shelf
// can serve three goals at once, which is the whole reason the goal picker left the
// group list.
//
// Two screens. The list is where groups are made, renamed and deleted, and it says
// how many goals each one is used by; the single group is where its questions live,
// with the same state labels and the same delete control the full question list has.
//
// "NOT FILED" IS DRAWN LIKE ANY OTHER GROUP, and it is drawn FIRST, because it is
// where every question written before groups existed is. A reader with forty
// questions and no groups should be told "not filed: 40" rather than be shown an
// empty list and left to work out that the questions are still there. It is one row
// for the whole device now rather than one per goal, which is what a shelf with no
// owner means.

import { h, link, emptyState, statRow, stat, icon } from "../dom.js";
import { head, card, section } from "../page.js";
import { confirm } from "../dialog.js";
import { field, textInput, selectInput, form, submitButton } from "../fields.js";
import * as toast from "../toast.js";
import { t } from "../../i18n/i18n.js";
import { LIMITS, GROUP_CATEGORIES } from "../../domain/validation.js";
import * as groups from "../../services/group-service.js";
import * as questions from "../../services/question-service.js";
import * as content from "../../services/goal-content-service.js";
import { go } from "../../app/router.js";

/* -------------------------------- the list -------------------------------- */

export async function render() {
    // The list is the whole device's shelves, with no goal switcher — there is no
    // "which goal's groups" to switch between any more, and offering a picker for a
    // scope that no longer exists would be a control that can only be set to what it
    // is already set to.
    const [rows, unfiled] = await Promise.all([questions.counts(), groups.unfiled()]);
    const named = rows.filter((row) => row.group && row.group.id !== unfiled.id);

    const node = h("div.stack", null);
    node.appendChild(head("groups.title", "groups.subtitle",
        link(`/questions?group=${encodeURIComponent(unfiled.id)}`,
            t("groups.unfiled_link", { n: String(rows.find((r) => r.group?.id === unfiled.id)?.total ?? 0) }),
            { class: "btn btn-secondary" })));

    if (!named.length) {
        node.appendChild(emptyState(
            t("groups.empty_heading"),
            t("groups.empty_body"),
            null
        ));
    } else {
        node.appendChild(await categoryList(named));
    }

    node.appendChild(section("groups.create_heading", createForm()));

    return { node };
}

/**
 * The shelf list, grouped by category and sorted into the fixed category order.
 *
 * A GROUP'S CATEGORY IS A HEADING, NOT A FILTER: the shelf appears once, under
 * whichever of the three known categories it was filed in, or at the bottom under
 * "no category" when it has none or its id is no longer a known one. The fallback
 * being shared is deliberate — a group whose category is unknown reads exactly
 * like a group whose reader never picked one, which, for the reader, it is.
 */
async function categoryList(named) {
    const buckets = new Map(GROUP_CATEGORIES.map((c) => [c.id, []]));
    const uncategorised = [];

    for (const row of named) {
        const cat = row.group.category;
        if (buckets.has(cat)) buckets.get(cat).push(row);
        else uncategorised.push(row);
    }

    const list = h("div.stack-tight");
    for (const cat of GROUP_CATEGORIES) {
        const rows = buckets.get(cat.id);
        if (!rows.length) continue;
        list.appendChild(h("h3", { text: t(cat.labelKey) }));
        for (const row of rows) list.appendChild(await rowFor(row));
    }
    if (uncategorised.length) {
        list.appendChild(h("h3", { text: t("groups.category_none") }));
        for (const row of uncategorised) list.appendChild(await rowFor(row));
    }
    return list;
}

/**
 * One shelf, with its counts and how many goals use it.
 *
 * THE GOAL COUNT IS ON THE ROW, not on the delete dialog, and that is a deliberate
 * change from the version this replaces. A group used to be a goal's private
 * classification, so it had exactly one owner and deleting it was a local act with
 * one question's worth of consequence. Now a shelf can be pointed at by three goals
 * at once, and a reader about to delete one needs to see that on the row while they
 * are still choosing — not after a confirm dialog has told them what they have just
 * done to three plans.
 */
async function rowFor(row) {
    const { group, total, new: fresh, review, learned } = row;
    const users = await content.goalsUsingGroup(group.id);

    return h("div.card.card-quiet", null,
        h("div.row-between", { style: { "gap": "var(--space-3)" } },
            h("div.grow", null,
                link(`/groups/${encodeURIComponent(group.id)}`, group.name),
                h("div.tiny.muted", {
                    text: t("groups.row_counts", {
                        total: String(total),
                        fresh: String(fresh),
                        review: String(review),
                        learned: String(learned)
                    })
                }),
                h("div.tiny.muted", {
                    text: users.length
                        ? t("groups.used_by", { n: String(users.length) })
                        : t("groups.used_by_none")
                })
            ),
            h("div.row", { style: { gap: "var(--space-1)" } },
                link(`/questions?group=${encodeURIComponent(group.id)}`,
                    t("groups.questions_button"), { class: "btn btn-secondary" }),
                h("button.btn.btn-quiet.row-delete", {
                    type: "button",
                    "aria-label": t("common.delete"),
                    onclick: (event) => removeGroup(event, group)
                }, icon("cross", 18))
            )
        )
    );
}

async function removeGroup(event, group) {
    const ok = await confirm({
        titleKey: "groups.delete_title",
        bodyKey: "groups.delete_body"
    });
    if (!ok) return;
    const row = event.currentTarget.closest(".card");
    try {
        await groups.remove(group.id);
        toast.show("groups.delete_done");
        row?.remove();
    } catch (err) {
        toast.error(err);
    }
}

/* -------------------------------- create --------------------------------- */

function createForm() {
    const name = field({
        labelKey: "groups.field_name",
        control: textInput({ maxlength: LIMITS.GROUP_NAME_MAX })
    });
    const category = field({
        labelKey: "groups.field_category",
        hintKey: "groups.category_hint",
        control: selectInput({
            value: "",
            options: [
                { value: "", labelKey: "groups.category_none" },
                ...GROUP_CATEGORIES.map((c) => ({ value: c.id, labelKey: c.labelKey }))
            ]
        })
    });
    const save = submitButton("groups.create_button");

    const body = form(async () => {
        save.setBusy(true);
        // No goal. A group created from here belongs to nobody, which is what makes it
        // reusable: the next step, if the reader wants one, is pointing a goal at it
        // from that goal's page. Passing a goal id here used to be the only way to make
        // a group at all, and it is the reason a shelf could not be shared.
        const result = await groups.create({
            name: name.control.value,
            // An empty pick is "no category" — the shelf is drawn under the fallback
            // heading, which is where a shelf without a category belongs.
            category: category.control.value || null
        });
        if (!result.ok) {
            save.setBusy(false);
            name.setError(result.errors.name);
            return;
        }
        name.control.value = "";
        category.control.value = "";
        save.setBusy(false);
        toast.show("toast.group_created");
        go("/groups");
    },
    name.node,
    category.node,
    h("p.small.muted", { style: { "margin-top": "var(--space-1)" }, text: t("groups.name_hint") }),
    save.node
    );

    return card(body);
}

/* ------------------------------ one group -------------------------------- */

/**
 * One group and its questions.
 *
 * THE DELETE CONTROL IS HERE AS WELL AS IN THE LIST, for the same reason the question
 * list has one: a list of sixty questions is where "that one was a typo and I want it
 * gone" is actually expressed. It confirms first, and it says what deleting a
 * question now does — it leaves the shelf, it leaves every session that has already
 * asked it alone, and it takes the question off any goal that was pointed at it.
 */
export async function renderGroup(ctx) {
    const id = ctx?.route?.params?.id ?? null;
    if (!id) {
        return { node: emptyState(t("error.not_found"), t("common.back"), link("/groups", t("common.back"), { class: "btn" })) };
    }

    const group = await groups.getGroup(id).catch(() => null);
    if (!group || group.deletedAt) {
        return { node: emptyState(t("error.not_found"), t("common.back"), link("/groups", t("common.back"), { class: "btn" })) };
    }

    const [list, users] = await Promise.all([
        questions.list(group.id),
        content.goalsUsingGroup(group.id)
    ]);

    const node = h("div.stack", null);
    node.appendChild(head(
        "groups.one_title",
        null,
        link("/groups", t("common.back"), { class: "btn btn-quiet" })
    ));

    node.appendChild(renameForm(group));

    // WHICH GOALS USE THIS, on the group's own page rather than only in the list.
    //
    // It is the answer to "can I reorganise this" and "who else would notice", and it
    // is a direct consequence of the shelf being shared: before, this page's header
    // said which goal the group belonged to because the group belonged to exactly one.
    //
    // The goals that use this shelf, listed as links, are also the only way to reach an
    // exercise from here. The button this page used to carry is gone and could not be
    // rebuilt honestly: an exercise belongs to a goal, so a shelf on its own has nothing
    // to build one with, and the reader has to say which plan is going to train on it.
    // Listing the goals and linking to each one means the reader picks the plan and then
    // attaches the shelf on that plan's page -- two taps instead of one, and both of them
    // a choice rather than a guess.
    if (users.length) {
        node.appendChild(card(
            h("p.small.muted", { text: t("groups.used_by", { n: String(users.length) }) }),
            h("div.row", { style: { gap: "var(--space-1)", "flex-wrap": "wrap" } },
                ...users.map((goal) => link(`/goal/${encodeURIComponent(goal.id)}`, goal.title, { class: "chip" }))
            ),
            h("p.tiny.muted", {
                style: { "margin-top": "var(--space-2)" },
                text: t("groups.exercise_via_goal")
            })
        ));
    }


    if (!list.length) {
        return {
            node: h("div.stack", null,
                emptyState(
                    t("groups.one_empty_heading"),
                    t("groups.one_empty_body", { name: group.name }),
                    link(`/questions/new?group=${encodeURIComponent(group.id)}`,
                        t("questions.add"), { class: "btn" })
                )
            )
        };
    }

    const counts = { new: 0, review: 0, learned: 0 };
    for (const q of list) counts[q.state] += 1;

    node.appendChild(card(statRow(
        stat(counts.new, t("questions.state_new")),
        stat(counts.review, t("questions.state_review")),
        stat(counts.learned, t("questions.state_learned"))
    )));

    node.appendChild(section("groups.one_heading", ...list.map((q) => questionRow(q))));

    return { node };
}

function renameForm(group) {
    const name = field({
        labelKey: "groups.field_name",
        control: textInput({ value: group.name, maxlength: LIMITS.GROUP_NAME_MAX })
    });
    const save = submitButton("common.save");

    const body = form(async () => {
        save.setBusy(true);
        const result = await groups.rename(group.id, { name: name.control.value });
        if (!result.ok) {
            save.setBusy(false);
            name.setError(result.errors.name);
            return;
        }
        save.setBusy(false);
        toast.show("toast.group_renamed");
        go(`/groups/${encodeURIComponent(group.id)}`);
    },
    name.node,
    save.node
    );

    return section("groups.rename_heading", card(body));
}

const STATE_TINT = {
    new: "var(--track)",
    review: "var(--bad-soft)",
    learned: "var(--ok-soft)"
};

/** One question row. Identical to the question list's own row rather than a
 *  second one that looks the same: two components for one row is how a list
 *  changes its delete behaviour on one screen and not the other. */
function questionRow(question) {
    const row = h("div.card.card-quiet.row-between", {
        style: {
            "border-inline-start": `4px solid ${STATE_TINT[question.state]}`,
            "gap": "var(--space-3)"
        }
    },
    h("div.grow", null,
        // No goal in the link, which is what the row on the question list does now
        // too. There is no goal for the editor to fall back to.
        link(`/questions/${encodeURIComponent(question.id)}`, question.text),
        h("div.tiny.muted", {
            text: `${t(`questions.state_${question.state}`)} · ${t(`questions.kind_${question.kind}`)}`
        })
    ),
    h("button.btn.btn-quiet.row-delete", {
        type: "button",
        "aria-label": t("common.delete"),
        onclick: (event) => removeQuestion(event, question)
    }, icon("cross", 18))
    );
    return row;
}

async function removeQuestion(event, question) {
    const ok = await confirm({
        titleKey: "questions.delete_title",
        bodyKey: "questions.delete_body"
    });
    if (!ok) return;
    const row = event.currentTarget.closest(".card");
    try {
        await questions.remove(question.id);
        toast.show("questions.delete_done");
        row?.remove();
    } catch (err) {
        toast.error(err);
    }
}
