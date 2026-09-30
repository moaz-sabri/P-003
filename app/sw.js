// The cache name carries the app version ON PURPOSE. With a fixed name the
// `activate` handler below can never clear anything — it only deletes caches
// whose name differs from CACHE, and CACHE never differs from itself — so a
// browser kept serving the bundle from the release it first installed, and a
// rebuilt fix appeared to have no effect.
//
// Bumping the version here (together with APP_VERSION in app/js/config.js, which
// tests/config.test.mjs keeps equal to package.json) gives every release its own
// cache, and the previous one is deleted on activation.
//
// The build's asset names carry a content hash, so a release that changes no
// version number still asks the network for a file it has never seen. What a
// version bump still buys is the sweep: the previous release's hashed assets stay
// in the cache until the next one deletes the whole thing, which is the right
// trade for a handful of files on a device that is usually offline anyway.
const CACHE = "recall-v1.0.0";

// The ONE key the app shell is filed under, whatever path the navigation that
// fetched it happened to use. Without a canonical key, a deep link (`/questions`,
// opened from a home-screen shortcut or a bookmark while offline) would cache the
// shell under that path and never be able to find it again, and forty routes
// would mean forty copies of one document in the one store nothing evicts.
const SHELL = "/index.html";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
])));

// WHAT MAY BE CACHED — an allowlist of the offline app, and nothing else.
//
// This is deliberately a list of the things the app needs to boot with no
// network, rather than a list of things it must not cache. An allowlist is the
// only version of this rule that stays true as the app grows: a deny-list has to
// be right about every request the app will ever make, and one forgotten entry is
// a copy of a user's questions sitting in Cache Storage — which, unlike a response
// cache, nothing evicts but a new release and nothing scopes but the origin.
//
// `/api/` is therefore excluded twice over, once by the allowlist and once by an
// explicit guard, because the API is the one path where the user's data passes
// through and the guard is what states that as a rule rather than as a
// consequence.
//
// The user's data is never cached here in any case: it lives in IndexedDB, which
// this worker does not touch, and it travels encrypted.
const OFFLINE_PREFIXES = ["/dist/", "/icons/"];

function cacheable(request) {
    const url = new URL(request.url);
    if (url.origin !== location.origin) return false;
    if (url.pathname.startsWith("/api/")) return false;
    if (url.pathname === SHELL || url.pathname === "/") return true;
    if (url.pathname === "/manifest.webmanifest") return true;
    return OFFLINE_PREFIXES.some(prefix => url.pathname.startsWith(prefix));
}

// WHETHER A RESPONSE IS THE APP — the question that decides whether an installed
// app opens or shows a proxy's error page.
//
// A resolved fetch is not a successful one: a reverse proxy in front of a home
// server answers 502, a host mid-deploy answers 503, a captive portal answers
// 302 to a login page, and an unbuilt checkout answers 503 with a page that says
// to run `npm run build`. Storing nothing and handing the error straight to the
// page leaves the installed app's window full of somebody else's error, with the
// real shell sitting in Cache Storage the whole time — because the `.catch()` that
// looks there was only ever reached by a request that failed to leave the device.
//
// So a response is only the app if it is OK, and — for a navigation — if it is
// actually a document. The content-type check is not pedantry: a captive portal
// and several proxies answer with 200 and their own HTML, and a shell swapped for
// a proxy's login form is a white page with a password box on it.
function usable(r, navigation) {
    if (r.type === "opaque" || r.type === "opaqueredirect") return false;
    if (!r.ok) return false;
    if (!navigation) return true;
    const type = (r.headers.get("content-type") || "").toLowerCase();
    return type.includes("text/html") || type.includes("application/xhtml+xml");
}

// Write a response, and file the shell under its one canonical key as well.
//
// The put is AWAITED, which the fire-and-forget version was not, and that is the
// difference between "the shell is cached" and "the shell is still being cached
// when the page goes away". A reload throws the old document away immediately,
// and an un-awaited `caches.open().then(put)` is very often killed with it.
//
// Both clones are taken before either put is called: a Response can only be
// cloned while its body is still unread, and `cache.put` starts reading as soon
// as it is handed one.
async function store(request, response, navigation) {
    try {
        const a = response.clone();
        const b = navigation ? response.clone() : null;
        const cache = await caches.open(CACHE);
        await cache.put(request, a);
        if (b) await cache.put(SHELL, b);
    } catch {
        // A full quota, a private-mode refusal, a browser that closed the cache
        // underneath us. None of that is a reason to fail the navigation the
        // response was already fetched for.
    }
}

self.addEventListener("fetch", e => {
    if (e.request.method !== "GET") return;
    if (new URL(e.request.url).origin !== location.origin) return;
    if (new URL(e.request.url).pathname.startsWith("/api/")) return;

    // A NAVIGATION is a request for the app shell whatever the path says — the
    // app is one document and the router picks the view from the URL — so every
    // navigation is answered here, including one at a path that is not on the
    // allowlist. What may be STORED stays allowlisted, one line below.
    const navigation = e.request.mode === "navigate";
    const storable = cacheable(e.request);
    if (!navigation && !storable) return;

    // Network-first, so a deployed update is picked up on the next load. The
    // response is still written to the cache for offline use.
    e.respondWith((async () => {
        let r = null;
        try {
            r = await fetch(e.request);
        } catch {
            r = null;   // offline, or the request never left the device
        }

        if (r && usable(r, navigation)) {
            if (r.status === 200 && storable) await store(e.request, r, navigation);
            return r;
        }

        // A miss stays a miss for an ASSET, and serving the shell in answer to a
        // failed request for a built asset hands the browser HTML to parse as
        // JavaScript. A copy we DO hold is better than either: the name is
        // content-hashed, so a held copy is the right bytes.
        if (!navigation) {
            const held = await caches.match(e.request, { ignoreSearch: true });
            if (held) return held;
            return Response.error();
        }

        // The shell is one document filed under SHELL, but the lookup still
        // starts at the requested path: a shell cached under `/` by an older
        // release of this worker is still a shell, and this is what finds it
        // during the one load that happens before the canonical write.
        // `respondWith(undefined)` renders an empty document, with no error
        // anywhere, and the app looks like it simply did not start — so a real
        // miss is reported as a miss instead.
        for (const key of [e.request, SHELL, "/"]) {
            const m = await caches.match(key, { ignoreSearch: true });
            if (m) return m;
        }
        return Response.error();
    })());
});
