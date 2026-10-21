// The home page: the goals, the exercises that are open on them, and enough numbers
// to tell whether any of it is working.
//
// WHAT IS ON IT, and what is deliberately not:
//
//   FOR EACH GOAL
//     the goal's name and what can be done about it, from one decision
//     its OPEN exercises, each with a resume button
//     the tracking figures: how many questions it draws on, how many are learned,
//         how many exercises are done, and the accuracy
//     its CATEGORIES -- the shelves it is pointed at, by name and size
//
// NOT ON IT
//     the plan's numbers. The plan is the same fixed ten-new / review-last-three
//     for every goal now, so there is nothing per-goal to check anyway; the page
//     would be four numbers that never move.
//     the "choose what to be asked" button. That is a decision, and the home page is
//     a place to find out what is due rather than a place to make one.
//
// It answers four questions, in this order because that is the order they are asked
// in: is there anything to do right now; how far along is the goal; what is the
// progress; how have I been doing.
//
// THE PAGE IS A LIST OF GOALS, which is the visible consequence of letting a reader
// have more than one. It used to draw "the" goal — `getActiveGoal()`, which silently
// took the newest — and with three goals that is a screen that answers a question
// about French on the day the reader came to revise Arabic. Each goal gets its own
// card, its own state and its own buttons, and the page says which is which.
//
// THE FIRST QUESTION IS THE ONLY ONE THAT HAS TO BE EXACTLY RIGHT. "Start exercise"
// reads a whole goal's schedule and decides whether it may be pressed, and the
// exercise it leads to is built from that same schedule, so there is no path where the
// page says yes and the builder says no. The decision itself is `domain/goal-action.js`
// and the numbers behind it are `goal-service.overviews()`, so the goal page draws the
// same answer from the same read.

import { h, link, meter, statRow, stat, emptyState } from "../dom.js";
import { head, card } from "../page.js";
import { t, formatPercent } from "../../i18n/i18n.js";
import { overviews, goalAction } from "../../services/goal-service.js";
import { goalActions, contentHref } from "../parts/goal-actions.js";
import { setCurrentGoal } from "../nav.js";

export async function render() {
    const rows = await overviews();
    if (!rows.length) return { node: noGoal() };

    // The goal the nav bar will carry from here. The FIRST card is not arbitrary:
    // `overviews()` comes back newest-first, and the newest goal is the one a reader
    // who just created something wants the nav bar pointing at.
    setCurrentGoal(rows[0]?.goal?.id ?? null);

    const node = h("div.stack", null);
    node.appendChild(head(
        "home.next_exercise_heading",
        null,
        link("/goal", t("nav.goal"), { class: "btn btn-quiet" })
    ));

    const destroyers = [];
    for (const row of rows) {
        const drawn = await goalCard(row);
        if (drawn?.destroy) destroyers.push(drawn.destroy);
        node.appendChild(drawn.node);
    }

    return {
        node,
        destroy() {
            for (const fn of destroyers) fn();
        }
    };
}

/* ------------------------------ one goal ---------------------------------- */

/**
 * One goal's whole card: its state, what can be done about it, and how far along it
 * is.
 *
 * THE STATE LINE IS BUILT FROM ONE DECISION, which is `goalAction` over `plan` and
 * `quota`, and it is asked once per card. The schedule answers whether this goal is
 * open (active, not closed or archived) and the quota answers whether it has been
 * started too often in the last two days; they are different questions with different
 * sentences, and a card that answered only the first would offer a Start the service
 * refuses.
 *
 * `compact` is set on the action block: the home page offers a Start and a resume,
 * and the "choose what to be asked" button belongs on the goal's own page, which is
 * where a reader goes when they already know what they want.
 */
