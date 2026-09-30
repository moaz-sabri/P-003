// A tiny publish/subscribe, for the four things that are true across screens.
//
//  * the language changed — every string on the page is now wrong
//  * sync finished, or failed, or is running
//  * a record changed underneath a screen that is already drawn
//  * the device's identity appeared or was forgotten
//
// Which is a short list on purpose. There is no store of the application's data
// here: each page loads what it needs from the repositories when it is rendered.
// A shared cache of the data would have to be invalidated by every write in
// every repository, and a cache that is one write behind is the difference
// between "I deleted that" and "I deleted that, and it is still there".
//
// So this holds only facts about the device, and pages subscribe to those.

const listeners = new Set();

export const state = {
    /** "checking" until the boot sequence has decided. */
    ready: false,
    hasIdentity: false,
    spaceId: null,
    language: "en",
    dir: "ltr",
    /** "off" | "on" | "error" — whether sync is configured and permitted. */
    syncMode: "off",
    syncStatus: "idle",
    syncError: null,
    syncPending: 0,
    lastSyncAt: null
};

export function getState() {
    return state;
}

export function setState(patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
        if (state[key] === value) continue;
        state[key] = value;
        changed = true;
    }
    if (changed) emit(patch);
    return state;
}

export function onState(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    // A copy: a listener that unsubscribes another while this is running would
    // otherwise mutate the set being walked, which in JavaScript skips the
    // element after the removed one.
    for (const fn of [...listeners]) {
        try {
            fn(state);
        } catch (err) {
            // A screen that throws while being told about the language must not
            // stop the other screens from hearing it. The error is re-reported
            // rather than swallowed — the throw has to be visible somewhere, and
            // the console is where a bug in a render belongs.
            console.error("state listener failed", err);
        }
    }
}