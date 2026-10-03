// Who this device is.
//
// There is no login. `createIdentity()` mints a Secret Key, derives everything
// from it and stores the non-extractable data key; `importIdentity()` does the
// same for a key somebody already has. Between them they are the entire account
// system, which is worth stating plainly: there is no server-side copy of the
// master, no reset mail, no second factor, and nothing anybody can do for a
// person who has lost the key.
//
// The derived keys are kept in a module variable rather than being derived again
// per request. Deriving is three HKDF calls and an import — cheap, but not free —
// and more importantly it would mean holding the master in memory for the life of
// the tab, when the master is the one value that must exist for as short a time
// as possible. What is cached is the data key, which cannot be read out of
// JavaScript at all.

import { deriveAll, envelopeOf, authHeaders, authKeyHex } from "./crypto-service.js";
import { CryptoError } from "../domain/errors.js";
import { createSecretKey, decodeSecretKey, formatSecretKey, SECRET_KEY_LENGTH } from "../domain/secret-key.js";
import { IDENTITY_VERSION } from "../config.js";
import { getIdentityEnvelope, saveIdentityEnvelope, clearIdentityEnvelope } from "../data/repo-core.js";
import { deleteDb } from "../data/db.js";

/** The derived keys for this device, or null. Never written anywhere. */
let session = null;

/** Whether this device has an identity at all — which is what the app's first
 *  screen branches on, so it must not throw on a browser with a full disk. */
export async function hasIdentity() {
    try {
        const envelope = await getIdentityEnvelope();
        return Boolean(envelope?.dek);
    } catch {
        return false;
    }
}

/** The derived keys, loading them from storage on first use. */
export async function getIdentity() {
    if (session) return session;
    const envelope = await getIdentityEnvelope();
    if (!envelope?.dek) throw new CryptoError("no_identity");
    if (envelope.version !== IDENTITY_VERSION) {
        // Refused rather than migrated. The version covers the KEY ENVELOPE, not
        // the data: a future version means a future derivation, and guessing at
        // it would either lose the data or quietly re-encrypt it under a key the
        // other devices do not have. The recovery path is the Secret Key itself,
        // which is exactly why it is the only credential.
        throw new CryptoError("identity_version");
    }
    session = { spaceId: envelope.spaceId, authKey: envelope.authKey, dek: envelope.dek };
    return session;
}

/** The headers every API call carries. Null when there is no identity, so the
 *  caller can skip the request rather than send one the server will refuse. */
export async function authHeadersOrNull() {
    if (!(await hasIdentity())) return null;
    return authHeaders(await getIdentity());
}

export { authKeyHex };

/**
 * A brand new identity.
 *
 * @returns {{secretKey: string}}  the printable key, shown ONCE. It is not
 *   stored in any form, not even encrypted with itself: the server has never seen
 *   it and this device has not kept it, so the only copy is whatever the reader
 *   does with it right now.
 */
export async function createIdentity() {
    const secretKey = createSecretKey();
    const derived = await deriveAll(decodeSecretKey(secretKey));
    await store(derived);
    return {
        secretKey,
        display: formatSecretKey(secretKey),
        spaceId: derived.spaceId
    };
}

/**
 * Adopt a key from another device.
 *
 * The checksum in the key is what makes this safe to offer as a text box: a
 * mistyped key decodes to 32 perfectly valid bytes, derives a perfectly valid
 * identity, and then reports "no data on this device" against data that exists
 * — with every symptom of a working app and nothing to indicate anything is
 * wrong. `decodeSecretKey` returns null on a bad checksum, so the failure lands
 * here, at the point where the reader can still do something about it.
 */
export async function importIdentity(text) {
    const master = decodeSecretKey(text);
    if (!master) throw new CryptoError("bad_secret_key");
    const derived = await deriveAll(master);
    await store(derived);
    return { spaceId: derived.spaceId };
}

async function store(derived) {
    try {
        await saveIdentityEnvelope(envelopeOf(derived, IDENTITY_VERSION));
    } catch (err) {
        // Storing a CryptoKey relies on structured clone supporting it, which is
        // true on every engine this app targets and is not something that can be
        // polyfilled. If it ever fails there is exactly one correct answer —
        // refuse, and say so — because the alternatives are to store the data key
        // as bytes (undoing the entire point of deriving it non-extractably) or
        // to run with no key at all and store plaintext.
        throw new CryptoError("key_store_unsupported");
    }
    session = { spaceId: derived.spaceId, authKey: derived.authKey, dek: derived.dek };
}

/** Forget this device. Destroys the database, which takes the data key with it —
 *  the alternative is a "log out" button that leaves the thing it was supposed
 *  to remove sitting in a store the next person with the phone can read. */
export async function forgetIdentity() {
    session = null;
    await clearIdentityEnvelope().catch(() => {});
    await deleteDb();
}

/** The key length the import box checks against, for the placeholder. */
export const IMPORT_LENGTH = SECRET_KEY_LENGTH;