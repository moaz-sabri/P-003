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
    GROUPS: "groups",
    OPTIONS: "options",
    EXERCISES: "exercises",
    EXERCISE_ITEMS: "exerciseItems",
    ATTEMPTS: "attempts",
    GOAL_REFS: "goalRefs",
    META: "meta",
    KEYS: "keys"
};

/**
 * Every store name, in the order a schema is created.
 *
 * `groups` AND `goalRefs` ARE LAST, and that is not tidiness — it is what happens.
 * `groups` was added by migration 2 and `goalRefs` by migration 5, and a store
 * created by a later migration is created after every store an earlier one made.
 * Putting them next to the stores they relate to, where they read better, would make
 * this list a description of how the schema *ought* to be rather than of what the
 * browser builds, and this list is compared against that in tests/data.test.mjs
 * precisely so the two cannot disagree.
 */
export const ALL_STORES = [
    STORE.GOALS,
    STORE.QUESTIONS,
    STORE.OPTIONS,
    STORE.EXERCISES,
    STORE.EXERCISE_ITEMS,
    STORE.ATTEMPTS,
    STORE.META,
    STORE.KEYS,
    STORE.GROUPS,
    STORE.GOAL_REFS
];

/** The stores whose records travel to the API, and nothing else. */
export const SYNCED_STORES = [
    STORE.GOALS,
    STORE.QUESTIONS,
    STORE.GROUPS,
    STORE.OPTIONS,
    STORE.EXERCISES,
    STORE.EXERCISE_ITEMS,
    STORE.ATTEMPTS,
    STORE.GOAL_REFS
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
    archivedGoals: { store: STORE.GOALS, index: "archivedAt" },
    recentExercises: { store: STORE.EXERCISES, index: "createdAt" },
    /** "Which exercises contain this question" — the reverse of `exerciseItems`, and
     *  the read that makes a question independent of any one of them answerable. */
    exercisesOfQuestion: { store: STORE.EXERCISE_ITEMS, index: "questionId" },
    /** A goal's references, in the order the reader added them. This is the read that
     *  replaced "questions with this `goalId`", and it is the ONLY thing that says a
     *  goal and a question are related now. */
    goalRefs: { store: STORE.GOAL_REFS, index: "goalOrder", keyPath: ["goalId", "order"] },
    /** The other direction: which goals point at this group or this question. The
     *  group page needs it to say "used by two goals" without reading every goal on
     *  the device, and it is what makes a group deletable-with-a-warning rather than
     *  silently pulling material out of a second goal. */
    refsOf: { store: STORE.GOAL_REFS, index: "ref", keyPath: ["refType", "refId"] },
    allQuestions: { store: STORE.QUESTIONS, index: "order" },
    allGroups: { store: STORE.GROUPS, index: "order" },
    groupQuestions: { store: STORE.QUESTIONS, index: "groupId" },
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