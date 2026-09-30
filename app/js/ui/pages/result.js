// The result page: what just happened, and when the next one opens.
//
// Everything on it is DERIVED from records that already exist — the attempt log
// for the score, the exercise record for when it finished, the goal for the
// interval — and nothing here is written. That is not asceticism: a "result"
// record would be a fifth copy of an answer, and the app's whole design is that
// the attempt log is the answer. `summaryFor()` in exercise-service.js is where
// those numbers are put together; this page only arranges them.
//
// The one thing it does that the home page does not is show the NEXT unlock, and
// it shows it as a live countdown for the same reason the home page does: a
// number computed when the page opened goes stale within the hour, and a stale
// "opens in 4 hours" is worse than no countdown at all. The interval is half a
// minute rather than a second — the answer changes in minutes, and nothing on
// this screen is worth waking a phone for more often than that.

import { h, statRow, stat, link, emptyState, meter } from "../dom.js";
import { head, section, card } from "../page.js";
import { t, formatPercent, formatCountdown, formatStopwatch } from "../../i18n/i18n.js";
import * as exercises from "../../services/exercise-service.js";
import { getActiveGoal } from "../../services/goal-service.js";
import { go } from "../../app/router.js";
import { remaining } from "../../domain/time.js";

export async function render({ query }) {
    const id = query.get("id");
    const exercise = id ? await exercises.findExercise(id) : await exercises.lastFinished();

    if (!exercise) return { node: nothingToShow() };

    // A result for an exercise that is still open is not a result. Somebody who
    // taps the nav item while an exercise is half answered is sent back to it
    // rather than shown a score for a session that has not ended.
    if (!exercise.completedAt) {
        go(`/exercise?id=${encodeURIComponent(exercise.id)}`);
        return { node: working() };
    }

    const [summary, goal] = await Promise.all([exercises.summaryFor(exercise), getActiveGoal()]);

    // The timer is created by the card that needs it and collected here, because
    // `destroy` is the only reliable place an interval can be cleared from: there
    // is no unload a page can count on, and an interval left running keeps
    // painting a node that is no longer in the document.
    const timers = [];
    const node = page(summary, goal, timers);
    return { node, destroy: () => { for (const timer of timers) clearInterval(timer); } };
}

function page(summary, goal, timers) {
    const node = h("div.stack", null);
    node.appendChild(head("result.title", null));

    node.appendChild(card(
        statRow(
            // The score is the FIRST-ATTEMPT figure, and the label says so. It used
            // to be the share of correct taps across every round, which is a
            // different claim: a question the reader was shown five times until it
            // stuck contributes five taps and one error, and a question they knew
            // first time contributes one tap and no errors — so the old number
            // moved DOWN as the reader answered more, which is not what a score
            // is for.
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
        // Three figures, then a sentence rather than a second row of tiles. The
        // counts below the bar — how many questions, how many wrong, how many had
        // to be shown again — are one idea, and they read as one when written as
        // one; as a second grid they had to be laid out for a different width than
        // the first one and produced a half-width tile of their own.
        h("p.small.muted", {
            style: { "margin-top": "var(--space-3)" },
            text: t("result.counts_line", {
                questions: summary.total,
                wrong: summary.wrong,
                reasks: summary.reasks
            })
        })
    ));

    // The one part of a report worth writing anything for: what was wrong, and
    // what the right answer was. Bounded at ten because a page of forty identical
    // "you got these wrong" rows is a list, not a report — the count above is
    // already the honest total, and the goal page carries the rest.
    if (summary.wrongItems.length) {
        node.appendChild(section("result.wrong_heading", wrongCard(summary)));
    }

    node.appendChild(section("result.next_heading", nextCard(summary, goal, timers)));

    node.appendChild(h("div.btn-row", null,
        link("/", t("result.done_button"), { class: "btn" }),
        link("/reports", t("result.reports_button"), { class: "btn btn-secondary" })
    ));

    return node;
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
            ? h("p.small.muted", { text: t("result.wrong_more", { n: summary.wrongItems.length - rows.length }) })
            : null
    );
}

/* -------------------------------- what next -------------------------------- */

function nextCard(summary, goal, timers) {
    // A goal that has been closed — here or on another device since this exercise
    // was finished — has no next exercise, so the only action worth offering is
    // the one that starts a new one. Handled before the countdown because a
    // countdown to an exercise that can never exist is a number that never
    // reaches zero.
    if (!goal || goal.status === "completed") {
        return card(
            h("p", { text: t("goal.finished_body") }),
            link("/goal", t("home.create_goal"), { class: "btn btn-block" })
        );
    }

    // `summaryFor` derives the unlock from the goal's own interval, so a zero here
    // means the goal arrived from a sync with a null one. The page checks rather
    // than trusts, because "opens in " followed by nothing is a sentence with a
    // hole in it and the alternative — believing it — is a permanently locked
    // exercise with no way to find out why.
    if (!summary.nextDueAt || remaining(summary.nextDueAt) === 0) {
        return card(
            h("p", { text: t("result.next_now") }),
            link("/", t("home.start_exercise"), { class: "btn btn-block" })
        );
    }

    const countdown = h("span.nums");
    const paint = () => { countdown.textContent = formatCountdown(remaining(summary.nextDueAt)); };
    paint();
    timers.push(setInterval(paint, 30_000));

    // NO BUTTON HERE. The two branches above each carry the one thing worth doing
    // next — start a new goal, start the exercise — and this branch's action is
    // "go home", which the page already has a button for, directly below. Two
    // controls to the same place on one screen is one too many.
    return card(h("p", null, t("result.next_in"), " ", countdown));
}

/* ------------------------------ nothing to see ----------------------------- */

function nothingToShow() {
    return h("div.stack", null,
        head("result.title", null),
        emptyState(
            t("error.not_found"),
            t("exercise.no_questions"),
            link("/", t("home.create_goal"), { class: "btn" })
        )
    );
}

function working() {
    return h("div.stack", null, card(h("p.muted", { text: t("common.loading") })));
}
