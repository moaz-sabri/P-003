// One goal, and it is the hub: its plan, what it is made of, its exercises, and the
// three ways to stop working on it.
//
// WHY THIS PAGE AND NOT `/exercise`.
//
// An exercise is PART OF A goal. It is built from the goal's schedule, out of the
// goal's material, numbered against the goal's own history, and it means nothing
// without the goal that produced it. It used to have a screen of its own at `/exercise`
// with no id in the URL, whose job was to work out which goal to act on and then
// re-derive the same start/resume/waiting buttons the home page had already drawn.
//
// That was the structural problem, and it had three symptoms a reader could see:
//
//   * a Start button that was dead on the home page and alive on `/exercise`,
//     depending on when each was drawn;
//   * a nav bar item called "Exercise" that had to ask WHICH GOAL before it could do
//     anything, because the URL did not say;
//   * a goal page that listed a goal's exercises and could not start one, so getting
//     from "here is my history" to "do the next one" needed the home page or the nav
//     bar.
//
// All three are gone because the goal names itself in its own URL and this page asks
// `domain/goal-action.js` once. The page is ordered by what a reader does with a goal:
//
//   1. what can be done right now   — the decision, and the buttons it implies
//   2. what it trains on            — the material, and the attachment screen
//   3. what it has done             — the exercises, open ones first
//   4. the plan                     — the four numbers, editable
//   5. stopping                     — archive, finish, and the refusal to delete
//
// The exercises section is THIRD rather than first because the action block above it
// already offers a resume button per open exercise. What the list adds is the
// finished ones, and the repeat button, which is the control that makes a history
// useful: "the exercise closes, and the same words can be asked again whenever you
// like." A reader revising for an exam wants the same twenty words again on Sunday,
// and an app that answers "come back on the 14th" has not read what they asked for.

import { h, link, statRow, stat } from "../dom.js";
import { head, card, section, destructiveButton } from "../page.js";
import { field, numberInput, form, submitButton, row } from "../fields.js";
import * as toast from "../toast.js";
import { t, formatDate, formatDateTime, formatPercent } from "../../i18n/i18n.js";
import { LIMITS } from "../../domain/validation.js";
import { goalAction } from "../../domain/goal-action.js";
import {
    overview, updatePlan, finishGoal, archiveGoal, unarchiveGoal, SCHEDULE
} from "../../services/goal-service.js";
import * as sessions from "../../services/session-service.js";
import { go } from "../../app/router.js";
import { goalActions, contentHref, buildHref, exerciseHref } from "../parts/goal-actions.js";
import { setCurrentGoal } from "../nav.js";

/**
 * The three ways to stop working on a goal, which are DIFFERENT AND ALL THREE ARE
 * OFFERED, because they answer different questions and the app used to conflate two
 * of them:
 *
 *   archive    put it away, keep everything, take it back. THE REVERSIBLE ONE, and
 *              the one the reader's words asked for: "the goal is archived with its
 *              report, and neither deleted nor hidden". It builds nothing new and
 *              appears in the archive.
 *   finish     the plan's own time is up, so it closes. Not reversible, and it
 *              offers a new goal because it is finished.
 *   delete     the goal was a mistake. Refused outright — see `notDeletable`.
 */
