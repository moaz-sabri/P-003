// The selection screen: choose what this goal's next exercise should ask, and start it.
//
// THIS SCREEN EXISTS BECAUSE OF ONE SENTENCE: "it is possible to attach a whole group
// to an exercise at once, and it is possible to choose the questions added to it."
//
// Both halves of that were unreachable before it, and unreachable in a way that no
// amount of fixing the data layer would have fixed:
//
//   * A GROUP COULD NOT BE ASSIGNED WHOLE. `start()` accepted `groupIds` and
//     `questionsForGroups()` existed and were tested, and NOTHING anywhere passed a
//     value. The feature was written and never connected to a button.
//   * NAMING INDIVIDUAL QUESTIONS WAS NOT POSSIBLE AT ALL. There was no field for it in
//     the builder, the service or the record -- the plan was the only thing that could
//     decide what an exercise contained, and the plan does not ask.
//
// IT IS UNDER THE GOAL IN THE PATH, not at `/exercise/build?goal=…`. That is the
// structural consequence of an exercise being part of a goal: a selection is a decision
// about a particular goal, so the goal is in the URL rather than in a query the page
// could be opened without. The old page fell back to the newest active goal when the
// query was missing, which is the same "silently pick a goal" behaviour that a nav
// destination called "Exercise" had -- and it is why the builder could offer a reader
// three goals' worth of questions with no indication which plan they were about to feed.
//
// WHAT THE READER CAN CHOOSE FROM IS THE GOAL'S OWN MATERIAL, and only that. The
// question store has no `goalId`, so "the questions of this goal" is a join through
// the reader's own reference rows, and a question the reader has not attached to this
// goal is not offered -- even if it is attached to another goal, and even if it is
// sitting unattached on the device. Starting an exercise from a question this goal
// does not train on would produce a session the goal's own report cannot account for.
//
// THE SCHEDULE IS ASKED BEFORE THE QUESTIONS ARE DRAWN. This page's job is to let a
// reader decide what they want, and whether anything may be built changes which
// questions are worth offering: a goal waiting for its interval or over the rate cap
// cannot start an exercise however well it is chosen, and a full list of tickable
// questions above a button that will refuse is the most expensive kind of wrong page.

import { h, link, emptyState, mount } from "../dom.js";
import { head, card, section } from "../page.js";
import * as toast from "../toast.js";
import { t } from "../../i18n/i18n.js";
import { LIMITS } from "../../domain/validation.js";
import { overview, goalAction } from "../../services/goal-service.js";
import * as groups from "../../services/group-service.js";
import * as questions from "../../services/question-service.js";
import * as sessions from "../../services/session-service.js";
import { go } from "../../app/router.js";
import { setCurrentGoal } from "../nav.js";
import { exerciseHref } from "../parts/goal-actions.js";

