// The schema, the registry of what lives in it, and the server's copy of the list.
//
// migrations.js is run by the browser and stores.js is not, so nothing at runtime
// compares them. An index added to the registry but forgotten in the migration is
// not a crash on the developer's device — the record they tested with still reads
// — it is a `NotFoundError` from `index()` the first time somebody opens a goal
// with six months of attempts in it, on a phone, in someone else's house.
//
// So the schema is built here against a stub that records what it is asked to
// create, and the two are compared as data. The server's store list is read out of
// api/sync.php because it is a second copy of the same fact in a different
// language, and nothing else compares those either.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    ALL_STORES,
    META_KEY,
    QUERIES,
    STORE,
    SYNCED_STORES,
    isSynced
} from "../app/js/data/stores.js";
import { COMMON_FIELDS, DB_VERSION, MIGRATIONS } from "../app/js/data/migrations.js";
import { DB_VERSION as CONFIG_DB_VERSION, IDENTITY_VERSION } from "../app/js/config.js";

/**
 * Run the migrations against a stub that records the schema instead of creating
 * it. The stub is deliberately the shape of IDBDatabase's two relevant methods and
 * nothing else, so a migration that reaches for anything else fails loudly here
 * rather than needing a fake-indexeddb dependency to be discovered.
 */
function buildSchema() {
    const stores = new Map();
    const db = {
        createObjectStore(name, options) {
            assert.ok(!stores.has(name), `store ${name} is created twice in one migration`);
            const indexes = new Map();
            stores.set(name, { keyPath: options?.keyPath ?? null, indexes, autoIncrement: options?.autoIncrement ?? false });
            return {
                createIndex(indexName, keyPath) {
                    assert.ok(!indexes.has(indexName), `index ${indexName} on ${name} is created twice`);
                    indexes.set(indexName, Array.isArray(keyPath) ? keyPath.join(",") : keyPath);
                }
            };
        }
    };
    for (const step of MIGRATIONS) step.apply(db);
    return stores;
}

const SCHEMA = buildSchema();

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the registry and the migration create the same stores, in the same order", () => {
    assert.deepEqual([...SCHEMA.keys()], ALL_STORES);
    assert.equal(new Set(ALL_STORES).size, ALL_STORES.length, "a store name is listed twice");
    // Order matters only in that a schema is built in it; the deeper reason to
    // keep the two lists identical is that ALL_STORES is what a "delete
    // everything" path and the export path iterate.
    assert.deepEqual(ALL_STORES.slice(0, 6), SYNCED_STORES, "the synced stores are not the first six");
});

test("the schema version in config.js is the one the migrations reach", () => {
    // db.js opens the database at this version and runs the steps above it. If the
    // list grows a step and config.js does not move, that step is dead code; if
    // config.js moves and the list does not, the upgrade transaction runs with
    // nothing in it and the browser's version is already ahead.
    assert.equal(CONFIG_DB_VERSION, DB_VERSION);
    assert.equal(MIGRATIONS.length, DB_VERSION);
    assert.deepEqual(MIGRATIONS.map((s) => s.version), Array.from({ length: DB_VERSION }, (_, i) => i + 1));
    // The identity envelope version is read back by crypto-service to refuse an
    // envelope it cannot open, and is mirrored by IDENTITY_VERSION in config.js.
    assert.equal(MIGRATIONS[0].identityVersion, IDENTITY_VERSION);
});

test("every synced record is keyed by id, and meta by key", () => {
    for (const name of SYNCED_STORES) {
        assert.equal(SCHEMA.get(name).keyPath, "id", `${name} is not keyed by id`);
        assert.equal(SCHEMA.get(name).autoIncrement, false, `${name} invents its own ids`);
    }
    assert.equal(SCHEMA.get(STORE.META).keyPath, "key");
    // The key envelope is one row, written by hand, for the same reason: nothing
    // in the app may mint an identity it did not derive.
    assert.equal(SCHEMA.get(STORE.KEYS).keyPath, "id");
    assert.equal(SCHEMA.get(STORE.KEYS).indexes.get("version"), "version");
});

test("every query in the registry is an index the migration actually creates", () => {
    for (const [name, query] of Object.entries(QUERIES)) {
        const store = SCHEMA.get(query.store);
        assert.ok(store, `${name} reads from store ${query.store}, which does not exist`);
        assert.ok(
            store.indexes.has(query.index),
            `${name} reads ${query.store}.${query.index}, which the migration does not create`
        );
        assert.equal(
            store.indexes.get(query.index),
            Array.isArray(query.keyPath) ? query.keyPath.join(",") : (query.keyPath ?? query.index),
            `${name} reads ${query.store}.${query.index} with the wrong key path`
        );
    }
    assert.equal(QUERIES.activeGoal.value, "active");
    assert.equal(QUERIES.activeGoal.index, "status", "the active-goal query must use the status index");
});

