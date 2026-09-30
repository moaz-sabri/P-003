<?php

declare(strict_types=1);

/**
 * Authentication: who is calling, and refusing the ones that are not.
 *
 * There is no login, no cookie and no session. A device proves itself by sending
 * two headers it derived from the Secret Key at setup time:
 *
 *   X-Space   the space id, and the name of the space it is writing into
 *   X-Key     the auth key, hex
 *
 * The server stores SHA-256 of the auth key and compares with `hash_equals`, so
 * the database is not a set of credentials: an attacker with the file can read
 * every ciphertext (which is what the ciphertext is for) and cannot push into any
 * space, because the hash is one-way. There is no recovery flow that could want
 * the original, which is why this is not a weakness of the design but the design.
 *
 * FOUR THINGS THIS FILE REFUSES, and each has a real failure behind it:
 *
 *   * A MISSING OR MALFORMED HEADER. Not "treat it as anonymous" — there is no
 *     anonymous. A header that is not exactly the shape it must be is a 401 with
 *     no detail, because the detail is what a prober iterates against.
 *   * A SPACE THAT DOES NOT EXIST. `POST /api/space/open` is how a space is
 *     created, and it is created from the same headers, so a caller cannot push
 *     into a space nobody has opened: the push requires an existing row whose key
 *     hash matches.
 *   * A RATE LIMIT, counted per identity in the database. nginx has one for the
 *     container deployment, but a plain PHP host has nothing, and this app is
 *     documented for one. The counter is a row, not a file: a file per client is
 *     a way to fill a disk.
 *   * AN ORIGIN THAT IS NOT THIS ONE. The API is same-origin by construction (the
 *     CSP's `connect-src 'self'` and the base-url rule in sync-service both
 *     enforce it from the browser), so an `Origin` header naming another host is a
 *     request no legitimate browser makes, and it is refused rather than answered.
 *
 * NOT LOGGED, ANYWHERE: the key, the hash, and the body of a request. The only
 * thing this file emits about a failure is an HTTP status.
 */

/** The exception every refusal in this file throws. `index.php` turns it into a
 *  JSON error; nothing else catches it.
 *
 *  `reason` rather than `code`, because `Exception::$code` already exists, is not
 *  readonly, and is an int — naming this property `code` is a redeclaration that
 *  PHP refuses at compile time, which is the kind of thing that is only discovered
 *  by loading the file. */
final class RcAuthError extends RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $reason)
    {
        parent::__construct($reason);
    }
}

/**
 * The identity behind this request, or a refusal.
 *
 * @return array{spaceId:string, keyHash:string}
 */
function rc_require_space(array $server): array
{
    $spaceId = $server['HTTP_X_SPACE'] ?? '';
    $key = $server['HTTP_X_KEY'] ?? '';

    $spaceId = is_string($spaceId) ? trim($spaceId) : '';
    $key = is_string($key) ? strtolower(trim($key)) : '';

    // 16 bytes, base64 — which is 24 characters ending in one `=`. The length and
    // the alphabet are both checked, because this value goes into a primary key
    // and a 10 MB header of arbitrary bytes should not be allowed to become one.
    if (!rc_is_space_id($spaceId) || !rc_is_auth_key($key)) {
        throw new RcAuthError(401, 'unauthorized');
    }

    $hash = hash('sha256', $key);

    require_once __DIR__ . '/db.php';
    $stmt = rc_db()->prepare('SELECT key_hash FROM spaces WHERE space_id = :space');
    $stmt->execute([':space' => $spaceId]);
    $row = $stmt->fetch();

    // The same refusal for "no such space" and "wrong key", and `hash_equals` for
    // the comparison. A distinct 404 for a missing space would tell a prober which
    // space ids exist, and `==` on the hash would be a timing oracle on a value
    // that is the only credential this server has.
    if (!is_array($row) || !hash_equals((string) $row['key_hash'], $hash)) {
        throw new RcAuthError(401, 'unauthorized');
    }

    // Best-effort. A failure here is a failed UPDATE on a read path and must not
    // fail the request: the reader is authenticated, and refusing a push because
    // the housekeeping timestamp could not be written would be a strange trade.
    try {
        $touch = rc_db()->prepare('UPDATE spaces SET last_seen_at = :now WHERE space_id = :space');
        $touch->execute([':now' => time(), ':space' => $spaceId]);
    } catch (PDOException) {
        // Swallowed on purpose, with the reason above.
    }

    return ['spaceId' => $spaceId, 'keyHash' => $hash];
}

