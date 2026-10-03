// The goal LIST: every active goal, a way to make another, and the ones set aside.
//
// This page used to be three screens in one file — the list, the create form, and one
// goal in detail — and the third of them is now `goal-view.js`. The split is not
// tidiness. The detail page became the hub the whole app points at (an exercise is
// started, repeated and listed from it), and folding a 300-line hub into a file whose
// other half is a list is how a list ends up carrying a branch it has no reason to
// have.
//
// WHAT A ROW SHOWS, and why so little:
//
//   the title, its state, and its three numbers — questions, exercises done, learned
//
// The state comes from `domain/goal-action.js`, the same decision the home page and
// the goal's own page draw from, so a goal that is ready here is ready there. It used
// to be assembled here from `planSchedule` directly, which is how the row and the
// home page's card came to disagree.
//
// A SECOND GOAL IS ALLOWED, which is the whole reason this page draws a list. The
// create form used to appear only when there were no goals at all, on the reasoning
// that there could only ever be one; that reasoning is gone, so the form is behind its
// own button and the list is above it. The button is not hidden when goals exist —
// there is nothing about having three goals that should stop a reader making a fourth.

import { h, link } from "../dom.js";
import { head, card, section } from "../page.js";
import { field, textInput, textareaInput, numberInput, form, submitButton, row } from "../fields.js";
import * as toast from "../toast.js";
import { t } from "../../i18n/i18n.js";
import { LIMITS } from "../../domain/validation.js";
import { stateKey } from "../../domain/goal-action.js";
import {
    DEFAULT_DURATION_DAYS, DEFAULT_NEW_PER_EXERCISE, DEFAULT_REVIEW_DEPTH, DEFAULT_INTERVAL_DAYS
} from "../../config.js";
import { overviews, goalAction, createGoal, listHistory } from "../../services/goal-service.js";
import { go } from "../../app/router.js";
import { setCurrentGoal } from "../nav.js";

/* -------------------------------- the list -------------------------------- */

export async function render(ctx) {
    const wantsNew = ctx?.query?.get("new") === "1";
    const rows = await overviews();

    if (!rows.length && !wantsNew) return { node: createGoalView() };

    const node = h("div.stack", null);
    node.appendChild(head("goal.title_list", "goal.subtitle_list",
        link("/goal?new=1", t("home.create_goal"), { class: "btn" })));

    for (const row of rows) {
        node.appendChild(goalRow(row));
    }

    if (!rows.length) {
        node.appendChild(h("p.muted", { text: t("goal.list_empty") }));
    }

    // Every goal ever made, completed and archived ones included, in one section.
    // `listHistory` returns all of them — archiving files a goal away, it does not
    // remove it — and this is where a reader finds one they set aside last year.
    node.appendChild(historySection());

    if (wantsNew) {
        node.appendChild(section("goal.create_heading", createGoalForm()));
    }

    return { node };
}

/**
 * One row: what it is, what state it is in, and how much is behind it.
 *
 * "One exercise open" and "ready" are BOTH printed when both are true, which they
 * often are now that a reader may have an exercise open AND start another. Printing
 * only the first makes a goal that is ready to start look unavailable.
 */
function goalRow(row) {
    const action = goalAction({
        plan: row.plan,
        materialCount: row.material.count,
        open: row.open,
        quota: row.quota
    });

    const stateLine = [];
    if (action.open.length) {
        stateLine.push(t("goal.state_open_n", { n: String(action.open.length) }));
    }
    stateLine.push(t(`goal.state_${stateKey(action)}`));

    return h("div.card.card-quiet", null,
        h("div.row-between", { style: { "gap": "var(--space-3)" } },
            h("div.grow", null,
                link(`/goal/${encodeURIComponent(row.goal.id)}`, row.goal.title),
                stateLine.length ? h("div.tiny.muted", { text: stateLine.join(" · ") }) : null,
                h("div.tiny.muted", {
                    text: t("goal.row_counts", {
                        questions: String(row.material.count),
                        exercises: String(row.exercisesCount.completed)
                    })
                })
            ),
            link(`/goal/${encodeURIComponent(row.goal.id)}`, t("goal.open_button"), { class: "btn btn-secondary" })
        )
    );
}

/* -------------------------------- create --------------------------------- */

/**
 * The create form on its own, which is what a reader with no goals sees.
 *
 * A goal with nothing attached is finished on creation rather than being a mistake to
 * repair, so this form says what it makes — a name and four numbers — and the next
 * screen is where the reader decides what it trains on.
 */
export function createGoalView() {
    setCurrentGoal(null);
    return h("div.stack", null,
        head("goal.title_new", "goal.subtitle_new"),
        card(createGoalForm())
    );
}

