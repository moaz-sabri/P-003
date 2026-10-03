// The bottom bar, and the header it becomes on a wide screen.
//
// FIVE DESTINATIONS AND NO MORE. The set is fixed by what a person actually comes
// here to do — see what is due, add questions, look at how it is going, change a
// setting — and anything beyond that belongs on a page rather than in the chrome.
// The bar is rendered from an array so that the "current" mark is derived from the URL
// rather than set by whichever page was rendered last, which is the thing that goes
// stale when a page pushes history or a deep link is opened cold.
//
// THERE IS NO "EXERCISE" ITEM, and its absence is the model rather than a gap. An
// exercise is part of a goal, so the thing a reader wants from the bar -- "do the
// thing I was going to do" -- is a property of a goal and is answered on the home
// page, which lists every goal and its open exercises. A bar item for it would have to
// either pick a goal for the reader or ask them which one, and both of those are
// questions the home page already answers without being asked.

import { h, icon } from "./dom.js";
import { t } from "../i18n/i18n.js";

// FIVE DESTINATIONS, AND EXACTLY ONE OF THEM IS GOAL-SCOPED.
//
// The one that is: reports, because it is ABOUT a goal's own history — its exercises,
// its attempts — and a reader with three goals tapping "report" from the nav bar means
// the one they were just reading, not whichever is newest.
//
// The two that are not are the interesting half. Questions and goals have nothing to
// carry: the question list is the whole device's, and a `?goal=` on it would be a
// query nothing reads. That is the separation showing up in the chrome — before it,
// four of the six destinations were goal-scoped because four of the six were lists of
// something a goal owned.
//
// `groups` is not in the bar and never was. It is a filter of the question list rather
// than a place of its own, reachable from there and from each group's chips, and a
// seventh row on a phone is a row the reader taps by accident.
const DESTINATIONS = [
    { href: "/", key: "nav.home", icon: "home" },
    { href: "/goal", key: "nav.goal", icon: "goal" },
    { href: "/questions", key: "nav.questions", icon: "questions" },
    { href: "/reports", key: "nav.reports", icon: "reports", goalScoped: true },
    { href: "/settings", key: "nav.settings", icon: "settings" }
];

/**
 * The current-goal id, remembered so the navigation can carry it where it is needed.
 *
 * A LINK THAT DOES NOT NAME A GOAL IS A LINK TO WHATEVER IS NEWEST, and with several
 * goals that is a coin toss. The goal pages and the home page write the id here
 * whenever they render, and the one destination that needs a goal carries it — so
 * tapping "Report" from the page for goal A opens goal A, which is what the reader
 * under their thumb meant.
 *
 * THE HOME PAGE SETS IT TO WHATEVER IS NEWEST on purpose. It is the one screen that
 * shows every goal at once, so there is no single one it is "about", and leaving the
 * previous value in place would mean tapping Report after reading the home page
 * silently reports on a goal the reader scrolled past an hour ago.
 *
 * A module variable rather than a query parameter on every nav item because the URL is
 * not changed: a reader who opens the app, goes to a goal and taps Report should not
 * find three goals in the address bar, and the nav is chrome rather than somewhere a
 * link's destination is being edited.
 */
let currentGoalId = null;

export function setCurrentGoal(id) {
    currentGoalId = id || null;
}

/** The href for a destination, carrying the goal when the destination needs one
 *  and there is one to carry. */
function hrefFor(destination) {
    if (destination.goalScoped && currentGoalId) {
        return `${destination.href}?goal=${encodeURIComponent(currentGoalId)}`;
    }
    return destination.href;
}

/** The prefix a path is "under" for the purposes of the current-page mark.
 *
 *  Longest match wins, and the comparison is on whole segments. A plain
 *  `startsWith` marks `/questions` current while the reader is on
 *  `/questions/new` for a question they are editing, which is at least harmless;
 *  the same prefix logic on `/goal` against `/goal-history` is not. */
function activeHref(path) {
    // The query is dropped for the comparison. `/reports?goal=abc` is on the
    // reports page, and comparing the whole string meant a nav item was never
    // marked current on any destination that now carries a goal id — which is most
    // of them, so the "you are here" mark silently stopped existing.
    const pathname = path.split("?")[0];
    let best = "";
    for (const d of DESTINATIONS) {
        if (d.href === "/") continue;
        const matches = pathname === d.href || pathname.startsWith(`${d.href}/`);
        if (matches && d.href.length > best.length) best = d.href;
    }
    return best || "/";
}

/** Draw the navigation for `path`. Called on every navigation, and once more
 *  whenever the language changes — the labels are strings, so a language switch
 *  has to redraw them rather than swap a text node somewhere. */
export function renderNav(path) {
    const root = document.getElementById("bottom-nav");
    if (!root) return;
    const current = activeHref(path);

    root.replaceChildren(...DESTINATIONS.map((d) => {
        const href = hrefFor(d);
        return h("a", {
            href,
            "data-link": true,
            "aria-current": d.href === current ? "page" : null,
            "aria-label": t(d.key)
        },
        icon(d.icon),
        h("span", { text: t(d.key) })
        );
    }));
}

/** Set the document language and direction. Called once at boot and again on
 *  every language change; `lang` and `dir` are both on <html> because a
 *  screen reader picks its voice from `lang` and the layout mirrors from `dir`,
 *  and setting only one of them is how an app ends up reading Arabic text in an
 *  English voice. */
export function applyDocumentLanguage(language, dir) {
    const html = document.documentElement;
    html.lang = language;
    html.dir = dir;
}
