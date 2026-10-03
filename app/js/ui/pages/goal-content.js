// What a goal draws on: the one screen about the join.
//
// THIS SCREEN IS THE USER-FACING HALF OF THE SEPARATION, and it exists because the
// relationship it edits is now a decision rather than a consequence. Before, a
// question was a goal's because it had been typed inside that goal, and the question
// list and the group list were both lists OF that goal. Now:
//
//   * a question exists on its own, and this is where a reader says "this goal trains
//     on it";
//   * a group is a shelf belonging to nobody, and this is where a reader says "this
//     goal trains on that shelf, whole";
//   * both are rows in `goalRefs`, and a goal with none of them is finished and
//     valid — which is why this screen is a link on the goal page rather than
//     something the create form insists on.
//
// TWO KINDS OF ROW, AND THEY ARE NOT THE SAME CONTROL. A group row says "everything
// filed on this shelf" and a question row says "this one question". They are added to
// the goal's material by the same union and are counted by the same number, but
// detaching a group detaches the questions it happened to contain at that moment —
// whereas detaching a question leaves the shelf and every other question on it
// exactly where they were. That difference is real and it is why the confirm dialog
// on a group says what it does while the one on a question does not: a reader
// removing one question is tidying, and a reader removing a shelf is making a
// decision about a hundred questions at once.
//
// NO REORDERING, because there is nothing to order. The references carry the order
// they were added in and the builder draws from all of them at once; a control that
// moved a group up a list would suggest the order matters to what gets asked, and it
// does not.

import { h, link, emptyState, mount, icon, statRow, stat } from "../dom.js";
import { head, card, section } from "../page.js";
import { confirm } from "../dialog.js";
import * as toast from "../toast.js";
import { t } from "../../i18n/i18n.js";
import { getGoal } from "../../data/repo-goals.js";
import * as content from "../../services/goal-content-service.js";
import * as groups from "../../services/group-service.js";
import * as questions from "../../services/question-service.js";
import { go } from "../../app/router.js";
import { setCurrentGoal } from "../nav.js";
import { libraryHref } from "../parts/goal-actions.js";

export async function render(ctx) {
    const goalId = ctx?.route?.params?.id ?? ctx?.query?.get("goal") ?? null;
    const goal = goalId ? await getGoal(goalId).catch(() => null) : null;
    if (!goal || goal.deletedAt) {
        return {
            node: h("div.stack", null,
                head("content.title", null),
                emptyState(t("error.not_found"), t("common.back"), link("/goal", { class: "btn" }))
            )
        };
    }

    setCurrentGoal(goal.id);

    // The three lists are read together and the page is painted once. Each painter
    // below re-reads nothing: a screen whose group rows and question rows come from
    // two moments has a count at the top that disagrees with the ticks underneath it,
    // and the ticks are the control the reader is about to use.
    const [refs, allGroups, allQuestions, attachedGroups, attachedQuestions] = await Promise.all([
        content.refsFor(goal.id),
        groups.list(),
        questions.list(),
        content.attachedSet(goal.id, content.REF_TYPE.GROUP),
        content.attachedSet(goal.id, content.REF_TYPE.QUESTION)
    ]);

    // The groups a reader can attach are all of them, and the ones already attached
    // are drawn as ticks rather than hidden. Hiding them would make the list of
    // "what else could I add" shorter every time something is added, which turns the
    // screen into a queue with no memory of what it has already done.
    //
    // TWO NUMBERS PER GROUP, and the difference between them is the whole point of the
    // separation. `size` is how many questions are FILED on the shelf — a fact about the
    // shelf. `inGoal` is how many of them this goal actually draws on, which is the
    // smaller number whenever the questions are on the shelf but not attached, and the
    // point where they come from a different attachment.
    //
    // GETTING THESE THE SAME WAY WAS A REAL BUG, and worth recording because it read
    // correctly: the count was taken from "questions filed on this shelf", so a shelf
    // holding three questions said "3 of its questions are in this goal" on a goal that
    // was pointed at none of them. The reader's decision on this screen is about what
    // THIS GOAL will train on, so the number beside a shelf has to be about this goal.
    const { size, inGoal } = await groupQuestionCounts(allGroups, allQuestions, {
        groupIds: attachedGroups,
        questionIds: new Set(refs.filter((r) => r.refType === content.REF_TYPE.QUESTION).map((r) => r.refId))
    });

    const node = h("div.stack", null);
    // THE LIBRARY IS A THIRD WAY IN, beside attaching a shelf and ticking questions, and
    // it is in the header rather than at the bottom of the list for the reason it matters:
    // it is the only one of the three a reader may never have heard of. It is also the
    // only one that is about MATERIAL RATHER THAN ATTACHMENT — everything else on this
    // screen takes questions the device already has — so burying it under two hundred
    // checkboxes would be a way of not offering it.
    //
    // The goal is in the link, so arriving here from the library comes back to this goal
    // with this goal chosen.
    node.appendChild(head("content.title", "content.subtitle",
        link(libraryHref(goal.id), t("library.title"), { class: "btn btn-secondary" }),
        link(`/goal/${encodeURIComponent(goal.id)}`, t("common.back"), { class: "btn btn-quiet" })
    ));

    const summary = card(statRow(
        stat(attachedGroups.size, t("content.stat_groups")),
        stat(attachedQuestions.size, t("content.stat_questions")),
        stat(refs.length, t("content.stat_refs"))
    ));
    node.appendChild(summary);

    node.appendChild(section("content.attached_heading", attachedSection({
        goal, refs, allGroups, allQuestions
    })));

    node.appendChild(section("content.groups_heading", card(
        h("p.small.muted", { text: t("content.groups_hint") }),
        h("div.stack-tight", null, ...allGroups.map((group) => groupRow({
            group, goal, on: attachedGroups.has(group.id),
            count: size.get(group.id) ?? 0,
            inGoal: inGoal.get(group.id) ?? 0,
            refresh
        }))),
        h("div", { style: { "margin-top": "var(--space-3)" } },
            link("/groups", t("content.manage_groups"), { class: "btn btn-secondary btn-block" })
        )
    )));

    node.appendChild(section("content.questions_heading", card(
        h("p.small.muted", { text: t("content.questions_hint") }),
        h("div.stack-tight", null, ...allQuestions.map((question) => questionRow({
            question, goal, on: attachedQuestions.has(question.id), refresh
        }))),
        h("div", { style: { "margin-top": "var(--space-3)" } },
            link("/questions/new", t("questions.add"), { class: "btn btn-secondary btn-block" })
        )
    )));

    /**
     * Re-read and re-paint, by re-running this page's own render.
     *
     * THE PAGE REBUILDS ITSELF RATHER THAN PATCHING THE ROW THAT WAS TICKED, and the
     * reason is the number at the top. Attaching a group changes three things at once:
     * the count of attached groups, the count of attached questions, and — through the
     * union — how many questions this goal can actually draw on. A toggle that only
     * changed its own checkbox would leave the summary claiming figures the reader can
     * no longer reconcile with the list, and the summary is the thing on this screen
     * that tells them whether the goal is ready to train.
     *
     * A full re-render also re-reads the reference table, which is what makes the tick
     * trustworthy afterwards: a row that was drawn from a read taken before the write
     * cannot claim to be current, and on a screen whose whole job is choosing what
     * belongs to what, a stale tick is worse than a slow repaint.
     */
    function refresh() {
        go(`/goal/${encodeURIComponent(goal.id)}/content`, { replace: true });
    }

    return { node };
}

