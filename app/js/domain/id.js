// Record ids.
//
// A UUID from the platform, generated on the device that creates the record and
// never re-generated. This matters more than it looks: sync merges two devices'
// writes, and a merge needs an identity that is the same on both sides without
// anybody having to ask the server what the next number is. Sequential ids would
// make two offline devices collide on every record they both created.
//
// Prefixed (`g_`, `q_`, `o_`, `x_`, `e_`, `a_`, `it_`) rather than bare, because
// an id is also something a human may end up reading — in a console, in an
// exported backup file, in a support message — and a prefix says which table it
// came from without a lookup. The prefix is part of the id; nothing strips it.

/** @type {Record<string, string>} */
const PREFIXES = {
    goal: "g_",
    question: "q_",
    option: "o_",
    exercise: "x_",
    exerciseItem: "it_",
    attempt: "a_"
};

/**
 * A new id for a record kind.
 *
 * `crypto.randomUUID()` or nothing. There is no counter fallback and there is no
 * timestamp-based fallback: both of those produce ids that collide across two
 * devices that were offline at the same moment, and the collision is silent
 * until a sync has already overwritten somebody's question with somebody else's.
 *
 * @param {keyof typeof PREFIXES} kind
 */
export function newId(kind) {
    const prefix = PREFIXES[kind];
    if (!prefix) throw new RangeError(`unknown record kind: ${kind}`);
    return `${prefix}${globalThis.crypto.randomUUID()}`;
}

/**
 * Whether a value has the shape of an id of this app.
 *
 * Used on every value that comes back from the API, before it is written into
 * IndexedDB. Sync is the only boundary where a server decides what a record's id
 * is, and an id is the one field a client cannot repair for itself afterwards —
 * a bad one is a record nothing can ever be found by again.
 */
export function isId(value) {
    if (typeof value !== "string") return false;
    return Object.values(PREFIXES).some(
        (prefix) => value.length === prefix.length + 36 && value.startsWith(prefix)
    );
}

/**
 * This installation's own id, generated once and stored in `meta`.
 *
 * Not a record id and not in PREFIXES: it never appears as a primary key, it is
 * never sent as an id, and it must be distinguishable from every record so that
 * a `device` field read as an id fails loudly instead of matching one.
 *
 * Its only job is to break a tie. Two phones writing the same question in the
 * same millisecond is ordinary, and `updatedAt` alone cannot say which one won —
 * and a merge that picks a different winner on each device leaves the two
 * disagreeing forever, flipping the question back and forth on every sync.
 */
export function newDeviceId() {
    return `dev_${globalThis.crypto.randomUUID()}`;
}