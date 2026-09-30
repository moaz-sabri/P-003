// The exercise page: one question on screen, and the only page with a clock.
//
// Four decisions here that the rest of the app depends on:
//
//   * THE QUESTION IS ASKED FOR FROM THE SESSION, NOT COUNTED UP. `resumeSession`
//     rebuilds the queue from the attempt log and the page asks it for the head
//     of that queue each time it moves on. There is no "question 7 of 12" index
//     held in a variable, which is what makes closing the tab mid-exercise cost
//     nothing: the next visit asks the same question the log says is next.
//     (domain/session-run.js has the reasoning; this is the consequence.)
//
//   * THE QUESTION ON SCREEN IS HELD, NOT RE-DERIVED. After an answer the item
//     has already left the queue, so asking the session for the head again would
//     put the NEXT question under the previous one's verdict — the reader is
//     shown the correct answer to a question that is no longer on screen. The
//     item is therefore remembered until the reader taps Next, which is also
//     where the session is asked for a new one.
//
//   * THE VERDICT IS DRAWN FROM WHAT THE SERVICE DECIDED, never re-derived here.
//     `answer()` compares the taps against the options as they are NOW, writes
//     the attempt, and returns whether it was right. The page shows that. A page
//     that compared for itself would be a second answer key, and the two would
//     differ on exactly the item that has been round twice.
//
//   * NOTHING ADVANCES ON A TIMER. After an answer the page waits for a tap on
//     Next, including on a wrong answer — which is the one case where there is
//     something to read, because the correct options are tinted and a reader who
//     was checking a second answer wants to see which one it was. A time-based
//     advance takes that away from anyone reading it slowly, and a six-option
//     question on a phone is not a hypothetical.
//
// And the leave guard only fires on an UNCONFIRMED TAP. An exercise is
// resumable, so leaving one costs nothing and must not cost a dialog. What would
// be lost is the half-tapped multiple-choice question the reader is about to
// leave behind, and that is the only thing the guard asks about.

import { h, link, emptyState, mount } from "../dom.js";
import { head, card } from "../page.js";
import { confirm } from "../dialog.js";
import * as toast from "../toast.js";
import { t, formatCountdown, formatStopwatch } from "../../i18n/i18n.js";
import { snapshot, SCHEDULE } from "../../services/goal-service.js";
import * as exercises from "../../services/exercise-service.js";
import { currentItem, isFinished, progress as sessionProgress } from "../../domain/session-run.js";
import { go, setLeaveGuard } from "../../app/router.js";
import { remaining } from "../../domain/time.js";

export async function render({ query }) {
    const target = await resolve(query.get("id"));
    if (target.node) return { node: target.node };

    let loaded;
    try {
        loaded = await exercises.load(target.exerciseId);
    } catch (err) {
        if (err?.code === "not_found") return { node: goneMessage() };
        throw err;
    }

    // An exercise whose session is over but whose record is not stamped is the one
    // state this page has to repair for itself: a tab closed between the last
    // answer and the `finish()` write. `finish()` re-checks the session and refuses
    // if it is not actually over, so all that is happening here is the call the
    // button would have made.
    if (isFinished(loaded.session)) {
        if (!loaded.exercise.completedAt) {
            try {
                await exercises.finish(loaded.exercise.id);
            } catch (err) {
                if (err?.code !== "invalid_transition") throw err;
            }
        }
        go(`/exercise/result?id=${encodeURIComponent(loaded.exercise.id)}`);
        return { node: working() };
    }

    return run(loaded);
}

/* ------------------------------ which exercise ---------------------------- */

/**
 * Which exercise this URL means.
 *
 * `/exercise` with no id is the nav bar's "Exercise" destination, so it has to
 * answer "what should I do" rather than "load this one": resume, start, or say
 * why not. The refusals are drawn here rather than left to the home page because
 * the nav item leads here as well, and a destination that opens on an explanation
 * of itself is a destination people stop using.
 */
async function resolve(id) {
    const { goal, questions, plan } = await snapshot();

    if (!goal || goal.status === "completed") {
        return {
            node: emptyState(
                t("home.no_goal_heading"),
                goal ? t("goal.finished_body") : t("home.no_goal_body"),
                link("/goal", t("home.create_goal"), { class: "btn" })
            )
        };
    }

    if (!id) {
        if (plan.state === SCHEDULE.IN_PROGRESS) return { exerciseId: plan.exercise.id };
        if (plan.state === SCHEDULE.WAITING) return { node: waiting(plan) };
        if (!questions.length) return { node: nothingToAsk() };

        const { exercise } = await exercises.start();
        return { exerciseId: exercise.id };
    }

    return { exerciseId: id };
}

