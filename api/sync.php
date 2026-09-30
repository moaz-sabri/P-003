<?php

declare(strict_types=1);

/**
 * Push and pull. The only two endpoints that move a record.
 *
 * THE WHOLE FILE IN ONE PARAGRAPH: a record is `{store, id, deleted, body}`, where
 * `body` is AES-GCM ciphertext this server cannot read, and the server's job is to
 * store it under `(space, store, id)` and give it a revision. Everything a merge
 * needs — what changed, in what order, which of two versions is newer — is decided
 * on the devices, after decryption, because this side is the only side that cannot
 * read the values it is ordering.
 *
 * WHY REVISIONS AND NOT TIMESTAMPS. Two devices writing in the same millisecond is
 * ordinary, and a pull ordered by a client-supplied timestamp lets a device with a
 * wrong clock order itself before or after whatever it should be. A revision is
 * assigned here, inside the transaction, from a per-space counter: total order,
 * monotonic, and no client input involved. The client's cursor is then just "give
 * me everything above this number", which is why a pull cannot skip a record it
 * has not seen even when two pushes interleave.
 *
 * PUSH IS AN UPSERT, NOT AN INSERT. A record can be pushed again — a second device
 * that has edited it, or the same device that has edited it twice — and the newer
 * copy wins. There is no conflict detection here and there cannot be: whether two
 * ciphertexts conflict is a question about plaintext, which this side cannot
 * answer. Last writer wins on revision order, and `applyRemote` on the client
 * resolves it against `updatedAt` plus the device id for the genuine tie.
 *
 * A PUSH IS NOT REFUSED BECAUSE IT IS OLD. An idempotent write that only moves a
 * row forward costs one upsert, and refusing stale pushes would mean refusing the
 * retry of a request that actually succeeded on the server and lost its response —
 * the one failure a client cannot distinguish from a request that never arrived.
 */

require_once __DIR__ . '/db.php';

/** The stores a record may name.
 *
 *  A closed list, and not a "starts with a letter" check, because `store` goes
 *  into a primary key and a column. Anything outside this set is a request trying
 *  to write a row that no device will ever read — and, because the pull returns
 *  whatever is in the table, a store name nobody reads is a way to store data
 *  nobody can delete. It mirrors SYNCED_STORES in app/js/data/stores.js, and
 *  deliberately excludes `meta` (which holds the sync cursor) and `keys` (which
 *  holds a non-extractable CryptoKey that must never leave a device).
 */
const RC_STORES = ['goals', 'questions', 'options', 'exercises', 'exerciseItems', 'attempts'];

/** Refuses one malformed record. A 400, because it is the request that is wrong
 *  and not the network — which is why app/net.js maps it to `bad_response` and not
 *  to `network`, so a bad request does not back off as though the connection were
 *  flaky.
 *
 *  `reason`, not `code`: `Exception::$code` exists, is an int and is not readonly. */
final class RcBadRequest extends RuntimeException
{
    public function __construct(public readonly string $reason = 'bad_request')
    {
        parent::__construct($reason);
    }
}

/**
 * Store records pushed by one space.
 *
 * @param array{0:array<mixed>,1:string} $input  the records and the space id
 * @return array{acks:list<array{store:string,id:string,rev:int}>, rev:int}
 */
