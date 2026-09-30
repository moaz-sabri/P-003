<?php

declare(strict_types=1);

/**
 * The API's front controller. One file, four routes, no framework.
 *
 * The route table is a switch on the exact path and nothing is matched by prefix:
 * every request under /api/ reaches this file (nginx `location ^~ /api/` and the
 * PHP router's own branch both guarantee it), so a typo in a path is a 404 rather
 * than a request that matches a handler it was never meant to.
 *
 *   GET  /api/health          liveness; no credentials, no database
 *   POST /api/space/open      create this space, or prove it is yours
 *   POST /api/sync/push       store records
 *   POST /api/sync/pull       fetch records above a revision
 *
 * WHAT EVERY RESPONSE CARRIES, and why each is here:
 *
 *   Content-Type: application/json   The client parses this or gives up with
 *                                    `bad_response`; an HTML error page from a
 *                                    misconfigured PHP is the single most common
 *                                    cause of a sync that "just fails".
 *   Cache-Control: no-store          The request carries a credential in a header
 *                                    and the response carries ciphertext. Neither
 *                                    belongs in a shared cache.
 *   X-Content-Type-Options: nosniff  Stops a browser treating a JSON response as
 *                                    HTML, which would execute a body an attacker
 *                                    shaped.
 *
 * WHAT IS NEVER SENT: the key, the key hash, the body of a request, or an error's
 * message. Failures are `{ok:false, error:{code}}` with a code from a closed list,
 * because the client's whole error handling is `toast.show('error.' + code)` and a
 * code it does not know degrades to the key name on screen rather than to a stack
 * trace.
 *
 * METHODS ARE EXACT. A GET on /api/sync/push is a 405, not a push: the only GET in
 * this API is the health check, and a read that writes is a bug in a route table.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/sync.php';

/* ------------------------------- responses --------------------------------- */

/** Send a JSON body and stop.
 *
 *  `JSON_UNESCAPED_UNICODE` because the ciphertext and the space id are ASCII, but
 *  an error message or a future field might not be, and `\uXXXX` in a response body
 *  makes the wire format harder to read in a log. `JSON_THROW_ON_ERROR` so an
 *  encoding failure throws here rather than returning `false` into a caller that
 *  would then send an empty body with a 200. */
function rc_json(mixed $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');

    try {
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        // The status line is already sent, so there is nothing to change. An empty
        // body with a non-2xx status is what the client maps to `bad_response`,
        // which is the right outcome: it is a server problem, and the reader is
        // told the data is still on their device.
    }
    exit;
}

/** A refusal, as JSON. The only failure shape this API emits. */
function rc_error(int $status, string $code): never
{
    rc_json(['ok' => false, 'error' => ['code' => $code]], $status);
}

/* --------------------------------- input ----------------------------------- */

/**
 * The request body as an array, or a refusal.
 *
 * `php://input` rather than `$_POST`, because the client sends JSON with
 * `Content-Type: application/json` and PHP would only populate `$_POST` for a form
 * encoding — leaving a well-formed request looking like an empty one.
 *
 * The size is checked against `request_max_bytes` BEFORE reading, by comparing
 * Content-Length where it is present. Where it is not — a chunked request, which
 * curl produces with `-T -` — the length of what was read is checked afterwards,
 * which is late but is the only thing available. nginx refuses an oversized body
 * before it reaches here in the container deployment, so this is the check that
 * matters on a plain PHP host.
 *
 * A JSON parse failure is a 400 and not a 500: the request is malformed, and
 * telling the client it was our problem would make it back off and retry something
 * that will never succeed.
 */
function rc_body(): array
{
    $max = (int) rc_conf('request_max_bytes');

    $declared = $_SERVER['CONTENT_LENGTH'] ?? '';
    if (is_string($declared) && $declared !== '' && (int) $declared > $max) {
        rc_error(413, 'too_large');
    }

    $raw = file_get_contents('php://input', false, null, 0, $max + 1);
    if ($raw === false) {
        rc_error(400, 'bad_request');
    }
    if (strlen($raw) > $max) {
        rc_error(413, 'too_large');
    }
    if ($raw === '') {
        return [];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        rc_error(400, 'bad_request');
    }
    return $decoded;
}

