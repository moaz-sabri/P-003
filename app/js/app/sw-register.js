// Registering the service worker.
//
// The worker is at the ROOT (`/sw.js`), not under the bundle directory, for two
// reasons: a worker's scope is its own path, so one under `/dist/` could control
// nothing above `/dist/` and every navigation would be uncached; and its own name
// cannot carry a content hash, so the version in its `CACHE` constant is the only
// thing that makes a new release take over (see the comment at the top of
// app/sw.js).
//
// Registration is deliberately not awaited before the app runs. A first visit on
// a slow connection would otherwise spend its time waiting for a worker that the
// page does not need in order to work — the app is fully functional with no worker
// at all, since the data is in IndexedDB and not behind a request. It is
// registered in the background and, once active, the worker claims the clients it
// missed (app/sw.js calls `clients.claim()` on activate).

export async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;

    // A page served from the file system, or an insecure origin, refuses to
    // register. `localhost` is a secure origin, so development over
    // http://127.0.0.1 works and a real deployment over http:// does not — which
    // is the correct outcome and the reason docker-compose publishes the app over
    // TLS by default rather than leaving it as a choice.
    try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
            scope: "/",
            // Not `updateViaCache: "none"`: a worker script is not served with a
            // long cache lifetime, and asking the browser not to use its HTTP cache
            // for it costs a conditional request on every launch for a file that
            // is a few kilobytes.
        });
        return registration;
    } catch {
        // No worker. Everything except working offline still works, and an app
        // that refuses to start because a worker would not install is strictly
        // worse than one that does not install it.
        return null;
    }
}

/** Remove every worker and cache this origin has registered.
 *
 *  The "forget this device" action calls this before deleting the database. The
 *  database is the user's data and deleting it is the point; the CACHE is the app's
 *  own copy of its own files, and leaving it means the next thing served on this
 *  origin is an old release of an app that no longer has a key — which is a state
 *  nobody can leave. */
export async function unregisterServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
    } catch {
        // Nothing to do. The database deletion is the part that matters and it has
        // its own error path.
    }
    try {
        if (typeof caches !== "undefined") {
            const keys = await caches.keys();
            await Promise.all(keys.map((key) => caches.delete(key)));
        }
    } catch {
        // Private mode, or a browser with no Cache Storage. Neither is a reason to
        // refuse to forget the data.
    }
}