// The bottom bar, and the header it becomes on a wide screen.
//
// Five destinations and no more. The set is fixed by what a person actually
// comes here to do — see what is due, add questions, do it, look at how it is
// going, change a setting — and anything beyond that belongs on a page rather
// than in the chrome. The bar is rendered from an array so that the "current"
// mark is derived from the URL rather than set by whichever page was rendered
// last, which is the thing that goes stale when a page pushes history or a deep
// link is opened cold.

import { h, icon } from "./dom.js";
import { t } from "../i18n/i18n.js";

const DESTINATIONS = [
    { href: "/", key: "nav.home", icon: "home" },
    { href: "/goal", key: "nav.goal", icon: "goal" },
    { href: "/questions", key: "nav.questions", icon: "questions" },
    { href: "/exercise", key: "nav.exercise", icon: "exercise" },
    { href: "/reports", key: "nav.reports", icon: "reports" },
    { href: "/settings", key: "nav.settings", icon: "settings" }
];

/** The prefix a path is "under" for the purposes of the current-page mark.
 *
 *  Longest match wins, and the comparison is on whole segments. A plain
 *  `startsWith` marks `/questions` current while the reader is on
 *  `/questions/new` for a question they are editing, which is at least harmless;
 *  the same prefix logic on `/goal` against `/goal-history` is not. */
function activeHref(path) {
    let best = "";
    for (const d of DESTINATIONS) {
        if (d.href === "/") continue;
        const matches = path === d.href || path.startsWith(`${d.href}/`);
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

    root.replaceChildren(...DESTINATIONS.map((d) => h("a", {
        href: d.href,
        "data-link": true,
        "aria-current": d.href === current ? "page" : null,
        "aria-label": t(d.key)
    },
    icon(d.icon),
    h("span", { text: t(d.key) })
    )));
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