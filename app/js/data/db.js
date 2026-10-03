// The database, and the transaction rules that everything else obeys.
//
// There is one promise for the connection and one function for every write, and
// both exist for the same reason: IndexedDB auto-commits a transaction the
// moment the event loop gets control back and there are no requests in flight.
// That is not a rule anybody can hold in their head while writing an app, so it
// is enforced here instead.
//
// The failure it prevents is this one, and it is silent. A repository writes a
// record, then awaits something — a crypto call, a network round trip, another
// IndexedDB store's read — and by the time it comes back the transaction has
// committed. Every request after that throws InvalidStateError, and if the code
// around it has a catch, the write is reported as done while the rest of it was
// never applied. The result is a half-written exercise that looks complete until
// the page is reloaded.
//
// So:
//   * `fn` must be a SYNCHRONOUS function. An async one is refused by name
//     rather than left to fail later, because the failure mode above has no
//     useful error message at the point it happens. A promise it RETURNS is
//     fine and is what every repository in repos.js does — the value is held
//     until the commit rather than delivered early.
//   * every request wrapper calls `assertActive()` first, so the attempt that
//     has outlived the transaction is reported as the bug it is
//     (TransactionInactiveError) instead of as whatever the browser said.
//   * `fn`'s RETURN value is delivered when the transaction actually commits, not
//     when `fn` returns. A repository that returns the id of the row it just
//     wrote therefore cannot hand back an id for a write that rolled back — and
//     a callback still waiting at commit time is an error rather than an
//     `undefined` that reads like a successful no-op.

import { DB_VERSION, MIGRATIONS } from "./migrations.js";
import { DB_NAME } from "../config.js";
import { TransactionInactiveError } from "../domain/errors.js";

let connection = null;
let opening = null;

function indexedDBFactory() {
    const factory = globalThis.indexedDB;
    if (!factory) {
        throw new Error("IndexedDB is unavailable");
    }
    return factory;
}

/** The open database, opened once. Concurrent callers share one open: two
 *  `open()` calls race on the version change, and the loser is blocked by the
 *  winner's own connection rather than by anything either of them did. */
export function openDb() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;

    opening = new Promise((resolve, reject) => {
        const request = indexedDBFactory().open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = request.result;
            // THE UPGRADE TRANSACTION IS HANDED TO EACH STEP, and that is not a
            // convenience. Adding an index to a store that already exists means
            // calling `createIndex` on an IDBObjectStore, and the only handle to
            // one is `transaction.objectStore(name)` — and `db.transaction(...)`
            // inside `onupgradeneeded` throws `InvalidStateError: A version change
            // transaction is running`, because the connection already has one
            // open. There is no way to add an index to a live store without this,
            // which is why `apply` takes two arguments rather than one.
            const tx = request.transaction;
            // Only the steps above the version the database was actually at.
            // The `event.oldVersion` guard is what makes adding version 2 safe on
            // a device that already ran version 1 — without it, step 1 would run
            // again over existing stores and fail.
            for (const step of MIGRATIONS) {
                if (step.version <= event.oldVersion) continue;
                if (step.version > event.newVersion) break;
                step.apply(db, tx);
            }
        };

        request.onsuccess = () => {
            const db = request.result;
            // Another tab upgrading (or the user pressing "reset this device" in
            // it) would otherwise block forever with no message in this one. The
            // database is per-origin, not per-tab: this tab is holding a
            // connection to a schema that is about to change under it.
            db.onversionchange = () => {
                db.close();
                connection = null;
                opening = null;
            };
            connection = db;
            resolve(db);
        };

        request.onerror = () => {
            opening = null;
            reject(request.error ?? new Error("could not open the database"));
        };

        request.onblocked = () => {
            // Not an error: another tab has an old connection open. The open
            // resolves once it goes away, which is the correct behaviour — but
            // there is nothing to tell the user yet, because from here it might
            // still succeed.
        };
    });

    return opening;
}

