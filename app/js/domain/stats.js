// Everything the app is willing to tell you, computed from the attempt log.
//
// One function in here reads the whole log and turns it into the map the rest of
// the app asks questions of: `latestAttempt`. The "latest wins" rule lives here
// and not at each call site because there is exactly one of it, and getting it
// wrong in one place means a question looks learned on one screen and unlearned
// on another — which for a flashcard app is the difference between the right
// question coming back and never coming back.
//
// Attempts are never edited and never deleted, so "latest" is a maximum over the
// log rather than a stored field. A stored "is this question learned" flag would
// have to be maintained by every write that touches an attempt, including the
// sync merge, and the merge is exactly where a flag gets out of step.

import { dayKey, dayRange } from "./time.js";
import { classifyQuestions } from "./exercise-builder.js";

/**
 * question id → the most recent attempt on that question.
 *
 * Ties are broken by id rather than by arrival order. Two devices offline in the
 * same second produce two attempts with the same timestamp, and IndexedDB hands
 * them back in key order — which is stable, but only because the ids sort the
 * same way on both devices. Relying on that is relying on an accident, so the
 * tie-break is written down.
 *
 * @param {{questionId: string, answeredAt: number, id: string}[]} attempts
 * @returns {Map<string, object>}
 */
export function latestAttempt(attempts) {
    const latest = new Map();
    for (const a of attempts) {
        const held = latest.get(a.questionId);
        if (!held || a.answeredAt > held.answeredAt
            || (a.answeredAt === held.answeredAt && a.id > held.id)) {
            latest.set(a.questionId, a);
        }
    }
    return latest;
}

/* ------------------------------ progress --------------------------------- */

/**
 * How far through its questions a goal is.
 *
 * `percent` IS OVER EVERY QUESTION IN THE GOAL, not over the ones the reader has
 * been shown. The page draws this beside "12 / 40", so a denominator of "the ones
 * I have seen" put a 100% meter next to the number 12 and asked the reader to
 * reconcile them — and worse, the meter then MOVED BACKWARDS: answering a question
 * wrongly took it out of `learned` and into `review`, which raised the seen count
 * and lowered the percentage, so doing more work made the goal look less finished.
 *
 * Two different questions are still both available here, because the goal page
 * wants both: `percent` is "how much of my material have I learned", and
 * `accuracy` over the attempt log is "how have I been doing". A question the
 * reader has not been shown counts as not learned, which is the honest answer —
 * nobody has established that they know it.
 */
export function progress(questions, history) {
    const { fresh, review, learned } = classifyQuestions(questions, history);
    const total = questions.length;
    const seen = review.length + learned.length;
    return {
        total,
        fresh: fresh.length,
        review: review.length,
        learned: learned.length,
        seen,
        percent: total === 0 ? 0 : Math.round((learned.length / total) * 100),
        // Of what they HAVE been shown, how much stuck. Kept beside the goal-wide
        // figure because the two answer different questions and the reports page
        // wants this one: a goal at 30% overall can still be at 90% on everything
        // it has actually asked.
        seenPercent: seen === 0 ? 0 : Math.round((learned.length / seen) * 100)
    };
}

/* ------------------------------ accuracy --------------------------------- */

/** Right answers over answers. Not over items: a question answered wrong twice
 *  and right once is two answers and one of them wrong, and averaging per item
 *  would let a reader finish an exercise at 100% while half their taps were
 *  misses. */
export function accuracy(attempts) {
    const total = attempts.length;
    const correct = attempts.reduce((n, a) => n + (a.correct ? 1 : 0), 0);
    return { total, correct, wrong: total - correct, percent: total === 0 ? 0 : Math.round((correct / total) * 100) };
}

/* ------------------------------- history --------------------------------- */

/** One bar per day, oldest first, for the last `days` days. Days with no
 *  attempts are present and zero: a gap in the bars is information (the app was
 *  not opened), and a series that skipped them would draw a straight line across
 *  a fortnight in which nothing happened. */
export function dailyActivity(attempts, days, now = Date.now()) {
    const keys = dayRange(now, days);
    const byDay = new Map(keys.map((k) => [k, { key: k, total: 0, correct: 0 }]));
    for (const a of attempts) {
        const bucket = byDay.get(dayKey(a.answeredAt));
        if (!bucket) continue;   // older than the window
        bucket.total += 1;
        if (a.correct) bucket.correct += 1;
    }
    return keys.map((k) => byDay.get(k));
}