function rc_push(array $records, string $spaceId): array
{
    $max = (int) rc_conf('push_max_records');
    if (count($records) > $max) {
        throw new RcBadRequest('too_many_records');
    }

    // Validated and normalised BEFORE the transaction opens, so that a bad record
    // cannot hold the write lock while the code decides it is bad.
    $clean = [];
    foreach ($records as $record) {
        $clean[] = rc_normalise_record($record);
    }
    if ($clean === []) {
        return ['acks' => [], 'rev' => rc_current_rev($spaceId)];
    }

    return rc_transaction(function (PDO $pdo) use ($clean, $spaceId): array {
        $bump = $pdo->prepare('UPDATE counters SET rev = rev + :n WHERE space_id = :space');
        $select = $pdo->prepare('SELECT rev FROM counters WHERE space_id = :space');
        $select->execute([':space' => $spaceId]);
        $start = (int) ($select->fetchColumn() ?: 0);

        // One revision per record, ascending in the order they arrived. The counter
        // moves by the batch size in a single statement rather than once per row:
        // a push of a hundred records is one UPDATE, and the ordering within the
        // batch is what the per-record assignment below preserves.
        $bump->execute([':n' => count($clean), ':space' => $spaceId]);

        $upsert = $pdo->prepare(
            'INSERT INTO records (space_id, store, record_id, rev, deleted, body, updated_at)
             VALUES (:space, :store, :id, :rev, :deleted, :body, :updated_at)
             ON CONFLICT(space_id, store, record_id) DO UPDATE SET
                 rev = excluded.rev,
                 deleted = excluded.deleted,
                 body = excluded.body,
                 updated_at = excluded.updated_at'
        );

        $acks = [];
        $rev = $start;
        $now = time();
        foreach ($clean as $record) {
            $rev++;
            $upsert->execute([
                ':space' => $spaceId,
                ':store' => $record['store'],
                ':id' => $record['id'],
                ':rev' => $rev,
                ':deleted' => $record['deleted'],
                ':body' => $record['body'],
                ':updated_at' => $record['updatedAt'],
            ]);
            $acks[] = ['store' => $record['store'], 'id' => $record['id'], 'rev' => $rev];
        }

        return ['acks' => $acks, 'rev' => $rev];
    });
}

/**
 * Everything in one space above a revision.
 *
 * @return array{records:list<array{store:string,id:string,rev:int,deleted:int,body:mixed}>,
 *               rev:int, more:bool}
 */
function rc_pull(string $spaceId, int $since, int $limit): array
{
    $limit = max(1, min($limit, (int) rc_conf('pull_max_limit')));

    $stmt = rc_db()->prepare(
        'SELECT store, record_id, rev, deleted, body
           FROM records
          WHERE space_id = :space AND rev > :since
       ORDER BY rev ASC
          LIMIT :limit'
    );
    $stmt->bindValue(':space', $spaceId, PDO::PARAM_STR);
    $stmt->bindValue(':since', $since, PDO::PARAM_INT);
    // A LIMIT that is a bound string rather than a bound int is ignored as a limit
    // by SQLite and the query returns everything; with emulation off it is a real
    // parameter, so this has to be declared as one.
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();

    $out = [];
    $highest = $since;
    foreach ($rows as $row) {
        $rev = (int) $row['rev'];
        if ($rev > $highest) {
            $highest = $rev;
        }
        $out[] = [
            'store' => (string) $row['store'],
            'id' => (string) $row['record_id'],
            'rev' => $rev,
            'deleted' => (int) $row['deleted'],
            // Decoded here rather than left as a string, because the client sends an
            // object `{v, iv, body}` and JSON-encoding it as a quoted string would
            // hand back something `unseal` cannot read. A body that will not decode
            // becomes an empty object, which unseal treats as unreadable and skips —
            // the correct outcome for a truncated or corrupted row.
            'body' => rc_decode_body((string) $row['body']),
        ];
    }

    // `more` is decided by asking whether anything is left above the last revision
    // handed out, NOT by comparing counts. A client that trusts a count will advance
    // its cursor past the end of the page whenever the two disagree, and the records
    // in between are then never sent by anybody, ever.
    $more = false;
    if ($highest > $since) {
        $probe = rc_db()->prepare('SELECT 1 FROM records WHERE space_id = :space AND rev > :since LIMIT 1');
        $probe->execute([':space' => $spaceId, ':since' => $highest]);
        $more = $probe->fetchColumn() !== false;
    }

    // The revision the client should remember. It is the highest revision it has
    // actually been GIVEN, never the space's current counter: advancing a cursor to
    // a revision whose records were not in this response is how a pull silently
    // loses a page.
    return ['records' => $out, 'rev' => $highest, 'more' => $more];
}

/** The space's current revision, for a push that had nothing to do. */
function rc_current_rev(string $spaceId): int
{
    $stmt = rc_db()->prepare('SELECT rev FROM counters WHERE space_id = :space');
    $stmt->execute([':space' => $spaceId]);
    return (int) ($stmt->fetchColumn() ?: 0);
}