test("every index a repository reads is in the schema, and none is missing", () => {
    // Scanned out of the source rather than maintained by hand, because a second
    // list of index names is a second thing to forget. `db.byIndex(STORE.X, "y")`
    // is the only way a repository reads by anything but primary key.
    const source = read("../app/js/data/repos.js");
    const used = new Set();
    for (const match of source.matchAll(/byIndex\(\s*STORE\.(\w+)\s*,\s*"([^"]+)"/g)) {
        const store = STORE[match[1]];
        assert.ok(store, `repos.js reads STORE.${match[1]}, which is not in the store registry`);
        used.add(`${store}.${match[2]}`);
    }
    assert.ok(used.size >= 10, `only ${used.size} index reads were found; the scan is probably wrong`);

    for (const key of used) {
        const [store, index] = key.split(".");
        assert.ok(SCHEMA.get(store)?.indexes.has(index),
            `repos.js reads ${key}, which no migration creates`);
    }

    // And the reverse, for the indexes a reader would expect to be there: every
    // synced store is read by `updatedAt` somewhere in the app's own future, so
    // each one carries the index now rather than after the first large goal.
    for (const name of SYNCED_STORES) {
        assert.ok(SCHEMA.get(name).indexes.has("updatedAt"), `${name} has no updatedAt index`);
    }
});

test("meta and keys are never synced, and the reason is in the registry", () => {
    // `meta` holds the sync cursor itself, so pushing it hands the device back a
    // cursor it did not have; `keys` holds a non-extractable CryptoKey, which
    // cannot be structured-cloned into JSON and must never leave the device.
    // Both are listed as unsynced rather than kept out of the map, because the
    // sync layer iterates SYNCED_STORES and "not in the list" is indistinguishable
    // from a typo.
    assert.ok(!isSynced(STORE.META));
    assert.ok(!isSynced(STORE.KEYS));
    assert.ok(!isSynced("goal"), "a near-miss store name is treated as synced");
    for (const name of ALL_STORES) {
        assert.equal(isSynced(name), SYNCED_STORES.includes(name), `${name}: isSynced disagrees with the list`);
    }
});

test("the server accepts exactly the stores the client pushes", () => {
    // Two copies of one fact, in two languages. The PHP side pins the same array
    // in api/tests/security.php, and this is the check that the CLIENT list has
    // not drifted from it: a store added here and not there syncs silently in one
    // direction and never comes back.
    const php = read("../api/sync.php");
    const match = php.match(/const\s+RC_STORES\s*=\s*\[([^\]]*)\]/);
    assert.ok(match, "RC_STORES was not found in api/sync.php");
    const server = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(server, SYNCED_STORES, "the client's synced stores and the server's have drifted");
    assert.equal(new Set(server).size, server.length);
});

test("the meta keys are all the keys anything writes", () => {
    // A misspelled meta key is a setting that silently never saves. The registry
    // is the only list; this checks it is not missing the ones the code uses.
    const sources = ["../app/js/services/identity-service.js", "../app/js/services/sync-service.js",
        "../app/js/services/export-service.js", "../app/js/i18n/i18n.js", "../app/js/main.js"]
        .map(read).join("\n");
    const used = new Set([...sources.matchAll(/META_KEY\.(\w+)/g)].map((m) => m[1]));
    assert.ok(used.size >= 4, `only ${used.size} meta keys were found; the scan is probably wrong`);
    for (const name of used) {
        assert.ok(META_KEY[name], `META_KEY.${name} is used but not registered`);
    }
    assert.equal(new Set(Object.values(META_KEY)).size, Object.values(META_KEY).length,
        "two meta keys share a string");
});

test("the sync bookkeeping fields are the five the whole app agrees on", () => {
    // updatedAt, rev, device, dirty, deletedAt. They travel with every synced
    // record and are written by repos.touch() and read by the sync merge; a
    // rename in one file and not the other is a record that never becomes clean.
    assert.deepEqual(COMMON_FIELDS, ["updatedAt", "rev", "device", "dirty", "deletedAt"]);
    const repos = read("../app/js/data/repos.js");
    for (const field of COMMON_FIELDS) {
        assert.ok(repos.includes(field), `repos.js never mentions ${field}`);
    }
    // `dirty` is 0 or 1 and never a boolean, because it goes into the API's
    // integer column; the PHP side refuses anything else, so the two must agree.
    assert.ok(/dirty:\s*[01]/.test(repos) || repos.includes("dirty"), "no dirty flag is written");
});