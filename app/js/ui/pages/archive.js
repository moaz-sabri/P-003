// The archive: the goals the reader has put away.
//
// A PAGE, AND NOT A FILTER ON THE GOAL LIST, because "put away" and "finished" are
// different things and a reader who archived four goals over two years has to be
// able to find the third one. Archiving writes `archivedAt` and changes nothing
// else — every question, every group, every exercise and every attempt stays exactly
// where it was — so an archived goal answers every report it answered before, and
// this page says so with a link rather than a paragraph promising it.
//
// The rows are NOT hidden behind a "show archived" toggle. A toggle is a page
// nobody opens twice, and the whole point of archiving is that a goal the reader
// chose to file away is still findable: they archived it because they were not
// working on it this month, not because they wanted it gone.

import { h, link, emptyState, stat } from "../dom.js";
import { head, card } from "../page.js";
import { t, formatDate, formatPercent } from "../../i18n/i18n.js";
import { archivedGoals } from "../../services/goal-service.js";
import { progressFor } from "../../services/report-service.js";
import { setCurrentGoal } from "../nav.js";

export async function render() {
    // The nav bar must not keep pointing at a goal this page is not about: a reader
    // who archives something and then taps Exercise from here should be offered a
    // choice rather than silently resuming the goal they were looking at an hour ago.
    setCurrentGoal(null);

    const rows = await archivedGoals();

    if (!rows.length) {
        return {
            node: h("div.stack", null,
                head("archive.title", "archive.subtitle"),
                emptyState(
                    t("archive.empty_heading"),
                    t("archive.empty_body"),
                    link("/goal", t("home.create_goal"), { class: "btn" })
                )
            )
        };
    }

    const node = h("div.stack", null);
    node.appendChild(head("archive.title", "archive.subtitle"));

    for (const row of rows) {
        node.appendChild(await rowFor(row));
    }

    return { node };
}

async function rowFor(row) {
    const { goal, exercises, completed, questions } = row;

    // The report is read here so the row can show what the goal actually achieved,
    // which is the thing a reader opening an archive wants and the one thing an
    // archive of titles cannot tell them. It is the same `progressFor` the home
    // page uses, so the two cannot count differently.
    const summary = await progressFor(goal);

    return h("div.card", null,
        h("div.row-between", { style: { "gap": "var(--space-3)" } },
            h("div.grow", null,
                link(`/goal/${encodeURIComponent(goal.id)}`, goal.title),
                goal.description ? h("p.small.muted", { text: goal.description }) : null,
                h("p.small.muted", {
                    text: `${t("archive.row_dates", {
                        from: formatDate(goal.createdAt),
                        to: formatDate(goal.completedAt ?? goal.archivedAt ?? Date.now())
                    })}`
                })
            )
        ),

        h("div.row", { style: { "margin-top": "var(--space-3)", "gap": "var(--space-4)" } },
            stat(String(questions), t("home.stat_questions")),
            stat(String(completed), t("home.stat_exercises")),
            stat(String(summary.progress.learned), t("home.stat_learned")),
            stat(formatPercent(summary.accuracy.percent), t("home.stat_accuracy"))
        ),

        h("p.small.muted", {
            style: { "margin-top": "var(--space-3)" },
            text: t("archive.row_exercises", { done: String(completed), total: String(exercises) })
        }),

        h("div.btn-row", { style: { "margin-top": "var(--space-3)" } },
            link(`/reports?goal=${encodeURIComponent(goal.id)}`, t("archive.report_button"), { class: "btn btn-secondary" }),
            // WHAT THIS GOAL TRAINED ON, and not "its questions". A goal does not own
            // questions, so there is no list of questions that are this goal's — and a
            // link to the whole question list labelled as if there were would send the
            // reader looking for a scope that no longer exists.
            link(`/goal/${encodeURIComponent(goal.id)}/content`, t("archive.questions_button"), { class: "btn btn-secondary" }),
            link(`/goal/${encodeURIComponent(goal.id)}`, t("archive.open_button"), { class: "btn btn-secondary" })
        )
    );
}