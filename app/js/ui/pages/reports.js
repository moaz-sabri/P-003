// The reports page: what is sticking and what is not.
//
// Three things and no more, in this order, because this is the order they are
// useful in: how the whole goal is going, whether they have been showing up at
// all, and which questions to go and look at. Anything a reports page grows
// beyond that — a streak, an average per day, a best score — is a rule that then
// exists in two places (here and domain/stats.js) and drifts, and this app has
// already decided it is a "remember things" tool and not a dashboard.
//
// EVERY NUMBER COMES FROM `report-service.build()`, which is the same call the
// home page makes for its smaller version. Two pages counting the same thing
// independently is how a report says 40% while the home page says 38%, and the
// reader concludes one of them is lying rather than that the app has a bug.

import { h, link, statRow, stat, emptyState } from "../dom.js";
import { head, section, sectionText, card } from "../page.js";
import { t, formatPercent, formatDate } from "../../i18n/i18n.js";
import { build, ACTIVITY_DAYS } from "../../services/report-service.js";
import { listActiveGoals } from "../../services/goal-service.js";
import { setCurrentGoal } from "../nav.js";

/**
 * A `dayKey` as a local timestamp.
 *
 * `new Date("2026-09-30")` — which is what a `dayKey` looks like to `Date` — is
 * parsed as UTC midnight, and every reader west of Greenwich then sees the bar
 * for one day labelled with the day before it. The activity series is bucketed by
 * LOCAL day in domain/time.js, so its labels have to be read back the same way or
 * the chart is a day out for half the world.
 */
function localDay(key) {
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
}

export async function render(ctx) {
    const goalId = ctx?.query?.get("goal") ?? null;
    const data = await build(goalId);
    if (!data) {
        return {
            node: h("div.stack", null,
                head("reports.title", "reports.subtitle"),
                emptyState(
                    t("home.no_goal_heading"),
                    t("home.no_goal_body"),
                    link("/goal", t("home.create_goal"), { class: "btn" })
                )
            )
        };
    }

    // How many goals are live, so the page knows whether naming one is necessary.
    // Read here rather than passed in because `build` already read the goal and
    // asking it again for a boolean would be a second transaction for one `if`.
    const active = await listActiveGoals();
    const data_ = { ...data, goals: active };

    setCurrentGoal(data.goal.id);

    const node = h("div.stack", null);
    node.appendChild(head("reports.title", "reports.subtitle"));

    // WHICH GOAL THIS IS ABOUT, said out loud. With one goal the heading is enough;
    // with three, "Accuracy 81%" on a page that does not say which subject it
    // belongs to is a number the reader has to guess about, and the reports are the
    // page they are most likely to compare between goals.
    if (data_.goals.length > 1) {
        node.appendChild(card(h("p.small.muted", { text: t("reports.for_goal", { title: data.goal.title }) })));
    }

    node.appendChild(card(statRow(
        stat(formatPercent(data.accuracy.percent), t("reports.stat_accuracy")),
        stat(data.accuracy.total, t("reports.stat_answered")),
        stat(data.progress.learned, t("reports.stat_learned")),
        stat(data.exercises.completed, t("reports.stat_exercises"))
    )));

    node.appendChild(sectionText(
        t("reports.activity_heading", { days: ACTIVITY_DAYS }),
        activityCard(data)
    ));
    node.appendChild(section("reports.weak_heading", weakList(data.weak, data.goal.id)));

    return { node };
}

/* -------------------------------- activity --------------------------------- */

function activityCard(data) {
    const days = data.activity;
    const busiest = days.reduce((max, day) => Math.max(max, day.total), 0);
    const total = days.reduce((sum, day) => sum + day.total, 0);

    // Nothing answered in the window is an empty state rather than fourteen
    // empty bars: a row of nothing is a picture of a broken page, and the
    // sentence "no answers yet" is the same information.
    if (!total) {
        return card(h("p.muted", { text: t("reports.activity_empty") }));
    }

    // A DAY WITH NO ANSWERS IS DRAWN AS NOTHING, not as a minimum-height bar.
    //
    // The bar has a `min-height` so that a day with one answer is still visible at
    // all, and the fill is red below the correct share — so a day with no answers
    // used to come out as a 2px RED sliver. Fourteen of them is a chart saying
    // "you got this wrong on thirteen days" to a reader who opened the app once.
    // The empty day now gets the track and no fill, which is what it is.
    const bars = h("ul.activity", { "aria-hidden": "true" },
        days.map((day) => {
            const height = busiest === 0 ? 0 : Math.round((day.total / busiest) * 100);
            const correct = day.total === 0 ? 0 : Math.round((day.correct / day.total) * 100);
            const bar = h("div.activity-bar", {
                style: { "--h": `${height}%`, "--c": `${correct}%` },
                "data-empty": day.total === 0 ? "true" : null
            });
            if (day.total > 0) {
                bar.appendChild(h("span.ok"));
                bar.appendChild(h("span.bad"));
            }
            return h("li", { title: formatDate(localDay(day.key)) }, bar);
        })
    );

    const correct = days.reduce((sum, day) => sum + day.correct, 0);

    return card(
        bars,
        h("div.row-between", { style: { "margin-top": "var(--space-2)" } },
            h("span.tiny.muted", { text: formatDate(localDay(days[0].key)) }),
            h("span.tiny.muted", { text: formatDate(localDay(days[days.length - 1].key)) })
        ),
        // A labelled sentence. The bare "51 of 54" this line used to be sat under a
        // chart with no heading of its own, and two numbers with no noun are the one
        // thing a report must never leave on screen.
        h("p.small.muted", {
            style: { "margin-top": "var(--space-2)" },
            text: t("reports.activity_line", { correct, total, days: ACTIVITY_DAYS })
        })
    );
}

/* ------------------------------- needs work -------------------------------- */

function weakList(rows, goalId) {
    if (!rows.length) {
        return card(h("p.muted", { text: t("reports.weak_empty") }));
    }

    // The list itself, not a card around it: the rows already carry their own
    // quiet card, and a card inside a card turns a column of rows into a column
    // of cards with two sets of shadows and a doubled inset.
    const list = h("div.stack-tight");
    for (const row of rows) {
        // The question and its score on ONE line. They were a title and a caption
        // on two lines, which made a list of ten into a column of ten tall empty
        // cards — and the score is the reason the row is in the list, so it belongs
        // beside the question rather than under it where the eye has to travel to
        // find it.
        list.appendChild(h("div.card.card-quiet.row-between", {
            style: { "border-inline-start": "4px solid var(--bad-soft)", gap: "var(--space-3)" }
        },
        // The goal is in the link. This page knows which goal it is reporting on,
        // and a weak-question link without it opens the editor against whichever goal
        // happens to be newest — where saving would FILE this question.
        h("span.grow", null, link(
            `/questions/${encodeURIComponent(row.questionId)}?goal=${encodeURIComponent(goalId)}`,
            row.text || t("error.not_found")
        )),
        h("span.small.muted.nums", {
            text: t("reports.weak_score", { correct: row.correct, total: row.total })
        })
        ));
    }
    return list;
}
