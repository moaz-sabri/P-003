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
//
// `groups` has a prefix too, and that is not a formality: `isId` is the check
// every record coming back from the API is put through before it is written, and a
// store whose ids do not match any prefix here is a store the sync merge refuses to
// store at all. Every group on a second device would be counted as "refused" and
// every question filed under one would arrive with a group id nothing recognises.
//
// `goalRef` is the same argument for the join table: a reference row is a record
// that syncs, and an id nothing recognises is a reference the other device throws
// away — which would silently un-attach a group from a goal on every other device.
//
// `goalRef` IS ALSO THE ONE PREFIX THAT IS NOT RANDOM. Every other id here is a
// `crypto.randomUUID()`, and that is right: a question is a fact about the reader, and
// two devices each writing their own copy of it is two questions, correctly. A
// reference is a RELATIONSHIP, and two devices can reach the same relationship
// independently — the same attachment made on a phone and a laptop, both offline — so
// a random id gives the merge two rows to keep and a goal with a shelf attached twice.
// `derivedId` below is how one id serves both.

/** @type {Record<string, string>} */
const PREFIXES = {
    goal: "g_",
    question: "q_",
    group: "gr_",
    option: "o_",
    exercise: "x_",
    exerciseItem: "it_",
    attempt: "a_",
    goalRef: "rf_"
};

/** The prefix for the join table, as a named constant.
 *
 *  It is exported because `derivedId` takes a prefix rather than a kind: the caller
 *  already knows which record it is writing, and making it pass a kind and look the
 *  prefix up here would add an indirection that could only ever be wrong one way. The
 *  two call sites are the repository that attaches something and the migration that
 *  attaches everything at once, and both pass this.
 */
export const GOAL_REF_PREFIX = PREFIXES.goalRef;

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
 * A UUID-SHAPED id DERIVED FROM A STRING, and identical on every device.
 *
 * It exists for one record kind: `goalRefs`, the join row saying a goal draws on a
 * group or on a question. That row is not a fact about the reader — it is a fact
 * about a relationship, and two devices can arrive at the same relationship
 * independently: a reader attaches "Chapter 3" to a goal on the phone while the same
 * attachment is made on the laptop, both offline.
 *
 * With `crypto.randomUUID()` those are two rows with two ids, and the merge keeps
 * both, because the merge can only tell them apart by id. The goal then holds the
 * same shelf twice — which sounds harmless and is not: the attachment count on the
 * content page says 4 when the reader attached 3, and `isExactSelection` and the
 * builder both see a group that has been named twice.
 *
 * DERIVING THE ID fixes it, because the merge's last-write-wins then collapses two
 * rows with the same key into one. It is the same reason a table with a natural key
 * uses that key as its primary key rather than a surrogate, and it is why this is a
 * function rather than something the repository works out.
 *
 * IT IS NOT A CRYPTOGRAPHIC HASH, and it does not need to be. The input is three ids
 * this app already minted at random; what is needed is that two devices agree, and
 * that is a property of a deterministic function rather than of its distribution.
 * The output is still a well-formed UUID in shape, because `isId` and the API's id
 * pattern both check the shape and neither should need a special case for this store.
 *
 * The input is a HASHED first, not concatenated raw. Concatenating ids that contain
 * `-` would let two different triples collide in a way a reader cannot predict; hashing
 * the joined string first means the 32 hex characters are a function of the whole tuple
 * and of nothing else.
 *
 * @param {string} prefix  one of PREFIXES; not validated, because the two callers
 *   pass the one constant each and a wrong prefix fails `isId` immediately.
 * @param {...string} parts  the values that identify this relationship
 * @returns {string} the prefix followed by 36 hex-and-dash characters
 */
export function derivedId(prefix, ...parts) {
    const seed = parts.join("");
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < seed.length; i += 1) {
        const code = seed.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
    }
    // Two words expanded to eight four-digit groups, which is enough for the id to be
    // distinct across the few hundred thousand relationships a personal device can
    // hold and costs nothing to compute.
    const groups = [];
    let a = h1;
    let b = h2;
    for (let i = 0; i < 8; i += 1) {
        a = Math.imul(a ^ b, 0x27d4eb2d) >>> 0;
        b = Math.imul(b ^ a, 0x165667b1) >>> 0;
        groups.push(((a ^ b) >>> 0).toString(16).padStart(8, "0"));
    }
    const hex = groups.join("");
    const body = [
        hex.slice(0, 8),
        hex.slice(8, 12),
        // The version and variant nibbles are set so the result is a syntactically
        // valid UUIDv4-shaped string rather than a hex string that happens to have
        // dashes in it. Nothing reads the version — `isId` checks length and prefix,
        // and the API's pattern checks the same — and it is done anyway because an id
        // that looks malformed in a log is the kind of thing somebody later "fixes"
        // in the one place that must not change.
        "4" + hex.slice(13, 16),
        ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
        hex.slice(20, 32)
    ].join("-");
    return `${prefix}${body}`;
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