export async function render(ctx) {
    const id = ctx?.route?.params?.id ?? null;
    const row = id ? await overview(id) : null;
    if (!row) return { node: notFound() };

    const { goal, plan, quota, open, exercises, exercisesCount, material, stats } = row;
    const action = goalAction({ plan, materialCount: material.count, open, quota });

    setCurrentGoal(goal.id);

    const node = h("div.stack", null);
    node.appendChild(head("goal.title_view", "goal.subtitle_view"));

    /* --------------------- 1. what can be done right now --------------------- */

    node.appendChild(card(
        h("h2", { text: goal.title }),
        goal.description ? h("p.muted", { text: goal.description }) : null,
        h("p.small.muted", { text: `${t("goal.created_on")} ${formatDate(goal.createdAt)}` }),
        goal.archivedAt
            ? h("p.small.muted", { text: t("goal.archived_on", { time: formatDateTime(goal.archivedAt) }) })
            : null,
        goal.status === "completed" && goal.completedAt
            ? h("p.small.muted", { text: t("goal.finished_on", { time: formatDateTime(goal.completedAt) }) })
            : null,
        plan.state === SCHEDULE.EXPIRED
            ? h("p.small.muted", { text: t("goal.expired_body") })
            : null
    ));

    // Not compact: this is the page where a reader goes when they already know what
    // they want, so "choose what to be asked" belongs beside the one-tap Start.
    const drawn = goalActions({ goal, action });
    node.appendChild(card(drawn.node));

    /* -------------------------- 2. what it trains on ------------------------- */

    node.appendChild(section("goal.material_heading", card(
        statRow(
            stat(material.count, t("home.stat_questions")),
            stat(material.groups.length, t("content.stat_groups")),
            stat(material.loose, t("content.stat_questions_picked"))
        ),
        material.groups.length
            ? h("div.row", { style: { "flex-wrap": "wrap", gap: "var(--space-1)", "margin-top": "var(--space-3)" } },
                ...material.groups.map((group) =>
                    h("span.chip", { text: `${group.name} · ${group.size}` })))
            : null,
        // "What this trains on" is a DECISION, not a collection to browse, and the
        // button says so. "The goal's questions" would be a link to a list that does
        // not exist -- a goal does not own questions, so there is no list of questions
        // that are this goal's and not another's.
        h("div", { style: { "margin-top": "var(--space-3)" } },
            link(contentHref(goal.id), t("content.title"), { class: "btn btn-secondary btn-block" })
        ),
        h("p.tiny.muted", {
            style: { "margin-top": "var(--space-2)" },
            text: t("goal.material_hint")
        })
    )));

    // Where the tracking figures live. The home page shows four; a page the reader
    // opened deliberately can afford the answer count and the session count beside
    // them, and they are read from the same `summarize` as everything else.
    node.appendChild(card(statRow(
        stat(formatPercent(stats.accuracy.percent), t("home.stat_accuracy")),
        stat(String(stats.accuracy.total), t("reports.stat_answered")),
        stat(exercisesCount.completed, t("home.stat_exercises")),
        stat(String(exercisesCount.total), t("goal.stat_exercises_total"))
    )));

    /* ---------------------------- 3. its exercises --------------------------- */

    node.appendChild(exerciseSection(goal, exercises, open));

    /* ------------------------------ 4. the plan ------------------------------ */

    node.appendChild(planForm(goal));

    /* ------------------------------ 5. stopping ------------------------------ */

    node.appendChild(actionsSection(goal, open));

    return {
        node,
        destroy: drawn.destroy ?? undefined
    };
}

/* -------------------------------- exercises -------------------------------- */

/**
 * The goal's exercises: the open ones with a resume button, the finished ones with a
 * result and a REPEAT button.
 *
 * OPEN ONES FIRST AND SEPARATED. An open exercise is unfinished work and a finished one
 * is history, and a reader opening this page is usually asking one of those two
 * questions rather than both. Two lists with their own headings make the difference
 * visible; one list sorted by number put the thing they were in the middle of below
 * twelve sittings from last month.
 *
 * THE REPEAT BUTTON IS THE POINT OF THE FINISHED LIST. A finished exercise is a set of
 * questions that was asked once, not a record that has been used up. It is offered on
 * EVERY finished exercise rather than only the newest, because the one a reader wants to
 * repeat is not the one they did last — it is the one that covered the material they
 * have not looked at since.
 *
 * "FROM THE SCHEDULE, NOT FILTERED HERE": `open` comes from `planSchedule` rather than
 * from a filter in this file, because "which exercises are open" is a question the
 * schedule answers and a second answer here is one that will disagree the day the
 * schedule learns something this filter does not.
 */
