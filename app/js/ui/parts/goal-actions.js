// The buttons that act on a goal, drawn from the ONE decision about it.
//
// WHY A SHARED PART. The home page and the goal page both have to offer the same
// actions on the same goal, and they used to write them out separately -- the home
// page from `planSchedule`, and a third `/exercise` screen from the same values again.
// Three copies of "is this Start button alive" is three chances to disagree, and the
// symptom a reader sees is a button that is grey on one screen and works on another.
//
// So `domain/goal-action.js` decides, `goal-service` reads the numbers once, and this
// file draws whatever that decision says. It takes an `action` and nothing else about
// the goal's state, which is what makes it impossible for a screen to be looking at
// something the decision did not account for.
//
// IT RETURNS A `destroy` WHEN IT PAINTS A CLOCK, and every thirty seconds rather than
// every second. A waiting goal says "opens in 1 day" and a goal over its own cap says
// "the next one opens in 3 hours"; both are painted once and left alone on a timer
// that never fires, and the reader concludes the app has stopped counting. Nothing on
// these lines is worth waking a phone for more often than half a minute, and a
// countdown that visibly ticks every second invites taps on a button that is disabled
// anyway.

import { h, link } from "../dom.js";
import { t, formatCountdown } from "../../i18n/i18n.js";
import { ACTION } from "../../domain/goal-action.js";
import { remaining } from "../../domain/time.js";
import { go } from "../../app/router.js";
import * as toast from "../toast.js";
import * as sessions from "../../services/session-service.js";

/** Where an exercise is RUN, given its id. The goal is not in the URL and does not
 *  need to be: the exercise record carries its own goal, and the page reads it from
 *  there. Putting the goal in the path would mean the URL could name a goal the
 *  exercise does not belong to, and a check to refuse that. */
export const exerciseHref = (exerciseId) => `/exercise/${encodeURIComponent(exerciseId)}`;

/** Where a goal's exercises are chosen from. */
export const buildHref = (goalId) => `/goal/${encodeURIComponent(goalId)}/exercise/build`;

/** Where a goal's material is attached. */
export const contentHref = (goalId) => `/goal/${encodeURIComponent(goalId)}/content`;

/**
 * Where the ready-made question sets are, with this goal already chosen.
 *
 * IT IS HERE WITH `contentHref` AND `buildHref` rather than in the library page, because
 * three screens link to it and a link written three times is three URLs to keep in step —
 * and because the point of the query is the goal, which is this file's subject. The
 * library reads the id back out of the URL and acts on that plan.
 *
 * The query is DROPPED when there is no goal rather than sent empty: `/library?goal=` is a
 * link that says "with some plan" without saying which, and the page would resolve it to
 * the newest one — so its meaning would depend on the day it was followed.
 */
export const libraryHref = (goalId) => withGoal("/library", goalId);

/** One ready-made set, with the plan still chosen. */
export const packHref = (packId, goalId) =>
    withGoal(`/library/${encodeURIComponent(packId)}`, goalId);

function withGoal(path, goalId) {
    return goalId ? `${path}?goal=${encodeURIComponent(goalId)}` : path;
}

/**
 * The action block for one goal.
 *
 * @param {{goal: object, action: object, compact?: boolean}} input
 *   `compact` drops the "choose what to be asked" button, which is the one control
 *   that belongs on the goal's own page and not on a dashboard card. Both screens
 *   want a Start; only the goal page is a place to make a considered decision.
 * @returns {{node: HTMLElement, destroy: (() => void)|null}}
 */
