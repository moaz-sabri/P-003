// The only place in the app where a key exists.
//
// One 32-byte Secret Key per person. Everything else is derived from it, by
// HKDF, with a different `info` label per purpose:
//
//   space id   16 bytes  the namespace this person syncs into
//   auth key   32 bytes  what the API checks; the server keeps only its SHA-256
//   data key   32 bytes  AES-GCM, encrypts every record before it leaves
//
// Three properties, and the reason for each:
//
//   * HKDF rather than three calls to the digest. Deriving by hashing
//     `master || label` is the same construction with the same properties and it
//     is wrong: a construction that produces `H(master||"data")` also produces
//     `H(master||"data" || anything)` for an attacker who chooses the suffix, so
//     the derived keys are not independent of each other. HKDF's extract step
//     breaks exactly that.
//   * A FIXED SALT. The salt in HKDF is not a secret — it exists to keep
//     identical inputs from deriving identical outputs across *protocols*. One
//     constant here domain-separates this app's labels from every other user of
//     the same function, and there is no second value to store.
//   * THE DATA KEY IS NON-EXTRACTABLE. It is a `CryptoKey` in IndexedDB, marked
//     `extractable: false`. Nothing in this codebase can read its bytes, not even
//     a bug in this file — `exportKey` is simply not granted. That is why the
//     envelope in the `keys` store holds a CryptoKey and not a base64 string:
//     the alternative is a secret sitting in a string in the same database as
//     the ciphertext it protects, readable by any code on the page.
//
// What the server sees is `{store, id, deleted, body}` with `body` being
// AES-GCM output. It can store, order and garbage-collect those. It cannot count
// a question, cannot find one by its text, and cannot tell an "a" from an "s".
// All the merging is done here, on the device, after decryption — which is why
// the API's schema is a bag of opaque blobs and why `deleted` is the one
// plaintext field in the envelope: it is the only thing the server needs to know
// in order to stop sending a tombstone it can recognise.
//
// Nothing in this file logs. Not the key, not a derivation, not a ciphertext —
// and the CryptoError codes below carry the reason and never the value, because
// a thrown error is the one thing in this app that reliably reaches a log.

import { CryptoError } from "../domain/errors.js";

const subtle = globalThis.crypto?.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Domain separator. Fixed, public, not a secret — see the header. */
const SALT = encoder.encode("recall/hkdf/v1");

/** The labels. Changing one of these changes the derived key, which locks
 *  everybody out of their own data, so they are versioned strings rather than
 *  assembled at the call site from a name somebody might edit. */
export const LABEL = {
    SPACE: "recall/v1/space-id",
    AUTH: "recall/v1/auth",
    DATA: "recall/v1/data"
};

const IV_BYTES = 12;    // the value AES-GCM is defined for
const TAG_BITS = 128;   // carried by WebCrypto; named here so it is written once

/* --------------------------------- base64 --------------------------------- */

export function toBase64(bytes) {
    let binary = "";
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
    return btoa(binary);
}

