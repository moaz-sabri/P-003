// Running an exercise: which question is next, and when it is over.
//
// The session is NOT STORED. This is the clearest case in the app of a rule that
// runs through all of it — nothing derived is written down — and it is possible
// only because an attempt log is enough to rebuild the entire state:
//
//   round  = the highest round number any attempt of this exercise has
//   queued = the items with no attempt in this round
//   repeat = the items whose attempt in this round was wrong
//   passed = everything else
//
// So a tab that dies mid-exercise, a phone that is locked for three days, and a
// reload that happens to land between two clicks all resume at the same place,
// and there is no second copy of the answer key to fall out of step with the
// first. `resumeSession()` is the whole of the restore path: it is called with
// the stored items and the stored attempts on every page load of /exercise.
//
// The other consequence is the loop: a wrong answer does not end the question, it
// puts it at the back of the queue for another round. The exercise is finished
// when the queue is empty AND nothing is waiting to repeat — which means an
// exercise ends at 100% on its last pass and not at 80% on its first.

import { ITEM_KIND } from "./exercise-builder.js";

/** A session, freshly made: one round, everything in the queue. */
export function startSession(items) {
    return { round: 1, queue: items.map((i) => i.id), repeat: [], passed: [] };
}

/**
 * Rebuild the session from what has been stored.
 *
 * @param {{id: string}[]} items  the exercise's items, in their stored order
 * @param {{id: string, itemId: string, round: number, correct: boolean}[]} attempts
 *        every attempt of THIS exercise, in any order
 */
export function resumeSession(items, attempts = []) {
    if (!attempts.length) return startSession(items);

    let round = 1;
    for (const a of attempts) if (a.round > round) round = a.round;

    // THE LATEST ATTEMPT PER ITEM, ACROSS ALL ROUNDS — NOT THE ATTEMPT IN THE
    // CURRENT ROUND.
    //
    // An item answered correctly in round 1 has NO row in round 2, because it is
    // never asked again. Reading only the current round therefore puts every
    // already-passed question back into the queue the moment a round begins: an
    // exercise interrupted in its second round asks again everything the reader
    // already got right, the item count never drops, and the round counter climbs
    // for work that is already done. "Has this item been answered correctly at
    // some point in this exercise" is the only question with a single yes/no
    // answer, and it is what `passed` means.
    const latest = new Map();
    for (const a of attempts) {
        const held = latest.get(a.itemId);
        if (!held || a.round > held.round || (a.round === held.round && a.id > held.id)) {
            latest.set(a.itemId, a);
        }
    }

    // AND THE ROUND AN ATTEMPT BELONGS TO IS WHAT SEPARATES THE QUEUE FROM THE
    // REPEAT. Both hold items whose last answer was wrong, and they mean opposite
    // things:
    //
    //   last answer wrong IN the current round → the reader has just tried it and
    //     it is waiting for the next round: `repeat`.
    //   last answer wrong BEFORE the current round → it is already IN the current
    //     round, waiting to be asked: `queue`.
    //
    // Without that distinction a session in its third round rebuilds as though
    // nothing in it had been asked yet — every item with an old wrong answer lands
    // in `repeat`, the queue comes out empty, and the empty-queue-with-a-repeat
    // rule below bumps the round AGAIN. The reader is back at the start of a round
    // they had already worked through, and the round counter climbs by one per
    // interruption.
    const queue = [];
    const repeat = [];
    const passed = [];
    for (const item of items) {
        const attempt = latest.get(item.id);
        if (!attempt) queue.push(item.id);
        else if (attempt.correct) passed.push(item.id);
        else if (attempt.round < round) queue.push(item.id);
        else repeat.push(item.id);
    }

    // THE ROUND BUMP IS REBUILT HERE, BECAUSE NOTHING IN THE LOG RECORDS IT.
    // `advance` increments the round the moment the last item of a round is
    // answered wrongly, and there is no row for "the round ended" — the attempt
    // that caused it is a round-1 row, correctly labelled. So the log's highest
    // round is one behind at exactly the moment it matters: after the final wrong
    // answer of a round. Rebuilding from it alone gives the old round, an empty
    // queue and one item in `repeat`, which is a session `currentItem` cannot
    // answer — it reads `queue[0]` — on an exercise that `isFinished` correctly
    // says is not over. The page then shows an exercise with nothing on it and no
    // way forward except reloading, which produces the same session again.
    //
    // An empty queue with something waiting to repeat IS the next round; that is
    // precisely the condition `advance` uses to bump, so the two agree by
    // construction rather than by both being remembered.
    if (queue.length === 0 && repeat.length > 0) {
        return { round: round + 1, queue: repeat, repeat: [], passed };
    }
    return { round, queue, repeat, passed };
}

