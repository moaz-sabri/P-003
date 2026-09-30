// The Secret Key's format.
//
// These tests are about the failure they prevent rather than the arithmetic: a key
// that decodes when it should not produces a device with a different identity and
// no data on it, and nothing about that looks like an error.

import test from "node:test";
import assert from "node:assert/strict";

import {
    SECRET_KEY_LENGTH,
    createSecretKey,
    decodeSecretKey,
    encodeSecretKey,
    formatSecretKey,
    normalizeSecretKey
} from "../app/js/domain/secret-key.js";
import { SECRET_KEY_BYTES } from "../app/js/config.js";
import { keyFromText } from "../app/js/services/export-service.js";

test("a generated key is the documented length", () => {
    const key = createSecretKey();
    assert.equal(key.length, SECRET_KEY_LENGTH);
    assert.equal(key.length, 55);
});

test("a generated key decodes back to the bytes it was made from", () => {
    const key = createSecretKey();
    const decoded = decodeSecretKey(key);
    assert.ok(decoded, "a fresh key did not decode");
    assert.equal(decoded.length, SECRET_KEY_BYTES);
    // And re-encoding gives the same string, so the round trip is not merely valid
    // but lossless — the checksum covers the bytes, not a normalised variant.
    assert.equal(encodeSecretKey(decoded), key);
});

test("the alphabet has no ambiguous characters", () => {
    // Crockford excludes I, L, O and U. This test is the reason: a key containing
    // them can be mistyped into a DIFFERENT valid key, and the checksum then
    // refuses an honest attempt at recovery.
    for (let i = 0; i < 40; i++) {
        const key = createSecretKey();
        assert.ok(!/[ILOU]/.test(key), `key contains an ambiguous character: ${key}`);
    }
});

test("a key survives lower case, spaces and separators", () => {
    const key = createSecretKey();
    const spaced = key.replace(/(.{4})(?=.)/g, "$1 ");
    const punctuated = spaced.replace(/ /g, "-");

    assert.equal(normalizeSecretKey(spaced), key);
    assert.equal(normalizeSecretKey(punctuated), key);
    assert.ok(decodeSecretKey(spaced.toLowerCase()), "a lower-case key did not decode");
    assert.ok(decodeSecretKey(`  ${punctuated}  \n`), "a key with whitespace did not decode");
});

test("the look-alike characters fold onto the right digits", () => {
    // A key written from a phone keyboard or by hand arrives with I instead of 1,
    // L instead of 1 and O instead of 0. Crockford exists for exactly this.
    const key = createSecretKey();
    const mangled = key.replace(/1/g, "I").replace(/0/g, "O");
    if (mangled === key) return;   // no 1 or 0 in this key; nothing to prove
    assert.equal(normalizeSecretKey(mangled), key);
    assert.ok(decodeSecretKey(mangled), "a look-alike key did not decode");
});

test("a single mistyped character is refused", () => {
    const key = createSecretKey();
    // Every position, two different wrong characters. Enumerating the positions is
    // the point: a checksum that covers only the length would pass every one of
    // these.
    let refused = 0;
    let tried = 0;
    for (let i = 0; i < key.length; i++) {
        for (const substitute of ["0", "X", "7"]) {
            if (key[i] === substitute) continue;
            const wrong = key.slice(0, i) + substitute + key.slice(i + 1);
            tried++;
            if (decodeSecretKey(wrong) === null) refused++;
        }
    }
    assert.ok(tried > 100, `expected a large number of substitutions, tried ${tried}`);
    // Every single-character substitution must be caught. The probability that a
    // 32-bit FNV checksum collides on one of ~150 changes is about 3.5e-8, so this
    // is a real assertion rather than a flaky one.
    assert.equal(refused, tried, "a mistyped key was accepted");
});

