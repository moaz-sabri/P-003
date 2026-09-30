// What lives where, as data rather than as code.
//
// data/migrations.js creates the schema and data/repos.js reads and writes
// through hand-written cursors, and both of them need the same list: the sync
// layer has to know which stores are worth pushing (and must never push `meta`
// or `keys`), and tests/data.test.mjs compares this list against the schema so
// that a store added to one and forgotten in the other cannot pass.
//
// `sync: false` is not a comment. `meta` holds the sync cursor itself, and
// pushing it would have the server hand back a cursor the device did not have;
// `keys` holds the non-extractable CryptoKey, which cannot be structured-cloned
// into JSON and must never leave the device under any circumstances. Both are
// listed as unsynced rather than kept out of the map, because the sync layer
// iterates this map and "not in the list" is indistinguishable from a typo.

export const STORE = {
    GOALS: "goals",
    QUESTIONS: "questions",
    OPTIONS: "options",
    EXERCISES: "exercises",
    EXERCISE_ITEMS: "exerciseItems",
    ATTEMPTS: "attempts",
    META: "meta",
    KEYS: "keys"
};

/** Every store name, in the order a schema is created. */
export const ALL_STORES = [
    STORE.GOALS,
    STORE.QUESTIONS,
    STORE.OPTIONS,
    STORE.EXERCISES,
    STORE.EXERCISE_ITEMS,
    STORE.ATTEMPTS,
    STORE.META,
    STORE.KEYS
];

/** The stores whose records travel to the API, and nothing else. */
export const SYNCED_STORES = [
    STORE.GOALS,
    STORE.QUESTIONS,
    STORE.OPTIONS,
    STORE.EXERCISES,
    STORE.EXERCISE_ITEMS,
    STORE.ATTEMPTS
];

const SYNCED = new Set(SYNCED_STORES);

/**
 * The index each store is read through, per access pattern. A repository that
 * wants a different access pattern says so in its own file rather than adding a
 * column here, so that this stays a table of "how things are actually read"
 * rather than a wish list.
 */
export const QUERIES = {
    activeGoal: { store: STORE.GOALS, index: "status", value: "active" },
    goalQuestions: { store: STORE.QUESTIONS, index: "goalId" },
    questionOptions: { store: STORE.OPTIONS, index: "questionId" },
    goalExercises: { store: STORE.EXERCISES, index: "goalId" },
    exerciseItems: { store: STORE.EXERCISE_ITEMS, index: "exerciseId" },
    questionItems: { store: STORE.EXERCISE_ITEMS, index: "questionId" },
    exerciseAttempts: { store: STORE.ATTEMPTS, index: "exerciseId" },
    questionAttempts: { store: STORE.ATTEMPTS, index: "questionId" },
    recentAttempts: { store: STORE.ATTEMPTS, index: "answeredAt" }
};

export function isSynced(storeName) {
    return SYNCED.has(storeName);
}

/* --------------------------------- fields --------------------------------- */

/** meta keys, in one place because a misspelled key is a setting that silently
 *  never saves. `device` is generated once per installation and is what breaks
 *  the `updatedAt` tie in the sync merge. */
export const META_KEY = {
    LANGUAGE: "language",
    DEVICE: "device",
    SYNC_CURSOR: "syncCursor",
    SYNC_CONFIG: "syncConfig",
    SYNC_LAST_AT: "lastSyncAt",
    LAST_BACKUP_AT: "lastBackupAt",
    ONBOARDED_AT: "onboardedAt"
};

/** The single row in the `keys` store. */
export const KEY_IDENTITY = "identity";