export async function render(ctx) {
    const goalId = ctx?.route?.params?.id ?? null;
    const row = goalId ? await overview(goalId) : null;
    if (!row) return { node: notFound() };

    const { goal, plan, quota, open } = row;
    const action = goalAction({ plan, materialCount: row.material.count, open, quota });

    setCurrentGoal(goal.id);

    const backHref = `/goal/${encodeURIComponent(goal.id)}`;

    if (!row.material.count) {
        return { node: nothingToPick(goal, backHref) };
    }

    // The same decision the goal page drew, from the same read. A builder that offered
    // a full list of tickable questions above a button that will refuse is the most
    // expensive kind of wrong page -- it lets the reader do the whole selecting first.
    // `blocked` disables the button rather than drawing a different page, because the
    // reader may well want to have chosen and to be ready when it opens.
    const blocked = !action.action.startsWith("resume");

    // One read of the goal's material, for the rows AND the count. Reading them twice can
    // straddle a sync merge, and the symptom would be a count that disagrees with the
    // rows it is counting -- which on this screen is the one thing a reader cannot work
    // out for themselves.
    //
    // THE STATES COME FROM THE ATTEMPT LOG, SEPARATELY, and that is a correction rather
    // than a duplication. `session-service.questionsFor` is the JOIN -- which questions
    // this goal draws on, with their options -- and it returns raw question records,
    // which have no `state` field because state is derived from the attempt log and is
    // stored nowhere. The row label said `questions.state_undefined` for exactly that
    // reason: the label was written from a field the join does not carry.
    //
    // It is asked of `question-service.statesFor`, which is where the rule already lives,
    // rather than computed here. A second derivation of "new / to review / learned" is
    // two definitions that can disagree, and this one already exists on the question
    // list, on the goal-content picker and on the group page.
    const [material, { states }] = await Promise.all([
        sessions.questionsFor(goal.id),
        questions.statesFor()
    ]);
    const list = material.map((question) => ({ ...question, state: states.get(question.id) ?? "new" }));
    // The groups are the device's shelves, not the goal's -- a group belongs to nobody
    // -- so the chip row is every group there is, and the counts on them come from the
    // rows below rather than from the group records. A group this goal does not draw on
    // shows "· 0", which is the honest number: there is nothing here to pick from it.
    //
    // NO "PRE-TICKED" GROUPS ANY MORE. It used to start the chips ticked for every group
    // this goal was pointed at, on the reasoning that the reader had already said "train
    // on this shelf" on the goal's page and the picker should not ask again. But a chip
    // ticked by the app is a selection the reader did not make, and this screen's whole
    // subject is what they choose. The goal's own page is where that decision is made,
    // and it is made by attaching, not by a default on a later screen.
    const groupList = await groups.list();

    /**
     * THE SELECTION IS THE SOURCE OF TRUTH, and everything else on this page is a view of
     * it. One value rather than a group set in one variable and a question set in
     * another, because the two halves are not independent -- a picked group and a ticked
     * question are ADDITIVE -- and "what does this selection mean" has exactly one
     * answer, which `questions.forSelection` gives by the same route the service takes.
     *
     * `questionIds` is a SET of ids rather than a list of drawn rows, and that is what
     * makes a tick survive a group being unticked: changing the group changes which
     * rows are DRAWN, never which questions are CHOSEN. A screen that kept its ticks in
     * the row objects would quietly drop two questions the reader had picked the moment
     * they looked elsewhere, and would do it looking like it had saved their work.
     */
    const selection = {
        goalId: goal.id,
        groupIds: [],
        questionIds: new Set(),
        excludeIds: new Set()
    };

    /**
     * Is this question in the exercise?
     *
     * READ THROUGH `questions.forSelection` RATHER THAN BEING ASKED DIRECTLY, so the tick
     * on a row and the count at the bottom are one rule.
     *
     * THE EXCLUSION IS CHECKED FIRST because it is the only thing that can take a
     * question back out of a group that would otherwise have included it.
     *
     * AND THE EXCLUSION IS *DELETED* ON THE WAY OUT, not merely skipped. That is not
     * tidiness -- it is what makes a tick reversible. A question that arrived through a
     * group is not in `questionIds`, so unticking it could only be recorded as an
     * exclusion; and if the exclusion stayed behind when the reader ticked the box again,
     * the row would come back still unticked and the reader would be tapping a control
     * forever with nothing to show for it.
     */
    const isIn = (question) => {
        if (selection.excludeIds.has(question.id)) return false;
        return questions.forSelection([question], selection).length > 0;
    };

    /* ------------------------------ the nodes ------------------------------ */

    const chips = h("div.chips");
    const unfiledNote = h("p.small.muted", { hidden: true });
    const rows = h("div.stack-tight");
    const countText = h("p.small.muted");
    const warnText = h("p.small.muted");
    /** The number of questions the button will build. Held here rather than read out of
     *  the selection again at tap time, because `startExercise` needs it to decide
     *  whether there is anything to start, and a second derivation would be a second
     *  place for the count and the rows to disagree. */
    let chosenCount = 0;

    const startButton = h("button.btn.btn-block", {
        type: "button",
        onclick: (event) => startExercise(event.currentTarget, goal, selection, chosenCount)
    }, t("build.start_button"));

    /* ------------------------------ the painting --------------------------- */

    /** Every container is created before any of them is painted. The three painters call
     *  each other through `repaint`, and a painter that ran before its neighbour's node
     *  existed would be reading a detached element -- which draws fine and then
     *  disappears when the real node replaces it. */
    const repaint = () => {
        paintChips();
        paintRows();
        paintSummary();
    };

    /**
     * The group chips.
     *
     * MULTIPLE GROUPS AT ONCE, because "Chapter 3 and the irregular verbs" is one request
     * and a single-select control would make it two. A CHIP IS ITSELF THE WHOLE GROUP --
     * tapping "Chapter 3" means every question in it, and the rows below are what that
     * came to, rather than the group and its questions being two separate things to set.
     *
     * BUTTONS AND NOT LINKS. Selecting a group does not navigate; it changes what is
     * selected on the page you are already on. A link whose only effect is to re-render
     * this page with a different query string is a control whose meaning lives in the
     * router rather than in itself, and it would put this page's whole selection into
     * the URL -- a hundred question ids in an address bar.
     */
    function paintChips() {
        // COUNTS FROM THE ROWS, NOT FROM THE GROUP RECORDS. A group record carries no
        // count, because a shelf's size is a fact about the questions filed on it and
        // that changes whenever one is re-filed.
        //
        // AND ONLY FROM THE ROWS THE GOAL CAN USE. `list` is the goal's material, so a
        // chip showing "Chapter 3 · 0" means this goal draws nothing from that shelf --
        // which is either because the shelf is empty or because the questions on it were
        // removed from the goal, and in both cases the number on the chip is the number
        // that matters. A count taken from the shelf itself would show forty questions
        // the reader cannot pick here, which is the one lie this screen is not allowed to
        // tell.
        const counts = new Map(groupList.map((g) => [g.id, 0]));
        let unfiled = 0;
        for (const question of list) {
            if (!question.groupId) { unfiled += 1; continue; }
            if (counts.has(question.groupId)) counts.set(question.groupId, counts.get(question.groupId) + 1);
        }

        // `mount` rather than `replaceChildren`, for the same reason as the rows below: a
        // spread of an array is fine, but this list is built with `.map` and handed a
        // possible `null`, and the native method would print both as text.
        mount(chips,
            h("button.chip", {
                type: "button",
                "aria-pressed": selection.groupIds.length === 0 ? "true" : "false",
                onclick: () => { selection.groupIds = []; repaint(); }
            }, t("build.all_groups", { n: String(list.length) })),
            ...groupList.map((group) => {
                const on = selection.groupIds.includes(group.id);
                return h("button.chip", {
                    type: "button",
                    "aria-pressed": on ? "true" : "false",
                    onclick: () => {
                        const at = selection.groupIds.indexOf(group.id);
                        if (at === -1) selection.groupIds.push(group.id);
                        else selection.groupIds.splice(at, 1);
                        repaint();
                    }
                }, `${group.name} · ${counts.get(group.id) ?? 0}`);
            })
        );

        // Named on the row because it is the rule a reader will hit within one tap:
        // "I picked Chapter 3 and got forty questions" has to have an explanation
        // somewhere on the page, and the chip itself cannot carry it -- the number it
        // shows is the group's own, not the exercise's.
        unfiledNote.textContent = unfiled
            ? t("build.unfiled_note", { n: String(unfiled) })
            : "";
        unfiledNote.hidden = !unfiled;
    }

    /**
     * The question rows.
     *
     * EVERY QUESTION IN THE GOAL IS DRAWN, all the time.
     *
     * It drew only the ones the group chips reached before, which is wrong twice over.
     * First, a reader who picked "Chapter 3" and unticked one of its questions to leave
     * it out could not put it back -- the row was gone, so the only way to include it
     * again was to untap the group and lose everything else they had chosen. Second,
     * and worse: unticking a question the GROUP had brought in had nothing to untick.
     * It was never in `questionIds`, because it arrived through the group, so the box
     * sprang straight back -- a control that does not do what it looks like it does.
     *
     * EXCLUDED QUESTIONS ARE DRAWN LAST, DIMMED, AND STILL THERE. A row that vanished
     * when it was unticked would be a control that deletes itself, and a reader who
     * unticked three in a row would have no way back to them.
     */
    function paintRows() {
        // ONE LIST, IN THE GOAL'S ORDER, AND IT NEVER REORDERS.
        //
        // It moved excluded rows to the end below them, and that is a control that moves
        // under the reader's thumb: untick the third question and it jumps from the top
        // half of the list to the bottom, so the next tap -- aimed at the row they can see
        // -- lands on whatever slid up into its place. Two taps, one question excluded
        // that nobody meant to. A list that reorders itself as a result of being tapped
        // cannot be used accurately, which is the whole job of a list of checkboxes.
        //
        // The exclusion is shown on the row itself -- dimmed, unticked -- rather than by
        // moving it, so "what is out" is still visible at a glance without the list
        // reshuffling underneath the reader.
        mount(rows,
            h("p.small.muted", { text: t("build.row_hint") }),
            list.map((q) => questionRow(q, isIn(q), selection, repaint, list))
        );
    }

    /**
     * The count, and the warning.
     *
     * THE COUNT IS THE BUILDER'S COUNT. `questions.forSelection` is what
     * `session-service.start()` calls a few lines before it writes the items, so the
     * number on this screen and the number of questions in the exercise are the same
     * number read twice rather than two rules that agree today.
     *
     * THE CAP IS WARNED ABOUT AND NOT REFUSED. `LIMITS.EXERCISE_ITEMS_MAX` exists
     * because a named selection has no natural ceiling -- the plan's `newPerExercise`
     * bounds the PLAN, and a selection is what replaces the plan -- and an exercise of
     * four hundred questions is not a sitting anybody finishes. The builder drops what
     * does not fit and reports the number, so refusing here would be the same rule in
     * two places with two chances to disagree, and starting silently would be a lie about
     * what is in the exercise.
     */
    function paintSummary() {
        const count = list.filter((q) => isIn(q)).length;
        chosenCount = count;

        // THE COUNT IS THE POOL UNTIL ANYTHING IS NAMED, and it says so rather than
        // quoting a number the exercise will not have. Saying "this exercise will ask 40
        // questions" above a button that builds five is the one number on this page that
        // cannot be true, and a reader who notices it has no way to work out which of the
        // two they are looking at.
        const named = selection.groupIds.length || selection.questionIds.size || selection.excludeIds.size;
        countText.textContent = named
            ? t("build.will_ask", { n: String(count) })
            : t("build.pool_note", { n: String(count) });

        warnText.textContent = count > LIMITS.EXERCISE_ITEMS_MAX
            ? t("build.too_many", { max: String(LIMITS.EXERCISE_ITEMS_MAX), n: String(count) })
            : "";

        // `blocked` DISABLES THE BUTTON RATHER THAN DRAWING A DIFFERENT PAGE, because the
        // reader may well want to have chosen and to be ready when it opens. It also does
        // not discard the selection, which a refusal page would.
        startButton.disabled = named ? (count === 0 || blocked) : blocked;
    }

    repaint();

    /* -------------------------------- the page ------------------------------ */

    return {
        node: h("div.stack", null,
            head("build.title", "build.subtitle",
                link(backHref, t("common.cancel"), { class: "btn btn-quiet" })),

            // THE BLOCKING NOTICE SITS ABOVE THE LIST, so a reader who arrives here from
            // a dead Start button is told why before they start choosing, and not after.
            blocked
                ? card(
                    h("p", { text: t("build.blocked_heading") }),
                    h("p.small.muted", { text: blockedHint(action) }),
                    link(backHref, t("goal.open_button"), { class: "btn btn-secondary btn-block" })
                )
                : null,

            section("build.groups_heading",
                card(h("p.small.muted", { text: t("build.groups_hint") }), chips, unfiledNote)),
            section("build.questions_heading", card(rows)),
            // The summary is its own card, at the END, because it is the answer to "what am
            // I about to do" and it has to be the last thing above the button rather than
            // up among the groups where it would be describing a selection the reader has
            // not finished making.
            card(countText, warnText, startButton)
        )
    };
}