/** Create the space if it is absent, and refuse if it exists under another key.
 *
 *  This is the only endpoint that writes an identity, and it cannot be used to take
 *  one over: an existing space with a different key hash is a 409, not an update.
 *  Without that check, anybody who learned a space id could claim it — and a
 *  space id is not a secret, it travels in every request and is printed on the
 *  settings page. */
function rc_open_space(array $server): array
{
    $spaceId = $server['HTTP_X_SPACE'] ?? '';
    $key = $server['HTTP_X_KEY'] ?? '';
    $spaceId = is_string($spaceId) ? trim($spaceId) : '';
    $key = is_string($key) ? strtolower(trim($key)) : '';

    if (!rc_is_space_id($spaceId) || !rc_is_auth_key($key)) {
        throw new RcAuthError(401, 'unauthorized');
    }

    $hash = hash('sha256', $key);
    $now = time();

    return rc_transaction(function (PDO $pdo) use ($spaceId, $hash, $now): array {
        $select = $pdo->prepare('SELECT key_hash FROM spaces WHERE space_id = :space');
        $select->execute([':space' => $spaceId]);
        $existing = $select->fetch();

        if (is_array($existing)) {
            if (!hash_equals((string) $existing['key_hash'], $hash)) {
                // 409, not 401: the space id is taken by somebody else, and
                // pretending otherwise would have this endpoint create a second
                // space with the same id and quietly diverge two devices.
                throw new RcAuthError(409, 'space_taken');
            }
        } else {
            $insert = $pdo->prepare(
                'INSERT INTO spaces (space_id, key_hash, created_at, last_seen_at)
                 VALUES (:space, :hash, :now, :now)'
            );
            $insert->execute([':space' => $spaceId, ':hash' => $hash, ':now' => $now]);
        }

        $counter = $pdo->prepare('INSERT OR IGNORE INTO counters (space_id, rev) VALUES (:space, 0)');
        $counter->execute([':space' => $spaceId]);

        return ['spaceId' => $spaceId];
    });
}

/** A space id: 16 bytes in base64. Exactly that, no more. */
function rc_is_space_id(string $value): bool
{
    return strlen($value) === 24
        && preg_match('#^[A-Za-z0-9+/]{22}==$#', $value) === 1;
}

/** An auth key: 32 bytes of hex, lower case. */
function rc_is_auth_key(string $value): bool
{
    return strlen($value) === 64
        && preg_match('#^[0-9a-f]{64}$#', $value) === 1;
}

/**
 * A fixed-window counter, per identity.
 *
 * The window is a row keyed by `(bucket, window_start)`, where the window start is
 * `floor(now / window) * window`. Counting that way means no cron, no cleanup
 * between windows — a row is overwritten when the window turns over — and no read
 * of every bucket on every request, which is what makes a per-identity limiter
 * affordable at all.
 *
 * The check and the increment are one statement, inside the caller's transaction
 * where there is one. A separate "is it over?" SELECT followed by an INSERT has a
 * race, and a race in a rate limiter means the limit is the limit plus the number
 * of requests that arrived at the same moment.
 *
 * @throws RcAuthError 429 when the window is full
 */
function rc_rate_limit(string $bucket): void
{
    $max = (int) rc_conf('rate_limit_max');
    $window = max(1, (int) rc_conf('rate_limit_window'));
    $start = intdiv(time(), $window) * $window;

    require_once __DIR__ . '/db.php';

    $upsert = rc_db()->prepare(
        'INSERT INTO rate (bucket, window_start, hits) VALUES (:bucket, :start, 1)
         ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1'
    );
    $upsert->execute([':bucket' => $bucket, ':start' => $start]);

    $read = rc_db()->prepare('SELECT hits FROM rate WHERE bucket = :bucket AND window_start = :start');
    $read->execute([':bucket' => $bucket, ':start' => $start]);
    $hits = $read->fetchColumn();

    if ($hits !== false && (int) $hits > $max) {
        throw new RcAuthError(429, 'rate_limited');
    }
}

