// The goal page: create one, look at one, change its plan, finish it.
//
// Two forms in one route, chosen by whether there is an active goal. That is
// deliberate — "Create New Goal" on a finished goal goes to the same URL as
// "New goal" from the home page, and a route that could be either would have to
// guess. What it must never do is offer to create a second active goal, which is
// why the create form is not drawn at all when one exists: the button that would
// have submitted it is simply not there.
//
// The three numbers are the whole of "the plan", and each has a hint that says
// what it actually does rather than what it is called. `reviewDepth` in
// particular is a multiplier, not a count, and the hint is the only place that
// says so.

import { h, link } from "../dom.js";
import { head, card, section, destructiveButton } from "../page.js";
import { field, textInput, textareaInput, numberInput, form, submitButton, row } from "../fields.js";
import * as toast from "../toast.js";
import { t, formatDate } from "../../i18n/i18n.js";
import { LIMITS } from "../../domain/validation.js";
import {
    DEFAULT_DURATION_DAYS, DEFAULT_NEW_PER_EXERCISE, DEFAULT_REVIEW_DEPTH, DEFAULT_INTERVAL_DAYS
} from "../../config.js";
import { snapshot, createGoal, updatePlan, finishGoal, listHistory } from "../../services/goal-service.js";
import { go } from "../../app/router.js";

export async function render() {
    const { goal } = await snapshot();
    return goal ? { node: viewGoal(goal) } : { node: createGoalView() };
}

/* ------------------------------- create ---------------------------------- */

/**
 * The create form carries the WHOLE PLAN, not just the name.
 *
 * It used to ask for a title and a description and then send neither number, so
 * `validateGoal` filled in the defaults and the reader who wanted "ten new words
 * a day, reviewing the last five exercises" got five and three — with nothing on
 * screen to say the plan existed at all, and a goal page three taps away that
 * looks like an afterthought. The plan is the first thing the goal is, and the
 * three numbers are the plan.
 */
function createGoalView() {
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

    const node = form(async () => {
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
            // Straight to the questions. A new goal with no questions opens on a
            // page with nothing to do, and the one thing anybody wants next is to
            // type a question.
            go(`/questions?goal=${encodeURIComponent(created.id)}`);
        } catch (err) {
            save.setBusy(false);
            if (err?.code) {
                title.setError(err.code);
                return;
            }
            toast.error(err);
        }
    },
    head("goal.title_new", "goal.subtitle_new"),
    card(
        h("div.stack", null,
            title.node,
            description.node,
            h("h3", { style: { "margin-top": "var(--space-2)" }, text: t("goal.plan_heading") }),
            row(per, depth),
            interval.node,
            duration.node,
            save.node
        )
    )
    );
    return node;
}

/* -------------------------------- view ----------------------------------- */

function viewGoal(goal) {
    const node = h("div.stack", null);
    node.appendChild(head("goal.title_view", "goal.subtitle_view"));

    node.appendChild(card(
        h("h2", { text: goal.title }),
        goal.description ? h("p.muted", { text: goal.description }) : null,
        h("p.small.muted", { text: `${t("goal.created_on")} ${formatDate(goal.createdAt)}` }),
        h("div.btn-row", { style: { "margin-top": "var(--space-4)" } },
            link("/questions", t("nav.questions"), { class: "btn btn-secondary" }),
            link("/reports", t("nav.reports"), { class: "btn btn-secondary" })
        )
    ));

    node.appendChild(planForm(goal));
    node.appendChild(finishSection(goal));
    node.appendChild(historySection());
    return node;
}

/* -------------------------------- the plan ------------------------------- */

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
    )
    );

    // "The plan", not the goal's own name. This section used to be headed with the
    // same key the page head uses, so the goal page said "Your goal" twice with a
    // form in between and no reader could tell the heading from a repeat of the
    // title.
    return section("goal.plan_heading", card(body));
}

/* -------------------------------- finish --------------------------------- */

/** Finishing is offered, and it warns, and it refuses if an exercise is open.
 *  The refusal is not politeness: a half-answered exercise inside a closed goal
 *  has nowhere to go — the goal page stops offering to resume it, and the reader
 *  is left with a record they can neither finish nor discard. */
function finishSection(goal) {
    return card(
        destructiveButton("goal.finish_button", {
            titleKey: "goal.finish_title",
            bodyKey: "goal.finish_body"
        }, async () => {
            try {
                await finishGoal(goal.id);
                toast.show("toast.goal_finished");
                go("/");
            } catch (err) {
                toast.error(err);
            }
        })
    );
}

/* -------------------------------- history -------------------------------- */

function historySection() {
    const container = h("div.stack-tight");

    listHistory().then((goals) => {
        const past = goals.filter((g) => g.status === "completed");
        if (!past.length) {
            container.appendChild(h("p.muted", { text: t("goal.history_empty") }));
            return;
        }
        for (const g of past) {
            container.appendChild(h("div.card.card-quiet", null,
                h("div.row-between", null,
                    h("span", { text: g.title }),
                    h("span.small.muted", { text: formatDate(g.completedAt ?? g.createdAt) })
                )
            ));
        }
    }).catch(() => {});

    return section("goal.history_heading", container);
}