/* ------------------------------- attached --------------------------------- */

/**
 * What is attached, and how to take it off.
 *
 * DETACHING IS NOT DELETING, and the wording says so on every row. A reader who is
 * looking at "Chapter 3" under a goal's material and takes it off has stopped that
 * goal training on those questions; the questions are still in the app, still filed
 * on that shelf, and still attachable to another goal in one tap. Under the old
 * design the only way to stop a goal asking a question was to delete the question,
 * which is why this screen has to exist at all.
 */
function attachedSection({ goal, refs, allGroups, allQuestions, refresh }) {
    if (!refs.length) {
        return h("p.muted", { text: t("content.attached_empty") });
    }

    const byId = new Map([
        ...allGroups.map((g) => [g.id, g]),
        ...allQuestions.map((q) => [q.id, q])
    ]);

    const rows = refs.map((ref) => {
        const thing = byId.get(ref.refId);
        // A reference to something this device has not seen — deleted on another, or
        // not yet pulled — is shown as an id the app cannot name rather than hidden.
        // Hiding it would make the count at the top disagree with the list, and a
        // reader who knows they attached four things and can see three has no way to
        // find the fourth.
        if (!thing) {
            return h("div.card.card-quiet.row-between", null,
                h("span.grow.muted", { text: t("content.ref_unknown", { id: ref.refId }) }),
                detachButton(ref, goal, refresh)
            );
        }

        const label = ref.refType === content.REF_TYPE.GROUP
            ? thing.name
            : (thing.text ?? "");

        return h("div.card.card-quiet.row-between", {
            style: { "gap": "var(--space-2)" }
        },
        h("div.grow", null,
            h("span", { text: label }),
            h("div.tiny.muted", {
                text: ref.refType === content.REF_TYPE.GROUP
                    ? t("content.ref_group")
                    : t("content.ref_question")
            })
        ),
        detachButton(ref, goal, refresh)
        );
    });

    return h("div.stack-tight", null, ...rows);
}

/** Remove one reference. A group confirms first, because it takes everything filed on
 *  it out of this goal at once; a question does not, because removing one question
 *  from a goal's material is a smaller act than removing a shelf. */