/** Close the connection. Used by the reset path, and by nothing else: every
 *  other caller wants the same connection. */
export async function closeDb() {
    if (opening) {
        try {
            await opening;
        } catch {
            // A failed open has nothing to close.
        }
    }
    const db = connection;
    connection = null;
    opening = null;
    if (db) db.close();
}

/** Delete the whole database. This is the "forget everything on this device"
 *  action, and it is the ONLY way any key material leaves storage — there is no
 *  unencrypt, no export of the derived key, and no way to ask for the master key
 *  back in the clear. */
export function deleteDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDBFactory().deleteDatabase(DB_NAME);
        request.onsuccess = () => {
            connection = null;
            opening = null;
            resolve(undefined);
        };
        request.onerror = () => reject(request.error ?? new Error("could not delete the database"));
        // Deliberately no onblocked: a blocked delete means another tab is open,
        // and there is nothing safe for this one to do about it — the data is
        // still there and saying otherwise would be a lie.
    });
}

/* -------------------------------- requests -------------------------------- */

function toPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("request failed"));
    });
}

/**
 * Run `fn` inside one transaction over `storeNames` and resolve with what it
 * returned, once — and only once — the transaction has committed.
 *
 * `fn` MAY RETURN A PROMISE, and it may be a long chain of them. Every repository
 * in data/repos.js is written that way — `db.get(…).then(row => db.put(…))` — and
 * that is not a style preference: sequencing two requests inside one transaction
 * REQUIRES chaining, because an `await` on the first one lets the transaction
 * auto-commit. So the promise is read here and the result is held until the
 * transaction commits, which gives both halves of what the repositories need:
 * arbitrary request sequencing inside, and a value that is only delivered once the
 * write is durable outside.
 *
 * What it still refuses is an `async` callback. A promise returned by a
 * synchronous function can only settle from IndexedDB requests or from a rejection
 * this function caused, whereas an `async` function suspends at its first `await`
 * on something the transaction knows nothing about — and then the failure surfaces
 * two lines later as "The transaction associated with this request is complete",
 * which points at IndexedDB rather than at the await that caused it.
 *
 * The two ways a repository can still break the rules are both caught here rather
 * than left to the browser:
 *
 *   * awaiting a fetch or a timer — the transaction commits underneath it, the
 *     next request throws from `assertActive()`, and the callback's rejection
 *     aborts the transaction with THAT error rather than with the browser's;
 *   * returning a promise that outlives the transaction — the transaction commits
 *     while the callback is still waiting, and resolving with an `undefined` the
 *     caller would read as "wrote nothing, all fine" is the one outcome worse
 *     than an error, so it is reported as the bug it is.
 *
 * @param {string|string[]} storeNames
 * @param {"readonly"|"readwrite"} mode
 * @param {(tx: IDBTransaction, api: object) => any} fn  MUST be synchronous
 */