/**
 * The create form, carrying the WHOLE PLAN and not just the name.
 *
 * It used to ask for a title and a description and then send neither number, so
 * `validateGoal` filled in the defaults and a reader who wanted "ten new words a
 * day, reviewing the last five exercises" got five and three — with nothing on screen
 * to say the plan existed at all. The plan is the first thing a goal is, and the four
 * numbers are the plan.
 *
 * Each has a hint that says what it actually does rather than what it is called.
 * `reviewDepth` in particular is a multiplier, not a count, and the hint is the only
 * place that says so.
 */
function createGoalForm() {
    const title = field({
        labelKey: "goal.field_title",
        control: textInput({ maxlength: LIMITS.TITLE_MAX })
    });
    const description = field({
        labelKey: "goal.field_description",
        hintKey: "common.optional",
        control: textareaInput({ maxlength: LIMITS.TEXT_MAX, rows: 3 })
    });

    // Pre-filled with the defaults, and editable — the same controls the goal page
    // uses to change them later, so a reader who learns what a number does can set
    // it here rather than discovering it after a week of exercises.
    const per = field({
        labelKey: "goal.field_new_per_exercise",
        hintKey: "goal.hint_new_per_exercise",
        control: numberInput({
            value: DEFAULT_NEW_PER_EXERCISE,
            min: LIMITS.NEW_PER_EXERCISE_MIN,
            max: LIMITS.NEW_PER_EXERCISE_MAX
        })
    });
    const depth = field({
        labelKey: "goal.field_review_depth",
        hintKey: "goal.hint_review_depth",
        control: numberInput({
            value: DEFAULT_REVIEW_DEPTH,
            min: LIMITS.REVIEW_DEPTH_MIN,
            max: LIMITS.REVIEW_DEPTH_MAX
        })
    });
    const interval = field({
        labelKey: "goal.field_interval_days",
        hintKey: "goal.hint_interval_days",
        control: numberInput({
            value: DEFAULT_INTERVAL_DAYS,
            min: LIMITS.INTERVAL_DAYS_MIN,
            max: LIMITS.INTERVAL_DAYS_MAX
        })
    });
    const duration = field({
        labelKey: "goal.field_duration_days",
        hintKey: "goal.hint_duration_days",
        control: numberInput({
            value: DEFAULT_DURATION_DAYS,
            min: LIMITS.DURATION_DAYS_MIN,
            max: LIMITS.DURATION_DAYS_MAX
        })
    });

    const save = submitButton("goal.create_button");

    const body = form(async () => {
        save.setBusy(true);
        try {
            const created = await createGoal({
                title: title.control.value,
                description: description.control.value,
                newPerExercise: per.control.value,
                reviewDepth: depth.control.value,
                intervalDays: interval.control.value,
                durationDays: duration.control.value
            });
            toast.show("toast.goal_created");
            // STRAIGHT TO THE GOAL'S OWN PAGE, and not to a question list.
            //
            // A goal is a plan, and a plan is finished the moment it has a name and
            // four numbers. It used to send the reader to a question list scoped to
            // the new goal, on the reasoning that a goal with no questions opens on a
            // page with nothing to do — which was true of that list and is not true
            // now, because questions belong to no goal. The screen that follows a new
            // goal is the goal itself, which is where an exercise is started and where
            // its material is attached.
            go(`/goal/${encodeURIComponent(created.id)}`);
        } catch (err) {
            save.setBusy(false);
            if (err?.code) {
                title.setError(err.code);
                return;
            }
            toast.error(err);
        }
    },
    h("div.stack", null,
        title.node,
        description.node,
        h("h3", { style: { "margin-top": "var(--space-2)" }, text: t("goal.plan_heading") }),
        row(per, depth),
        interval.node,
        duration.node,
        save.node
    ));

    return body;
}

/* -------------------------------- history -------------------------------- */

/**
 * The goals that are finished or in the archive.
 *
 * Every one of them is a link to its own page, which still shows its plan, its
 * material and its whole exercise history — because a goal that is closed keeps
 * everything, and a history list that only showed titles would be the one screen in
 * the app where a reader cannot find out what they actually did.
 */
function historySection() {
    const container = h("div.stack-tight");

    listHistory().then((goals) => {
        const past = goals.filter((g) => g.status === "completed" || g.archivedAt);
        if (!past.length) {
            container.appendChild(h("p.muted", { text: t("goal.history_empty") }));
            return;
        }
        for (const g of past) {
            container.appendChild(h("div.card.card-quiet.row-between", null,
                link(`/goal/${encodeURIComponent(g.id)}`, g.title),
                h("span.small.muted", {
                    text: g.archivedAt ? t("goal.archived_badge") : t("goal.finished_badge")
                })
            ));
        }
    }).catch(() => {});

    return section("goal.history_heading", container);
}