function waiting(plan) {
    // Painted once and left alone is the one thing this must not do: a countdown
    // that reads "opens in 1 day" all day is the fastest way to make a reader
    // think the app has stopped counting.
    const countdown = h("span.nums");
    const paint = () => { countdown.textContent = formatCountdown(remaining(plan.dueAt)); };
    paint();

    return h("div.stack", null,
        head("home.next_exercise_heading", null),
        card(
            h("p", null, t("home.locked_body", { time: "" }), " ", countdown),
            link("/", t("nav.home"), { class: "btn btn-block" })
        )
    );
}

function nothingToAsk() {
    return h("div.stack", null,
        head("exercise.title", null),
        emptyState(
            t("home.needs_questions_title"),
            t("exercise.no_questions"),
            link("/questions/new", t("questions.add"), { class: "btn" })
        )
    );
}

function goneMessage() {
    return h("div.stack", null,
        head("exercise.title", null),
        emptyState(
            t("error.not_found"),
            t("exercise.no_questions"),
            link("/", t("nav.home"), { class: "btn" })
        )
    );
}

function working() {
    return h("div.stack", null, card(h("p.muted", { text: t("common.loading") })));
}

/* ---------------------------------- the run -------------------------------- */

function run(loaded) {
    const { items, questions, exercise } = loaded;

    let session = loaded.session;
    let progress = loaded.progress;

    /** The question on screen, held rather than re-asked for. See the header. */
    let item = currentItem(session, items);
    let question = item ? questions.get(item.questionId) : null;

    /** Option ids tapped and not yet submitted. Set equality decides the verdict,
     *  so the order two of them were tapped in cannot change anything. */
    let selected = new Set();

    /** null until an answer has been recorded; then the service's verdict. */
    let verdict = null;

    /* -------------------------------- the head ------------------------------ */

    const progressText = h("span.run-progress");
    const roundText = h("span.small.muted");
    const timerText = h("span.timer");
    const bar = h("div.meter", { role: "presentation" }, h("span"));

    const headerBox = h("div", null,
        h("div.run-head", null,
            h("div.row", { style: { "flex-wrap": "nowrap", gap: "var(--space-2)" } },
                progressText,
                roundText
            ),
            timerText
        ),
        bar
    );

    /* ------------------------------- the body ------------------------------ */

    const questionBox = h("div");
    const verdictBox = h("div");
    const actions = h("div");

    const node = h("div.stack", null, card(headerBox, questionBox, verdictBox, actions));

    // An exercise item whose question was deleted on another device is
    // tombstoned by the sync merge and `load` filters tombstones out, so this
    // cannot normally happen. It is handled anyway because the alternative is a
    // blank screen with a running clock, and a blank screen with a running clock
    // is a hang.
    if (!question) {
        return { node: goneMessage() };
    }

    /* -------------------------------- the clock ---------------------------- */

    // From the exercise's creation, not from this page load. A timer that restarts
    // every time the exercise is opened is a per-visit time, and the result page
    // prints one figure computed from `createdAt` — so a session left open across
    // three days would show three short timers and then report a total none of them
    // added up to. One span, measured the same way on both screens, is the honest
    // version, and an honest large number beats a small one that is wrong.
    const startedAt = exercise.createdAt;
    const paintClock = () => { timerText.textContent = formatStopwatch(Date.now() - startedAt); };
    paintClock();
    const clock = setInterval(paintClock, 1000);

    /* -------------------------------- drawing ------------------------------ */

    function draw() {
        progressText.textContent = t("exercise.progress_label", {
            done: progress.done, total: progress.total
        });
        // Round 1 is the default and is not announced. Only a repeat round is,
        // because "round 3" is what tells a reader that two questions have already
        // been asked twice and this one is the third try.
        roundText.textContent = session.round > 1
            ? t("exercise.round_label", { round: session.round })
            : "";
        bar.style.setProperty("--fill", `${progress.percent}%`);

        mount(questionBox,
            h("h2.question-text", { text: question.text }),
            h("div.options", null, question.options.map(optionButton))
        );

        if (verdict) {
            paintTints();
            mount(verdictBox, h("div.verdict", {
                dataset: { state: verdict.correct ? "correct" : "wrong" }
            }, t(verdict.correct ? "exercise.correct" : "exercise.wrong")));
        } else {
            mount(verdictBox, h("p.small.muted", {
                style: { "margin-top": "var(--space-3)" },
                text: question.kind === "multiple" ? t("exercise.tap_multiple") : t("exercise.tap_single")
            }));
        }

        mount(actions, actionButton());
    }

    /* -------------------------------- options ------------------------------ */

    function optionButton(option) {
        const pressed = selected.has(option.id) || (verdict ? verdict.correctIds.includes(option.id) : false);
        return h("button.option", {
            type: "button",
            "data-kind": question.kind,
            "aria-pressed": pressed ? "true" : "false",
            disabled: Boolean(verdict),
            onclick: (event) => choose(option, event.currentTarget)
        },
        h("span.option-mark", { text: pressed ? "✓" : "" }),
        h("span.grow", { text: option.text })
        );
    }

    /** Mark which options were right, and which of the reader's taps were not. */
    function paintTints() {
        const buttons = questionBox.querySelectorAll(".option");
        const chosen = verdict.attempt.selected;
        question.options.forEach((option, index) => {
            const button = buttons[index];
            if (!button) return;
            if (verdict.correctIds.includes(option.id)) {
                button.dataset.state = "correct";
                button.dataset.flash = "correct";
            } else if (chosen.includes(option.id)) {
                button.dataset.state = "wrong";
                button.dataset.flash = "wrong";
            }
        });
    }

    function choose(option, button) {
        if (verdict) return;

        if (question.kind === "single") {
            // A single-choice question submits on the tap. A Confirm button after
            // the reader has already said which one they mean adds a tap to the
            // most common event in the app and can only ever be wrong in the
            // direction of being slower.
            submit([option.id]);
            return;
        }

        if (selected.has(option.id)) selected.delete(option.id);
        else selected.add(option.id);

        const on = selected.has(option.id);
        button.setAttribute("aria-pressed", on ? "true" : "false");
        button.querySelector(".option-mark").textContent = on ? "✓" : "";
        mount(actions, actionButton());
    }

    /* -------------------------------- actions ------------------------------ */

    function actionButton() {
        if (verdict) {
            return h("button.btn.btn-block", {
                type: "button",
                style: { "margin-top": "var(--space-4)" },
                onclick: next
            }, t("common.next"));
        }
        if (question.kind !== "multiple") return null;
        return h("button.btn.btn-block", {
            type: "button",
            style: { "margin-top": "var(--space-4)" },
            // Disabled with nothing selected rather than refusing on press: the
            // rule is then visible in the button's own state, and a reader who
            // taps a greyed-out button learns nothing it had not already said.
            disabled: selected.size === 0,
            "aria-disabled": selected.size === 0 ? "true" : null,
            onclick: () => submit([...selected])
        }, t("exercise.confirm"));
    }

    /* ------------------------------ answering ------------------------------ */

    async function submit(chosen) {
        if (verdict) return;

        for (const button of questionBox.querySelectorAll(".option")) button.disabled = true;
        try {
            const answer = await exercises.answer(exercise.id, item, chosen, session.round);
            verdict = answer;
            session = answer.session;
            // The one place the session's own arithmetic is asked for. Not
            // recomputed here, because "how many are left" has to be the answer
            // the next question is drawn from or the two disagree.
            progress = sessionProgress(session, progress.total);
            selected = new Set();
        } catch (err) {
            // Unlocked rather than left disabled: the attempt was not recorded, so
            // the reader's taps are still the answer to a question nobody has
            // graded, and a screen they cannot touch is a dead end.
            for (const button of questionBox.querySelectorAll(".option")) button.disabled = false;
            toast.error(err);
        }
        draw();
    }

    async function next() {
        verdict = null;
        if (isFinished(session)) {
            clearInterval(clock);
            go(`/exercise/result?id=${encodeURIComponent(exercise.id)}`);
            return;
        }
        item = currentItem(session, items);
        question = item ? questions.get(item.questionId) : null;
        if (!question) {
            clearInterval(clock);
            go("/");
            return;
        }
        draw();
    }

    /* ------------------------------ the guard ------------------------------ */

    // Registered once, closing over the two variables that decide whether there is
    // anything to ask about. A guard registered per redraw would be a second
    // source of truth for the same two facts.
    setLeaveGuard(async () => {
        if (verdict || selected.size === 0) return true;
        return confirm({
            titleKey: "exercise.leaving_title",
            bodyKey: "exercise.leaving_body",
            yesKey: "exercise.leaving_leave",
            noKey: "exercise.leaving_stay"
        });
    });

    draw();

    return {
        node,
        destroy() {
            clearInterval(clock);
            // Cleared rather than left to the router: the router nulls the guard
            // when a move it accepted happens, and a page reached any other way —
            // a bookmark, a fresh tab, a reload — never goes through that path.
            setLeaveGuard(null);
        }
    };
}