/* -------------------------------- routing ---------------------------------- */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

// Normalised the same way docker-router.php normalises: no trailing slash, so
// `/api/health/` and `/api/health` are one route and not two, and nothing matches
// a path with a dot-segment in it.
if (is_string($path) && $path !== '') {
    $trimmed = rtrim($path, '/');
    $path = $trimmed === '' ? '/' : $trimmed;
}
$path = is_string($path) ? $path : '/';

if (!rc_same_origin($_SERVER)) {
    rc_error(403, 'forbidden');
}

// The health check is the only unauthenticated route, and it deliberately does not
// open the database: a container health check that fails because the volume is
// read-only should report "the process is up", and the compose healthcheck probes
// this on every start.
if ($path === '/api/health' || $path === '/api') {
    if ($method !== 'GET' && $method !== 'HEAD') {
        header('Allow: GET, HEAD');
        rc_error(405, 'method_not_allowed');
    }
    rc_json([
        'ok' => true,
        'service' => 'recall-api',
        'version' => (string) rc_conf('version'),
    ]);
}

try {
    switch ($path) {
        case '/api/space/open':
            if ($method !== 'POST') {
                header('Allow: POST');
                rc_error(405, 'method_not_allowed');
            }
            rc_rate_limit(rc_rate_bucket(null, $_SERVER));
            $space = rc_open_space($_SERVER);
            rc_json(['ok' => true, 'space' => $space['spaceId'], 'rev' => rc_current_rev($space['spaceId'])]);

        case '/api/sync/push':
            if ($method !== 'POST') {
                header('Allow: POST');
                rc_error(405, 'method_not_allowed');
            }
            $identity = rc_require_space($_SERVER);
            rc_rate_limit(rc_rate_bucket($identity['spaceId'], $_SERVER));

            $body = rc_body();
            $records = $body['records'] ?? null;
            if (!is_array($records) || !array_is_list($records)) {
                rc_error(400, 'bad_request');
            }
            $result = rc_push($records, $identity['spaceId']);
            rc_json(['ok' => true, ...$result]);

        case '/api/sync/pull':
            if ($method !== 'POST') {
                header('Allow: POST');
                rc_error(405, 'method_not_allowed');
            }
            $identity = rc_require_space($_SERVER);
            rc_rate_limit(rc_rate_bucket($identity['spaceId'], $_SERVER));

            $body = rc_body();
            $since = $body['since'] ?? 0;
            if (!is_int($since) || $since < 0) {
                rc_error(400, 'bad_request');
            }
            $limit = $body['limit'] ?? (int) rc_conf('pull_max_limit');
            if (!is_int($limit) || $limit < 1) {
                rc_error(400, 'bad_request');
            }
            $result = rc_pull($identity['spaceId'], $since, $limit);
            rc_json(['ok' => true, ...$result]);

        default:
            // 404 for a path under /api/ that is not a route. Not a 405, and not a
            // redirect to the SPA shell: a request under /api/ that this server
            // does not know is a client calling the wrong address, and answering it
            // with an HTML page would turn a wrong path into an unparseable
            // response rather than into a clear 404.
            rc_error(404, 'not_found');
    }
} catch (RcAuthError $err) {
    // The rate limiter's status carries a Retry-After, because a client that is
    // refused for exceeding a window and then immediately retries is a client that
    // stays refused for as long as it keeps asking.
    if ($err->status === 429) {
        header('Retry-After: ' . (int) rc_conf('rate_limit_window'));
    }
    rc_error($err->status, $err->reason);
} catch (RcBadRequest $err) {
    rc_error(400, $err->reason);
} catch (PDOException) {
    // A database failure is a 500 with no detail. The exception's message names the
    // table and sometimes the query, and this file's whole error surface is a code
    // from a list the client already knows. The message goes to the error log, which
    // is on stderr in the container and which nothing here prints a credential to.
    error_log('recall api: database failure');
    rc_error(500, 'server_error');
} catch (Throwable $err) {
    error_log('recall api: unhandled ' . get_class($err));
    rc_error(500, 'server_error');
}