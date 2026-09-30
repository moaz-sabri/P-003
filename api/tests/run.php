<?php

declare(strict_types=1);

/**
 * The API test runner. `php api/tests/run.php`, or `npm run test:api`.
 *
 * Deliberately not a framework. There are about twenty tests, they run in
 * milliseconds, and each one needs a temporary SQLite file — a test framework
 * would add a dependency to a project whose entire premise is that it has almost
 * none, to replace a loop.
 *
 * One test, one file, exit code 0 or 1. The exit code is the part CI reads and the
 * reason this file exists at all: a suite that prints failures and returns success
 * is a suite that stops being run.
 */

require_once __DIR__ . '/security.php';

$filter = $argv[1] ?? null;

/** @var list<array{0:string,1:callable}> $tests */
$tests = $GLOBALS['RC_TESTS'];

$passed = 0;
$failures = [];

foreach ($tests as [$name, $fn]) {
    if ($filter !== null && stripos($name, $filter) === false) {
        continue;
    }

    try {
        $fn();
        $passed++;
        fwrite(STDOUT, "  ok   {$name}\n");
    } catch (Throwable $err) {
        $failures[] = [$name, $err];
        fwrite(STDOUT, "  FAIL {$name}\n");
        fwrite(STDOUT, '         ' . $err->getMessage() . "\n");
    }
}

$total = $passed + count($failures);
fwrite(STDOUT, "\n{$passed}/{$total} passed\n");

if ($failures !== []) {
    // The class and file, not the stack: a stack trace from a twenty-test suite is
    // noise, and the message is written to say what was expected.
    foreach ($failures as [$name, $err]) {
        fwrite(STDERR, "\n{$name}\n  {$err->getMessage()}\n");
    }
    exit(1);
}

exit(0);