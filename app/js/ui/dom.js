// Building DOM, the one way.
//
// `h()` exists because this app has no framework and no template compiler, and
// the alternative — a `<div>` in a template string plus `innerHTML` — is
// incompatible with the policy in app/index.html in two separate ways. It puts
// user text through an HTML parser, so a question containing `<` renders as a
// broken page instead of as text, and it needs `unsafe-inline` for the inline
// event handlers that any version of it requires.
//
// THE STYLE PROP IS NOT A STYLE ATTRIBUTE. `style-src 'self'` with no
// 'unsafe-inline' means `setAttribute("style", …)` is refused by the browser, so
// the width of a meter bar cannot be written as a string. It is written through
// CSSOM — `element.style.setProperty` — which the policy does not cover, because
// what it restricts is style *markup*. This is the whole reason components here
// take `style: { "--fill": "42%" }` as an object: an object cannot be turned
// into a style attribute by accident, because there is no path that does it.
//
// Everything else is ordinary. Tag and classes come first in one string
// (`"button.btn.btn-secondary"`), `data-*` and `aria-*` are set with
// `setAttribute` because they have no camelCase spelling, and `on*` props become
// listeners so nothing in this app ever writes `onclick` into markup.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build an element.
 *
 * @param {string} tag      e.g. `"button.btn.btn-primary"` or `"div#main"`
 * @param {object|null} [props]
 * @param {...(Node|string|number|null|undefined|false|Array)} children
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
    const [name, ...classes] = String(tag).split(".");
    const element = document.createElement(name || "div");
    if (classes.length) element.classList.add(...classes.filter(Boolean));

    if (props) applyProps(element, props);
    append(element, children);
    return element;
}

/** The SVG equivalent, for the handful of icons and the favicon-like marks.
 *  `createElement` on an SVG element in the HTML namespace produces a node that
 *  renders as nothing, so every namespace-sensitive element goes through here. */
export function svg(tag, props = null, ...children) {
    const element = document.createElementNS(SVG_NS, tag);
    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === null || value === undefined || value === false) continue;
            if (key === "class") element.setAttribute("class", value);
            else element.setAttributeNS(null, key, String(value));
        }
    }
    append(element, children);
    return element;
}

function applyProps(element, props) {
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;

        if (key === "class" || key === "className") {
            for (const name of String(value).split(/\s+/).filter(Boolean)) {
                element.classList.add(name);
            }
        } else if (key === "style" && typeof value === "object") {
            // CSSOM, never the attribute. See the header.
            for (const [property, v] of Object.entries(value)) {
                if (v === null || v === undefined) continue;
                element.style.setProperty(property, String(v));
            }
        } else if (key === "dataset" && typeof value === "object") {
            for (const [name, v] of Object.entries(value)) {
                if (v === null || v === undefined) continue;
                element.dataset[name] = String(v);
            }
        } else if (key === "text") {
            element.textContent = String(value);
        } else if (key === "value") {
            // Assigned, not attributed: the property is what a form reads back,
            // and setting it on a control that is not yet in the document is the
            // only way its value survives the first render.
            element.value = value === true ? "true" : String(value);
        } else if (key === "checked" || key === "disabled" || key === "selected"
            || key === "hidden" || key === "required") {
            element[key] = Boolean(value);
        } else if (key.startsWith("on") && typeof value === "function") {
            element.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key.startsWith("data-") || key.startsWith("aria-")) {
            element.setAttribute(key, value === true ? "" : String(value));
        } else {
            element.setAttribute(key, value === true ? "" : String(value));
        }
    }
}

function append(parent, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false || child === true) continue;
        if (Array.isArray(child)) {
            append(parent, child);
        } else if (child instanceof Node) {
            parent.appendChild(child);
        } else {
            parent.appendChild(document.createTextNode(String(child)));
        }
    }
}

/** A document fragment, for returning a list of elements from a component that
 *  renders into a parent rather than replacing it. */
export function frag(...children) {
    const fragment = document.createDocumentFragment();
    append(fragment, children);
    return fragment;
}

/**
 * Replace a container's contents.
 *
 * Used by the router, and by every component that re-renders its own subtree —
 * so a screen never has to be thrown away and rebuilt to show one more row.
 *
 * IT IS THIS, NOT `parent.replaceChildren(…)`. The native method takes `Node`s and
 * stringifies anything else, so a component that legitimately has nothing to draw
 * in a slot — the exercise page's action row before an answer, where a
 * single-choice question submits on the tap and needs no button — and writes
 * `replaceChildren(null)` puts a text node reading **null** on the screen. That is
 * not a theoretical hole: it was on the first question of every single-choice
 * exercise, the commonest screen in the app. `append` below already filters
 * `null`, `undefined` and the booleans, which is what every `h(…)` child list has
 * always relied on; this brings the same tolerance to the containers.
 */
