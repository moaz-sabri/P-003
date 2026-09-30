<?php

declare(strict_types=1);

/**
 * The database: one SQLite file, a connection, and the schema.
 *
 * The schema is four tables and that is the whole design. There is no users
 * table, no sessions table, no questions table, because this server cannot read
 * a question — every record is AES-GCM ciphertext produced on a device, and the
 * server's job is to store it, order it by revision, and stop sending what a
 * device has deleted. Anything else here would be a table whose only reader is
 * the server itself, which is a table that can leak.
 *
 *   spaces    the identity: `space_id`, the SHA-256 of the auth key, and when it
 *             was last seen. The auth key itself is never stored — the server has
 *             no copy, so a stolen database file does not let an attacker push
 *             into somebody else's space.
 *   counters  the per-space revision high-water mark. A separate table rather
 *             than a column on `spaces` so that advancing it is one statement that
 *             does not rewrite the space row.
 *   records   `(space_id, store, record_id)` → ciphertext, revision, tombstone.
 *   rate      request counters for the limiter in auth.php.
 *
 * EVERY QUERY THAT TOUCHES A ROW IS SCOPED BY `space_id`, in the WHERE clause and
 * in the primary key, and every statement is prepared. Both are load-bearing and
 * neither is a style choice: without the space in the key, forgetting it in one
 * WHERE is a cross-tenant read, and the `api/tests/security.php` suite exists
 * precisely because that mistake is invisible in review.
 */

require_once __DIR__ . '/config.php';

/**
 * The one connection for this process.
 *
 * A global rather than a `static` inside rc_db() because it has to be
 * resettable: gc.php moves the database file after a VACUUM INTO, and the test
 * suite deletes the directory it made. A function-local static can only be
 * changed from inside its own function, which would mean giving up the cache to
 * gain a reset.
 */
$GLOBALS['RC_DB_PDO'] = null;

/**
 * Open (and if necessary create) the database.
 *
 * The connection is cached because PHP-FPM re-requires this file on every request
 * anyway and re-opening is measurable under load; one connection per worker is
 * what a worker should have.
 */
function rc_db(): PDO
{
    if ($GLOBALS['RC_DB_PDO'] instanceof PDO) {
        return $GLOBALS['RC_DB_PDO'];
    }

    $path = (string) rc_conf('db_path');
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('cannot create the database directory');
    }

    // A database file readable by the web server's group is a database file in a
    // shared-hosting neighbour's web root. 0600 and no group bit at all.
    if (is_file($path)) {
        @chmod($path, 0600);
    }

    $pdo = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        // Real prepared statements. With emulation on, a bound value is
        // interpolated into the SQL text by the driver, which is a string
        // concatenation with extra steps.
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_TIMEOUT => 5,
    ]);

    // WAL, because the deployment is one web container and one PHP container
    // writing the same file: a reader must not block the writer.
    $pdo->exec('PRAGMA journal_mode = WAL');
    // NORMAL rather than FULL: a lost tail after a power cut costs one sync run,
    // and every record is still on the device that wrote it, which is the entire
    // durability argument this design makes. FULL would fsync on every write for a
    // guarantee the client does not need.
    $pdo->exec('PRAGMA synchronous = NORMAL');
    // A hard limit rather than the default. A second of waiting on a locked file
    // is already longer than a request should take, and the busy handler would
    // turn a deadlock into a timeout instead of an error.
    $pdo->exec('PRAGMA busy_timeout = 5000');
    // Foreign keys are declared off deliberately and this is not an oversight:
    // there are no foreign keys. Every row is a bag of ciphertext keyed by
    // (space, store, id) because that is all a device can be relied upon to agree
    // on, and a constraint that references another table would have to be
    // enforced against rows this server cannot read.
    $pdo->exec('PRAGMA foreign_keys = OFF');

    rc_migrate($pdo);

    @chmod($path, 0600);
    $GLOBALS['RC_DB_PDO'] = $pdo;
    return $pdo;
}

/**
 * Create the schema, idempotently.
 *
 * `CREATE TABLE IF NOT EXISTS` rather than a version table, because there is
 * exactly one schema and it is created by this function on first use. A migration
 * framework here would be a second place to forget something, and the schema is
 * small enough to read in full.
 */
function rc_migrate(PDO $pdo): void
{
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS spaces (
            space_id     TEXT PRIMARY KEY,
            key_hash     TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
        )'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS counters (
            space_id TEXT PRIMARY KEY,
            rev      INTEGER NOT NULL
        )'
    );

    // The primary key is (space_id, store, record_id) and NOT (store, id): a
    // record id is a UUID generated on a device, so two spaces can legitimately
    // hold the same id, and a key that omitted the space would make one device's
    // question overwrite another's. The trailing index is for pulls, which are
    // always "everything in this space above this revision, in order".
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS records (
            space_id   TEXT NOT NULL,
            store      TEXT NOT NULL,
            record_id  TEXT NOT NULL,
            rev        INTEGER NOT NULL,
            deleted    INTEGER NOT NULL DEFAULT 0,
            body       TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (space_id, store, record_id)
        )'
    );
    $pdo->exec('CREATE INDEX IF NOT EXISTS records_by_rev ON records (space_id, rev)');
    // Garbage collection asks "tombstones in this space older than X", and
    // "spaces with nothing touched in a while" is a scan of `spaces` alone.
    $pdo->exec('CREATE INDEX IF NOT EXISTS records_tombstones ON records (deleted, updated_at)');

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS rate (
            bucket        TEXT NOT NULL,
            window_start  INTEGER NOT NULL,
            hits          INTEGER NOT NULL,
            PRIMARY KEY (bucket, window_start)
        )'
    );
}

/**
 * Run a statement inside a transaction, returning its result.
 *
 * Every write in sync.php goes through here, and none of them opens a transaction
 * itself. Two reasons: a push that updates the counter and then the records has to
 * be atomic — a counter that advanced without its records leaves a device pulling
 * a page that starts after records that were never written — and a hand-written
 * BEGIN/commit pair is one that is forgotten on the error path.
 *
 * @template T
 * @param callable(PDO):T $work
 * @return T
 */
function rc_transaction(callable $work): mixed
{
    $pdo = rc_db();
    // IMMEDIATE rather than DEFERRED: the whole point is to take the write lock
    // now, so that the counter read and the records written inside cannot be
    // interleaved with another space's push.
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $result = $work($pdo);
        $pdo->exec('COMMIT');
        return $result;
    } catch (Throwable $err) {
        // Rolled back on the way out rather than at the throw site. A caller that
        // catches and continues without a rollback leaves a transaction open, and
        // the next statement on this connection becomes part of it.
        try {
            if ($pdo->inTransaction()) {
                $pdo->exec('ROLLBACK');
            }
        } catch (Throwable) {
            // Nothing useful to do; the connection is already unusable and the
            // request is about to fail anyway.
        }
        throw $err;
    }
}

/** Drop the connection.
 *
 * Only `gc.php` and the test suite call this, and only for the same reason: both
 * need the file lock released before they move or delete the database. A request
 * that does not need it keeps its connection until the end of the request, which
 * is when PHP releases it anyway.
 */
function rc_db_close(): void
{
    if (!$GLOBALS['RC_DB_PDO'] instanceof PDO) {
        return;
    }
    // Not `= null` on its own: PDO has no close(), and dropping the last reference
    // is what actually releases the file handle. `$pdo` exists so the object stays
    // alive until this line and no longer.
    $pdo = $GLOBALS['RC_DB_PDO'];
    $GLOBALS['RC_DB_PDO'] = null;
    unset($pdo);
}