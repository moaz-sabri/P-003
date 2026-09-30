<?php

declare(strict_types=1);

/**
 * Garbage collection. Deletes tombstones, then spaces nobody has used.
 *
 * Run it from cron, or by hand:
 *
 *   php api/gc.php
 *   php api/gc.php --dry-run
 *
 * TWO JOINS, IN THIS ORDER, and the order is the correctness of the whole file.
 *
 *   1. TOMBSTONES older than `gc_tombstone_days`. A deleted record is kept as a
 *      row with `deleted = 1` and no body, because a device that has been offline
 *      has to be told the record is gone. Collect it too early and the next device
 *      to pull finds nothing for that id and keeps its own copy forever — the
 *      deletion is undone, silently, on a device that was merely late.
 *
 *   2. SPACES with no authentication for `gc_space_days`, with their records and
 *      counters. This is the only thing in the app that deletes data nobody asked
 *      it to delete, and it is worth being exact about why it is acceptable: the
 *      auth key cannot be recovered from the stored hash, the Secret Key is not on
 *      this server, and the ciphertext in those rows is not readable from here. A
 *      space nobody has authenticated against in eight months is data that no route
 *      can bring back — keeping it costs storage and buys the owner nothing they
 *      could have lost.
 *
 * IT IS A CLI SCRIPT AND NOT AN ENDPOINT, deliberately. An HTTP route that deletes
 * rows needs an authentication scheme of its own, and the only credential this
 * server has is per-space — which would mean either "any device can trigger this"
 * or a second secret in a configuration file, and both are worse than a cron line.
 */

require_once __DIR__ . '/db.php';

if (PHP_SAPI !== 'cli') {
    // Reached only if a server is configured to execute this file directly, which
    // the shipped configs all avoid (nginx routes every /api/ path to index.php).
    // Refusing here means a misconfigured host produces a 403 rather than a
    // deletion.
    http_response_code(403);
    exit("gc.php is a command-line script\n");
}

/**
 * Collect, and report what it did.
 *
 * @return array{tombstones:int, spaces:int, records:int, dryRun:bool}
 */
function rc_collect(bool $dryRun = false): array
{
    $now = time();
    $tombstoneBefore = (int) rc_conf('gc_tombstone_days');
    $spaceBefore = (int) rc_conf('gc_space_days');

    $tombstoneCut = $now - ($tombstoneBefore * 86400);
    $spaceCut = $now - ($spaceBefore * 86400);

    return rc_transaction(function (PDO $pdo) use ($dryRun, $now, $tombstoneCut, $spaceCut): array {
        // 1. Tombstones. `deleted = 1` in the WHERE clause rather than reading the
        //    rows first: a live record with an old `updated_at` is the common case
        //    and must not be counted, let alone deleted.
        $tomb = $pdo->prepare('SELECT COUNT(*) FROM records WHERE deleted = 1 AND updated_at < :cut');
        $tomb->execute([':cut' => $tombstoneCut]);
        $tombstones = (int) $tomb->fetchColumn();

        // 2. Spaces, and what is in them. The counts come first so that a --dry-run
        //    can report them, and so that the deletion below can say how much it is
        //    removing rather than only how many spaces.
        $spaces = $pdo->prepare('SELECT space_id FROM spaces WHERE last_seen_at < :cut');
        $spaces->execute([':cut' => $spaceCut]);
        $ids = array_column($spaces->fetchAll(), 'space_id');

        $records = 0;
        foreach ($ids as $spaceId) {
            $count = $pdo->prepare('SELECT COUNT(*) FROM records WHERE space_id = :space');
            $count->execute([':space' => $spaceId]);
            $records += (int) $count->fetchColumn();
        }

        if ($dryRun) {
            return ['tombstones' => $tombstones, 'spaces' => count($ids), 'records' => $records, 'dryRun' => true];
        }

        foreach ($ids as $spaceId) {
            // Scoped by space_id in all three statements, for the same reason every
            // other statement in this API is: a missing space id here deletes
            // somebody else's records.
            $pdo->prepare('DELETE FROM records WHERE space_id = :space')->execute([':space' => $spaceId]);
            $pdo->prepare('DELETE FROM counters WHERE space_id = :space')->execute([':space' => $spaceId]);
            $pdo->prepare('DELETE FROM spaces WHERE space_id = :space')->execute([':space' => $spaceId]);
        }

        // Expired rate-limit rows are dropped last and unconditionally: a bucket
        // whose window has passed cannot affect the current window's count, so
        // there is nothing to be gained by keeping it and an unbounded table to
        // lose by keeping them.
        $rate = $pdo->prepare('DELETE FROM rate WHERE window_start < :cut');
        $rate->execute([':cut' => $now - ((int) rc_conf('rate_limit_window') * 2)]);

        // The one statement in this API that is deliberately not scoped by space, and
        // the only one: a tombstone is `deleted = 1` with no body, so removing it
        // loses nothing a reader can ever see, and scoping it by space would mean a
        // separate pass over every space rather than one indexed sweep. It cannot
        // delete a live record — `deleted = 1` is in the WHERE clause — and the
        // test that checks statement scoping in api/tests/security.php allows it
        // explicitly rather than not at all.
        $pdo->prepare('DELETE FROM records WHERE deleted = 1 AND updated_at < :cut')
            ->execute([':cut' => $tombstoneCut]);

        return ['tombstones' => $tombstones, 'spaces' => count($ids), 'records' => $records, 'dryRun' => false];
    });
}