async function goalCard(row) {
    const { goal, plan, quota, exercises, material, stats, open } = row;
    const action = goalAction({ plan, materialCount: material.count, open, quota });
    const drawn = goalActions({ goal, action, compact: true });

    const body = h("div.stack-tight");
    // THE TITLE IS THE LINK, and the quiet "Open" button beside it is kept for the
    // reader who looks for one. A reader who came to the home page to work on one
    // particular goal aims at the name they are reading, and a name that is not a link
    // makes them find the button instead — on a card whose whole width is available.
    body.appendChild(h("div.row-between", null,
        h("h2", { style: { "margin": "0" } },
            link(`/goal/${encodeURIComponent(goal.id)}`, goal.title)),
        link(`/goal/${encodeURIComponent(goal.id)}`, t("goal.open_button"), { class: "btn btn-quiet" })
    ));

    if (goal.description) {
        body.appendChild(h("p.small.muted", { text: goal.description }));
    }

    const controls = h("div", null);
    controls.appendChild(drawn.node);
    body.appendChild(controls);

    // THE CATEGORIES. The shelves this goal draws on, by name and size, and the
    // questions attached one at a time.
    //
    // It is here rather than only on the goal's page because the reader's question on
    // the home page is "is this the material I think it is?" — and "42 questions" does
    // not answer that, whereas "Chapter 3 · 18, Irregular verbs · 12, plus 12 picked
    // one by one" does. It is also the one row of the card that can be acted on from
    // here, which is why the whole line is a link to the attachment screen.
    if (material.count) {
        body.appendChild(h("div", { style: { "margin-top": "var(--space-3)" } },
            link(contentHref(goal.id), categoriesLine(material), { class: "chips" })
        ));
    }

    // Progress. Read through the same `summarize` the reports page makes, so the two
    // can never disagree about how much is learned.
    const p = stats.progress;

    body.appendChild(h("div", { style: { "margin-top": "var(--space-3)" } },
        meter(p.percent),
        h("div.row-between", { style: { "margin-top": "var(--space-2)" } },
            h("span.small.muted", { text: `${p.learned} / ${material.count}` }),
            h("span.small.nums", { text: formatPercent(p.percent) })
        )
    ));

    body.appendChild(h("div", { style: { "margin-top": "var(--space-3)" } },
        statRow(
            stat(material.count, t("home.stat_questions")),
            stat(p.learned, t("home.stat_learned")),
            stat(row.exercisesCount.completed, t("home.stat_exercises")),
            stat(String(stats.accuracy.percent), t("home.stat_accuracy"))
        )
    ));

    body.appendChild(h("p.small.muted", {
        style: { "margin-top": "var(--space-3)" },
        text: t("home.answers_line", {
            correct: stats.accuracy.correct,
            total: stats.accuracy.total
        })
    }));

    // THE OPEN EXERCISES AS ROWS, not only as buttons.
    //
    // The action block above already offers a resume button per open exercise, and
    // this line says how many are sitting there and when the oldest was started. A
    // reader with two exercises open needs to know which one has been sitting for a
    // fortnight, because that is the one they have either forgotten about or given up
    // on -- and a button labelled "Continue exercise 3" does not tell them that.
    if (open.length > 1) {
        body.appendChild(h("p.small.muted", {
            style: { "margin-top": "var(--space-3)" },
            text: t("home.open_exercises_line", { n: String(open.length) })
        }));
    }

    return { node: card(body), destroy: drawn.destroy };
}

/**
 * The category line: the shelves, then the loose questions.
 *
 * A NODE LIST rather than one string, and the reasons are the same as the group chips
 * on the question list: a shelf name is reader-supplied text of unbounded length, and
 * joining three of them with a middot into one string is a line that wraps to three
 * lines on a phone and reads as a sentence about nothing. Each shelf is its own chip
 * with its size, which is also what makes the sizes comparable at a glance.
 */
function categoriesLine(material) {
    const chips = material.groups.map((group) =>
        h("span.chip", { text: `${group.name} · ${group.size}` })
    );
    if (material.loose) {
        chips.push(h("span.chip", { text: t("home.loose_chip", { n: String(material.loose) }) }));
    }
    return h("div.row", { style: { "flex-wrap": "wrap", gap: "var(--space-1)" } }, ...chips);
}

/* ------------------------------- no goal --------------------------------- */

function noGoal() {
    setCurrentGoal(null);
    return h("div.stack", null,
        head("home.no_goal_heading", null),
        emptyState(
            t("home.no_goal_heading"),
            t("home.no_goal_body"),
            link("/goal", t("home.create_goal"), { class: "btn" })
        )
    );
}