function exerciseSection(goal, list, open) {
    const finished = list.filter((x) => x.completedAt)
        .sort((a, b) => b.number - a.number);

    const parts = [];

    if (open.length) {
        parts.push(section("goal.open_exercises_heading", ...open.map((exercise) =>
            h("div.card.card-quiet.row-between", null,
                h("div.grow", null,
                    h("span", { text: t("exercise.row_open", { n: String(exercise.number) }) }),
                    h("div.tiny.muted", { text: formatDateTime(exercise.createdAt) })
                ),
                link(exerciseHref(exercise.id),
                    t("home.continue_exercise", { n: String(exercise.number) }),
                    { class: "btn btn-secondary" })
            ))));
    }

    if (finished.length) {
        parts.push(section("exercise.heading", ...finished.map((exercise) =>
            h("div.card.card-quiet.row-between", { style: { "gap": "var(--space-2)" } },
                h("div.grow", null,
                    link(`/exercise/${encodeURIComponent(exercise.id)}/result`,
                        t("exercise.row_done", { n: String(exercise.number) })),
                    h("div.tiny.muted", {
                        text: `${formatDateTime(exercise.completedAt)}`
                            + (exercise.sourceId ? ` · ${t("exercise.row_repeat")}` : "")
                    })
                ),
                h("button.btn.btn-quiet", {
                    type: "button",
                    "aria-label": t("exercise.repeat_button"),
                    onclick: (event) => repeatExercise(event, exercise)
                }, iconRepeat())
            ))));
    }

    if (!parts.length) {
        return section("exercise.heading", card(h("p.muted", { text: t("exercise.list_empty") })));
    }

    // The picker is offered once, under the lists, rather than above them: a reader
    // arriving here to finish something is looking at the open list, and a big
    // "choose what to be asked" above it is a control for a different intention.
    parts.push(h("div", { style: { "margin-top": "var(--space-2)" } },
        link(buildHref(goal.id), t("build.title"), { class: "btn btn-secondary btn-block" })
    ));

    return h("div.stack", null, ...parts);
}

/** The repeat glyph. Drawn rather than typed: the text `↻` is one thin character that
 *  means different things in different fonts, and this button's whole job is to say
 *  "the same questions again" in a form nobody has to guess at. */
function iconRepeat() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "nav-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4");
    svg.appendChild(path);
    return svg;
}

/**
 * Ask for this exercise's questions again.
 *
 * It is a BUTTON and not a link because it writes: a new exercise of the same goal,
 * with the same frozen copies of the questions, its own attempt log and its own score.
 * A link would be a thing that looks free and spends a slot from the rate cap.
 */
async function repeatExercise(event, exercise) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const { exercise: made } = await sessions.repeat(exercise.id);
        toast.show("toast.exercise_repeated");
        go(exerciseHref(made.id));
    } catch (err) {
        button.disabled = false;
        toast.error(err);
        // The cap is device-wide, so a refusal here can be about another goal's
        // spending rather than this one. The home page redraws from the decision.
        if (err?.code === "too_many_exercises") go("/");
    }
}

/* -------------------------------- the plan ------------------------------- */

/**
 * The four numbers, editable.
 *
 * "The plan", not the goal's own name. This section used to be headed with the same
 * key the page head uses, so the goal page said "Your goal" twice with a form in
 * between and no reader could tell the heading from a repeat of the title.
 */
function planForm(goal) {
    const per = field({
        labelKey: "goal.field_new_per_exercise",
        hintKey: "goal.hint_new_per_exercise",
        control: numberInput({
            value: goal.newPerExercise,
            min: LIMITS.NEW_PER_EXERCISE_MIN,
            max: LIMITS.NEW_PER_EXERCISE_MAX
        })
    });
    const depth = field({
        labelKey: "goal.field_review_depth",
        hintKey: "goal.hint_review_depth",
        control: numberInput({
            value: goal.reviewDepth,
            min: LIMITS.REVIEW_DEPTH_MIN,
            max: LIMITS.REVIEW_DEPTH_MAX
        })
    });
    const interval = field({
        labelKey: "goal.field_interval_days",
        hintKey: "goal.hint_interval_days",
        control: numberInput({
            value: goal.intervalDays,
            min: LIMITS.INTERVAL_DAYS_MIN,
            max: LIMITS.INTERVAL_DAYS_MAX
        })
    });
    const duration = field({
        labelKey: "goal.field_duration_days",
        hintKey: "goal.hint_duration_days",
        control: numberInput({
            value: goal.durationDays,
            min: LIMITS.DURATION_DAYS_MIN,
            max: LIMITS.DURATION_DAYS_MAX
        })
    });

    const save = submitButton("goal.save_button");

    const body = form(async () => {
        save.setBusy(true);
        try {
            await updatePlan(goal.id, {
                newPerExercise: per.control.value,
                reviewDepth: depth.control.value,
                intervalDays: interval.control.value,
                durationDays: duration.control.value
            });
            save.setBusy(false);
            toast.show("toast.goal_saved");
            // REDRAW, because three of the four numbers change what the page says.
            // Widening the interval can turn a Start button into a waiting countdown;
            // raising `reviewDepth` changes how big the next exercise will be. Saving
            // and leaving the old numbers on screen is how a reader ends up waiting
            // for a date they have just changed.
            go(`/goal/${encodeURIComponent(goal.id)}`);
        } catch (err) {
            save.setBusy(false);
            toast.error(err);
        }
    },
    h("div.stack", null,
        row(per, depth),
        interval.node,
        duration.node,
        save.node
    ));

    return section("goal.plan_heading", card(body));
}

