// Reports.
//
// One page, one read of the attempt log, and nothing derived on the way out that the
// domain layer has not already decided. That is why this file is short: the whole of
// "what is sticking and what is not" is `summarize()` plus two lists from
// domain/stats.js, and the temptation in a reports page is always to compute one more
// thing here — a streak, an average, a best day — which is a rule that then exists in
// two places and drifts.
//
// The one scoping decision here is the interesting one, and it is not "this goal's
// questions" any more.
//
// A GOAL'S REPORT IS ABOUT THE GOAL'S OWN SESSIONS. Its accuracy, its answer count
// and its dates come from the attempts of the sessions that goal started, and the
// sessions it has are still indexed by `goalId` — a session belongs to the plan that
// produced it even though its questions do not belong to that plan.
//
// Its PROGRESS is about the material the goal draws on, which is a join through the
// references. The two are different sets and conflating them produced a real bug: a
// report whose "needs work" list was correctly scoped to this goal while its accuracy
// figure counted every goal that came before it, on one screen, with no way for a
// reader to tell which half was wrong.

import { summarize, dailyActivity, weakest, latestAttempt } from "../domain/stats.js";
import { getGoal } from "../data/repo-goals.js";
import { listQuestions } from "../data/repo-questions.js";
import { listExercises, listAllAttempts } from "../data/repo-sessions.js";
import { questionsFor } from "./goal-content-service.js";

/** How many days the activity bars cover. Fourteen is the most that stays
 *  legible at 320px with a bar per day, and it is long enough that a fortnight of
 *  nothing is visibly nothing. */
export const ACTIVITY_DAYS = 14;

/** The reports page's data, or null when there is no goal to report on.
 *
 *  `goalId` is what makes this work with several goals: omitted it is the newest
 *  active one, which is what the nav bar means when it does not carry a goal, and
 *  named it is the goal the reader was just looking at. Without the parameter every
 *  report on a device with three goals was about whichever happened to be newest. */
export async function build(goalId = null) {
    const goal = goalId ? await getGoal(goalId) : await (await import("./goal-service.js")).getActiveGoal();
    if (!goal) return null;
    if (goal.deletedAt) return null;

    const [exercises, questions, attempts] = await Promise.all([
        listExercises(goal.id),
        // THE MATERIAL, through the join. A count of rows the goal used to own is
        // not available and not reconstructible, which is the honest consequence of
        // questions not belonging to goals: what a goal's report says about coverage
        // is about what it was drawing on.
        questionsFor(goal.id),
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
 * disagree about what the reader has done — which is the symptom of each page having
 * its own count. */
export async function progressFor(goal) {
    const [exercises, questions, attempts] = await Promise.all([
        listExercises(goal.id),
        questionsFor(goal.id),
        listAllAttempts()
    ]);
    return summarize({ goal, exercises, questions, attempts });
}

/** Every question on the device with its own state, for the reports page's
 *  device-wide view. Not the same as `questionsFor(goalId)`: a reader asking "how
 *  much of my material have I learned" is asking about all of it, and the answer
 *  must not change because they happen to be looking at one goal's page. */
export async function overall() {
    const questions = await listQuestions();
    const attempts = await listAllAttempts();
    return summarize({ goal: null, exercises: [], questions, attempts });
}

export { latestAttempt };
