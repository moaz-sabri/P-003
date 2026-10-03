// The entry point: boot, then draw whatever the URL says.
//
// Four jobs, in this order, and the order is the whole file:
//
//   1. LANGUAGE, before anything is drawn. A string table is read by every screen,
//      so a page rendered before the stored language is known is a page half in
//      the wrong language until something happens to redraw it.
//   2. IDENTITY, before the router. Whether this device has a key decides what the
//      first screen IS, and that is a question about storage — not about the URL —
//      so it is asked once here rather than inside every page.
//   3. THE ROUTER, which renders into `#app` and owns the URL.
//   4. EVERYTHING OPTIONAL. The sync scheduler and the service worker are started
//      after the first screen is on its way, because neither is needed to read a
//      question and both can fail on a device this app still works on.
//
// THE DESTRUCTURED SWITCH IS HERE BECAUSE THE LANGUAGE LISTENER IS HERE. Both
// calls are the same one from the settings page's point of view — "the language
// changed, draw again" — and they differ only in whether the URL is replaced. A
// deep link opened in Arabic and then switched to English should keep its address.

import { startRouter, go, currentPath, match } from "./app/router.js";

import { startFlush } from "./app/flush.js";
import { registerServiceWorker } from "./app/sw-register.js";
import { setState, getState } from "./app/bus.js";
import { loadLanguage, getLanguage, onLanguageChange, direction } from "./i18n/i18n.js";
import { renderNav, applyDocumentLanguage } from "./ui/nav.js";
import * as identity from "./services/identity-service.js";
import * as toast from "./ui/toast.js";
import { mount } from "./ui/dom.js";
import { render as identityScreen } from "./ui/identity-screen.js";

import { render as home } from "./ui/pages/home.js";
import { render as goal } from "./ui/pages/goal.js";
import { render as goalView } from "./ui/pages/goal-view.js";
import { render as goalContent } from "./ui/pages/goal-content.js";
import { render as archive } from "./ui/pages/archive.js";
import { render as questions } from "./ui/pages/questions.js";
import { render as questionEdit } from "./ui/pages/question-edit.js";
import { render as groups, renderGroup } from "./ui/pages/groups.js";
import { render as library, renderPack } from "./ui/pages/library.js";
import { render as exercise } from "./ui/pages/exercise.js";
import { render as exerciseBuild } from "./ui/pages/exercise-build.js";
import { render as result } from "./ui/pages/result.js";
import { render as reports } from "./ui/pages/reports.js";
import { render as settings } from "./ui/pages/settings.js";
import { render as notFound } from "./ui/pages/not-found.js";

/* --------------------------------- pages ----------------------------------- */

/** The route table, mirrored from app/router.js's patterns. Both files list the
 *  paths, and neither can read the other: the router matches strings and knows
 *  nothing about modules, while this one holds the imports that must not be in
 *  the router's chunk. A path added to one and not the other shows up as the 404
 *  page, which is the cheapest possible failure for a table this small — a wrong
 *  handler would be worse. */
const PAGES = {
    home,
    // `/goal` with no id is the list-and-create page; with an id it is that one
    // goal. Two handlers rather than one page branching on `params`, because the
    // two have nothing in common but the heading and a branching page grows a
    // branch for every future difference.
    goal,
    "goal-view": (ctx) => goalView(ctx),
    // What a goal draws on. It is its own screen rather than a section of the goal
    // page because the picker lists every question on the device, and four hundred
    // rows do not belong inside a page whose subject is one goal's four numbers.
    "goal-content": (ctx) => goalContent(ctx),
    archive,
    questions,
    // Both question paths are the same page and the same handler. The difference
    // between "add" and "edit" is whether the matched route carries an id, and
    // that is the route's own business — deciding it here meant passing a second,
    // differently-shaped context to one page and the router's context to the other,
    // and the page then read `params` from whichever it was given.
    "question-new": (ctx) => questionEdit(ctx),
    "question-edit": (ctx) => questionEdit(ctx),
    // Same arrangement: the group list, and one group.
    groups,
    "group-view": (ctx) => renderGroup(ctx),
    // And the same arrangement again: the library of ready-made sets, and one set. A set
    // has a name and an id rather than an id alone, which is why the second handler is
    // separate — the list needs no argument and the set needs the id from the path.
    library,
    "library-pack": (ctx) => renderPack(ctx),
    // RUNNING an exercise. The id is in the path and is required; there is no
    // handler for a bare `/exercise`, because choosing which goal to act on is a
    // decision the goal page makes from `domain/goal-action.js` and this screen has
    // nothing to add to it.
    exercise: (ctx) => exercise(ctx),
    "exercise-build": (ctx) => exerciseBuild(ctx),
    result: (ctx) => result(ctx),
    reports,
    settings
};

