// The Secret Key: 32 random bytes, written down in a form a person can save.
//
// This file is the whole of "the key is the account". There is no login, no
// email and no password anywhere in this app, so the format of this string is
// the difference between "I lost my data" and "I moved my data to a new phone",
// and it has to survive being read off a screen by somebody in a hurry and typed
// into another one.
//
// Three properties, in order of how much they matter:
//
//   1. NO AMBIGUOUS CHARACTERS. Crockford base32 excludes I, L, O and U, and this
//      decoder additionally maps I→1, L→1 and O→0 so a key that was written by
//      a phone keyboard, a person or a handwriting-recognition app still reads.
//      Base64 would have been shorter and would have produced keys containing
//      `0`/`O` and `1`/`l` — the two pairs that turn a saved key into a locked
//      account.
//   2. A CHECKSUM. 32 bytes typed by hand will be mistyped. Without a check, a
//      single wrong character decodes into 32 perfectly valid bytes, every
//      derivation from it produces a different identity, and the result is a
//      device that confidently reports "no data here" against data that exists.
//      Two extra bytes are appended and two characters of FNV-1a cover them, so a
//      mistyped key is refused at the door instead of silently opening an empty
//      identity.
//   3. NO PADDING AND NO CASE. 34 bytes is 55 characters with nothing to strip,
//      and the decoder upper-cases and drops separators, so a key pasted in
//      lowercase, in groups of four, or with the spaces a phone keyboard adds is
//      still the same key.
//
// This module is pure arithmetic over a byte array: no DOM, no IndexedDB, no
// WebCrypto for the encoding itself (only for generating the bytes), which is
// what lets tests/*.test.mjs exercise it under `node --test`.

import { SECRET_KEY_BYTES } from "../config.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U

/** Bytes of key material, plus two of check. 34 bytes → 55 characters. */
const CHECK_BYTES = 2;
const RAW_BYTES = SECRET_KEY_BYTES + CHECK_BYTES;

/** Number of characters the encoded key has. Kept as a value rather than
 *  recomputed at each call site, because it is used in a validation message and
 *  a mismatch there is exactly what a reader needs to see. */
export const SECRET_KEY_LENGTH = Math.ceil((RAW_BYTES * 8) / 5);

function encode5(value) {
    let out = "";
    for (let i = 4; i >= 0; i--) out += ALPHABET[(value >>> (i * 5)) & 31];
    return out;
}

/** 32 bits of FNV-1a. Not a hash for security — it detects typing errors, and
 *  that is the entire job. */
function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (const b of bytes) {
        h ^= b;
        // Math.imul keeps the multiply in 32 bits; `h * 16777619` would leave it
        // a float and the loop would quietly stop producing a stable value.
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * 32 fresh bytes from the platform CSPRNG.
 *
 * `crypto.getRandomValues` is the only source used, and there is no fallback: an
 * app whose identity can be weak must fail rather than pretend.
 */
export function randomSecretBytes() {
    const bytes = new Uint8Array(SECRET_KEY_BYTES);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
}

/**
 * The printable form of a key: 55 characters, upper case, no padding.
 *
 * `buffer` IS MASKED after every group of five bits, and that line is not an
 * optimisation — it is the whole function. `<<` in JavaScript is a 32-bit
 * operation, so an unmasked accumulator loses everything above bit 31: the buffer
 * here is fed 8 bits at a time and drained 5 at a time, which leaves between 0 and
 * 4 bits carried and grows without bound, and by the fourth byte the bits that
 * were emitted ten characters ago are gone. The result is a 55-character string
 * whose tail does not depend on the head, so it round-trips to something else and
 * `decodeSecretKey` returns null on the key the app itself just generated.
 *
 * Masking to the `bits` that are still pending is what makes it a shift register
 * rather than a counter.
 */
export function encodeSecretKey(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== SECRET_KEY_BYTES) {
        throw new RangeError(`secret key must be ${SECRET_KEY_BYTES} bytes`);
    }
    const raw = new Uint8Array(RAW_BYTES);
    raw.set(bytes, 0);
    // 16 bits of the 32-bit FNV-1a, because the check is two bytes and there is no
    // third byte to put the rest in. See the note in `decodeSecretKey` — the two
    // halves have to agree on this mask or nothing round-trips.
    const check = fnv1a(bytes) & 0xffff;
    raw[SECRET_KEY_BYTES] = (check >>> 8) & 0xff;
    raw[SECRET_KEY_BYTES + 1] = check & 0xff;

    let out = "";
    let buffer = 0;
    let bits = 0;
    for (const b of raw) {
        buffer = (buffer << 8) | b;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += ALPHABET[(buffer >>> bits) & 31];
            // Keep only what has not been emitted. `bits` is at most 4 here, so the
            // mask is small and the shift is safe.
            buffer &= (1 << bits) - 1;
        }
    }
    if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
    return out;
}

