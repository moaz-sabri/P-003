// The result page: what just happened, and when the next one opens.
//
// Everything on it is DERIVED from records that already exist — the attempt log for
// the score, the exercise record for when it finished, the goal for the interval — and
// nothing here is written. That is not asceticism: a "result" record would be a fifth
// copy of an answer, and the app's whole design is that the attempt log is the answer.
// `summaryFor()` in session-service.js is where those numbers are put together; this
// page only arranges them.
//
// IT IS ABOUT AN EXERCISE, NAMED IN THE PATH. It used to be `/exercise/result?id=x` with
// a `?goal=` fallback, and it could be reached with no id at all — in which case it
// guessed the newest finished exercise of the newest active goal. That guess is the same
// "silently pick a goal" behaviour the rest of this restructure removed: a result
// belongs to one sitting, and the sitting belongs to a goal, and both of those are in
// the records. A reader who opens the result page is asking about a session they just
// did; asking them to have found it is not a thing a page should do.
//
// The one thing it does that the home page does not is show the NEXT unlock, and it
// shows it as a live countdown for the same reason the home page does: a number
// computed when the page opened goes stale within the hour, and a stale "opens in 4
// hours" is worse than no countdown at all. The interval is half a minute rather than
// a second — the answer changes in minutes, and nothing on this screen is worth waking
// a phone for more often than that.

import { h, statRow, stat, link, emptyState, meter } from "../dom.js";
import { head, section, card } from "../page.js";
import * as toast from "../toast.js";
import { t, formatPercent, formatCountdown, formatStopwatch } from "../../i18n/i18n.js";
import * as sessions from "../../services/session-service.js";
import { getGoal } from "../../services/goal-service.js";
import { go } from "../../app/router.js";
import { setCurrentGoal } from "../nav.js";
import { exerciseHref } from "../parts/goal-actions.js";
import { remaining } from "../../domain/time.js";

/**
 * @param {{route: {params: {id: string}}}} ctx  the exercise's id is in the PATH.
 */
export async function render(ctx) {
    const id = ctx?.route?.params?.id ?? null;
    if (!id) return { node: nothingToShow() };

    const exercise = await sessions.findExercise(id);
    if (!exercise) return { node: nothingToShow() };

    // A result for an exercise that is still open is not a result. Somebody who taps
    // a stale link, or whose exercise finished between the render and the tap, is sent
    // back to it rather than shown a score for a session that has not ended.
    if (!exercise.completedAt) {
        go(exerciseHref(exercise.id));
        return { node: working() };
    }

    // The goal is the exercise's OWN, not the newest active one, and with several goals
    // on a device those are different records. It is also what the nav bar's reports
    // destination should carry from here.
    setCurrentGoal(exercise.goalId);

    const [summary, goal] = await Promise.all([
        sessions.summaryFor(exercise),
        getGoal(exercise.goalId).catch(() => null)
    ]);

    // The timer is created by the card that needs it and collected here, because
    // `destroy` is the only reliable place an interval can be cleared from: there is no
    // unload a page can count on, and an interval left running keeps painting a node
    // that is no longer in the document.
    const timers = [];
    const node = page(summary, goal, exercise, timers);
    return { node, destroy: () => { for (const timer of timers) clearInterval(timer); } };
}

function page(summary, goal, exercise, timers) {
    const node = h("div.stack", null);
    node.appendChild(head("result.title", null));

    node.appendChild(card(
        statRow(
            // The score is the FIRST-ATTEMPT figure, and the label says so. It used to
            // be the share of correct taps across every round, which is a different claim:
            // a question the reader was shown five times until it stuck contributes five
            // taps and one error, and a question they knew first time contributes one tap
            // and no errors — so the old number moved DOWN as the reader answered more,
            // which is not what a score is for.
            stat(formatPercent(summary.percent), t("result.stat_score")),
            stat(formatStopwatch(summary.elapsed), t("result.stat_time")),
            stat(summary.first.correct, t("result.stat_first_right"))
        ),
        h("div", { style: { "margin-top": "var(--space-4)" } },
            meter(summary.percent),
            h("p.small.muted", {
                style: { "margin-top": "var(--space-2)" },
                text: t("result.first_line", {
                    correct: summary.first.correct,
                    total: summary.first.asked
                })
            })
        ),
        // Three figures, then a sentence rather than a second row of tiles. The counts
        // below the bar — how many questions, how many wrong, how many had to be shown
        // again — are one idea, and they read as one when written as one; as a second
        // grid they had to be laid out for a different width than the first one and
        // produced a half-width tile of their own.
        h("p.small.muted", {
            style: { "margin-top": "var(--space-3)" },
            text: t("result.counts_line", {
                questions: summary.total,
                wrong: summary.wrong,
                reasks: summary.reasks
            })
        })
    ));

    // The one part of a report worth writing anything for: what was wrong, and what the
    // right answer was. Bounded at ten because a page of forty identical "you got these
    // wrong" rows is a list, not a report — the count above is already the honest total,
    // and the goal page carries the rest.
    if (summary.wrongItems.length) {
        node.appendChild(section("result.wrong_heading", wrongCard(summary)));
    }

    node.appendChild(section("result.next_heading", nextCard(summary, goal, timers)));

    // DONE LEADS TO THE GOAL, not to the home page. The sitting belonged to a goal and
    // the goal is where the next one is started and where this one is listed; sending a
    // reader who has just finished something to a dashboard instead of to the plan they
    // were working on is a wasted tap on the most common navigation in the app.
    node.appendChild(h("div.btn-row", null,
        link(`/goal/${encodeURIComponent(exercise.goalId)}`, t("result.goal_button"), { class: "btn" }),
        repeatButton(exercise),
        link(`/reports?goal=${encodeURIComponent(exercise.goalId)}`, t("result.reports_button"), { class: "btn btn-secondary" })
    ));

    return node;
}