/** Why the button is dead, in the reader's terms rather than the schedule's. It is
 *  asked of the DECISION rather than of `plan`, so the sentence cannot differ from the
 *  one the goal page gave for the same state. */
function blockedHint(action) {
    if (action.action === "rate_limited") return t("build.blocked_quota");
    return t("build.blocked_other");
}

/**
 * One question, as a checkbox row.
 *
 * THE STATE LABEL IS BECAUSE PICKING IS A BET. A reader choosing four questions to revise
 * is choosing the four they keep getting wrong, and the app already knows which those are
 * from the attempt log -- so "to review" beside a row turns a tap-by-tap judgement into a
 * tap on the four rows that say so.
 *
 * The group name is here too, and only when there is one. "Not filed" is an absence rather
 * than a fact about a question, and printing it on every row of a list that is mostly
 * unfiled is a word per row saying nothing.
 *
 * `all` IS PASSED IN rather than closed over, because this function is at module scope and
 * the page's `list` is not. Reaching for it from here is a ReferenceError on the one tap
 * this row cannot survive: the first untick on a screen where nothing has been named,
 * which is both the first thing a reader tries and the branch that needs the whole list.
 */
function questionRow(question, checked, selection, repaint, all) {
    const input = h("input", { type: "checkbox", checked });

    // ONE HANDLER FOR BOTH DIRECTIONS, and it does not ask which one this is. The
    // alternative -- adding to `questionIds` when ticked and deleting from it when not --
    // is wrong for a question a group already brought in, because it was never in that set
    // to begin with, so unticking it recorded nothing and the row came back.
    //
    // What happens instead is decided by asking the SELECTION rather than by the direction
    // the pointer moved: a question that is in the exercise and should not be goes to
    // `excludeIds`, and one that is not and should be goes to `questionIds`. Both sets are
    // cleared of this id on either branch, so a question can never be in the exclusion list
    // and the inclusion list at once -- which is the state where the row and the count
    // disagree with no way for a reader to tell which is right.
    input.addEventListener("change", () => {
        // BOTH SETS CLEARED FIRST, THEN SET AGAIN. Ticking a question the reader had
        // unticked has to remove the exclusion, because `excludeIds` is checked first in
        // `isIn` and a leftover entry there makes the row come back still unticked -- a
        // reader tapping the same box forever with nothing to show for it.
        selection.questionIds.delete(question.id);
        selection.excludeIds.delete(question.id);

        if (input.checked) {
            // Named explicitly, so it stays asked for even after the group it came from is
            // untapped. Without this, picking a group and unticking one of its questions
            // would lose the question entirely rather than move it to a section of its own.
            selection.questionIds.add(question.id);
        } else if (selection.groupIds.length || selection.questionIds.size || selection.excludeIds.size) {
            selection.excludeIds.add(question.id);
        } else {
            // AN UNTICK WITH NOTHING NAMED IS "JUST THIS ONE", and it has to become a real
            // selection rather than being ignored.
            //
            // It was ignored first, on the reasoning that an exclusion with no selection to
            // subtract from says nothing. And it does not say nothing -- a reader who unticks
            // one of five rows is pointing at one question, and having the box spring back
            // unchanged is a control that does not do what it looks like it does. It is also
            // the commonest first action on this screen: pick out the four you get wrong and
            // leave one.
            selection.excludeIds.add(question.id);
            for (const other of all) {
                if (other.id === question.id) continue;
                selection.questionIds.add(other.id);
            }
        }
        repaint();
    });

    // A question named on its own is asked for whatever its groups are. Marked, so
    // untapping the group later does not look like it silently removed it.
    const named = selection.questionIds.has(question.id);

    return h("label.choice", checked ? null : { style: { opacity: "0.65" } },
        input,
        h("span.grow", { text: question.text }),
        h("span.tiny.muted", {
            text: [
                t(`questions.state_${question.state}`),
                question.group,
                named ? t("build.named") : null
            ].filter(Boolean).join(" · ")
        })
    );
}

