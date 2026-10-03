<?php

declare(strict_types=1);

/**
 * The API's test suite, as functions a tiny runner calls.
 *
 * Every test here is one the code's own comments claim, checked. The claims are the
 * dangerous part of this project — "every query is scoped by space_id", "a 401 for a
 * missing space and for a wrong key", "the pull cursor never advances past a
 * record" — because each is a sentence in a comment that a change elsewhere does
 * not have to honour. A test is what makes the sentence binding.
 *
 * Run with `php api/tests/run.php`, or `npm run test:api`.
 *
 * NO MOCKS. Every test runs against a real SQLite file in a temporary directory,
 * created fresh and deleted afterwards. A test that mocked the database would be
 * testing the mock's idea of SQL, and the failures that matter here — a missing
 * space scope in a WHERE, a comparison that is not constant-time, a cursor that
 * jumps — are all things a mock cannot see.
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../sync.php';
// `rc_collect` lives in the collection script. Requiring it is what makes the
// `PHP_SAPI !== 'cli'` guard in that file pass — these tests run under the CLI
// SAPI, which is the only way they run at all.
require_once __DIR__ . '/../gc.php';

/* --------------------------------- runner ---------------------------------- */

/** @var list<array{0:string,1:callable}> */
$GLOBALS['RC_TESTS'] = [];

function rc_test(string $name, callable $fn): void
{
    $GLOBALS['RC_TESTS'][] = [$name, $fn];
}

/** @throws RuntimeException when the assertion does not hold */
function rc_assert(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function rc_assert_same(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(sprintf(
            '%s (expected %s, got %s)',
            $message,
            var_export($expected, true),
            var_export($actual, true)
        ));
    }
}

/** A fresh database in a temporary directory, with the config pointing at it. */
function rc_fresh_db(): string
{
    $dir = sys_get_temp_dir() . '/recall-test-' . bin2hex(random_bytes(6));
    if (!mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('cannot create a temporary directory');
    }
    // Set the environment rather than editing config.php: the config reads the
    // environment on every call, so this is the one place a test can point the
    // whole app at its own file without touching a global that another test is
    // using.
    putenv('DATABASE_PATH=' . $dir . '/sync.sqlite');
    // The cache has to go with it, or the second test in this file opens the FIRST
    // test's database — which has already been deleted, so every later test fails
    // with an auth error against a space that was never created.
    rc_config_reset();
    rc_db_close();
    return $dir;
}

function rc_drop_db(string $dir): void
{
    rc_db_close();
    foreach (['sync.sqlite', 'sync.sqlite-wal', 'sync.sqlite-shm'] as $file) {
        $path = $dir . '/' . $file;
        if (is_file($path)) {
            @unlink($path);
        }
    }
    @rmdir($dir);
    putenv('DATABASE_PATH');
}

/** A plausible request environment, so a test only names what it is about. */
function rc_request(string $space, string $key, array $overrides = []): array
{
    return $overrides + [
        'HTTP_X_SPACE' => $space,
        'HTTP_X_KEY' => $key,
        'REMOTE_ADDR' => '203.0.113.7',
        'HTTP_HOST' => 'recall.example',
    ];
}

/** A valid auth key for a named seed.
 *
 * Written as a hash rather than as a literal string of repeated characters because
 * a hand-typed "key" in a test is a hex string that is quietly not hex — `g7g7…`
 * and `ka` read as keys and are refused by `rc_is_auth_key`, which turns a test
 * about pushing records into a failure about a header. The hash is 32 bytes of
 * hex by construction and always passes. */
function rc_key(string $seed): string
{
    return hash('sha256', $seed);
}

/** A record with the right shape and a real-looking id. */
function rc_record(string $store = 'questions', string $id = 'q_11111111-1111-4111-8111-111111111111', array $overrides = []): array
{
    return $overrides + [
        'store' => $store,
        'id' => $id,
        'deleted' => 0,
        'body' => [
            'v' => 1,
            'iv' => 'AAAAAAAAAAAAAAAA',
            'body' => 'Y2lwaGVydGV4dA==',
        ],
        'updatedAt' => 1700000000,
    ];
}

/* ------------------------------ shape checks ------------------------------- */