/**
 * "run these same questions again".
 *
 * THE BUTTON IS HERE BECAUSE THIS IS WHERE A READER JUST FINISHED SOMETHING. The same
 * button on the goal page is a list to scroll through; this one is at the end of the
 * exercise that produced the questions, which is the only moment at which "I want
 * these again" is something somebody is actually thinking.
 *
 * It is a button and not a link because it WRITES: a new exercise of the same goal
 * with the same items — their own frozen copies of the questions, so the words on
 * screen are the words from last week — its own attempt log and its own score. A link
 * would be a thing that looks free and spends a slot from the rate cap, so it says what
 * it does.
 */
function repeatButton(exercise) {
    return h("button.btn.btn-secondary", {
        type: "button",
        onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                const { exercise: made } = await sessions.repeat(exercise.id);
                toast.show("toast.exercise_repeated");
                go(exerciseHref(made.id));
            } catch (err) {
                button.disabled = false;
                toast.error(err);
            }
        }
    }, t("result.repeat_button"));
}

/** What was wrong, with the answer beside it. */
function wrongCard(summary) {
    const rows = summary.wrongItems.slice(0, 10);
    return card(
        ...rows.map((item) => h("div.wrong-item", null,
            h("p", { text: item.text }),
            item.selected.length
                ? h("p.small.wrong", { text: t("result.wrong_you_chose", { text: item.selected.join(t("common.list_separator")) }) })
                : null,
            h("p.small.right", { text: t("result.wrong_right_is", { text: item.correct.join(t("common.list_separator")) }) })
        )),
        summary.wrongItems.length > rows.length
            ? h("p.small.muted", { text: t("result.wrong_more", { n: String(summary.wrongItems.length - rows.length) }) })
            : null
    );
}

/* -------------------------------- what next -------------------------------- */

function nextCard(summary, goal, timers) {
    // A goal that has been closed or archived — here or on another device since this
    // exercise was finished — has no next exercise, so the only action worth offering is
    // the one that starts a new goal. Handled before the countdown because a countdown to
    // an exercise that can never exist is a number that never reaches zero.
    if (!goal || goal.status === "completed" || goal.archivedAt) {
        return card(
            h("p", { text: goal?.archivedAt ? t("goal.archived_body") : t("goal.finished_body") }),
            link("/goal", t("home.create_goal"), { class: "btn btn-block" })
        );
    }

    // `summaryFor` derives the unlock from the goal's own interval, so a zero here means
    // the goal arrived from a sync with a null one. The page checks rather than trusts,
    // because "opens in " followed by nothing is a sentence with a hole in it and the
    // alternative — believing it — is a permanently locked exercise with no way to find
    // out why.
    if (!summary.nextDueAt || remaining(summary.nextDueAt) === 0) {
        return card(
            h("p", { text: t("result.next_now") }),
            // The GOAL, not the exercise screen: the next exercise is a decision this
            // goal's page makes, from the same schedule this countdown came from.
            link(`/goal/${encodeURIComponent(summary.exercise.goalId)}`, t("home.start_exercise"), { class: "btn btn-block" })
        );
    }

    const countdown = h("span.nums");
    const paint = () => { countdown.textContent = formatCountdown(remaining(summary.nextDueAt)); };
    paint();
    timers.push(setInterval(paint, 30_000));

    // NO BUTTON HERE. The two branches above each carry the one thing worth doing next
    // — start a new goal, start the exercise — and this branch's action is "go to the
    // goal", which the page already has a button for, directly below. Two controls to the
    // same place on one screen is one too many.
    return card(h("p", null, t("result.next_in"), " ", countdown));
}

/* ------------------------------ nothing to see ----------------------------- */

function nothingToShow() {
    return h("div.stack", null,
        head("result.title", null),
        emptyState(
            t("error.not_found"),
            t("exercise.no_questions"),
            link("/goal", t("goal.title_list"), { class: "btn" })
        )
    );
}

function working() {
    return h("div.stack", null, card(h("p.muted", { text: t("common.loading") })));
}