/* -------------------------------- actions -------------------------------- */

/**
 * Archive, finish, and the refusal to delete.
 *
 * ARCHIVE IS THE FIRST BUTTON because it is the one that is reversible and it is the
 * one that loses nothing. A reader who wants to stop working on a goal this week taps
 * it, sees it on the archive page with its report, and can take it back next week
 * without having destroyed a single question.
 *
 * FINISH IS SECOND and it refuses while anything is open, as it always did — but the
 * message it gives now says what to do instead, because the thing to do instead
 * exists.
 */
function actionsSection(goal, open) {
    const parts = [];

    if (goal.archivedAt) {
        parts.push(h("p.small.muted", { text: t("goal.archived_body") }));
        parts.push(h("button.btn.btn-block", {
            type: "button",
            onclick: async (event) => {
                event.currentTarget.disabled = true;
                try {
                    await unarchiveGoal(goal.id);
                    toast.show("toast.goal_unarchived");
                    go(`/goal/${encodeURIComponent(goal.id)}`);
                } catch (err) {
                    event.currentTarget.disabled = false;
                    toast.error(err);
                }
            }
        }, t("goal.unarchive_button")));
    } else {
        parts.push(destructiveButton("goal.archive_button", {
            titleKey: "goal.archive_title",
            bodyKey: "goal.archive_body"
        }, async () => {
            try {
                await archiveGoal(goal.id);
                toast.show("toast.goal_archived");
                go("/archive");
            } catch (err) {
                toast.error(err);
            }
        }));

        if (goal.status !== "completed") {
            parts.push(open.length
                ? h("p.small.muted", { text: t("goal.finish_blocked", { n: String(open.length) }) })
                : destructiveButton("goal.finish_button", {
                    titleKey: "goal.finish_title",
                    bodyKey: "goal.finish_body"
                }, async () => {
                    try {
                        await finishGoal(goal.id);
                        toast.show("toast.goal_finished");
                        go("/goal");
                    } catch (err) {
                        toast.error(err);
                    }
                }));
        }
    }

    parts.push(notDeletable());

    // THE BUTTONS ARE STACKED, not laid side by side. `.btn` is `inline-flex`, so two
    // of them inside one card sit on one line with no gap between them and read as a
    // single sentence — "Take it out of the archiveFinish this goal" — which is what a
    // reader saw when a goal was archived and both actions were offered. There is no
    // rule that stacks them, so it is done here.
    return section("goal.actions_heading", card(
        h("div.stack-tight", null, ...parts.filter(Boolean))
    ));
}

/**
 * Why there is no delete button.
 *
 * A GOAL IS NOT DELETABLE, and this paragraph is where that is said rather than where
 * it is merely true. It used to be: `deleteGoal` cascaded through questions, options,
 * exercises, items and attempts, and it was reachable from this page. Both halves of
 * that are wrong now. Questions are filed under groups and can be pointed at by any
 * goal, so cascading them away destroys material the reader can still use; and the
 * reader's instruction is explicit — the goal is archived, with its report, and neither
 * deleted nor hidden.
 *
 * So the button is gone rather than disabled. A greyed-out Delete is a promise the app
 * has not kept, and the sentence below it is the honest version: the goal stays, and
 * here is where it went.
 */
function notDeletable() {
    return h("p.small.muted", { style: { "margin-top": "var(--space-3)" }, text: t("goal.not_deletable") });
}

/* ------------------------------- not found ------------------------------- */

function notFound() {
    return h("div.stack", null,
        head("goal.title_view", null),
        h("div.empty", null,
            h("h2", { text: t("error.not_found") }),
            link("/goal", t("goal.title_list"), { class: "btn" })
        )
    );
}