/* -------------------------------- empty states ------------------------------ */

function nothingToPick(goal, backHref) {
    // A goal with nothing ATTACHED, which is not the same thing as a goal with no
    // questions anywhere. The reader may well have two hundred questions written and
    // simply not pointed this goal at any of them, so the two buttons are the two
    // decisions: attach some of what exists, or write something new.
    return h("div.stack", null,
        head("build.title", "build.subtitle",
            link(backHref, t("common.back"), { class: "btn btn-quiet" })),
        emptyState(
            t("home.needs_questions_title"),
            t("home.needs_questions_body"),
            h("div.btn-row", { style: { "justify-content": "center" } },
                link(`/goal/${encodeURIComponent(goal.id)}/content`, t("content.title"), { class: "btn" }),
                link("/questions/new", t("questions.add"), { class: "btn btn-secondary" })
            )
        )
    );
}

function notFound() {
    return h("div.stack", null,
        head("build.title", null),
        emptyState(
            t("error.not_found"),
            t("home.no_goal_body"),
            link("/goal", t("home.create_goal"), { class: "btn" })
        )
    );
}

/**
 * Start the exercise the reader has just chosen.
 *
 * THE SELECTION IS COPIED OUT OF ITS SETS BEFORE IT LEAVES THIS FUNCTION. A `Set` handed
 * to a service that is about to do async work is a live reference to the screen's own
 * state, and a reader who taps Start and untaps a question on the way out would get an
 * exercise built from a selection that no longer matches what the button said it would
 * build. `null` rather than an empty array for "nothing picked", because an empty array is
 * a real selection of nothing in `isExactSelection` and would build a zero-question
 * exercise instead of falling back to the plan.
 */