/**
 * The questions that have not stuck: answered wrongly at least once, worst rate
 * first, and most recently missed first among equals.
 *
 * ONLY QUESTIONS THAT HAVE BEEN MISSED. A question the reader has never been asked
 * is not "weak", it is unstarted, and one answered five times out of five is the
 * opposite of weak — and both used to be in this list, which made a heading that
 * says what the list is for into a list of things that are not that. A goal whose
 * material is all learned now returns nothing here, and "nothing needs work" is the
 * true and useful answer; the questions still to be WRITTEN are the ones the goal's
 * "New" count already counts.
 *
 * Attempts for questions this list does not contain are DROPPED, not summed:
 * building a row from the attempt alone means a question deleted by a sync
 * tombstone keeps a row here for ever — it is not in `questions`, so nothing else
 * removes it, and it cannot be answered again to push it back down.
 */
export function weakest(questions, attempts, limit = 10) {
    const known = new Set(questions.map((q) => q.id));
    const byQuestion = new Map();

    for (const a of attempts) {
        if (!known.has(a.questionId)) continue;
        let row = byQuestion.get(a.questionId);
        if (!row) {
            row = { questionId: a.questionId, total: 0, correct: 0, lastAt: 0, lastWrongAt: 0 };
            byQuestion.set(a.questionId, row);
        }
        row.total += 1;
        if (a.correct) row.correct += 1;
        if (a.answeredAt > row.lastAt) row.lastAt = a.answeredAt;
        if (!a.correct && a.answeredAt > row.lastWrongAt) row.lastWrongAt = a.answeredAt;
    }

    return [...byQuestion.values()]
        .filter((row) => row.correct < row.total)
        .sort((a, b) => {
            const rateA = a.correct / a.total;
            const rateB = b.correct / b.total;
            // Worst rate first; then the most recently missed, so a question that
            // was wrong this morning is above one that was wrong in March; then the
            // id, so two devices merge the same list in the same order.
            return (rateA - rateB)
                || (b.lastWrongAt - a.lastWrongAt)
                || (a.questionId < b.questionId ? -1 : 1);
        })
        .slice(0, limit);
}

/* ------------------------------- summary --------------------------------- */

/**
 * The one call the home page and the report page both make.
 *
 * ATTEMPTS ARE SCOPED TO THIS GOAL. Both `goal` and `exercises` arrive as
 * parameters and the goal's own exercises are right there in `exercises`, so
 * "which answers belong to this goal" is answerable without a guess — and it has
 * to be answered, because both callers hand in the whole attempt log of the
 * device. Without the filter a goal created last week reported the accuracy and
 * the answer count of every goal that came before it, on a page whose "needs
 * work" list was correctly scoped to this goal alone: two figures about the same
 * goal, counting different things, on one screen.
 *
 * @param {{goal: object|null, exercises: object[], questions: object[],
 *          attempts: object[], now?: number}} input
 */
export function summarize({ goal, exercises = [], questions = [], attempts = [], now = Date.now() }) {
    const live = questions.filter((q) => !q.deletedAt);
    const doneExercises = exercises.filter((e) => !e.deletedAt && e.completedAt);
    const liveExercises = exercises.filter((e) => !e.deletedAt);

    // The exercise ids this goal owns, and only those. An attempt of an exercise
    // that was deleted is dropped rather than counted, so a question somebody
    // removed last month does not keep answering for a goal it is no longer part
    // of — and an attempt whose exercise id is not in this list at all belongs to
    // another goal, whatever it says on the row.
    const owned = new Set(liveExercises.map((e) => e.id));
    const mine = attempts.filter((a) => !a.deletedAt && owned.has(a.exerciseId));
    const history = latestAttempt(mine);

    // FIRST AND LAST ANSWER, OVER THE SAME ROWS AS THE ACCURACY BELOW AND NOT OVER
    // `attempts`. These two dates are printed beside the accuracy figure; a first
    // answer taken from a tombstoned attempt dates the reader's history to a
    // question that has since been deleted, and a last one taken from one says
    // they were working yesterday about something that no longer exists.
    //
    // AND THE EMPTY CASE IS `null`, NOT 0. The reduce starts at `Infinity` so the
    // comparison inside it is a comparison; testing the RESULT for `Infinity` only
    // works if the empty list keeps that initial value, and the empty list here is
    // short-circuited to 0 further down. `0` is a real timestamp — midnight on 1
    // January 1970 — and a report that opens with it is a report showing a date
    // fifty-six years before the reader was born.
    const first = mine.length
        ? mine.reduce((min, a) => (a.answeredAt < min ? a.answeredAt : min), Infinity)
        : null;
    const last = mine.length
        ? mine.reduce((max, a) => (a.answeredAt > max ? a.answeredAt : max), 0)
        : null;

    return {
        goal,
        progress: progress(live, history),
        accuracy: accuracy(mine),
        exercises: {
            total: liveExercises.length,
            completed: doneExercises.length,
            lastAt: last ?? null
        },
        streakFree: { firstAnswerAt: first, lastAnswerAt: last ?? null },
        weakest: weakest(live, mine)
    };
}