/**
 * Compact the file.
 *
 * Not run by `collect()`: VACUUM rewrites the whole database, which on a large one
 * takes long enough to hold the write lock for minutes, and a cron job that holds
 * the write lock that long turns every device's sync into a timeout. So it is a
 * separate entry point, `php api/gc.php --vacuum`, for an operator to schedule at
 * an hour when nobody is using it.
 *
 * `VACUUM INTO` writes a NEW file and then moves it over the old one, which is why
 * this is the only thing in the app that calls rc_db_close(): the original has to
 * have no open handle before it can be replaced on any platform, and on Windows the
 * rename would fail with the file still locked. */
function rc_vacuum(): void
{
    $path = (string) rc_conf('db_path');
    $target = $path . '.compact';

    if (is_file($target) && !@unlink($target)) {
        throw new RuntimeException('cannot remove a previous compact file');
    }

    rc_db()->exec('VACUUM INTO ' . rc_pdo_quote_path($target));

    // Permissions first, then the move: the new file is created with the process's
    // umask and would otherwise be readable by whatever group the directory
    // allows, which is the one thing the 0600 on the original is there to prevent.
    @chmod($target, 0600);
    rc_db_close();

    if (!@rename($target, $path)) {
        throw new RuntimeException('cannot move the compacted database into place');
    }
}

/** A path quoted for use as a SQLite literal. The value is this script's own
 *  configuration rather than user input, but a path containing an apostrophe would
 *  otherwise produce a syntax error inside the VACUUM statement and there is no
 *  prepared-statement form of VACUUM INTO to fall back to. */
function rc_pdo_quote_path(string $path): string
{
    $pdo = rc_db();
    return $pdo->quote($path);
}

/* --------------------------------- CLI ------------------------------------- */

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === realpath(__FILE__)) {
    $dryRun = in_array('--dry-run', $argv, true);
    $vacuumOnly = in_array('--vacuum', $argv, true);

    if ($vacuumOnly) {
        rc_vacuum();
        fwrite(STDOUT, "compacted\n");
        exit(0);
    }

    $result = rc_collect($dryRun);
    $prefix = $result['dryRun'] ? 'would remove' : 'removed';
    fwrite(STDOUT, sprintf(
        "%s %d tombstones, %d spaces, %d records\n",
        $prefix,
        $result['tombstones'],
        $result['spaces'],
        $result['records']
    ));
}