async function startExercise(button, goal, selection, count) {
    const groupIds = selection.groupIds.length ? [...selection.groupIds] : null;
    const questionIds = selection.questionIds.size ? [...selection.questionIds] : null;
    const excludeIds = selection.excludeIds.size ? [...selection.excludeIds] : null;

    // A SELECTION OF NOTHING IS THE PLAN, not an empty exercise. The reader unticked
    // everything without naming anything, which is not "build me an exercise with no
    // questions" -- it is the absence of a choice, and `questionsForSelection` answers it
    // with the whole goal for the plan to draw from. The exclusions are DROPPED here rather
    // than sent, because sending them with no selection would exclude everything and build
    // nothing.
    //
    // The button is not disabled in that state. It says what it will do -- the count reads
    // as the whole goal, because that is the count of what `start()` will build -- and a
    // reader who unticked four things by accident and then taps Start has asked for the
    // ordinary next exercise, which is a reasonable thing to have wanted.
    if (!groupIds && !questionIds && !excludeIds) {
        return startExercise(button, goal, { groupIds: null, questionIds: null, excludeIds: null }, -1);
    }

    button.disabled = true;
    try {
        const { exercise } = await sessions.start({
            goalId: goal.id,
            groupIds,
            questionIds,
            excludeIds
        });
        go(exerciseHref(exercise.id));
    } catch (err) {
        // Unlocked rather than left dead: the exercise was not created, so the selection
        // is still the one the button described.
        button.disabled = false;
        toast.error(err);
        // `nothing_to_exercise` means every question the reader picked is gone -- most often
        // deleted on another device between drawing this list and pressing the button. There
        // is nothing to fix on this page, so it says so by leaving, rather than leaving a
        // reader tapping a button that will keep refusing.
        if (err?.code === "nothing_to_exercise") {
            go("/questions");
        }
    }
}