function detachButton(ref, goal, refresh) {
    const isGroup = ref.refType === content.REF_TYPE.GROUP;
    return h("button.btn.btn-quiet.row-delete", {
        type: "button",
        "aria-label": t("content.detach"),
        onclick: async (event) => {
            if (isGroup) {
                const ok = await confirm({
                    titleKey: "content.detach_group_title",
                    bodyKey: "content.detach_group_body"
                });
                if (!ok) return;
            }
            const row = event.currentTarget.closest(".card");
            try {
                await content.detach(ref.id);
                toast.show("content.detached");
                row?.remove();
                refresh();
            } catch (err) {
                toast.error(err);
            }
        }
    }, icon("cross", 18));
}

/* --------------------------------- groups ---------------------------------- */

function groupRow({ group, goal, on, count, inGoal, refresh }) {
    const label = h("span", { text: `${group.name} · ${count}` });

    return h("label.choice", null,
        checkbox(on, async (checked) => {
            try {
                if (checked) await content.attachGroup(goal.id, group.id);
                else await detachFirst(content.REF_TYPE.GROUP, goal.id, group.id);
                toast.show(checked ? "content.group_attached" : "content.detached");
                refresh();
            } catch (err) {
                toast.error(err);
            }
        }),
        h("span.grow", null,
            label,
            h("div.tiny.muted", {
                // BOTH numbers when they differ, because the difference is the
                // information: a shelf of thirty that this goal draws on none of is
                // the row a reader needs to see before ticking it. When they are the
                // same — the usual case once the shelf is attached — one number is
                // enough and two would be noise.
                text: inGoal === count
                    ? t("content.group_size", { n: String(count) })
                    : `${t("content.group_size", { n: String(count) })} · `
                        + t("content.group_in_goal", { n: String(inGoal) })
            })
        )
    );
}

/* -------------------------------- questions -------------------------------- */

function questionRow({ question, goal, on, refresh }) {
    return h("label.choice", null,
        checkbox(on, async (checked) => {
            try {
                if (checked) await content.attachQuestion(goal.id, question.id);
                else await detachFirst(content.REF_TYPE.QUESTION, goal.id, question.id);
                toast.show(checked ? "content.question_attached" : "content.detached");
                refresh();
            } catch (err) {
                toast.error(err);
            }
        }),
        h("span.grow", null,
            h("span", { text: question.text }),
            h("div.tiny.muted", {
                text: [
                    t(`questions.state_${question.state}`),
                    question.group
                ].filter(Boolean).join(" · ")
            })
        )
    );
}

/**
 * A checkbox that reports the direction, not the state.
 *
 * THE CALLER DECIDES WHAT TO DO WITH IT rather than the checkbox knowing whether it
 * is attaching or detaching. An `onchange` that toggled a set would need the set to
 * know the difference, and a set of attached ids cannot say "remove this" without
 * also knowing which kind of thing it is — so the two directions get two functions
 * and the row passes the right one in.
 */
function checkbox(checked, onChange) {
    const input = h("input", { type: "checkbox", checked });
    input.addEventListener("change", () => onChange(input.checked));
    return input;
}

/** Detach by kind and id rather than by reference id, for the tick boxes.
 *
 *  The repository's write takes a reference id because that is the row to tombstone,
 *  and a caller holding only the two ids has to find it first. This is that lookup,
 *  and it is one read rather than one per row: `refresh` re-reads the whole
 *  attachment set anyway, so a per-row tombstone write followed by a full re-read is
 *  one transaction too many for a list of four hundred.
 */
async function detachFirst(refType, goalId, refId) {
    const refs = await content.refsFor(goalId);
    const found = refs.find((r) => r.refType === refType && r.refId === refId);
    if (found) await content.detach(found.id);
}

/**
 * Two counts per group: how many questions are FILED on it, and how many of those
 * this goal actually draws on.
 *
 * THE SECOND IS A JOIN, and it is the one that has to be computed here rather than
 * read off the group. It is deliberately NOT "every question filed on the shelf" —
 * that number is the first one, it is bigger, and it answers a different question: a
 * reader looking at a shelf on THIS goal's page is deciding what this goal will train
 * on, so "3 questions filed here" next to a tick that is off is the row that tells
 * them the shelf is not connected to this plan yet.
 *
 * A question counts as in the goal when the goal is pointed at its shelf OR at the
 * question itself — which is the same union `questionsForGoal` resolves, and the same
 * two kinds of attachment this page offers. Both come in as arguments rather than being
 * read again, because a second read of the same table on a page that already has it
 * is a window in which a sync merge makes the two numbers describe different moments.
 */
async function groupQuestionCounts(allGroups, allQuestions, { groupIds, questionIds }) {
    const size = new Map(allGroups.map((g) => [g.id, 0]));
    const inGoal = new Map(allGroups.map((g) => [g.id, 0]));

    for (const question of allQuestions) {
        if (!question.groupId || !size.has(question.groupId)) continue;
        size.set(question.groupId, size.get(question.groupId) + 1);
        if (groupIds.has(question.groupId) || questionIds.has(question.id)) {
            inGoal.set(question.groupId, inGoal.get(question.groupId) + 1);
        }
    }
    return { size, inGoal };
}
