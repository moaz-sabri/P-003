// The home page: what is due, and how far along it is.
//
// It answers four questions in this order, because that is the order they are
// asked in: is there anything to do right now; how far along is the goal; what is
// the progress; how have I been doing. Everything else about a goal is on its own
// page.
//
// The first is the only one that has to be exactly right. "Start exercise" is a
// button that reads a whole goal's exercises and decides whether it may be
// pressed — and the exercise it leads to is built from the same schedule, so there
// is no path where the page says yes and the builder says no.

import { h, meter, statRow, stat, link, emptyState } from "../dom.js";
import { head, section, card } from "../page.js";
import * as toast from "../toast.js";
import { t, formatPercent, formatCountdown } from "../../i18n/i18n.js";
import { snapshot, SCHEDULE } from "../../services/goal-service.js";
import { progressFor } from "../../services/report-service.js";
import { go } from "../../app/router.js";
import { remaining } from "../../domain/time.js";

export async function render() {
    const { goal, exercises, questions, plan } = await snapshot();

    if (!goal) return { node: noGoal() };
    if (goal.status === "completed") return { node: finishedGoal(goal) };
    if (plan.state === SCHEDULE.EXPIRED) return { node: expiredGoal(goal) };

    const node = h("div.stack", null);
    node.appendChild(head(
        "home.next_exercise_heading",
        goal.title,
        link("/goal", t("goal.title_view"), { class: "btn btn-quiet" })
    ));

    const summary = await progressFor(goal);
    const exercise = exerciseCard(plan, questions.length);
    node.appendChild(exercise.node);

    node.appendChild(section("home.progress_heading", progressCard(summary, questions.length, plan)));

    const completed = exercises.filter((e) => e.completedAt).length;
    const accuracyPercent = String(summary.accuracy.percent);
    // A labelled sentence, not "51 of 54".
    //
    // That line used to borrow the reports page's bare `weak_score` string, which on
    // its own page sits under a heading that says what the numbers are and here
    // sits under nothing at all: two figures with no noun on the home page of an
    // app whose whole point is being legible at a glance. The sentence says what was
    // answered and how many were right, and the reports page is one tap away for
    // the per-question list.
    const answersLine = h("p.small.muted", {
        style: { "margin-top": "var(--space-3)" },
        text: t("home.answers_line", {
            correct: summary.accuracy.correct,
            total: summary.accuracy.total
        })
    });
    const progressStats = statRow(
        stat(questions.length, t("home.stat_questions")),
        stat(summary.progress.learned, t("home.stat_learned")),
        stat(completed, t("home.stat_exercises")),
        stat(accuracyPercent, t("home.stat_accuracy"))
    );
    node.appendChild(card(progressStats, answersLine));

    return { node, destroy: exercise.destroy };
}

/* ------------------------------ the button ------------------------------- */

function exerciseCard(plan, questionCount) {
    const body = h("div.stack-tight");
    let destroy = null;

    if (plan.state === SCHEDULE.IN_PROGRESS && plan.exercise) {
        const openId = plan.exercise.id;
        body.appendChild(h("p.muted", { text: t("home.open_exercise_body") }));
        body.appendChild(h("button.btn.btn-block", {
            type: "button",
            onclick: () => go(`/exercise?id=${encodeURIComponent(openId)}`)
        }, t("home.continue_exercise")));
    } else if (plan.state === SCHEDULE.WAITING) {
        // A live number, so a node that is updated rather than a string computed
        // once. Painted once and left alone it reads "opens in 1 day" for a whole
        // day, which is the fastest way to make a reader think the app has
        // stopped counting. Every thirty seconds, not every second: nothing on
        // this page is worth waking a phone for more often, and a countdown that
        // visibly ticks down every second invites taps on a button that is
        // disabled anyway.
        const countdown = h("span.nums");
        const paint = () => { countdown.textContent = formatCountdown(remaining(plan.dueAt)); };
        paint();
        const timer = setInterval(paint, 30_000);
        destroy = () => clearInterval(timer);

        // The countdown is a NODE. The sentence has no `{time}` and no trailing
        // full stop for the same reason the result page's does not: the value used
        // to be interpolated as an empty placeholder and the period that followed
        // it was left stranded in front of a number that arrived after it, which
        // printed "opens in . 23h 59m" on the one screen whose whole job is to say
        // when the reader may come back.
        body.appendChild(h("p", null, t("home.locked_body"), " ", countdown));
        body.appendChild(h("button.btn.btn-block", {
            type: "button",
            disabled: true,
            "aria-disabled": "true"
        }, t("home.locked_heading")));
    } else if (questionCount === 0) {
        body.appendChild(h("p.muted", { text: t("home.needs_questions_body") }));
        body.appendChild(link("/questions", t("home.add_questions"), { class: "btn btn-block" }));
    } else {
        body.appendChild(h("button.btn.btn-block", {
            type: "button",
            onclick: startExercise
        }, t("home.start_exercise")));
    }

    return { node: card(body), destroy };
}