export async function withTx(storeNames, mode, fn) {
    if (typeof fn !== "function") throw new TypeError("withTx needs a function");

    // Named rather than silently tolerated. See above: an `async` callback is the
    // single most likely way to break the transaction rules, and this is where it
    // is cheapest to say so.
    if (fn.constructor && fn.constructor.name === "AsyncFunction") {
        throw new TypeError("withTx callback must not be async: the transaction closes while it awaits");
    }

    const db = await openDb();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];

    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = db.transaction(names, mode);
        } catch (err) {
            reject(err);
            return;
        }

        // `settled` guards against the three ways this promise can be answered
        // twice: `onabort` after an explicit `tx.abort()` in `fail` below,
        // `onerror` (which is followed by `onabort`) for a request that failed on
        // its own, and `oncomplete` for a transaction that committed before the
        // callback's own promise settled.
        let settled = false;
        // What `fn` resolved with, and whether it resolved at all. `finished` is
        // what separates "the callback returned a value" from "the callback is
        // still waiting for something the transaction knows nothing about".
        let value;
        let finished = false;
        // A rejection from `fn`, held until the abort it caused has landed. It is
        // kept rather than rejected immediately so that the caller is told the
        // repository's own error (`not_found`, `storage`) instead of the
        // AbortError the abort itself produces.
        let failure = null;

        const api = makeApi(tx);

        tx.oncomplete = () => {
            if (settled) return;
            settled = true;
            connection = db;   // a successful open is now the settled connection
            if (failure) {
                reject(failure);
                return;
            }
            // The transaction committed while `fn`'s promise was still pending, so
            // the value it was going to return is not something this caller can be
            // given. `undefined` would read as "nothing was written" on a
            // transaction that may well have written most of it, which is the one
            // answer worse than an error.
            if (!finished) {
                reject(new TransactionInactiveError());
                return;
            }
            resolve(value);
        };

        tx.onabort = () => {
            if (settled) return;
            settled = true;
            reject(failure ?? tx.error ?? new Error("transaction aborted"));
        };

        tx.onerror = () => {
            // Deliberately empty. A request that fails on its own aborts the
            // transaction, and `onabort` is what reports it — with `tx.error`
            // already set and, where there is one, the repository's own rejection
            // taking precedence. Rejecting here as well would settle the promise
            // before `onabort` could add that, and would win the race with it.
        };

        /** Abort with `err` as the reason, keeping `err` for the caller. */
        const fail = (err) => {
            if (settled) return;
            failure = err;
            try {
                tx.abort();
            } catch {
                // Already committed or already aborted; `oncomplete`/`onabort` below
                // still runs and settles this, carrying `failure` with it.
            }
        };

        try {
            const returned = fn(tx, api);
            if (returned && typeof returned.then === "function") {
                returned.then(
                    (result) => { value = result; finished = true; },
                    (err) => { finished = true; fail(err); }
                );
            } else {
                value = returned;
                finished = true;
            }
        } catch (err) {
            finished = true;
            fail(err);
        }
    });
}

/** The request wrappers handed to a `withTx` callback. Every one of them checks
 *  that the transaction is still running first. */
function makeApi(tx) {
    const assertActive = () => {
        // `tx.db` is null once the transaction is finished, in every engine that
        // implements the spec, and reading it is the documented way to tell.
        if (!tx.db) throw new TransactionInactiveError();
    };

    const store = (name) => tx.objectStore(name);

    return {
        tx,
        assertActive,

        get(storeName, key) {
            assertActive();
            return toPromise(store(storeName).get(key));
        },

        getAll(storeName, query = null, count) {
            assertActive();
            return toPromise(store(storeName).getAll(query, count));
        },

        getAllKeys(storeName, query = null, count) {
            assertActive();
            return toPromise(store(storeName).getAllKeys(query, count));
        },

        /** Read through a named index. `range` may be anything IDBKeyRange
         *  accepts, which is how the bounded scans are written. */
        byIndex(storeName, indexName, range = null, count) {
            assertActive();
            return toPromise(store(storeName).index(indexName).getAll(range, count));
        },

        getByIndex(storeName, indexName, key) {
            assertActive();
            return toPromise(store(storeName).index(indexName).get(key));
        },

        count(storeName, query = null) {
            assertActive();
            return toPromise(store(storeName).count(query));
        },

        put(storeName, value) {
            assertActive();
            return toPromise(store(storeName).put(value));
        },

        add(storeName, value) {
            assertActive();
            return toPromise(store(storeName).add(value));
        },

        remove(storeName, key) {
            assertActive();
            return toPromise(store(storeName).delete(key));
        },

        clear(storeName) {
            assertActive();
            return toPromise(store(storeName).clear());
        }
    };
}

/** Read-only shorthand: a transaction that cannot write, so a bug in a query
 *  path cannot silently create a record. */
export function readTx(storeNames, fn) {
    return withTx(storeNames, "readonly", fn);
}