/* -------------------------------- rendering -------------------------------- */

/** The page currently on screen, so its `destroy` can be called. A module-level
 *  variable rather than something on the container: the router's token discards a
 *  slow render's result, and a discarded render must NOT have destroyed the page
 *  that is already on screen. */
let mounted = null;
let mounting = 0;

async function renderRoute(ctx) {
    const { route, path } = ctx;
    const page = route ? PAGES[route.name] : notFound;

    if (!route) {
        // A URL that matches nothing is drawn as the 404 page, and the URL stays
        // as it is. Rewriting it to "/" would make the address bar agree with the
        // screen by lying about where the reader is, and Back would then go to the
        // wrong page.
        replace(page, null);
        return;
    }

    // The exercise page is reached with an id in the path on some deep links and
    // without it on others; the handler receives the whole context and reads what
    // it needs, so nothing is unpacked here.
    replace(page, { ...ctx, route });
}

async function replace(page, context) {
    const mine = ++mounting;
    let next;
    try {
        next = context ? await page(context) : await page();
    } catch (err) {
        if (mine !== mounting) return;
        console.error("page failed", err);
        toast.error(err);
        next = { node: document.createDocumentFragment() };
    }

    // Two renders can be in flight at once — the router starts one, a language
    // change starts another, and a slow IndexedDB read can finish them out of
    // order. The later one wins and the earlier one's result is thrown away whole,
    // `destroy` included: destroying the discarded page would take down the screen
    // that replaced it.
    if (mine !== mounting) return;

    const previous = mounted;
    mounted = next;
    previous?.destroy?.();
    mount(document.getElementById("app"), next.node);
    renderNav(currentPath());
}

/* ------------------------------- first run --------------------------------- */

/** Is there anything to show before an identity exists? The identity screen has
 *  no URL of its own, so this is a flag rather than a path. */
let needsIdentity = false;

async function renderIdentity(ctx) {
    replace(() => identityScreen({
        ...ctx,
        // `onReady` is where the app starts for real. `go("/", {replace: true})`
        // rather than a push: the setup screen was never an address the reader
        // chose, and Back leading into it would be a screen with no way forward.
        onReady: async () => {
            needsIdentity = false;
            const envelope = await identity.getIdentity().catch(() => null);
            setState({ hasIdentity: Boolean(envelope), spaceId: envelope?.spaceId ?? null });
            go("/", { replace: true });
        }
    }), null);
}

/* ---------------------------------- boot ----------------------------------- */

async function boot() {
    const language = await loadLanguage();
    applyDocumentLanguage(language, direction());
    setState({ language, dir: direction() });
    renderNav(location.pathname);

    needsIdentity = !(await identity.hasIdentity());
    setState({ hasIdentity: !needsIdentity, ready: true });

    // Redrawing on a language change rather than swapping text nodes: every string
    // on the screen comes from the tables, and a page that updated its own labels
    // would have to know which of its nodes hold text. Navigation is redrawn here
    // too, and `replace` does it as a side effect of every render — but a change
    // with no render (a page that is still loading) still needs it, so it is not
    // left to `replace` alone.
    onLanguageChange((code) => {
        applyDocumentLanguage(code, direction());
        setState({ language: code, dir: direction() });
        renderNav(currentPath());
        void renderRoute({ route: match(currentPath()), path: currentPath() });
    });

    startRouter((ctx) => (needsIdentity ? renderIdentity(ctx) : renderRoute(ctx)));

    // Both of these are allowed to fail. A device with no service worker still
    // runs the whole app — the data is in IndexedDB, not behind a request — and a
    // sync scheduler with a broken timer is no worse than no scheduler, because
    // nothing is lost by not syncing: the dirty flags stay where they are.
    startFlush();
    registerServiceWorker();

    if (getState().hasIdentity) await syncOnceIfReady();
}

/** One opportunistic sync on a cold open. `syncNow` refuses itself when sync is
 *  off, unconfigured or backing off, so this costs nothing when it cannot work;
 *  it is here rather than left to the scheduler's interval because the first run
 *  after opening is the one a reader is waiting for, and waiting thirty seconds
 *  for it is the difference between "it works" and "it is broken". */
async function syncOnceIfReady() {
    const { syncNow } = await import("./services/sync-service.js");
    const result = await syncNow({ reason: "open" }).catch(() => ({ ok: false }));
    if (result.ok && result.pushed) toast.show("toast.synced");
}

boot().catch((err) => {
    // The last thing this file can do. The shell is already on screen with its
    // header and navigation, so the failure is reported where the reader is
    // rather than as a blank page.
    console.error("boot failed", err);
    toast.error(err);
});