/**
 * Record an answer and return the session after it.
 *
 * @param {{round: number, queue: string[], repeat: string[], passed: string[]}} session
 * @param {{itemId: string, correct: boolean}} answer
 * @returns {{session: object, repeated: boolean, finished: boolean}}
 *   `repeated` is true when this wrong answer has just pushed the exercise into
 *   another round, which the UI uses to say so.
 */
export function advance(session, { itemId, correct }) {
    // AN ANSWER FOR SOMETHING THAT IS NOT ON SCREEN CHANGES NOTHING.
    //
    // A second tap on Next, a click that lands after the page has already moved
    // on, and an event queued before the tab was hidden all arrive here as an
    // answer for an item that is no longer at the head of the queue. Appending it
    // anyway is not a no-op: the id is filtered out of a queue it is not in (so
    // nothing visibly moves) and then PUSHED ONTO repeat or passed, so a reader
    // who got a question right is asked it again immediately afterwards, and two
    // attempt rows are written for one tap. Ignoring it is the only outcome that
    // cannot show up on screen.
    //
    // `queue` is the whole of it, and it covers the round-bump branch too: that
    // branch returns `queue: repeat`, so an item is "not in the queue" in one call
    // and the head of the queue in the next — which is correct, because the bump
    // is what puts the item back on screen. An item waiting in `repeat` is not on
    // screen, so it is not in the queue either, and the one condition is enough.
    if (!session.queue.includes(itemId)) {
        return { session, repeated: false, finished: isFinished(session) };
    }

    const queue = session.queue.filter((id) => id !== itemId);
    const repeat = session.repeat.slice();
    const passed = session.passed.slice();

    if (correct) passed.push(itemId);
    else repeat.push(itemId);

    let round = session.round;
    let repeated = false;
    if (queue.length === 0 && repeat.length > 0) {
        round += 1;
        repeated = true;
        return {
            session: { round, queue: repeat, repeat: [], passed },
            repeated,
            finished: false
        };
    }

    return {
        session: { round, queue, repeat, passed },
        repeated,
        finished: queue.length === 0 && repeat.length === 0
    };
}

/** Whether the exercise is over. Derived, not stored — and the one thing that
 *  has to be true before a single record is stamped `completedAt`.
 *
 *  AN EXERCISE WITH NO ITEMS IS NOT OVER, IT IS UNANSWERABLE. `isFinished({queue:
 *  [], repeat: []})` is true by construction, and that is the right answer to
 *  "is there anything left to ask" — but the reader of this function is the one
 *  that stamps `completedAt`, and an open exercise whose every question was
 *  deleted while it sat there has nothing to ask and must not be recorded as an
 *  exercise that asked zero questions and was passed. `hasItems` is the second
 *  half of the predicate, and it defaults to true so every existing caller keeps
 *  the meaning it had. */
export function isFinished(session, hasItems = true) {
    return hasItems
        && session.queue.length === 0
        && session.repeat.length === 0;
}

/**
 * The numbers the head of the exercise page shows.
 *
 * `remaining` counts the queue AND the repeat, because an item waiting for
 * round 3 is still a question the reader has not answered right. Counting only
 * the queue would show "0 left" with four wrong answers still pending, and then
 * keep the page open.
 */
export function progress(session, total) {
    const done = session.queue.length === 0 && session.repeat.length === 0
        ? total
        : total - session.queue.length - session.repeat.length;
    return {
        round: session.round,
        remaining: session.queue.length + session.repeat.length,
        done,
        total,
        percent: total === 0 ? 0 : Math.round((done / total) * 100)
    };
}