/**
 * Whether this request came from this origin.
 *
 * `Origin` is absent on a same-origin GET and on a form post, so its absence is
 * fine. When it IS present it has to name this host — the API is same-origin by
 * design and a cross-origin caller has no business here; the browser would have
 * stopped it at the preflight anyway, and this is what catches a non-browser.
 *
 * The comparison uses the request's own Host header, which a client controls, so
 * this is NOT an origin check in the strict sense and must not be mistaken for
 * one. What it stops is the case that actually occurs: a page on some other origin
 * getting this API to answer for it, in a browser that would otherwise have let
 * the request through because the server sent no CORS headers and the *response*
 * was what the page wanted. Nothing here depends on the client being honest about
 * its Host — an attacker who sets it gets a request against their own name, which
 * is the same request a direct caller could make anyway.
 *
 * THE PORT COMPARISON IS WHAT CATCHES THE INTERESTING CASE, and it is why this is
 * not a bare `str_contains` on the host name. An app served on `localhost:8080`
 * and something else on `localhost:9000` share a host name and are different
 * origins, so a page on the second one must not be able to drive the first. When
 * one side omits the port it means the default for its own scheme, and the scheme
 * is not in the Host header — so the port is compared only when both sides state
 * one, and the scheme decides the other cases.
 */
function rc_same_origin(array $server): bool
{
    $origin = $server['HTTP_ORIGIN'] ?? '';
    if (!is_string($origin) || $origin === '') {
        return true;
    }

    $originHost = parse_url($origin, PHP_URL_HOST);
    $expected = $server['HTTP_HOST'] ?? '';
    if (!is_string($originHost) || $originHost === '' || !is_string($expected) || $expected === '') {
        return false;
    }

    [$expectedHost, $expectedPort] = rc_split_authority($expected);
    if ($expectedHost !== $originHost) {
        return false;
    }

    $originPort = parse_url($origin, PHP_URL_PORT);
    // Both explicit: they have to be equal, and this is the localhost:8080 versus
    // localhost:9000 case.
    if (is_int($originPort)) {
        return $expectedPort !== null && (string) $originPort === $expectedPort;
    }

    // The origin named no port, so it is on its scheme's default. The Host header
    // named one, so the request came in on a non-default port for its scheme —
    // which means the origin (a default-port page) is not the same origin. This is
    // the case that used to be refused when it should have been allowed: an https
    // app behind a TLS terminator that forwards `Host: recall.example` with no
    // port, requested by a page whose origin is `https://recall.example`.
    if ($expectedPort !== null) {
        $scheme = strtolower((string) (parse_url($origin, PHP_URL_SCHEME) ?: ''));
        $default = ($scheme === 'https' || $scheme === 'wss') ? '443' : '80';
        return $expectedPort === $default;
    }

    // Neither side named a port.
    return true;
}

/**
 * A bare `host[:port]` authority as `[host, port|null]`.
 *
 * @return array{0:string,1:?string}
 */
function rc_split_authority(string $authority): array
{
    if (str_contains($authority, ':')) {
        [$host, $port] = explode(':', $authority, 2);
        return [$host, $port === '' ? null : $port];
    }
    return [$authority, null];
}

/** Where a rate limit is counted when there is no identity yet — the open endpoint
 *  and anything unauthenticated. Keyed by address, and a forwarded address is only
 *  believed when the deployment says it should be. */
function rc_rate_bucket(?string $spaceId, array $server): string
{
    if ($spaceId !== null && $spaceId !== '') {
        return 'space:' . $spaceId;
    }
    return 'addr:' . rc_remote_address($server);
}

/** The caller's address.
 *
 * `X-Forwarded-For` is IGNORED by default, deliberately. It is a header any client
 * can set, so trusting it turns the rate limiter into something a caller raises by
 * inventing a value — and it also lets a prober attribute attempts to other people.
 * A deployment behind a proxy can set `trust_proxy_headers` in config.local.php,
 * where the operator has stated that the proxy overwrites the header rather than
 * appending to it. */
function rc_remote_address(array $server): string
{
    if (rc_conf('trust_proxy_headers') === true) {
        $forwarded = $server['HTTP_X_FORWARDED_FOR'] ?? '';
        if (is_string($forwarded) && $forwarded !== '') {
            // The left-most entry is the original client when a proxy appends.
            $first = trim(explode(',', $forwarded)[0]);
            if ($first !== '') {
                return $first;
            }
        }
    }
    $remote = $server['REMOTE_ADDR'] ?? '';
    return is_string($remote) && $remote !== '' ? $remote : 'unknown';
}