async function startExercise(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const { start } = await import("../../services/exercise-service.js");
        const { exercise } = await start();
        go(`/exercise?id=${encodeURIComponent(exercise.id)}`);
    } catch (err) {
        button.disabled = false;
        toast.error(err);
        // A refusal from the schedule means this page was out of date. The honest
        // repair is to re-draw, not to explain the rule.
        if (err?.code === "invalid_transition" || err?.code === "too_soon") {
            go("/");
        }
    }
}

/* -------------------------------- progress ------------------------------- */

function progressCard(summary, questionCount, plan) {
    const p = summary.progress;
    const endsAt = plan?.endsAt;
    return card(
        meter(p.percent),
        h("div.row-between", { style: { "margin-top": "var(--space-2)" } },
            h("span.small.muted", { text: `${p.learned} / ${questionCount}` }),
            h("span.small.nums", { text: formatPercent(p.percent) })
        ),
        // "How long is left" is one of the few things a goal page owes the reader:
        // without it there is no way to tell a slow week from a nearly finished
        // plan, and the percentage alone answers neither.
        endsAt
            ? h("p.small.muted", {
                style: { "margin-top": "var(--space-2)" },
                text: t("home.ends_in", { time: formatCountdown(endsAt - Date.now()) })
            })
            : null
    );
}

/* ------------------------------- no goal --------------------------------- */

function noGoal() {
    return h("div.stack", null,
        head("home.no_goal_heading", null),
        emptyState(
            t("home.no_goal_heading"),
            t("home.no_goal_body"),
            link("/goal", t("home.create_goal"), { class: "btn" })
        )
    );
}

/* ---------------------------- finished goal ------------------------------ */

function finishedGoal(goal) {
    return h("div.stack", null,
        head("goal.finished_heading", goal.title),
        card(
            h("p", { text: t("goal.finished_body") }),
            h("div.btn-row", null,
                link("/reports", t("result.reports_button"), { class: "btn btn-secondary" }),
                link("/goal", t("home.create_goal"), { class: "btn" })
            )
        )
    );
}

/* ------------------------------ expired goal ------------------------------ */

/**
 * The plan's time is up, and nothing has been deleted.
 *
 * This is a state, not an ending. The questions are all still there, the reports
 * still answer, and the one thing the page will not do is build another exercise
 * — because the reader set a length when they created the goal and quietly
 * ignoring it is how a plan turns into an open-ended habit nobody chose.
 *
 * The two buttons are the two real choices and both are offered: close it and
 * start the next one, or look at how it went. An expired goal that only offered
 * "start a new one" would be telling the reader their work is over, which is not
 * what a date is.
 */
function expiredGoal(goal) {
    return h("div.stack", null,
        head("goal.expired_heading", goal.title),
        card(
            h("p", { text: t("goal.expired_body") }),
            h("div.stack-tight", null,
                link("/reports", t("result.reports_button"), { class: "btn btn-secondary btn-block" }),
                link("/questions", t("nav.questions"), { class: "btn btn-secondary btn-block" }),
                link("/goal", t("goal.expired_close"), { class: "btn btn-block" })
            )
        )
    );
}