export function fromBase64(text) {
    const binary = atob(String(text ?? ""));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/* --------------------------------- HKDF ----------------------------------- */

function requireWebCrypto() {
    if (!subtle) throw new CryptoError("no_webcrypto");
}

/** One derivation. `info` is the label; the length is in bytes. */
async function derive(master, info, length) {
    requireWebCrypto();
    try {
        const key = await subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
        const bits = await subtle.deriveBits(
            { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode(info) },
            key,
            length * 8
        );
        return new Uint8Array(bits);
    } catch (err) {
        if (err instanceof CryptoError) throw err;
        throw new CryptoError("derive_failed");
    }
}

/**
 * The three keys, from 32 bytes.
 *
 * Returned together rather than as three functions because a caller that could
 * ask for the data key alone would eventually do so with a label of its own and
 * get a key that is not the one the server's records were sealed with.
 *
 * The master is NOT returned. It is the only secret in this app that can leave
 * the process in readable form, and the only code that ever holds it is the
 * import path — handing it back from a function whose result is spread into a
 * stored envelope is one refactor away from putting it in the database.
 */
export async function deriveAll(master) {
    if (!(master instanceof Uint8Array) || master.length !== 32) {
        throw new CryptoError("bad_master");
    }
    const [spaceBytes, authBytes, dekBytes] = await Promise.all([
        derive(master, LABEL.SPACE, 16),
        derive(master, LABEL.AUTH, 32),
        derive(master, LABEL.DATA, 32)
    ]);
    return {
        spaceId: toBase64(spaceBytes),
        authKey: toBase64(authBytes),
        dek: await importDataKey(dekBytes)
    };
}

async function importDataKey(bytes) {
    requireWebCrypto();
    try {
        return await subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    } catch {
        // The only realistic cause is a platform without AES-GCM. Refusing here
        // is the whole point: an app that quietly falls back to plaintext has
        // stopped being the thing the reader was promised.
        throw new CryptoError("aes_unavailable");
    }
}

/** The auth key as the header value the API wants: hex, lower case. */
export function authKeyHex(authKey) {
    const bytes = fromBase64(authKey);
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
}

/* --------------------------------- AES-GCM -------------------------------- */

/**
 * Encrypt a value for the wire.
 *
 * A fresh 96-bit IV per record, from the platform CSPRNG, never reused. The IV
 * is stored next to the ciphertext and is not secret; what must never happen is
 * an IV being reused under the same key, which is the one way GCM loses.
 *
 * `context` becomes the additional authenticated data, so a record cannot be
 * moved from one question to another by editing the envelope around it. It is
 * authenticated but not encrypted — which is exactly what a store name and a
 * record id are: routing information the server already has.
 */
export async function seal(dek, value, context = "") {
    requireWebCrypto();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    try {
        const ciphertext = await subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: encoder.encode(context), tagLength: TAG_BITS },
            dek,
            encoder.encode(JSON.stringify(value))
        );
        return {
            v: 1,
            iv: toBase64(iv),
            body: toBase64(new Uint8Array(ciphertext))
        };
    } catch {
        throw new CryptoError("encrypt_failed");
    }
}

/**
 * Decrypt what the server handed back.
 *
 * Everything that can go wrong returns `null` rather than throwing: an envelope
 * from another app, a record truncated by a proxy, a ciphertext whose additional
 * data does not match where it is being read. The caller is a merge, and a merge
 * that cannot read one record must keep its own copy of it rather than drop the
 * record and report a failure that looks like a network problem.
 */
export async function unseal(dek, envelope, context = "") {
    if (!envelope || envelope.v !== 1 || typeof envelope.body !== "string") return null;
    try {
        const plaintext = await subtle.decrypt(
            {
                name: "AES-GCM",
                iv: fromBase64(envelope.iv),
                additionalData: encoder.encode(context),
                tagLength: TAG_BITS
            },
            dek,
            fromBase64(envelope.body)
        );
        return JSON.parse(decoder.decode(plaintext));
    } catch {
        return null;
    }
}

/** SHA-256 of something, hex. Used to fingerprint a record for debugging
 *  without ever printing it. */
export async function digestHex(value) {
    requireWebCrypto();
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    const hash = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The envelope as it is stored: a non-extractable CryptoKey plus the two
 *  derived values the API needs. The master is NOT part of it — it exists only
 *  while the Secret Key is being imported, and nothing stores it. */
export function envelopeOf(derived, version) {
    return {
        version,
        spaceId: derived.spaceId,
        authKey: derived.authKey,
        dek: derived.dek,
        createdAt: Date.now()
    };
}

/** The header pair every API request carries. */
export function authHeaders(derived) {
    return {
        "X-Space": derived.spaceId,
        "X-Key": authKeyHex(derived.authKey)
    };
}