export function goalActions({ goal, action, compact = false }) {
    const timers = [];
    const body = h("div.stack-tight");

    // THE OPEN EXERCISES ARE OFFERED IN EVERY BRANCH THAT CAN HAVE THEM.
    //
    // Waiting for the interval and being over the rate cap are refusals to BUILD
    // something new. Neither is a reason a reader cannot finish the one they already
    // started — and a reader whose goal opens tomorrow morning is exactly the person
    // most likely to have something half-finished tonight. The decision already carries
    // `open`; drawing it in three of the six branches and not the other two meant the
    // home page said "not yet" with no way through while the goal page listed the same
    // exercise with a Continue button on it.
    //
    // Newest first, because that is the one they most likely want.
    for (const exercise of action.open ?? []) {
        body.appendChild(h("button.btn.btn-block", {
            type: "button",
            onclick: () => go(exerciseHref(exercise.id))
        }, t("home.continue_exercise", { n: String(exercise.number) })));
    }

    switch (action.action) {
        case ACTION.NO_GOAL:
            body.appendChild(h("p.muted", { text: t("home.no_goal_body") }));
            body.appendChild(link("/goal", t("home.create_goal"), { class: "btn btn-block" }));
            break;

        case ACTION.CLOSED:
            body.appendChild(h("p.small.muted", {
                text: goal.archivedAt ? t("goal.archived_body") : t("goal.finished_body")
            }));
            // An exercise that is still open can still be FINISHED on a closed goal.
            body.appendChild(link(
                `/goal/${encodeURIComponent(goal.id)}`,
                t("goal.open_button"),
                { class: "btn btn-secondary btn-block" }
            ));
            break;

        case ACTION.NO_MATERIAL:
            // A GOAL WITH NOTHING ATTACHED IS NOT HALF-MADE, and the two buttons say
            // so. "Add some questions" is a request to go and create material before
            // this goal can be used -- and it is wrong twice over now that questions
            // belong to no goal. A reader with two hundred questions written and no
            // attachments has everything they need; what they lack is the decision of
            // which of it this plan covers. So the first button is the join, and the
            // second is only for the case where there is genuinely nothing to point at.
            body.appendChild(h("p.muted", { text: t("home.needs_questions_body") }));
            body.appendChild(link(contentHref(goal.id), t("content.title"), { class: "btn btn-block" }));
            body.appendChild(link("/questions/new", t("home.add_questions"),
                { class: "btn btn-secondary btn-block" }));
            break;

        case ACTION.WAITING: {
            // The countdown is a NODE. The sentence has no `{time}` and no trailing
            // full stop for the same reason the result page's does not: the value used
            // to be interpolated as an empty placeholder and the period that followed it
            // was left stranded in front of a number that arrived after it, which
            // printed "opens in . 23h 59m" on the one screen whose whole job is to say
            // when the reader may come back.
            const countdown = h("span.nums");
            const paint = () => { countdown.textContent = formatCountdown(remaining(action.dueAt)); };
            paint();
            timers.push(setInterval(paint, 30_000));

            body.appendChild(h("p", null, t("home.locked_body"), " ", countdown));
            body.appendChild(h("button.btn.btn-block", {
                type: "button",
                disabled: true,
                "aria-disabled": "true"
            }, t("home.locked_heading")));
            break;
        }

        case ACTION.RATE_LIMITED: {
            // The rate cap. Its own button and its own sentence, because it is not the
            // same thing as the goal's interval: this goal's interval has elapsed and
            // this goal has been started three times in the last two days. It counts
            // this goal's own exercises only, so a reader with three goals is not
            // refused by one they have not opened — which is what the wording below
            // says, and what it would not say if the cap were shared.
            const quota = action.quota ?? {};
            body.appendChild(h("p.small.muted", {
                text: t("home.quota_line", {
                    used: String(quota.used ?? 0),
                    limit: String(quota.limit ?? 0)
                })
            }));

            const countdown = h("span.nums");
            const paint = () => { countdown.textContent = formatCountdown(remaining(quota.retryAt)); };
            paint();
            timers.push(setInterval(paint, 30_000));
            body.appendChild(h("p.small.muted", null,
                t("home.quota_free_body", { time: "" }), " ", countdown));

            body.appendChild(h("button.btn.btn-block", {
                type: "button",
                disabled: true,
                "aria-disabled": "true"
            }, t("home.quota_heading")));
            break;
        }

        default: {
            // READY, WITH MATERIAL: one Start button, beside any resume button drawn
            // above. The open exercises are already on screen by this point, so this
            // branch is only the part that can be refused -- and it is the only branch
            // where the "choose what to be asked" control belongs, because that is a
            // decision and this is the screen where a reader makes decisions.
            body.appendChild(h("button.btn.btn-block", {
                type: "button",
                onclick: (event) => startExercise(event.currentTarget, goal)
            }, t("home.start_exercise")));

            // "CHOOSE WHAT TO BE ASKED" IS A SECOND BUTTON BESIDE START, not a mode of
            // it. The button above is the plan drawing the next exercise, which is what
            // almost every visit wants and is one tap. This one is for the day the reader
            // already knows -- "the irregular verbs, and these four I keep getting wrong"
            // -- and it goes to a page rather than opening a dialog, because a list of
            // questions to tick does not belong in a modal on a phone.
            if (!compact) {
                body.appendChild(link(buildHref(goal.id), t("build.title"),
                    { class: "btn btn-secondary btn-block" }));
            }
            break;
        }
    }

    // THE ALLOWANCE, ALWAYS, and only on the block that offers a Start. It is the one
    // number a reader can act on before being refused, and it is only meaningful while
    // there is still something left -- a reader who sees "1 of 3" knows to start the
    // one they want rather than the one they happened to open. A goal that is waiting
    // or over the cap has nothing to act on here; its own sentence is above.
    const quota = action.quota;
    if (action.action === ACTION.RESUME || action.action === ACTION.RESUME_OR_START) {
        body.appendChild(h("div.small.muted", {
            style: { "margin-top": "var(--space-2)" },
            text: t("home.quota_remaining", {
                n: String(quota?.remaining ?? 0),
                total: String(quota?.limit ?? 0)
            })
        }));
    }

    return {
        node: body,
        destroy: timers.length ? () => { for (const timer of timers) clearInterval(timer); } : null
    };
}

/**
 * Start this goal's next exercise and go to it.
 *
 * The button is disabled before the write rather than after it, because a second tap
 * on a Start that is already building a session is a second exercise: the id is
 * derived from nothing the reader can see, so the service's idempotence cannot help,
 * and the quota would spend twice for one intention.
 *
 * A REFUSAL REDRAWS rather than explaining. `too_soon` and `too_many_exercises` mean
 * this page was out of date -- another tab finished something, or another goal spent
 * a slot -- and the honest repair is to re-read the decision, not to describe the rule
 * that changed underneath it.
 */
async function startExercise(button, goal) {
    button.disabled = true;
    try {
        const { exercise } = await sessions.start({ goalId: goal.id });
        go(exerciseHref(exercise.id));
    } catch (err) {
        button.disabled = false;
        toast.error(err);
        if (err?.code === "invalid_transition" || err?.code === "too_soon"
            || err?.code === "too_many_exercises") {
            go("/");
        }
    }
}
