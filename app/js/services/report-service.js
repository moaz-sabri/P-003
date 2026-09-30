// Reports.
//
// One page, one read of the attempt log, and nothing derived on the way out that
// the domain layer has not already decided. That is why this file is short: the
// whole of "what is sticking and what is not" is `summarize()` plus two lists
// from domain/stats.js, and the temptation in a reports page is always to compute
// one more thing here — a streak, an average, a best day — which is a rule that
// then exists in two places and drifts.

import { summarize, dailyActivity, weakest } from "../domain/stats.js";
import { latestAttempt } from "../domain/stats.js";
import { getGoal, listExercises, listQuestions, listAllAttempts } from "../data/repos.js";

/** How many days the activity bars cover. Fourteen is the most that stays
 *  legible at 320px with a bar per day, and it is long enough that a fortnight of
 *  nothing is visibly nothing. */
export const ACTIVITY_DAYS = 14;

/** The reports page's data, or null when there is no goal to report on. */
export async function build(goalId = null) {
    const goal = goalId ? await getGoal(goalId) : await (await import("./goal-service.js")).getActiveGoal();
    if (!goal) return null;

    const [exercises, questions, attempts] = await Promise.all([
        listExercises(goal.id),
        listQuestions(goal.id),
        listAllAttempts()
    ]);

    const summary = summarize({ goal, exercises, questions, attempts });

    // The questions the "needs work" list refers to, keyed by id. A weak row is a
    // question the reader might tap to open — and the tap has to work even if the
    // question was deleted a moment ago on another device, so the page checks.
    const text = new Map(questions.map((q) => [q.id, q.text]));

    return {
        ...summary,
        activity: dailyActivity(attempts, ACTIVITY_DAYS),
        weak: weakest(questions, attempts, 10).map((row) => ({
            ...row,
            text: text.get(row.questionId) ?? "",
            percent: row.total === 0 ? 0 : Math.round((row.correct / row.total) * 100)
        }))
    };
}

/** The home page's smaller version of the same read, so that the two can never
 *  disagree about what the reader has done — which is the symptom of each page
 *  having its own count. */
export async function progressFor(goal) {
    const [exercises, questions, attempts] = await Promise.all([
        listExercises(goal.id),
        listQuestions(goal.id),
        listAllAttempts()
    ]);
    return summarize({ goal, exercises, questions, attempts });
}

export { latestAttempt };