export function mount(parent, ...children) {
    parent.replaceChildren();
    append(parent, children);
    return parent;
}

export function clear(node) {
    node.replaceChildren();
    return node;
}

/** The icon set, as path data on a 24×24 grid.
 *
 *  Inline SVG rather than icon files or a font: an icon font is another request
 *  the service worker has to be told about and another thing that shows as a
 *  blank box on a first paint, and an <img> of an SVG cannot inherit the colour
 *  of the nav bar it sits in. These are stroke paths with `currentColor`, so the
 *  selected item in the navigation is the accent colour for free. */
const ICON_PATHS = {
    home: "M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5",
    goal: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
    questions: "M4 6h16M4 12h16M4 18h9",
    exercise: "M8 5.5v13l10-6.5-10-6.5Z",
    reports: "M4 20V9M10 20V4M16 20v-7M22 20H2",
    settings: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM12 2.8v2.1M12 19.1v2.1M4.5 12H2.4M21.6 12h-2.1M6.7 6.7 5.2 5.2M18.8 18.8l-1.5-1.5M6.7 17.3l-1.5 1.5M18.8 5.2l-1.5 1.5",
    check: "M4.5 12.5 9.5 17.5 19.5 7",
    cross: "M6 6l12 12M18 6 6 18",
    plus: "M12 5v14M5 12h14",
    arrow: "M5 12h14M13 6l6 6-6 6"
};

/**
 * An icon element. `name` must be one of the keys above — an unknown one renders
 * nothing rather than a broken box, and `size` is in pixels on both axes.
 */
export function icon(name, size = 20) {
    const path = ICON_PATHS[name];
    if (!path) return document.createTextNode("");
    return svg("svg", {
        class: "nav-icon",
        viewBox: "0 0 24 24",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.6",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
        focusable: "false"
    }, svg("path", { d: path }));
}

/* ----------------------------- small helpers ----------------------------- */

/** A percentage bar. The value goes in as a CSS custom property through
 *  CSSOM — `style: { "--fill": "42%" }` — because that is the only way the
 *  stylesheet can size it without an inline style attribute. */
export function meter(percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    return h("div.meter", { role: "presentation", style: { "--fill": `${clamped}%` } }, h("span"));
}

/** One figure with its label. Three per row is the most that stays legible at
 *  320px, and `.stat-row` is the thing that decides how many fit. */
export function stat(value, label) {
    return h("div.stat", null,
        h("div.stat-value.nums", { text: value }),
        h("div.stat-label", { text: label })
    );
}

/**
 * A row of statistics.
 *
 * THE COUNT IS WRITTEN INTO THE ROW rather than left to the grid to work out. The
 * app has rows of two, three and four, and no single `minmax()` floor in a media
 * query serves all three: a floor wide enough for four is also wide enough for
 * three, so a three-item row lands in a four-column grid with a hole in it, and a
 * floor wide enough for three leaves a four-item row as three-and-a-lonely-one.
 * `--cols` is the count, and `components.css` overrides it to two below 26rem
 * where an odd last tile spans the row instead.
 *
 * Capped at four: a fifth figure belongs in a sentence beside the row, not in a
 * tile too narrow to hold its own label.
 */
export function statRow(...stats) {
    const kept = stats.filter(Boolean);
    return h("div.stat-row", { style: { "--cols": String(Math.min(4, Math.max(1, kept.length))) } },
        ...kept);
}

/** An empty state: a heading, a sentence, and whatever the reader can do about
 *  it. The action is a parameter rather than a slot because every empty state in
 *  this app leads to exactly one place. */
export function emptyState(heading, body, action) {
    return h("div.empty", null,
        h("h2", { text: heading }),
        h("p", { text: body }),
        action ?? null
    );
}

/** A link that the router intercepts. `data-link` is the marker: a click on
 *  anything carrying it is handled in app/router.js, and anything not carrying
 *  it is left to the browser. Making it an attribute rather than a class of link
 *  is what lets a `mailto:` in a help line behave like a mail link. */
export function link(href, label, props = {}) {
    return h("a", { href, "data-link": true, ...props }, label);
}

/** A button that navigates, for the cases where the thing is a link visually and
 *  a command semantically. */
export function navButton(href, label, cls = "btn btn-secondary") {
    return h("a", { href, class: cls, "data-link": true }, label);
}

/** Attach a handler once and detach it when the node leaves the document. Used
 *  where a component subscribes to something global — the language, the sync
 *  status — and would otherwise leak a listener on every navigation. */
export function bound(node, event, handler, options) {
    node.addEventListener(event, handler, options);
    return node;
}