test("a mistyped character in the padding bits is refused", () => {
    // 34 bytes is 272 bits and 55 characters is 275, so the LAST character carries
    // two real bits and three bits that belong to no byte at all. The checksum
    // covers the key bytes and the check bytes, so a key that differs only in
    // those three bits decodes to the very same 32 bytes and passes the checksum.
    //
    // The substitutions that do exactly that are the seven characters sharing the
    // last character's top two bits — the real bits. Enumerating them from the
    // alphabet rather than from a fixed list is what makes this deterministic: the
    // fixed list above happened to include one of them only when the key ended in a
    // character below 8, so the test caught the bug by luck and would have passed
    // three times out of four forever.
    const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (let attempt = 0; attempt < 20; attempt++) {
        const key = createSecretKey();
        const last = key.length - 1;
        const index = ALPHABET.indexOf(key[last]);
        assert.ok(index >= 0, `the last character is not in the alphabet: ${key}`);

        // The two real bits are the TOP two of the character's five-bit value, so
        // the padding is the low three — and seven other characters share those top
        // two bits with the original. Every one of them must be refused.
        const paddingOnly = [];
        for (let j = 0; j < ALPHABET.length; j++) {
            if (j === index) continue;
            if ((j >> 3) === (index >> 3)) paddingOnly.push(ALPHABET[j]);
        }
        assert.equal(paddingOnly.length, 7, "expected seven padding-only substitutions");

        for (const substitute of paddingOnly) {
            const wrong = key.slice(0, last) + substitute;
            assert.equal(
                decodeSecretKey(wrong),
                null,
                `a padding-only change to the last character was accepted: ${wrong}`
            );
        }
    }
});

test("keys of the wrong length are refused", () => {
    const key = createSecretKey();
    assert.equal(decodeSecretKey(key.slice(0, -1)), null);
    assert.equal(decodeSecretKey(key + "0"), null);
    assert.equal(decodeSecretKey(""), null);
    assert.equal(decodeSecretKey(null), null);
    assert.equal(decodeSecretKey(undefined), null);
});

test("a key file's comments and layout are stripped on the way in", () => {
    // The file export-service writes is plain text with `#` comments and a blank
    // line, and the import box accepts it verbatim. A reader who downloads the
    // file and pastes the whole thing must get their key, not an error.
    //
    // The tolerance lives in keyFromText(), NOT in decodeSecretKey(): the latter is
    // the strict validator and must keep refusing anything that is not exactly one
    // key, because it is also what the derivation path uses to decide whether a
    // string is the identity at all. Handing it a file with prose on top is handing
    // it 200 characters of the right alphabet and the wrong length.
    const key = createSecretKey();
    const file = [
        "# Recall — Secret Key",
        "#",
        "# This file is the whole of your account.",
        "",
        "# Sync space: AAAAAAAAAAAAAAAAAAAAAA==",
        "",
        formatSecretKey(key),
        ""
    ].join("\n");

    assert.equal(keyFromText(file), key);
    assert.deepEqual(decodeSecretKey(keyFromText(file)), decodeSecretKey(key));
    // And a bare key, which is the other thing the import box is documented to
    // accept, still arrives unchanged through the same path.
    assert.equal(keyFromText(key), key);
});

test("formatSecretKey groups in fours and survives the round trip", () => {
    const key = createSecretKey();
    const shown = formatSecretKey(key);
    assert.equal(shown.replace(/ /g, ""), key);
    assert.ok(decodeSecretKey(shown), "the display form did not decode");
    // Groups of four make a truncated paste visible: the last group is short.
    const groups = shown.split(" ");
    assert.ok(groups[groups.length - 1].length < 4);
});

test("two generated keys are different", () => {
    // A single test run is not proof of the CSPRNG, but it catches the failure
    // that actually happens — a constant seed, or a zero-filled buffer that
    // "works" and gives every install the same identity.
    const keys = new Set();
    for (let i = 0; i < 200; i++) keys.add(createSecretKey());
    assert.equal(keys.size, 200);
});

test("encodeSecretKey refuses the wrong number of bytes", () => {
    assert.throws(() => encodeSecretKey(new Uint8Array(16)), RangeError);
    assert.throws(() => encodeSecretKey(new Uint8Array(SECRET_KEY_BYTES + 1)), RangeError);
    assert.throws(() => encodeSecretKey([1, 2, 3]), RangeError);
});