/**
 * Validate one pushed record and return it in the shape the statements above use.
 *
 * Everything a device sends is untrusted, including from a device that has
 * authenticated: the credentials prove the caller owns the space, not that this
 * particular body is well formed. The checks here are the ones that keep a
 * malformed record out of the table, where it would be handed to every future pull
 * and cost every device that reads it.
 *
 * @return array{store:string,id:string,deleted:int,body:string,updatedAt:int}
 */
function rc_normalise_record(mixed $record): array
{
    if (!is_array($record)) {
        throw new RcBadRequest();
    }

    $store = $record['store'] ?? null;
    if (!is_string($store) || !in_array($store, RC_STORES, true)) {
        throw new RcBadRequest();
    }

    $id = $record['id'] ?? null;
    // Prefixed UUID, exactly as app/js/domain/id.js mints them: a prefix, then 36
    // characters. Not `strlen` alone and not a character-class check, because an id
    // is what every other row is looked up by and a loose one is a key collision
    // waiting for a second device to invent it.
    if (!is_string($id)
        || preg_match('#^(g_|q_|o_|x_|it_|a_)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$#', $id) !== 1) {
        throw new RcBadRequest();
    }

    // `deleted` is the one plaintext field in the envelope and it is a flag, not a
    // date: the server needs to know a record is gone so it stops sending it, and
    // it learns the WHEN from the revision. `1` and `0` only — accepting a
    // timestamp here would mean trusting a device's clock for the garbage
    // collector's decisions.
    //
    // Absent is 0, but PRESENT AND NOT A FLAG IS REFUSED, so the default cannot be
    // reached with `??`. `$record['deleted'] ?? 0` turns an explicit `null` into 0,
    // which means a client sending `"deleted": null` silently stores a live record
    // where it meant to delete one — the one failure in this file that loses data
    // without anybody noticing, because everything after it works.
    if (!array_key_exists('deleted', $record)) {
        $deleted = 0;
    } else {
        $deleted = $record['deleted'];
        if (!is_int($deleted) || ($deleted !== 0 && $deleted !== 1)) {
            throw new RcBadRequest();
        }
    }

    $body = $record['body'] ?? null;
    if (is_array($body)) {
        $encoded = json_encode($body);
    } elseif (is_string($body)) {
        // A body that arrived as a string is accepted and re-encoded as an object
        // where it looks like one. Storing the raw string and handing it back
        // quoted would make it unreadable on the way back out, which is a
        // correctness bug in the pull rather than a security one — but the fix
        // belongs here, next to the validation, rather than in the client.
        $decoded = json_decode($body, true);
        $encoded = is_array($decoded) ? json_encode($decoded) : null;
    } else {
        $encoded = null;
    }
    if (!is_string($encoded) || strlen($encoded) > (int) rc_conf('record_max_body')) {
        throw new RcBadRequest('body_too_large');
    }

    // Sanity-check the envelope's shape without touching the ciphertext. `v` and
    // `iv` and `body` are what `unseal` reads; a row whose envelope has none of them
    // is unreadable on every device and would be handed out forever.
    $envelope = json_decode($encoded, true);
    if (!is_array($envelope) || !isset($envelope['iv'], $envelope['body'])
        || !is_string($envelope['iv']) || !is_string($envelope['body'])) {
        throw new RcBadRequest();
    }
    if (isset($envelope['v']) && !is_int($envelope['v'])) {
        throw new RcBadRequest();
    }

    $updatedAt = $record['updatedAt'] ?? null;
    if (!is_int($updatedAt) || $updatedAt < 0) {
        // Not fatal and not trusted: the server records what it was told for
        // ordering garbage collection, and a device with a clock set to 1969
        // should not be able to have its tombstone collected early. So an
        // implausible value becomes "now", which is the only timestamp this server
        // can vouch for.
        $updatedAt = time();
    }
    // Twenty-four hours in the future, and the same argument in the other
    // direction: a device whose clock is a year fast would otherwise have every one
    // of its tombstones collected the moment it deleted something.
    if ($updatedAt > time() + 86400) {
        $updatedAt = time();
    }

    return [
        'store' => $store,
        'id' => $id,
        'deleted' => $deleted,
        'body' => $encoded,
        'updatedAt' => $updatedAt,
    ];
}

/** A stored body back to the structure the client sent. */
function rc_decode_body(string $stored): mixed
{
    $decoded = json_decode($stored, true);
    return is_array($decoded) ? $decoded : [];
}