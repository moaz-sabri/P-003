// The result page: what just happened, and what to do next.
//
// Everything on it is DERIVED from records that already exist — the attempt log for
// the score, the exercise record for when it finished — and nothing here is written.
// That is not asceticism: a "result" record would be a fifth copy of an answer, and
// the app's whole design is that the attempt log is the answer. `summaryFor()` in
// session-service.js is where those numbers are put together; this page only arranges
// them.
//
// IT IS ABOUT AN EXERCISE, NAMED IN THE PATH. It used to be `/exercise/result?id=x` with
// a `?goal=` fallback, and it could be reached with no id at all — in which case it
// guessed the newest finished exercise of the newest active goal. That guess is the same
// "silently pick a goal" behaviour the rest of this restructure removed: a result
// belongs to one sitting, and the sitting belongs to a goal, and both of those are in
// the records. A reader who opens the result page is asking about a session they just
// did; asking them to have found it is not a thing a page should do.
//
// THE "WHAT NEXT" LINE IS TWO BUTTONS, and they are the whole point of the page. A
// finished exercise used to end with a countdown to the next unlock, tied to an
// interval and a plan length that no longer exist. Now the plan is a fixed ten new
// plus a review of the last three, and the only thing that can be between the reader
// and the next sitting is the rate cap — so the page says "ready when you are" and
// offers Continue (start the next exercise now) or Stop (back to the goal). No dates,
// no clock, no "come back on the 14th".

import { h, statRow, stat, link, emptyState, meter } from "../dom.js";
import { head, section, card } from "../page.js";
import * as toast from "../toast.js";
import { t, formatPercent, formatStopwatch } from "../../i18n/i18n.js";
import * as sessions from "../../services/session-service.js";
import { getGoal } from "../../services/goal-service.js";
import { go } from "../../app/router.js";
import { setCurrentGoal } from "../nav.js";
import { exerciseHref } from "../parts/goal-actions.js";

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

    const node = page(summary, goal);
    return { node };
}

function page(summary, goal) {
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

    node.appendChild(section("result.next_heading", nextCard(summary, goal)));

    // DONE LEADS ON HERE. The Continue/Stop decision lives in `nextCard` above, where it
    // belongs to the exercise that was just finished; this row is the shelf below it —
    // "run the same questions again" and the report — and the only navigation that is
    // the same no matter what the goal's state is.
    node.appendChild(h("div.btn-row", null,
        repeatButton(summary.exercise),
        link(`/reports?goal=${encodeURIComponent(summary.exercise.goalId)}`, t("result.reports_button"), { class: "btn btn-secondary" })
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

/**
 * The end of an exercise: what the reader does from here.
 *
 * Two answers, and the goal's state is the only thing between them. A goal that has
 * been closed or archived — here or on another device since this exercise was
 * finished — has no next exercise, so the only action worth offering is the one that
 * starts a new goal. Every other goal is ready when the reader is, because the plan
 * is fixed and nothing between exercises but the rate cap counts down; there is no
 * date to report and no reason to wait.
 */
function nextCard(summary, goal) {
    if (!goal || goal.status === "completed" || goal.archivedAt) {
        return card(
            h("p", { text: goal?.archivedAt ? t("goal.archived_body") : t("goal.finished_body") }),
            link("/goal", t("home.create_goal"), { class: "btn btn-block" })
        );
    }

    // READY WHEN YOU ARE. There used to be a third branch here that counted down to the
    // next unlock and, when there was none, offered only the goal page; both are gone
    // with the interval. Start the next exercise (Continue) or go to the goal (Stop) —
    // `sessions.start` refuses on the rate cap with its own message, so this page does
    // not have to know the cap's date.
    return card(
        h("p", { text: t("result.next_now") }),
        h("div.btn-row", null,
            continueButton(summary.exercise.goalId),
            link(`/goal/${encodeURIComponent(summary.exercise.goalId)}`, t("result.stop_button"), { class: "btn btn-secondary" })
        )
    );
}

/** Continue: build and open the next exercise of the same goal, now. */
function continueButton(goalId) {
    return h("button.btn.btn-primary", {
        type: "button",
        onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                const { exercise } = await sessions.start({ goalId });
                go(exerciseHref(exercise.id));
            } catch (err) {
                button.disabled = false;
                toast.error(err);
            }
        }
    }, t("result.continue_button"));
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