/** The item the reader should answer now: the head of the queue. */
export function currentItem(session, items) {
    const id = session.queue[0];
    if (id === undefined) return null;
    return items.find((i) => i.id === id) ?? null;
}

/** How many of the wrong answers so far were new material rather than review —
 *  the number the result page shows next to "you got the new ones right".
 *
 *  COUNTED PER ITEM, NOT PER ROW. An exercise of five new items where two were
 *  answered wrongly and then correctly produces seven attempt rows for five
 *  questions, and counting rows said "7 new questions" on a page whose exercise
 *  asked five — so the two figures on screen (5 items, 7 new) could not both be
 *  right and neither had a way to be checked. Every item is counted once, on its
 *  LAST attempt, which is the same "latest wins" rule the session itself is
 *  rebuilt by: an item answered wrongly and then rightly is an item the reader
 *  got right.
 *
 *  `firstCorrect` / `firstTotal` are the round-one figures, and they are counted
 *  from the row for round 1 rather than derived from the last one, because "what
 *  did you get right the first time" is a different question from "what did you
 *  end up knowing" and the result page has to be able to answer both. */
export function countKinds(items, attempts) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const out = {
        new: 0, review: 0, newCorrect: 0, reviewCorrect: 0,
        firstTotal: 0, firstCorrect: 0
    };

    const lastByItem = new Map();
    for (const a of attempts) {
        const held = lastByItem.get(a.itemId);
        if (!held || a.round > held.round || (a.round === held.round && a.id > held.id)) {
            lastByItem.set(a.itemId, a);
        }
    }

    for (const item of items) {
        const final = lastByItem.get(item.id);
        if (!final) continue;
        if (item.kind !== ITEM_KIND.NEW) {
            out.review += 1;
            if (final.correct) out.reviewCorrect += 1;
        } else {
            out.new += 1;
            if (final.correct) out.newCorrect += 1;
        }
    }

    // Round 1, one row per item — the exercise cannot ask an item twice in a
    // round, so counting the rows of round 1 IS counting the questions of round 1.
    for (const a of attempts) {
        if (a.round !== 1) continue;
        out.firstTotal += 1;
        if (a.correct) out.firstCorrect += 1;
    }

    return out;
}

/**
 * What the reader got right the FIRST time, and what they had to be shown again.
 *
 * These are the two numbers a report about repetition is actually about, and they
 * are not the accuracy over every tap: a question answered wrongly three times and
 * then correctly is one that was not learned, and averaging all five taps hides
 * exactly the thing the exercise was built to find.
 *
 * @param {{id: string}[]} items
 * @param {{itemId: string, round: number, correct: boolean, id: string}[]} attempts
 */
export function firstPass(items, attempts) {
    const itemIds = new Set(items.map((i) => i.id));
    const first = new Map();
    for (const a of attempts) {
        if (!itemIds.has(a.itemId)) continue;
        if (a.round !== 1) continue;
        const held = first.get(a.itemId);
        if (!held || a.id > held.id) first.set(a.itemId, a);
    }

    // The first-ATTEMPT total is the number of items that were ever asked, not the
    // number of round-one rows: an exercise abandoned before the last question has
    // a smaller first-attempt total than it has items, and reporting the full item
    // count as the denominator would score the reader on a question they never
    // saw.
    const asked = first.size;
    const correctOnFirst = [...first.values()].filter((a) => a.correct).length;
    const reasks = attempts.length - asked;

    return {
        asked,
        correct: correctOnFirst,
        wrong: asked - correctOnFirst,
        reasks: Math.max(0, reasks),
        percent: asked === 0 ? 100 : Math.round((correctOnFirst / asked) * 100),
        // The ids of the items whose first answer was wrong, in the order they were
        // first asked. The result page turns these into "here is what you got
        // wrong, and here is the right answer", which is the one part of a report
        // that is worth writing anything at all for.
        wrongItemIds: [...first.entries()]
            .filter(([, a]) => !a.correct)
            .sort((a, b) => (a[1].answeredAt - b[1].answeredAt) || (a[1].id < b[1].id ? -1 : 1))
            .map(([itemId]) => itemId)
    };
}