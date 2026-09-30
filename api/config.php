<?php

declare(strict_types=1);

/**
 * The API's configuration, in one file.
 *
 * Every value here has a default that works, so `php -S` with no setup and the
 * container both run. An operator who needs to change something sets an
 * environment variable or drops an `api/config.local.php` in place — the local
 * file wins, because a value that only works from the environment is a value that
 * cannot be committed and cannot be reviewed.
 *
 * Nothing secret belongs in either file, and nothing here is read from a request.
 * The only credential this server has is the SHA-256 of an auth key that a device
 * derives, and it lives in the database; a configuration file that could hold a
 * key is a configuration file that ends up in a backup somebody mails around.
 */

/**
 * @return array<string,mixed>
 */
function rc_defaults(): array
{
    return [
        // Where the SQLite file goes. Must be inside api/var/ in every deployment,
        // because that is the only directory the shipped server configs refuse to
        // serve — the file is the store of every record's ciphertext.
        'db_path' => __DIR__ . '/var/sync.sqlite',

        // How large a request body may be before it is refused unread. nginx
        // caps this at 1m as well (see docker/nginx/default.conf); the value here
        // is the one that actually applies, and the two are kept in step because
        // raising only the PHP side leaves nginx refusing perfectly good pushes.
        'request_max_bytes' => 1048576,

        // Requests per minute, per identity (or per address before there is one).
        // The app's own behaviour is one push, one pull and one open per sync run
        // every thirty seconds, so this is roughly an order of magnitude of
        // headroom over a device that syncs constantly and a hard stop for one
        // that is looping.
        'rate_limit_max' => 120,

        // How long a rate-limit window lasts, in seconds. One window, counted in
        // the database, because there is nowhere else in a stateless PHP-FPM
        // deployment to put a counter and a file per client is a denial of
        // service in itself.
        'rate_limit_window' => 60,

        // Records per push request, and the ceiling on a pull page. Both mirror
        // SYNC_PUSH_BATCH in app/js/config.js. The server's number is the one that
        // counts: a client that asked for a thousand records and got them would
        // make one request cost a thousand rows.
        'push_max_records' => 100,
        'pull_max_limit' => 100,

        // A single sealed record, base64. 96 KiB of ciphertext is far beyond any
        // question this app can produce — the largest thing it stores is a handful
        // of short option texts — and it exists so that one enormous record
        // cannot fill a page before the body limit notices.
        'record_max_body' => 131072,

        // Tombstones are kept for this long before collection, in days. A device
        // that has been offline for a month has to learn about a deletion, and a
        // deletion that is collected too early comes back as a resurrected
        // question on the next device that asks.
        'gc_tombstone_days' => 120,

        // A space that has not authenticated in this long is removed with its
        // records, in days. The auth key cannot be recovered from the stored hash
        // and the Secret Key is not here, so a space nobody has used in eight
        // months is data nobody can read by any route.
        'gc_space_days' => 240,

        // Sent as Strict-Transport-Security when > 0. Off by default because the
        // container serves plain HTTP on :8080 and the header is cached by the
        // browser for its whole max-age — turning it on there would break every
        // later plain-HTTP request to the same host, including `docker compose up`.
        'hsts_max_age' => 0,

        // 'production' by default so that a bare checkout is not verbose. Anything
        // else is treated as development, which relaxes the frame and referrer
        // headers enough for a local tool to drive it.
        'environment' => 'production',

        // The app version, for /api/health. Kept in step with app/js/config.js and
        // package.json by tests/deploy.test.mjs; it is a build marker, not a
        // dependency check.
        'version' => '1.0.0',

        // Whether to believe X-Forwarded-For. Off by default because the header is
        // client-writable and a limiter that believes it is a limiter the client
        // sets for itself; a deployment behind a proxy that OVERWRITES the header
        // can turn this on in config.local.php. See rc_remote_address.
        'trust_proxy_headers' => false,
    ];
}

/** Environment overrides, read once. `false` and empty mean "not set". */
function rc_env_overrides(): array
{
    $map = [
        'DATABASE_PATH' => ['db_path', 'string'],
        'REQUEST_MAX_BYTES' => ['request_max_bytes', 'int'],
        'RATE_LIMIT_MAX' => ['rate_limit_max', 'int'],
        'RATE_LIMIT_WINDOW' => ['rate_limit_window', 'int'],
        'PUSH_MAX_RECORDS' => ['push_max_records', 'int'],
        'PULL_MAX_LIMIT' => ['pull_max_limit', 'int'],
        'RECORD_MAX_BODY' => ['record_max_body', 'int'],
        'GC_TOMBSTONE_DAYS' => ['gc_tombstone_days', 'int'],
        'GC_SPACE_DAYS' => ['gc_space_days', 'int'],
        'HSTS_MAX_AGE' => ['hsts_max_age', 'int'],
        'ENVIRONMENT' => ['environment', 'string'],
    ];

    $out = [];
    foreach ($map as $env => [$key, $type]) {
        $value = getenv($env);
        if ($value === false || $value === '') {
            continue;
        }
        if ($type === 'int') {
            $int = (int) $value;
            if ($int > 0) {
                $out[$key] = $int;
            }
            continue;
        }
        $out[$key] = $value;
    }
    return $out;
}

function rc_config(): array
{
    if (is_array($GLOBALS['RC_CONFIG'] ?? null)) {
        return $GLOBALS['RC_CONFIG'];
    }

    $config = rc_defaults();

    $local = __DIR__ . '/config.local.php';
    if (is_file($local)) {
        /** @var mixed $loaded */
        $loaded = require $local;
        if (is_array($loaded)) {
            foreach ($loaded as $key => $value) {
                if (array_key_exists($key, $config)) {
                    $config[$key] = $value;
                }
            }
        }
    }

    // Environment beats the local file: a container that mounts a config file from
    // the host and then gets DATABASE_PATH from compose wants the compose value,
    // and the other order would silently prefer the copy in the image.
    foreach (rc_env_overrides() as $key => $value) {
        $config[$key] = $value;
    }

    if (!is_string($config['db_path']) || $config['db_path'] === '') {
        $config['db_path'] = rc_defaults()['db_path'];
    }

    // In a global rather than a function-local `static`, and reset by
    // rc_config_reset() — see below.
    $GLOBALS['RC_CONFIG'] = $config;
    return $config;
}

/**
 * Forget the cached configuration.
 *
 * Only the test suite calls this, and only because it points the whole app at a
 * temporary database by setting an environment variable between tests. A cache
 * that outlived that is a cache that makes the second test run against the first
 * test's file, and every failure afterwards looks like a bug in the code under
 * test rather than in the harness. */
function rc_config_reset(): void
{
    $GLOBALS['RC_CONFIG'] = null;
}

/** One value, by key. */
function rc_conf(string $key): mixed
{
    $config = rc_config();
    if (!array_key_exists($key, $config)) {
        throw new OutOfBoundsException("unknown config key: {$key}");
    }
    return $config[$key];
}

/** Whether this is a production deployment. Used for exactly two things: the
 *  health endpoint's verbosity and the frame/referrer headers. */
function rc_is_production(): bool
{
    return strtolower((string) rc_conf('environment')) === 'production';
}