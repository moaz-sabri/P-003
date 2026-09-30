// The router.
//
// Ten paths and a fallback, which is a small enough table to be a list rather
// than a dependency. Two things it does that are easy to get wrong:
//
//   * EVERY NAVIGATION IS A RENDER, not a page load. The app is one document and
//     the service worker caches that one document (app/sw.js files it under a
//     single key, so a deep link opened offline finds it). Which means this file
//     has to handle a route it has never seen before at boot, from a cold start,
//     with no prior render — and `match()` returning null for it has to be a
//     page, not a blank screen.
//
//   * A LEAVE GUARD. The exercise page registers one. It is checked for link
//     taps, for the back button, and for the tab being closed — three separate
//     mechanisms, because the one that is actually wanted (back, or closing the
//     tab mid-question) is the one that is hardest to intercept. An exercise is
//     resumable, so the guard's real job is to stop a half-tapped question being
//     skipped, not to prevent data loss.

const routes = [
    { name: "home", pattern: /^\/$/ },
    { name: "goal", pattern: /^\/goal$/ },
    { name: "questions", pattern: /^\/questions$/ },
    { name: "question-new", pattern: /^\/questions\/new$/ },
    { name: "question-edit", pattern: /^\/questions\/([^/]+)$/, keys: ["id"] },
    { name: "exercise", pattern: /^\/exercise$/ },
    { name: "result", pattern: /^\/exercise\/result$/ },
    { name: "reports", pattern: /^\/reports$/ },
    { name: "settings", pattern: /^\/settings$/ }
];

let renderFn = null;
let leaveGuard = null;
let current = "/";
let token = 0;

/** Match a pathname to a route. `null` means the 404 page. */
export function match(path) {
    for (const route of routes) {
        const found = route.pattern.exec(path);
        if (!found) continue;
        const params = {};
        (route.keys ?? []).forEach((key, i) => { params[key] = decodeURIComponent(found[i + 1]); });
        return { name: route.name, params };
    }
    return null;
}

export function currentPath() {
    return current;
}

/** Install the renderer and handle the first route. */
export function startRouter(render) {
    renderFn = render;

    // One listener on the document rather than one per link. Links are created
    // and destroyed constantly, and a listener attached to a node that is about
    // to be replaced is a listener that keeps its element alive.
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", () => {
        go(location.pathname + location.search, { replace: true, fromHistory: true });
    });

    // A tab being closed mid-question. `beforeunload` cannot show anything except
    // the browser's own dialog, and the return value is ignored on mobile — so
    // this is deliberately NOT used for a confirm. It only exists to give the
    // exercise page a chance to flush, which it does on every answer anyway.
    window.addEventListener("beforeunload", () => {});

    go(location.pathname + location.search, { replace: true });
}

/**
 * Register a function asked before leaving the current route. It returns true to
 * allow the navigation. Replaced, not stacked: only the page that is on screen
 * gets to have an opinion about leaving.
 *
 * IT MAY RETURN A PROMISE, and it is asked BEFORE the history entry is written.
 * Both halves of that are the same correction.
 *
 * A promise is allowed because the only question worth asking a reader is one
 * `confirm()` can answer, and `confirm()` is asynchronous — a guard that has to
 * be synchronous is a guard that cannot ask, and the version here that read the
 * answer off a synchronous `window.confirm` was the reason the exercise page
 * registered a guard and then did nothing with it.
 *
 * The order matters because of what a refusal has to undo. The first version
 * pushed the history entry and then asked, so refusing it left the address bar
 * showing a page the reader was not on, and the repair — `history.forward()` —
 * moved FORWARD onto the entry that had just been pushed, which is that very
 * wrong URL. Asking first means a refusal has nothing to undo at all: no entry
 * was written, so the address bar never moved and there is no duplicate for Back
 * to walk through twice.
 */
export function setLeaveGuard(fn) {
    leaveGuard = fn;
}

function onClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target.closest?.("a[href]");
    // Only same-document links. A `mailto:`, an external URL and a download are
    // all the browser's business; the `closest` lookup also stops at the nearest
    // ancestor with an href, so a link inside a button-shaped anchor still works.
    if (!anchor) return;
    if (anchor.target === "_blank") return;
    if (anchor.hasAttribute("download")) return;
    if (!anchor.hasAttribute("data-link")) return;

    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;

    event.preventDefault();
    go(url.pathname + url.search, {});
}

/** Navigate. Returns after the render has been started, not after it finished —
 *  a route handler is asynchronous and the caller has no reason to wait for it.
 *
 *  When a guard is registered and the move is deliberate, the guard is asked
 *  first and the move happens inside its answer. A guard that returns a promise
 *  therefore delays the navigation by however long the reader takes to answer a
 *  dialog, which is the point. */
export function go(path, { replace = false, fromHistory = false } = {}) {
    const move = () => {
        if (!fromHistory) {
            if (replace) history.replaceState(null, "", path);
            else history.pushState(null, "", path);
        }
        leaveGuard = null;
        current = path;
        // The token is what makes a slow route harmless. Every render increments
        // it, and a handler that resolves after a newer navigation has started
        // throws its result away instead of painting over the newer screen. This
        // is not a theoretical concern: every page here loads from IndexedDB,
        // and a device that has been asleep can take long enough that a fast
        // double tap genuinely reorders the two.
        const mine = ++token;
        render(path)
            .catch((err) => {
                console.error("route failed", err);
            })
            .finally(() => {
                if (mine !== token) return;
                scrollTo(0, 0);
            });
    };

    // Only for a deliberate move. A popstate is the browser's own Back and is
    // reported to the page as something the user already did.
    const guard = fromHistory ? null : leaveGuard;
    if (!guard) {
        move();
        return;
    }

    const allowed = guard(path);
    if (allowed === false) return;
    if (allowed && typeof allowed.then === "function") {
        allowed
            .then((ok) => { if (ok !== false) move(); })
            // A guard that throws is treated as "stay here". The alternative —
            // navigating anyway — means a broken guard loses the reader's place
            // in an exercise, and staying costs one tap on the link again.
            .catch(() => {});
        return;
    }
    move();
}

async function render(path) {
    const pathname = path.split("?")[0];
    const query = new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");
    const route = match(pathname);
    await renderFn({ route, pathname, query, path });
}