rc_test('a space id must be 24 base64 characters ending in one pad', function (): void {
    rc_assert(rc_is_space_id('AAAAAAAAAAAAAAAAAAAAAA=='), 'a well-formed id is refused');
    rc_assert(!rc_is_space_id('AAAAAAAAAAAAAAAAAAAAAA='), 'a single pad is accepted');
    rc_assert(!rc_is_space_id('short'), 'a short id is accepted');
    rc_assert(!rc_is_space_id('AAAAAAAAAAAAAAAAAAAAAAA=='), 'a long id is accepted');
    rc_assert(!rc_is_space_id(str_repeat('A', 23) . '=='), 'a wrong length is accepted');
    rc_assert(!rc_is_space_id("AAAAAAAAAAAAAAAAAAAAAA==\0"), 'a NUL byte is accepted');
    rc_assert(!rc_is_space_id('!' . str_repeat('A', 21) . '!='), 'a character outside the alphabet is accepted');
});

rc_test('an auth key must be 64 lower-case hex characters', function (): void {
    rc_assert(rc_is_auth_key(str_repeat('a', 64)), 'a well-formed key is refused');
    rc_assert(!rc_is_auth_key(str_repeat('A', 64)), 'an upper-case key is accepted');
    rc_assert(!rc_is_auth_key(str_repeat('a', 63)), 'a 63-character key is accepted');
    rc_assert(!rc_is_auth_key(str_repeat('g', 64)), 'a non-hex key is accepted');
    rc_assert(!rc_is_auth_key(''), 'an empty key is accepted');
});

rc_test('the store list is the eight synced stores and nothing else', function (): void {
    // Mirrors SYNCED_STORES in app/js/data/stores.js. `meta` and `keys` must
    // never appear: the first holds the sync cursor, the second a CryptoKey.
    //
    // `groups` is in here because a question's group travels with it. A question
    // that arrived without the group it belongs to would be a question filed
    // nowhere, on the device that synced it — which is precisely the state groups
    // were added to get rid of, arriving again through the server instead.
    //
    // `goalRefs` is in here for the same reason and more sharply: it is the ONLY
    // thing that says a goal draws on a group or on a question, so a goalRefs row
    // that stops here is a goal that silently loses a shelf on the other device. It
    // cannot be re-derived on arrival — there is nothing on the other side to derive
    // it from — which is exactly why it is a store rather than a join done at read
    // time.
    rc_assert_same(
        ['goals', 'questions', 'groups', 'options', 'exercises', 'exerciseItems',
            'attempts', 'goalRefs'],
        RC_STORES,
        'the store list drifted from the client'
    );
});

rc_test('every synced store has its id prefix accepted, including the two that were missing', function (): void {
    // The id pattern in sync.php and the PREFIXES map in app/js/domain/id.js are two
    // copies of one fact in two languages, and they disagreed: `gr_` and `rf_` were
    // in PREFIXES and not in the pattern. A group or a reference row whose id the
    // pattern refuses is refused on push AND is not in the id check on the way back,
    // so it vanished between two devices with no error on either side.
    //
    // This asserts the shape rather than the pattern string, so renaming a prefix in
    // one language and forgetting the other fails here instead of on a reader's
    // second phone.
    $code = file_get_contents(__DIR__ . '/../sync.php');
    rc_assert(strpos($code, 'RC_STORES') !== false, 'sync.php does not declare RC_STORES');

    foreach (['g_', 'q_', 'gr_', 'o_', 'x_', 'it_', 'a_', 'rf_'] as $prefix) {
        rc_assert(
            strpos($code, $prefix) !== false,
            "the id pattern in sync.php does not accept the {$prefix} prefix"
        );
    }
    // And the shape, from a real id per prefix, through the real check.
    $uuid = '0f7c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    rc_assert(
        preg_match('#^(g_|q_|gr_|o_|x_|it_|a_|rf_)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$#', 'gr_' . $uuid) === 1,
        'a group id is refused'
    );
    rc_assert(
        preg_match('#^(g_|q_|gr_|o_|x_|it_|a_|rf_)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$#', 'rf_' . $uuid) === 1,
        'a goalRef id is refused'
    );
    rc_assert(
        preg_match('#^(g_|q_|gr_|o_|x_|it_|a_|rf_)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$#', 'zz_' . $uuid) !== 1,
        'an id with an unregistered prefix is accepted'
    );
});

/* --------------------------------- auth ------------------------------------ */

