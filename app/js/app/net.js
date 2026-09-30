// Talking to the API.
//
// One function does every request, and there are four things it must get right
// that a bare `fetch` does not:
//
//   * A TIMEOUT. `SYNC_REQUEST_TIMEOUT_MS` exists because a request that never
//     settles leaves the sync run suspended forever: the flag that keeps two
//     runs from overlapping is only released in the `finally` of a call that
//     never returns, so every later attempt finds sync "busy" and does nothing
//     while the app goes on showing "syncing". A captive portal that accepts the
//     connection and answers nothing is enough to do it. The timeout maps to the
//     SAME `network` code a real network failure produces, so the backoff that
//     already exists takes over unchanged.
//
//   * NO SECRETS ANYWHERE ELSE. `X-Key` is the auth key, and it is in this
//     function's `headers` argument. Nothing here logs the headers, the body or
//     the response — an `error.` code is thrown with no detail attached, because
//     the one place a request detail could surface is the console, and the
//     console is where it must never be.
//
//   * SAME-ORIGIN ONLY. The API is mounted under this origin, and a base URL the
//     reader typed into settings is a path, never a host. Resolving one against
//     another origin would send every question in this app to a server somebody
//     chose, which is the entire attack this app's design is against.
//
//   * ONE SHAPE OF FAILURE. Everything leaves as a `SyncError` with a `code`,
//     so there is one catch block in sync-service.js instead of one per call
//     site.

import { SyncError } from "../domain/errors.js";
import { SYNC_REQUEST_TIMEOUT_MS } from "../config.js";

/**
 * @param {string} path        same-origin path, e.g. "/api/sync/push"
 * @param {{method?: string, body?: unknown, headers?: object,
 *          timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<any>} the parsed JSON body
 */
export async function request(path, options = {}) {
    const {
        method = "GET",
        body = undefined,
        headers = {},
        timeoutMs = SYNC_REQUEST_TIMEOUT_MS,
        signal = undefined
    } = options;

    if (typeof path !== "string" || !path.startsWith("/")) {
        throw new SyncError("bad_endpoint");
    }
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) {
        throw new SyncError("bad_endpoint");
    }

    // Two aborts, one controller. `signal` is the caller's (a page going away),
    // `timeout` is ours. They are combined rather than chained so that whichever
    // fires first actually aborts the fetch — a listener added to an already
    // aborted signal does nothing, which is exactly the case where the caller
    // cancels during the timeout window.
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

    let timedOut = false;
    const onTimeout = () => { timedOut = true; };
    if (typeof controller.signal.addEventListener === "function") {
        controller.signal.addEventListener("abort", onTimeout, { once: true });
    }

    try {
        const response = await fetch(url, {
            method,
            headers: {
                Accept: "application/json",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                ...headers
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
            // Never send cookies. This app has no cookie anywhere, and
            // `credentials: "same-origin"` would let any session cookie the host
            // happens to set ride along with the auth header.
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer"
        });

        return await read(response);
    } catch (err) {
        if (timedOut) throw new SyncError("network");
        if (signal?.aborted) throw new SyncError("network");
        if (err instanceof SyncError) throw err;
        // A DNS failure, a refused connection, a CORS rejection, a body that is
        // not JSON. All of them mean the same thing to a caller: this attempt is
        // over and the data is still safe on the device.
        throw new SyncError("network");
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
}

async function read(response) {
    if (response.status === 401 || response.status === 403) throw new SyncError("unauthorized");
    if (response.status === 429) throw new SyncError("rate_limited");
    if (response.status >= 500) throw new SyncError("server");

    const text = await response.text();
    if (!response.ok) {
        // A 4xx from this API means the request was wrong, not the network.
        // `bad_response` is deliberately a separate code from `server` so a
        // mismatch does not back off as though the connection were flaky.
        throw new SyncError("bad_response");
    }
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        throw new SyncError("bad_response");
    }
}

/** Whether the device is online enough to be worth trying. Advisory only — it
 *  is asked before a push to avoid a pointless request, never used to decide
 *  whether a record is saved. */
export function looksOnline() {
    return navigator.onLine !== false;
}