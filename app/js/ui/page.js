// The two things every page has: a heading and a stack of cards.
//
// A page returns `{node, destroy?}`. `destroy` is optional and exists for the
// one thing a screen can leak — the exercise page's stopwatch interval. It is
// called before the next page is drawn, which is the only place it can be called
// reliably from: there is no "unload" a page can rely on, and an interval left
// running keeps updating a node that is no longer in the document.

import { h } from "./dom.js";
import { t } from "../i18n/i18n.js";

/** A title, an optional subtitle, and whatever the page puts in its top-right
 *  corner. The actions come last so they line up on the right in both
 *  directions — `dir` handles that, and it is why nothing here sets a `text-align`
 *  or a margin that assumes left-to-right. */
export function head(titleKey, subtitleKey = null, ...actions) {
    return h("header", { class: "page-head" },
        h("div.grow", null,
            h("h1.page-title", { text: t(titleKey) }),
            subtitleKey ? h("p.page-sub", { text: t(subtitleKey) }) : null
        ),
        actions.filter(Boolean).length ? h("div.row", null, actions.filter(Boolean)) : null
    );
}

export function card(...children) {
    return h("div.card", null, children);
}

export function quietCard(...children) {
    return h("div.card.card-quiet", null, children);
}

/** A section heading inside a page — smaller than `head`, for the second and
 *  third groups of a screen. */
export function section(titleKey, ...children) {
    return h("section", { class: "stack" },
        h("h2", { text: t(titleKey) }),
        children
    );
}

/** A section whose heading is a translated STRING rather than a key.
 *
 *  The two exist because a key cannot take parameters and two headings in this
 *  app interpolate one — the reports page's "Last 14 days". Passing a key and
 *  rendering `{days}` in the middle of a screen is the kind of thing that ships,
 *  because a template literal in the test output looks the same as a broken
 *  lookup, and a second variant of `section` is cheaper than a `section` that
 *  accepts both and has to work out which it was given. */
export function sectionText(heading, ...children) {
    return h("section", { class: "stack" },
        h("h2", { text: heading }),
        children
    );
}

/** A destructive button that asks first. The confirm is here rather than at
 *  every call site because "does this need asking about" is a property of the
 *  button, not of the screen that happens to have it. */
export function destructiveButton(labelKey, { titleKey, bodyKey, yesKey = "common.yes" }, onConfirm) {
    return h("button.btn.btn-danger.btn-block", {
        type: "button",
        onclick: async () => {
            const { confirm } = await import("./dialog.js");
            if (await confirm({ titleKey, bodyKey, yesKey })) await onConfirm();
        }
    }, t(labelKey));
}