/**
 * Strip everything a person or a keyboard adds, and fold the look-alikes.
 *
 * Spaces, dashes, dots and underscores go; upper-casing happens here so every
 * caller gets the same canonical form to compare against; and I/L→1, O→0 is the
 * whole reason Crockford was chosen.
 */
export function normalizeSecretKey(text) {
    return String(text ?? "")
        .toUpperCase()
        .replace(/[^0-9A-Z]/g, "")
        .replace(/[IL]/g, "1")
        .replace(/O/g, "0")
        .replace(/U/g, "V");
}

/**
 * The bytes behind a key string, or null when the string is not one.
 *
 * Null rather than a thrown error, because the two callers want opposite
 * behaviour: the import screen wants to say "that is not a key", and the tests
 * want to enumerate the shapes that are not keys. Neither wants a try/catch.
 */
export function decodeSecretKey(text) {
    const clean = normalizeSecretKey(text);
    if (clean.length !== SECRET_KEY_LENGTH) return null;
    if (!/^[0-9A-Z]+$/.test(clean)) return null;

    const raw = new Uint8Array(RAW_BYTES);
    let buffer = 0;
    let bits = 0;
    let at = 0;
    for (const ch of clean) {
        const index = ALPHABET.indexOf(ch);
        // -1 means a character outside the alphabet. The regex above already
        // excludes everything that is not 0-9A-Z, but the alphabet has four holes
        // in that range (I, L, O, U), and folding one into 31 would silently
        // decode a key the reader never had. Checked here as well because a
        // character that maps to -1 is the one case where the two checks would
        // disagree.
        if (index < 0) return null;

        buffer = (buffer << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            raw[at++] = (buffer >>> bits) & 0xff;
            // See `encodeSecretKey`: without this the accumulator overflows 32 bits
            // and the decode does not invert the encode.
            buffer &= (1 << bits) - 1;
        }
    }
    if (at !== RAW_BYTES) return null;

    // THE THREE PADDING BITS MUST BE ZERO. 34 bytes is 272 bits and 55 characters
    // is 275, so the last character carries the final two real bits and three bits
    // that are not part of any byte. The encoder writes those three as zeros
    // (`buffer << (5 - bits)` puts the pending bits at the TOP of the group), and
    // nothing downstream ever looks at them again — which is exactly why they have
    // to be checked HERE rather than trusted: the checksum covers the 32 key bytes
    // and the two check bytes, so a substitution that touches only the padding
    // decodes to a byte-identical key, passes the checksum, and is accepted as the
    // same key. `0`→`7` on the last character is 00000 → 00111, which moves bits the
    // byte array never sees. Without this line a mistyped key is a valid key.
    if (buffer !== 0) return null;

    const bytes = raw.slice(0, SECRET_KEY_BYTES);
    // THE LOW 16 BITS OF THE HASH, AND ONLY THOSE. The check occupies two bytes, so
    // what is stored is `fnv1a(bytes) & 0xffff` — and comparing the whole 32-bit
    // value against those two bytes can never be equal, which makes every key
    // undecodable. The asymmetry is the whole reason the two halves of this pair
    // have to be written side by side: the encoder masks to 16 bits on the way out
    // and the decoder masks on the way back, and a change to one without the other
    // makes the app reject its own key at the import screen with no way for the
    // reader to tell that from a mistyped character.
    const check = (raw[SECRET_KEY_BYTES] << 8) | raw[SECRET_KEY_BYTES + 1];
    return (fnv1a(bytes) & 0xffff) === check ? bytes : null;
}

/**
 * The key as it should be SHOWN: grouped in fours.
 *
 * A single 55-character line is unreadable and, more to the point, easy to
 * truncate silently when somebody copies it by dragging across a screen. Four
 * character groups make a dropped character visible at a glance, and the groups
 * are spaces — which normalizeSecretKey() removes again on the way in, so the
 * display form and the stored form are the same key.
 */
export function formatSecretKey(text) {
    const clean = normalizeSecretKey(text);
    return clean.replace(/(.{4})(?=.)/g, "$1 ");
}

/** A whole new key, as the printable string the reader saves. */
export function createSecretKey() {
    return encodeSecretKey(randomSecretBytes());
}
