// A test for the DOM helpers, and the reason there is one at all.
//
// The app has no framework and no template compiler: `h()` builds every element,
// `append()` is the one place children are added, and `mount()` is the one place a
// container's contents are replaced. That is a small enough surface to test
// directly, and the failure it has to catch is one that reached the screen —
// `replaceChildren(null)` on the exercise page's action row printed the word
// "null" under the answer options of the first question of every single-choice
// exercise, which is the commonest screen in the app. Nothing threw; the text was
// simply there.
//
// The DOM is stubbed rather than driven. A real browser would need a fixture and a
// runner this project does not have, and the behaviour under test is precisely the
// part that has no business depending on an engine: which argument values are
// turned into children and which are dropped.

import test from "node:test";
import assert from "node:assert/strict";

/* ------------------------------- a tiny DOM ------------------------------- */

/** Just enough of Node/Document for `h`, `append` and `mount` to be exercised for
 *  real, including the parts `applyProps` touches: `classList`, `style` (which is
 *  CSSOM in this app, not an attribute — see the CSP note in ui/dom.js),
 *  `setAttribute` and `addEventListener`. */
class FakeNode {
    constructor(name = "#node") {
        this.nodeName = name;
        this.childNodes = [];
        this.attributes = {};
        this.listeners = {};
        this.classes = [];
        this.props = {};
        this.classList = {
            add: (...names) => { for (const n of names) if (n) this.classes.push(n); },
            remove: (n) => { this.classes = this.classes.filter((c) => c !== n); }
        };
        // A live CSSStyleDeclaration-ish object: `setProperty` is the ONLY way this
        // app writes a style, because `setAttribute("style", …)` is refused by the
        // browser under `style-src 'self'` with no `unsafe-inline`.
        this.style = {
            setProperty: (property, value) => { this.props[property] = String(value); },
            removeProperty: (property) => { delete this.props[property]; }
        };
    }

    get textContent() {
        return this.childNodes.map((n) => (n instanceof FakeNode ? n.textContent : n.data)).join("");
    }

    setAttribute(name, value) { this.attributes[name] = String(value); }

    getAttribute(name) { return this.attributes[name] ?? null; }

    removeAttribute(name) { delete this.attributes[name]; }

    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

    appendChild(child) {
        this.childNodes.push(child);
        return child;
    }

    remove() { /* the app calls this on nodes it has already detached */ }

    replaceChildren(...children) {
        // The native method, faithfully: it stringifies anything that is not a
        // Node, which is the whole reason `mount` exists.
        this.childNodes = children.map((c) => (
            c instanceof FakeNode ? c : { data: String(c) }
        ));
    }

    /** Every descendant node, depth first. */
    descendants() {
        const out = [];
        for (const child of this.childNodes) {
            if (!(child instanceof FakeNode)) continue;
            out.push(child, ...child.descendants());
        }
        return out;
    }
}

class FakeText {
    constructor(data) { this.data = String(data); }
}

// The module reads `document` at call time, not at import time, so a stub
// installed before the dynamic import is enough.
globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeText(text),
    createDocumentFragment: () => new FakeNode("#fragment")
};
globalThis.Node = FakeNode;

const { h, mount, frag } = await import("../app/js/ui/dom.js");

/* ---------------------------------- h() ---------------------------------- */

test("h() puts a tag and its classes on the element", () => {
    const el = h("div.card.card-quiet", null, "text");
    assert.equal(el.nodeName, "div");
    assert.deepEqual(el.classes, ["card", "card-quiet"]);
    assert.equal(el.textContent, "text");
});

test("h() drops the children that mean nothing", () => {
    // Every component in this app passes conditionals straight into `h(…)`:
    // `answer ? h("p") : null`. The native appendChild would print "null" here, so
    // the filter is load-bearing rather than a convenience.
    const el = h("div", null, null, undefined, false, true, "kept", 0);
    assert.equal(el.childNodes.length, 2);
    assert.equal(el.childNodes[0].data, "kept");
    // A zero is a value, and it is kept: `stat(0, …)` and `stat(questions.length, …)`
    // both go through here, and a progress figure of zero is the one number a
    // report must not drop.
    assert.equal(el.childNodes[1].data, "0");
});

test("h() flattens nested arrays of children", () => {
    const el = h("ul", null, [h("li", null, "a"), [h("li", null, "b"), null]]);
    assert.equal(el.descendants().filter((n) => n.nodeName === "li").length, 2);
    assert.equal(el.textContent, "ab");
});

test("h() sets the style prop through CSSOM, never as an attribute", () => {
    // The CSP has `style-src 'self'` and no `unsafe-inline`, so a style ATTRIBUTE
    // is refused by the browser. This is why the prop is an object, and the reason
    // a page cannot hand the app a pre-built style string.
    const el = h("div", { style: { "--fill": "42%" } });
    assert.equal(el.props["--fill"], "42%");
    assert.equal("style" in el.attributes, false, "a style attribute was written");
});

/* -------------------------------- mount() -------------------------------- */

test("mount() replaces the contents", () => {
    const parent = new FakeNode("div");
    parent.appendChild(h("span", null, "old"));
    mount(parent, h("span", null, "new"));
    assert.equal(parent.textContent, "new");
});

test("mount() with nothing empties the container", () => {
    const parent = new FakeNode("div");
    parent.appendChild(h("span", null, "old"));
    mount(parent);
    assert.equal(parent.textContent, "");
});

test("mount() tolerates a null child where replaceChildren would print one", () => {
    // THE REGRESSION. The exercise page's action row has nothing to draw before an
    // answer on a single-choice question, because tapping the option submits it and
    // there is no button to press. `replaceChildren(actionButton())` with that
    // function returning `null` put a text node reading "null" on screen.
    const parent = new FakeNode("div");
    parent.appendChild(h("button", null, "Next"));

    mount(parent, null);
    assert.equal(parent.textContent, "", "mount(null) left something behind");

    mount(parent, undefined, false, true);
    assert.equal(parent.textContent, "");

    // And the difference is the whole point: the native call is what was wrong.
    parent.replaceChildren(null);
    assert.equal(parent.textContent, "null", "the native behaviour is what mount() exists to avoid");
});

test("mount() still draws the real children around a null", () => {
    const parent = new FakeNode("div");
    mount(parent, h("span", null, "before"), null, h("span", null, "after"));
    assert.equal(parent.textContent, "beforeafter");
});

/* --------------------------------- frag() -------------------------------- */

test("frag() collects children the same way, nulls and all", () => {
    const f = frag(h("span", null, "a"), null, h("span", null, "b"));
    assert.equal(f.textContent, "ab");
    assert.equal(f.descendants().length, 2);
});