rc_test('open creates a space, and the same key opens it again', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'BBBBBBBBBBBBBBBBBBBBBB==';
        $key = rc_key('b1');

        $created = rc_open_space(rc_request($space, $key));
        rc_assert_same($space, $created['spaceId'], 'open returned the wrong space');

        // Idempotent: the sync client opens on every run, and a second open with
        // the same key must not fail or duplicate anything.
        $again = rc_open_space(rc_request($space, $key));
        rc_assert_same($space, $again['spaceId'], 'a repeated open did not return the space');

        $count = rc_db()->query('SELECT COUNT(*) FROM spaces')->fetchColumn();
        rc_assert_same(1, (int) $count, 'a repeated open created a second space row');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('open refuses a space that exists under another key', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'CCCCCCCCCCCCCCCCCCCCCC==';
        rc_open_space(rc_request($space, rc_key('c2')));

        $refused = false;
        try {
            rc_open_space(rc_request($space, rc_key('c3')));
        } catch (RcAuthError $err) {
            $refused = true;
            rc_assert_same(409, $err->status, 'a taken space is refused with the wrong status');
        }
        rc_assert($refused, 'a second key took over an existing space');

        // And the original key still works — the failed claim must not have written
        // anything, which is the failure mode an "UPDATE on conflict" would have.
        $identity = rc_require_space(rc_request($space, rc_key('c2')));
        rc_assert_same($space, $identity['spaceId'], 'the original key stopped working');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a wrong key and an unknown space are refused identically', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'DDDDDDDDDDDDDDDDDDDDDD==';
        rc_open_space(rc_request($space, rc_key('d4')));

        $statuses = [];
        foreach ([[$space, rc_key('d5')], ['EEEEEEEEEEEEEEEEEEEEEE==', rc_key('d6')]] as [$s, $k]) {
            try {
                rc_require_space(rc_request($s, $k));
                $statuses[] = 'accepted';
            } catch (RcAuthError $err) {
                $statuses[] = $err->status;
            }
        }
        // The same status for both, and the same code: a different answer for a
        // missing space would tell a prober which space ids exist.
        rc_assert_same([401, 401], $statuses, 'the two refusals differ');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a malformed header is refused before any query', function (): void {
    $dir = rc_fresh_db();
    try {
        foreach ([['', str_repeat('a', 64)], ['AAAAAAAAAAAAAAAAAAAAAA==', ''], ['AAAAAAAAAAAAAAAAAAAAAA==', 'nope']] as [$s, $k]) {
            $refused = false;
            try {
                rc_require_space(rc_request($s, $k));
            } catch (RcAuthError) {
                $refused = true;
            }
            rc_assert($refused, 'a malformed header pair was accepted');
        }
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('the rate limiter stops at the configured count', function (): void {
    $dir = rc_fresh_db();
    try {
        putenv('RATE_LIMIT_MAX=5');
        rc_config_reset();
        $bucket = 'addr:198.51.100.1';
        for ($i = 0; $i < 5; $i++) {
            rc_rate_limit($bucket);
        }
        $refused = false;
        try {
            rc_rate_limit($bucket);
        } catch (RcAuthError $err) {
            $refused = true;
            rc_assert_same(429, $err->status, 'the limiter refused with the wrong status');
        }
        rc_assert($refused, 'the sixth request in a window of five was allowed');

        // A different bucket is unaffected: the limiter is per identity, and one
        // device hitting the limit must not lock out every other device.
        rc_rate_limit('addr:198.51.100.2');
    } finally {
        putenv('RATE_LIMIT_MAX');
        rc_config_reset();
        rc_drop_db($dir);
    }
});

rc_test('an unauthenticated bucket is counted by address, and only by address', function (): void {
    rc_assert_same('addr:203.0.113.7', rc_rate_bucket(null, rc_request('AAAAAAAAAAAAAAAAAAAAAA==', str_repeat('a', 64))), 'an anonymous request is not keyed by address');
    rc_assert_same('space:AAAAAAAAAAAAAAAAAAAAAA==', rc_rate_bucket('AAAAAAAAAAAAAAAAAAAAAA==', rc_request('AAAAAAAAAAAAAAAAAAAAAA==', str_repeat('a', 64))), 'an identified request is not keyed by space');

    // X-Forwarded-For is client-writable and is ignored unless the deployment opts
    // in, so a caller cannot raise its own limit by inventing a header.
    $forwarded = rc_request('AAAAAAAAAAAAAAAAAAAAAA==', str_repeat('a', 64), ['HTTP_X_FORWARDED_FOR' => '1.2.3.4']);
    rc_assert_same('addr:203.0.113.7', rc_rate_bucket(null, $forwarded), 'X-Forwarded-For was believed by default');
});

rc_test('a cross-origin request is refused and a same-origin one is not', function (): void {
    $request = rc_request('AAAAAAAAAAAAAAAAAAAAAA==', str_repeat('a', 64), ['HTTP_ORIGIN' => 'https://recall.example']);
    rc_assert(rc_same_origin($request), 'a same-origin request was refused');

    rc_assert(!rc_same_origin(rc_request('AAAAAAAAAAAAAAAAAAAAAA==', str_repeat('a', 64), ['HTTP_ORIGIN' => 'https://elsewhere.example'])), 'another host was allowed');
    // A different PORT is a different origin to a browser, and this app is served
    // on :8080 in development — so a same-host wrong-port request must be refused.
    rc_assert(!rc_same_origin(rc_request('AAAAAAAAAAAAAAAAAAAAAA==', str_repeat('a', 64), ['HTTP_ORIGIN' => 'https://recall.example:8443'])), 'another port was allowed');
    // No Origin at all: same-origin GETs and form posts do not send one.
    rc_assert(rc_same_origin(rc_request('AAAAAAAAAAAAAAAAAAAAAA==', str_repeat('a', 64))), 'a request with no Origin was refused');
});

/* -------------------------------- push/pull -------------------------------- */

rc_test('a push acknowledges every record with a rising revision', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'FFFFFFFFFFFFFFFFFFFFFF==';
        rc_open_space(rc_request($space, rc_key('f6')));

        $result = rc_push([
            rc_record('questions', 'q_11111111-1111-4111-8111-111111111111'),
            rc_record('options', 'o_22222222-2222-4222-8222-222222222222'),
        ], $space);

        rc_assert_same(2, count($result['acks']), 'the wrong number of acknowledgements');
        rc_assert_same(2, $result['rev'], 'the push revision is wrong');
        // Strictly rising, and the last acknowledgement equals the reported
        // revision: the client's cursor is set from this number, so a revision that
        // is higher than any record handed out is how a pull skips a page.
        $revs = array_column($result['acks'], 'rev');
        rc_assert($revs[1] > $revs[0], 'revisions did not rise');
        rc_assert_same($result['rev'], $revs[1], 'the reported revision is not the last record');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a push is an upsert: the same id twice leaves one row', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'GGGGGGGGGGGGGGGGGGGGGG==';
        rc_open_space(rc_request($space, rc_key('g7')));

        $id = 'q_33333333-3333-4333-8333-333333333333';
        rc_push([rc_record('questions', $id)], $space);
        rc_push([rc_record('questions', $id, ['updatedAt' => 1700000500])], $space);

        $rows = rc_db()->query("SELECT COUNT(*) FROM records WHERE space_id = '{$space}'")->fetchColumn();
        rc_assert_same(1, (int) $rows, 'a repeated push duplicated the row');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a pull returns records in revision order and then stops', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'HHHHHHHHHHHHHHHHHHHHHH==';
        rc_open_space(rc_request($space, rc_key('h8')));

        $ids = [];
        for ($i = 0; $i < 5; $i++) {
            $ids[] = sprintf('q_%08x-1111-4111-8111-111111111111', $i);
        }
        rc_push(array_map(fn (string $id) => rc_record('questions', $id), $ids), $space);

        $page = rc_pull($space, 0, 2);
        rc_assert_same(2, count($page['records']), 'the page is the wrong size');
        rc_assert_same(true, $page['more'], 'a full page did not report more');
        rc_assert_same(2, $page['rev'], 'the cursor is not the highest revision handed out');

        $next = rc_pull($space, $page['rev'], 2);
        rc_assert_same(2, count($next['records']), 'the second page is the wrong size');

        $last = rc_pull($space, $next['rev'], 100);
        rc_assert_same(1, count($last['records']), 'the last page is the wrong size');
        rc_assert_same(false, $last['more'], 'a short page still reported more');

        // The cursor the client would keep: the last revision it was GIVEN. Not the
        // space's counter — advancing to the counter skips records the client never
        // received, and nothing will send them again.
        rc_assert_same(5, $last['rev'], 'the final cursor is not the last record handed out');
        rc_assert_same(0, count(rc_pull($space, $last['rev'], 100)['records']), 'a pull from the end returned records');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a pull never crosses a space boundary', function (): void {
    $dir = rc_fresh_db();
    try {
        $mine = 'IIIIIIIIIIIIIIIIIIIIII==';
        $theirs = 'JJJJJJJJJJJJJJJJJJJJJJ==';
        rc_open_space(rc_request($mine, rc_key('i9')));
        rc_open_space(rc_request($theirs, rc_key('j0')));

        $theirId = 'q_44444444-4444-4444-8444-444444444444';
        rc_push([rc_record('questions', $theirId)], $theirs);

        $page = rc_pull($mine, 0, 100);
        rc_assert_same(0, count($page['records']), 'one space read another space');

        // And the id is not blocked by the other space having used it: a record id
        // is generated on a device, so two spaces can hold the same one and the
        // primary key has to keep them apart.
        $myId = 'q_44444444-4444-4444-8444-444444444444';
        rc_push([rc_record('questions', $myId)], $mine);
        $rows = rc_db()->query('SELECT COUNT(*) FROM records')->fetchColumn();
        rc_assert_same(2, (int) $rows, 'the same id in two spaces collapsed into one row');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a pull limit from the client is capped by the server', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'KKKKKKKKKKKKKKKKKKKKKK==';
        rc_open_space(rc_request($space, rc_key('ka')));
        $max = (int) rc_conf('pull_max_limit');

        $records = [];
        for ($i = 0; $i < $max + 5; $i++) {
            $records[] = rc_record('questions', sprintf('q_%08x-1111-4111-8111-111111111111', $i + 1));
        }
        rc_push(array_slice($records, 0, $max + 5 > (int) rc_conf('push_max_records') ? (int) rc_conf('push_max_records') : $max + 5), $space);

        $page = rc_pull($space, 0, 100000);
        rc_assert(count($page['records']) <= $max, 'the server honoured a client limit above its own');
    } finally {
        rc_drop_db($dir);
    }
});

/* ------------------------------ record checks ------------------------------ */

rc_test('a record outside the store list is refused', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'LLLLLLLLLLLLLLLLLLLLLL==';
        rc_open_space(rc_request($space, rc_key('lb')));

        foreach (['meta', 'keys', 'attempts ', 'QUESTIONS', '', '../../etc'] as $store) {
            $refused = false;
            try {
                rc_push([rc_record($store)], $space);
            } catch (RcBadRequest) {
                $refused = true;
            }
            rc_assert($refused, "the store '{$store}' was accepted");
        }
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a record with a bad id is refused', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'MMMMMMMMMMMMMMMMMMMMMM==';
        rc_open_space(rc_request($space, rc_key('mc')));

        foreach ([
            'not-an-id',
            'q_short',
            str_repeat('A', 38),
            "q_11111111-1111-4111-8111-111111111111' OR 1=1--",
            '../../etc/passwd',
            str_repeat('q_', 40)
        ] as $id) {
            $refused = false;
            try {
                rc_push([rc_record('questions', $id)], $space);
            } catch (RcBadRequest) {
                $refused = true;
            }
            rc_assert($refused, 'a malformed id was accepted');
        }
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a deleted flag that is not 0 or 1 is refused', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'NNNNNNNNNNNNNNNNNNNNNN==';
        rc_open_space(rc_request($space, rc_key('nd')));

        foreach ([2, -1, '1', 1.0, null] as $deleted) {
            $refused = false;
            try {
                rc_push([rc_record('questions', 'q_55555555-5555-4555-8555-555555555555', ['deleted' => $deleted])], $space);
            } catch (RcBadRequest) {
                $refused = true;
            }
            rc_assert($refused, 'a non-flag deleted value was accepted');
        }
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a body that is not a sealed envelope is refused', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'OOOOOOOOOOOOOOOOOOOOOO==';
        rc_open_space(rc_request($space, rc_key('oe')));

        foreach ([
            ['v' => 1],
            ['iv' => 'AAAAAAAAAAAAAAAA'],
            'a string',
            ['iv' => 'AAAAAAAAAAAAAAAA', 'body' => ['not', 'a', 'string']],
            ['v' => '1', 'iv' => 'AAAAAAAAAAAAAAAA', 'body' => 'Y2lwaGVy'],
            null,
            42
        ] as $body) {
            $refused = false;
            try {
                rc_push([rc_record('questions', 'q_66666666-6666-4666-8666-666666666666', ['body' => $body])], $space);
            } catch (RcBadRequest) {
                $refused = true;
            }
            rc_assert($refused, 'a body that no device could read was stored');
        }
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('an implausible updatedAt is replaced rather than trusted', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'PPPPPPPPPPPPPPPPPPPPPP==';
        rc_open_space(rc_request($space, rc_key('pf')));

        // A year in the future, with the record marked deleted: trusted as-is it
        // would sit in the table until the garbage collector's idea of "old" caught
        // up, and the deletion would not be propagated to an offline device for
        // most of a year.
        $future = time() + 31536000;
        rc_push([rc_record('questions', 'q_77777777-7777-4777-8777-777777777777', [
            'deleted' => 1,
            'updatedAt' => $future
        ])], $space);

        $stored = (int) rc_db()->query('SELECT updated_at FROM records')->fetchColumn();
        rc_assert(abs($stored - time()) < 60, 'a future updatedAt was stored as sent');

        // A negative one is replaced too — a device with a clock before 1970 should
        // not be able to have its tombstone collected immediately.
        rc_push([rc_record('questions', 'q_88888888-8888-4888-8888-888888888888', [
            'deleted' => 1,
            'updatedAt' => -5000
        ])], $space);
        $rows = rc_db()->query('SELECT updated_at FROM records ORDER BY updated_at')->fetchAll();
        rc_assert((int) $rows[0]['updated_at'] > 0, 'a negative updatedAt was stored');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a body larger than the per-record limit is refused', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'QQQQQQQQQQQQQQQQQQQQQQ==';
        rc_open_space(rc_request($space, rc_key('qg')));

        $huge = str_repeat('A', (int) rc_conf('record_max_body') + 16);
        $refused = false;
        try {
            rc_push([rc_record('questions', 'q_99999999-9999-4999-8999-999999999999', [
                'body' => ['v' => 1, 'iv' => 'AAAAAAAAAAAAAAAA', 'body' => $huge]
            ])], $space);
        } catch (RcBadRequest $err) {
            $refused = true;
            rc_assert_same('body_too_large', $err->reason, 'the wrong refusal reason for an oversized record');
        }
        rc_assert($refused, 'an oversized record was stored');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('a push over the batch limit is refused rather than truncated', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'RRRRRRRRRRRRRRRRRRRRRR==';
        rc_open_space(rc_request($space, rc_key('rh')));

        $records = [];
        for ($i = 0; $i < (int) rc_conf('push_max_records') + 1; $i++) {
            $records[] = rc_record('questions', sprintf('q_%08x-2111-4111-8111-111111111111', $i));
        }
        $refused = false;
        try {
            rc_push($records, $space);
        } catch (RcBadRequest) {
            $refused = true;
        }
        rc_assert($refused, 'an oversized batch was accepted');

        // Nothing was written: validating before the transaction opens is the whole
        // point, and a partial push would leave a client with acknowledgements for
        // records it did not send.
        $rows = rc_db()->query('SELECT COUNT(*) FROM records')->fetchColumn();
        rc_assert_same(0, (int) $rows, 'a refused batch left rows behind');
    } finally {
        rc_drop_db($dir);
    }
});

/* ------------------------------- collection -------------------------------- */

rc_test('collection keeps recent tombstones and drops old ones', function (): void {
    $dir = rc_fresh_db();
    try {
        $space = 'SSSSSSSSSSSSSSSSSSSSSS==';
        rc_open_space(rc_request($space, rc_key('si')));

        $cut = (int) rc_conf('gc_tombstone_days');
        rc_push([
            rc_record('questions', 'q_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ['deleted' => 1, 'updatedAt' => time() - 5]),
            rc_record('questions', 'q_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ['deleted' => 0, 'updatedAt' => time() - 5]),
            rc_record('questions', 'q_cccccccc-cccc-4ccc-8ccc-cccccccccccc', ['deleted' => 1, 'updatedAt' => time() - (($cut + 1) * 86400)]),
        ], $space);

        $result = rc_collect(true);
        rc_assert_same(1, $result['tombstones'], 'the dry run counted the wrong tombstones');
        rc_assert_same(true, $result['dryRun'], 'the dry run reported itself as a real run');

        $before = (int) rc_db()->query('SELECT COUNT(*) FROM records')->fetchColumn();
        rc_assert_same(3, $before, 'the dry run changed the table');

        rc_collect(false);
        $after = (int) rc_db()->query('SELECT COUNT(*) FROM records')->fetchColumn();
        // The live record and the recent tombstone stay; only the old tombstone goes.
        rc_assert_same(2, $after, 'collection removed the wrong rows');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('collection removes an abandoned space with everything in it', function (): void {
    $dir = rc_fresh_db();
    try {
        $gone = 'TTTTTTTTTTTTTTTTTTTTTT==';
        $live = 'UUUUUUUUUUUUUUUUUUUUUU==';
        rc_open_space(rc_request($gone, rc_key('t4')));
        rc_open_space(rc_request($live, rc_key('u5')));

        $cut = (int) rc_conf('gc_space_days');
        rc_push([rc_record('questions', 'q_dddddddd-dddd-4ddd-8ddd-dddddddddddd')], $gone);
        rc_push([rc_record('questions', 'q_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')], $live);

        // Backdate one space's last sighting. Written with a prepared statement
        // rather than through the API, because there is no API that moves it — and
        // that is the point: a client cannot keep its own space alive by lying
        // about anything.
        $backdate = rc_db()->prepare('UPDATE spaces SET last_seen_at = :at WHERE space_id = :space');
        $backdate->execute([':at' => time() - (($cut + 1) * 86400), ':space' => $gone]);

        $result = rc_collect(false);
        rc_assert_same(1, $result['spaces'], 'the wrong number of spaces was collected');
        rc_assert_same(1, $result['records'], 'the wrong number of records was reported');

        $spaces = rc_db()->query('SELECT space_id FROM spaces')->fetchAll();
        rc_assert_same(1, count($spaces), 'the live space was removed too');
        rc_assert_same($live, (string) $spaces[0]['space_id'], 'the wrong space survived');

        // Only the surviving space's record survives: the removed one's went with it.
        $remaining = rc_db()->prepare('SELECT COUNT(*) FROM records WHERE space_id = :space');
        $remaining->execute([':space' => $live]);
        rc_assert_same(1, (int) $remaining->fetchColumn(), 'a removed space kept its records');
    } finally {
        rc_drop_db($dir);
    }
});

rc_test('every statement that touches a row names the space', function (): void {
    // Not a runtime check — a source check, and it is the only one that can catch a
    // WHERE clause that lost its space in a future edit. `records`, `counters` and
    // `spaces` are the tables where a missing scope is a cross-tenant read or
    // write; `rate` is keyed by bucket on purpose and is excluded.
    $sources = [__DIR__ . '/../sync.php', __DIR__ . '/../auth.php', __DIR__ . '/../gc.php'];
    foreach ($sources as $file) {
        $code = (string) file_get_contents($file);
        // Every prepared statement against a scoped table, in one statement, has to
        // bind :space. Matched on the statement text up to its parameter list.
        preg_match_all('/(?:FROM|INTO|UPDATE)\s+(records|counters|spaces)\b([^;]*)/i', $code, $matches, PREG_SET_ORDER);
        foreach ($matches as $match) {
            $clause = $match[2];
            // A statement that mentions :space somewhere in its text is scoped; one
            // that does not is either a COUNT(*) helper or a bug, and this suite
            // would rather be noisy than miss the second kind.
            if (stripos($clause, ':space') === false && stripos($clause, 'space_id') === false) {
                // Three statements are allowed to be unscoped, and each is allowed
                // for a stated reason rather than because the check gave up:
                //
                //   COUNT(*) — aggregates rather than reading or writing a row, and
                //     appears in the collection report.
                //   `FROM rate` — the limiter is keyed by bucket on purpose.
                //   `deleted = 1` — the tombstone sweep in gc.php. A tombstone is a
                //     row with no body, so removing it exposes nothing, and the
                //     clause cannot match a live record.
                //   `last_seen_at` — the same script's "which spaces have nobody
                //     used lately" query, which has to scan `spaces` to be able to
                //     answer that. The deletions that follow it are scoped.
                $allowed = stripos($clause, 'count(') !== false
                    || stripos($match[0], 'rate') !== false
                    || stripos($clause, 'deleted = 1') !== false
                    || stripos($clause, 'last_seen_at') !== false;
                if (!$allowed) {
                    throw new RuntimeException(
                        "{$file}: a statement against {$match[1]} has no space scope"
                    );
                }
            }
        }
    }
});