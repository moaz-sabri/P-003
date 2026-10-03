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
//
// THE SHAPE OF THE URL IS THE MODEL.
//
// AN EXERCISE IS PART OF A GOAL, so the two halves of that live at different depths
// for different reasons, and both are deliberate:
//
//   /goal/:id                     the goal. Its plan, what it is made of, and its
//                                 exercises — the open ones with a resume button and
//                                 the finished ones with a result and a repeat button.
//                                 This is where an exercise is DECIDED.
//   /goal/:id/exercise/build      choosing what an exercise will ask. It names the
//                                 goal in the PATH rather than a `?goal=` because
//                                 there is nothing to fall back to any more: an
//                                 exercise belongs to a goal and the reader is on
//                                 that goal's page.
//   /exercise/:id                 RUNNING one. A mode rather than a page: full screen,
//                                 one question, a clock, a leave guard. The goal is not
//                                 in the URL because the exercise record carries it and
//                                 putting it in the path would create a URL that can
//                                 name a goal the exercise does not belong to.
//
// WHAT IS NOT HERE, and used to be, is `/exercise` with no id -- a screen that asked
// "what should I do" and answered it for the newest goal because the URL did not say.
// That question belonged to the goal page, which knows which goal it is about, and it
// is answered there from one decision rather than re-derived on a second screen.
//
// WHAT IS ALSO NOT HERE is any dependency between questions and a goal in a URL.
// There is no `/goal/:id/questions`: questions are not under a goal, so there is no
// such place to go. What a goal has is ATTACHMENTS, and those live on the goal's own
// page, because that is the decision they are part of.
const routes = [
    // THE LEGACY SHAPES COME FIRST, and that ordering is load-bearing rather than
    // cosmetic. `match()` returns the FIRST pattern that matches, and
    // `/exercise/([^/]+)` matches `/exercise/build` with the id "build" — so a
    // `/exercise/build` link was reaching the runner, failing to load an exercise with
    // that id, and drawing "that is not here any more". An exact literal placed after a
    // parameterised pattern is not reachable at all, which is a fact about regexes that
    // is invisible in the table itself: the route is present, looks correct, and can
    // never fire.
    //
    // Each of these was a real URL with bookmarks and history entries behind it, and
    // `/exercise/result?id=x` is still a link inside a page the service worker cached
    // last release. They are answered rather than 404'd.
    { name: "legacy-exercise", pattern: /^\/exercise$/, redirect: (p, q) => resumeHref(q) },
    // `/exercise/build` with no `?goal=` used to fall back to the newest active goal,
    // which is the "silently pick a goal" behaviour the whole restructure removed. It
    // goes to the goal LIST instead: a link with no goal in it is a link that does not
    // say what it is for, and the honest answer is the screen where one can be chosen.
    // (`/goal//exercise/build` — a doubled slash and a not-found page — is technically
    // consistent and practically a dead end.)
    { name: "legacy-build", pattern: /^\/exercise\/build$/, redirect: (p, q) => {
        const goal = q.get("goal");
        return goal ? `/goal/${goal}/exercise/build` : "/goal";
    } },
    { name: "legacy-result", pattern: /^\/exercise\/result$/, redirect: (p, q) => (q.get("id") ? `/exercise/${q.get("id")}/result` : "/") },

    { name: "home", pattern: /^\/$/ },
    { name: "goal", pattern: /^\/goal$/ },
    { name: "goal-view", pattern: /^\/goal\/([^/]+)$/, keys: ["id"] },
    { name: "goal-content", pattern: /^\/goal\/([^/]+)\/content$/, keys: ["id"] },
    // The picker. Under the goal, because a selection is a decision about that goal.
    { name: "exercise-build", pattern: /^\/goal\/([^/]+)\/exercise\/build$/, keys: ["id"] },
    // Running an exercise. The id is REQUIRED: `/exercise` on its own was the dispatch
    // screen, and it is the goal page's job now. A deep link to it lands on the home
    // page rather than on a 404, because a reader following an old bookmark wants to be
    // taken somewhere they can carry on from.
    { name: "exercise", pattern: /^\/exercise\/([^/]+)$/, keys: ["id"] },
    { name: "result", pattern: /^\/exercise\/([^/]+)\/result$/, keys: ["id"] },
    { name: "archive", pattern: /^\/archive$/ },
    { name: "questions", pattern: /^\/questions$/ },
    { name: "question-new", pattern: /^\/questions\/new$/ },
    { name: "question-edit", pattern: /^\/questions\/([^/]+)$/, keys: ["id"] },
    { name: "groups", pattern: /^\/groups$/ },
    { name: "group-view", pattern: /^\/groups\/([^/]+)$/, keys: ["id"] },
    { name: "reports", pattern: /^\/reports$/ },
    { name: "settings", pattern: /^\/settings$/ }
];

/** An old `/exercise?id=x` link is still an instruction to run exercise x, and it is
 *  the commonest of the three legacy shapes because the nav bar used to produce one. */
function resumeHref(query) {
    const id = query.get("id");
    return id ? `/exercise/${encodeURIComponent(id)}` : "/";
}

/**
 * The address a path SHOULD be, or `path` itself.
 *
 * IT IS RESOLVED IN `go()` RATHER THAN IN `render()` because a redirect that renders
 * without moving the address bar is not a redirect. `render` is reached from inside the
 * render promise, and the only way it can change the URL is `history.replaceState` plus
 * setting `current` by hand — and the first version did it through `go(..., {fromHistory:
 * true})`, which is the flag that means "do not write a history entry". So the reader was
 * shown the new page at the old address, and Reload, Back and "copy link" all went to a
 * URL that only worked because of a rule in this file.
 *
 * Resolving it first means the move below is an ordinary move: one entry written, the
 * new path in the address bar, and the page drawn from it.
 */
function resolveRedirect(path) {
    const pathname = path.split("?")[0];
    const route = match(pathname);
    if (!route?.redirect) return path;
    const query = new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");
    return route.redirect(pathname, query);
}

let renderFn = null;
let leaveGuard = null;
let current = "/";
let token = 0;

/**
 * Match a pathname to a route. `null` means the 404 page.
 *
 * `redirect` IS CARRIED THROUGH, and the reason is a bug this function had for one
 * revision: the three legacy rules declare `redirect`, and `match` returned only
 * `{name, params}`, so `route.redirect` was `undefined` and calling it threw
 * `TypeError: route.redirect is not a function` — on every old link, with the reader
 * looking at a page that had already half-replaced. The match result is the route, not
 * a summary of it; anything the table says about a route is part of what it means.
 */
export function match(path) {
    for (const route of routes) {
        const found = route.pattern.exec(path);
        if (!found) continue;
        const params = {};
        (route.keys ?? []).forEach((key, i) => { params[key] = decodeURIComponent(found[i + 1]); });
        return { name: route.name, params, redirect: route.redirect ?? null };
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
    // A REDIRECT REPLACES THE ENTRY rather than pushing onto it. A legacy link that
    // lands on `/` by pushing has put "the old address" in the history in front of where
    // the reader is now, so Back goes to a URL that redirects to the page they were just
    // on -- a trap that only closes after two Backs instead of one.
    const wanted = resolveRedirect(path);
    if (wanted !== path) {
        path = wanted;
        replace = true;
        fromHistory = false;
    }

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
