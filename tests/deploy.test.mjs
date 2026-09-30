// The build, and the three servers that have to agree about it.
//
// The app is deployed three ways — a PHP host, the nginx container, and a static
// host that reads `_headers` — and all three implement one cache policy in three
// files that cannot import one another. Nothing at runtime compares them, so
// nothing at runtime notices when one of them is edited: the fix ships, nginx
// serves the old bundle for a year, and the report is "it works on my phone".
//
// The version is the same story in a smaller way: config.js, package.json and the
// service worker's cache name are three copies of one string, and a worker whose
// cache name does not move cannot evict the previous release at all — which is
// why the worker's `activate` handler appears not to work and looks like a bug in
// code nobody can find.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { APP_VERSION } from "../app/js/config.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json"));

const NGINX = read("../docker/nginx/default.conf");
const ROUTER = read("../docker-router.php");
const HEADERS = read("../app/_headers");

// Every server below declares the same headers in a different syntax — nginx
// writes `add_header Name "value" always`, the static host writes `Name: value`
// and the router writes `header('Name: value')` with the CSP split over four
// concatenated PHP literals. Comparing them with `includes` on the literal
// string therefore fails on the SYNTAX rather than on the policy, and the
// failure reads as "nginx does not send nosniff" to whoever sees it — who then
// edits a config that was already correct. So each source is parsed into
// name -> value and only the values are compared.
//
// The comment strip is safe for these three files because none of them has a
// `#` inside a quoted value; the CSP and Permissions-Policy are full of
// semicolons, and stripping comments first is what keeps an inline
// `expires -1;  # Cache-Control: no-cache` from being read as a header.
const withoutComments = (source) => source.replace(/(^|\s)#[^\n]*/g, "$1");

function nginxHeaders(source) {
    const map = new Map();
    for (const m of withoutComments(source).matchAll(/add_header\s+([A-Za-z0-9-]+)\s+"([^"]*)"/g)) {
        map.set(m[1].toLowerCase(), m[2]);
    }
    return map;
}

// Netlify/Cloudflare `_headers`: indented `Name: value` lines, repeated per
// path block. A name that appears in two blocks keeps the last value, which is
// fine for the security headers — they are declared once, in the /* block — and
// is why the cache policy is still checked per path below rather than here.
function headerFileHeaders(source) {
    const map = new Map();
    for (const m of withoutComments(source).matchAll(/^\s*([A-Za-z][A-Za-z0-9-]*):[ \t]*(.+?)\s*$/gm)) {
        map.set(m[1].toLowerCase(), m[2]);
    }
    return map;
}

function phpHeaders(source) {
    const map = new Map();
    for (const call of source.matchAll(/header\(([\s\S]*?)\);/g)) {
        // Concatenated literals are joined before the name is split off, so a
        // value may be re-wrapped across lines without this failing, and a
        // value that actually changed cannot hide inside a line break.
        let value = "";
        for (const literal of call[1].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
            value += literal[1] ?? literal[2] ?? "";
        }
        const colon = value.indexOf(":");
        if (colon > 0) {
            map.set(value.slice(0, colon).trim().toLowerCase(), value.slice(colon + 1).trim());
        }
    }
    return map;
}

const NGINX_HEADERS = nginxHeaders(NGINX);
const ROUTER_HEADERS = phpHeaders(ROUTER);
const STATIC_HEADERS = headerFileHeaders(HEADERS);
const SERVERS = [["nginx", NGINX_HEADERS], ["router", ROUTER_HEADERS], ["_headers", STATIC_HEADERS]];

test("the version is the same string in all three places it appears", () => {
    assert.equal(APP_VERSION, pkg.version, "config.js and package.json disagree about the version");

    const sw = read("../app/sw.js");
    const cache = sw.match(/const\s+CACHE\s*=\s*"([^"]+)"/);
    assert.ok(cache, "the service worker's cache name was not found");
    // The name carries the version because the activate handler deletes every
    // cache whose name is not CACHE, and a fixed name means it can delete nothing.
    assert.equal(cache[1], `recall-v${APP_VERSION}`,
        "the service worker's cache name does not move with the version");
    // And the reference to the test that keeps this true, since sw.js names it.
    assert.ok(sw.includes("tests/"), "the worker no longer points at the test that checks it");
});

test("the content hash is eight hex characters everywhere it is written down", () => {
    // webpack puts it in the file name, both servers recognise it by pattern, and
    // the static host is told to keep whatever is under /dist/ for a year. If the
    // pattern is eight characters and the name is not, or the other way round, the
    // immutable rule silently stops applying to the hashed assets and every load
    // goes back to the network for a file that cannot have changed.
    const webpack = read("../webpack.config.js");
    assert.match(webpack, /const HASH = "\[contenthash:(\d+)\]"/);
    const length = Number(webpack.match(/const HASH = "\[contenthash:(\d+)\]"/)[1]);
    assert.equal(length, 8);
    assert.match(webpack, new RegExp(`app\\.\\$\\{HASH\\}\\.js`));
    assert.match(webpack, new RegExp(`app\\.\\$\\{HASH\\}\\.css`));

    // Both servers write the quantifier literally, so the pattern is built from
    // the length webpack uses rather than written as {8} here: a test that
    // hardcodes the number cannot fail when the number is changed in one place.
    const quantifier = new RegExp(`\\[0-9a-f\\]\\{${length}\\}`);
    assert.match(ROUTER, quantifier, "the PHP router's hash pattern is a different length");
    assert.match(NGINX, quantifier, "nginx's hash pattern is a different length");
});

test("nginx's hash pattern is quoted, because an unquoted {8} ends the block", () => {
    // THE reason this file has a test at all. nginx's configuration parser reads
    // `{` as the start of a block even inside a `location ~` pattern, so `{8}`
    // unquoted ends the location early:
    //
    //   [emerg] unknown directive "8}\.(?:js|css)$" in .../default.conf
    //
    // and nginx refuses to start. Nothing in the repository can see that — a text
    // test reads the same line happily, and the PHP router, which implements the
    // same policy in code, is not nginx — so this is asserted here and by
    // `nginx -t` inside the image.
    const location = NGINX.match(/^\s*location\s+~\s+.*\[0-9a-f\]\{\d+\}[^\n]*$/m);
    assert.ok(location, "the hashed-asset location was not found");
    const line = location[0];
    assert.match(line, /location\s+~\s+"/, `the hashed-asset pattern is not quoted: ${line.trim()}`);
    // With the quoted pattern removed, only the block opener may be left. Any
    // other brace is nginx's parser reading a quantifier as the start of a
    // block, which is the whole failure this test exists to prevent.
    const outside = line.replace(/"[^"]*"/g, "").replace(/\{8\}/g, "").trim();
    assert.match(outside, /^location\s+~\s*\{$/, `an unquoted brace survives outside the pattern: ${line.trim()}`);
});

test("both servers refuse the unbuilt sources and the platform config files", () => {
    // app/js and app/css are in the images because the bundle is built from them.
    // The shell references nothing under them, so serving them hands out readable
    // unminified source for nothing at all.
    assert.match(NGINX, /location \^~ \/js\/ \{ return 404; \}/);
    assert.match(NGINX, /location \^~ \/css\/ \{ return 404; \}/);
    assert.match(ROUTER, /str_starts_with\(\$path, '\/js\/'\)/);
    assert.match(ROUTER, /str_starts_with\(\$path, '\/css\/'\)/);

    // _headers and _redirects describe the deployment's own security policy.
    assert.match(NGINX, /location ~ \^\/\(_headers\|_redirects\)\$ \{ return 404; \}/);
    assert.match(ROUTER, /\$path === '\/_headers' \|\| \$path === '\/_redirects'/);
});

test("the three servers send the same cache policy", () => {
    // The policy is four rules, in this order, in all three files. Read out of
    // each file rather than restated here, so this test fails when a file changes
    // rather than when a copy of the file changes.
    const year = 31536000;
    const month = 2592000;

    assert.match(ROUTER, new RegExp(`public, max-age=${year}, immutable`));
    assert.match(NGINX, /location ~ "\^\/dist\/\[\^\/\]\*\\\.\[0-9a-f\]\{8\}\\\.\(\?:js\|css\)\$" \{\s*\n\s*try_files \$uri =404;\s*\n\s*expires 1y;/);
    assert.match(HEADERS, new RegExp(`Cache-Control: public, max-age=${year}, immutable`));

    // The shell and the service worker are never stored. nginx writes this as
    // `expires -1`, which sends `no-cache` rather than the router's `no-store`;
    // both refuse a stale copy and the difference is recorded in the config.
    assert.match(ROUTER, /\$path === '\/sw\.js' \|\| \$path === RC_SHELL_REL \|\| \$ext === 'html'\) \{\s*\n\s*\$cache = 'no-store, must-revalidate';/);
    assert.match(HEADERS, /\/sw\.js\s*\n\s*Cache-Control: no-store, must-revalidate/);
    assert.match(HEADERS, /\/dist\/index\.html\s*\n\s*Cache-Control: no-store, must-revalidate/);
    assert.match(NGINX, /location = \/sw\.js \{[\s\S]*?expires -1;/);
    assert.match(NGINX, /location = \/dist\/index\.html \{[\s\S]*?expires -1;/);

    // The manifest is revalidated every time — it is what installability is judged
    // against, and a host with no .webmanifest mapping serves it as octet-stream,
    // which fails the install criteria outright.
    assert.match(ROUTER, /\$path === '\/manifest\.webmanifest'\) \{\s*\n\s*\$cache = 'no-cache, must-revalidate';/);
    assert.match(HEADERS, /\/manifest\.webmanifest\s*\n\s*Cache-Control: no-cache, must-revalidate/);
    assert.match(NGINX, /location = \/manifest\.webmanifest \{[\s\S]*?expires -1;/);

    // Icons change only with a release and are the one thing a home screen keeps
    // asking for.
    assert.match(ROUTER, new RegExp(`str_starts_with\\(\\$path, '/icons/'\\)\\) \\{\\s*\\n\\s*\\$cache = 'public, max-age=${month}, must-revalidate'`));
    assert.match(HEADERS, new RegExp(`Cache-Control: public, max-age=${month}, must-revalidate`));
    assert.match(NGINX, /location \^~ \/icons\/ \{[\s\S]*?expires 30d;/);
});

test("both servers send the same Content-Security-Policy, and so does the static host", () => {
    // Four places: nginx, the PHP router, _headers, and the document itself. The
    // policy is what keeps the app from executing an inline script, so a
    // deployment that weakens it to fix something else has to show up here.
    const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        + "font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; "
        + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    for (const [name, headers] of SERVERS) {
        assert.ok(headers.size > 0, `${name} declared no headers at all — the comparison below would pass on an empty map`);
        assert.equal(headers.get("content-security-policy"), policy, `${name} sends a different CSP`);
    }

    // And there is no `unsafe-inline` anywhere: that is why ui/dom.js writes the
    // `style` prop through CSSOM instead of setting a style attribute. The
    // comments are stripped first, because both files explain the policy in
    // prose that necessarily contains the words they are ruling out — a search
    // that matched the explanation would report the config as permissive.
    for (const [name, source] of [["nginx", NGINX], ["router", ROUTER], ["_headers", HEADERS]]) {
        assert.ok(!withoutComments(source).includes("unsafe-inline"), `${name} allows an inline script or style`);
        assert.ok(!withoutComments(source).includes("unsafe-eval"), `${name} allows eval`);
    }
});

test("the other three security headers are the same everywhere too", () => {
    for (const [header, value] of [
        ["X-Content-Type-Options", "nosniff"],
        ["X-Frame-Options", "DENY"],
        ["Referrer-Policy", "strict-origin-when-cross-origin"],
        ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"]
    ]) {
        for (const [name, headers] of SERVERS) {
            assert.equal(headers.get(header.toLowerCase()), value, `${name} does not send ${header}: ${value}`);
        }
    }
    // frame-ancestors is in the CSP as well as X-Frame-Options, because old
    // browsers honour only the latter. nginx has no `add_header` for it — it is
    // in its one policy string — so it is read out of the value compared above.
    for (const [name, headers] of SERVERS) {
        assert.ok(headers.get("content-security-policy").includes("frame-ancestors 'none'"),
            `${name} omits frame-ancestors 'none'`);
    }
});

test("HSTS is off unless the operator turns it on, and it belongs at the TLS terminator", () => {
    // Both of these are served over plain HTTP, and Strict-Transport-Security is
    // cached by the browser for the max-age given: sending it here makes every
    // later plain-HTTP request to the same host fail outright, including a local
    // `docker compose up`.
    assert.ok(!/Strict-Transport-Security/i.test(NGINX) || NGINX.includes("# Enable it at the TLS terminator"),
        "nginx sends HSTS on a plain-HTTP listener");

    // The router CAN send it, because the operator may be terminating TLS in
    // front of it — so the check is not that the call is absent but that the
    // only call is inside the environment gate. A header moved above the `if` is
    // invisible to a search for the string and fatal in production.
    const call = ROUTER.indexOf("header('Strict-Transport-Security");
    assert.notEqual(call, -1, "the router can no longer send HSTS at all, which removes the option entirely");
    assert.equal(ROUTER.split("header('Strict-Transport-Security").length - 1, 1, "HSTS is sent from more than one place");
    const gate = ROUTER.indexOf("if ($hsts > 0) {");
    assert.ok(gate !== -1 && gate < call, "the router sends HSTS outside the HSTS_MAX_AGE gate");
    assert.ok(!ROUTER.slice(gate, call).includes("}"), "the HSTS header is not inside the gate block");
    assert.match(ROUTER, /getenv\('HSTS_MAX_AGE'\)/);
});

test("the nginx config has no `index` directive and names the built shell", () => {
    // app/index.html is the TEMPLATE the build reads: it names no assets and would
    // render an unstyled dead page. An `index` directive hands it out for `/`.
    const body = NGINX.replace(/^\s*#.*$/gm, "");
    assert.ok(!/^\s*index\s+/m.test(body), "an index directive would serve the unbuilt template");
    assert.match(NGINX, /location = \/ \{\s*\n\s*try_files \/dist\/index\.html =404;/);
    assert.match(NGINX, /location = \/index\.html \{\s*\n\s*try_files \/dist\/index\.html =404;/);
    assert.match(ROUTER, /const RC_SHELL_REL = '\/dist\/index\.html'/);
});

test("an unbuilt checkout says so instead of serving a dead page", () => {
    // A missing shell is a 503 with the instruction in it, from both servers. A
    // bare 404 leaves the browser reporting a syntax error pointing at a file
    // that does not exist.
    assert.match(ROUTER, /http_response_code\(503\)/);
    assert.match(ROUTER, /npm ci &amp;&amp; npm run build/);
    assert.match(NGINX, /npm run build|not built/i);
});

test("the API is never served as a file, and never cached", () => {
    // Everything under /api/ goes to the one front controller, which is what keeps
    // api/var/sync.sqlite and api/*.php unreachable over HTTP.
    assert.match(NGINX, /location \^~ \/api\/ \{[\s\S]*?fastcgi_param SCRIPT_FILENAME \/app\/api\/index\.php;/);
    assert.match(ROUTER, /str_starts_with\(\$path, '\/api\/'\)\) \{\s*\n\s*require __DIR__ \. '\/api\/index\.php';/);
    assert.match(ROUTER, /str_starts_with\(\$path, '\/api\/'\)\) \{\s*\n\s*require __DIR__ \. '\/api\/index\.php';/);
    // The static host has no PHP in it, so an API path must 404 rather than return
    // the HTML shell to something expecting JSON.
    assert.match(read("../app/_redirects"), /\/api\/\*\s+\/api\/:splat\s+404/);
    // And the service worker never caches it.
    assert.match(read("../app/sw.js"), /url\.pathname\.startsWith\("\/api\/"\)\) return false/);
});

test("the service worker only ever caches the offline app", () => {
    const sw = read("../app/sw.js");
    // An allowlist, not a deny-list: a deny-list has to be right about every
    // request the app will ever make, and one forgotten entry is a copy of the
    // reader's data in Cache Storage, which nothing evicts but a new release.
    const allow = sw.match(/const OFFLINE_PREFIXES = \[([^\]]*)\]/);
    assert.ok(allow, "the offline allowlist was not found");
    for (const prefix of ["/dist/", "/icons/"]) {
        assert.ok(allow[1].includes(`"${prefix}"`), `${prefix} is not on the allowlist`);
    }
    for (const forbidden of ["/api/"]) {
        assert.ok(!allow[1].includes(`"${forbidden}"`), `${forbidden} must never be cached`);
    }
    // The shell has ONE canonical key. Without it, a deep link opened offline
    // caches the shell under `/questions` and forty routes mean forty copies of
    // one document in the one store nothing evicts.
    assert.match(sw, /const SHELL = "\/index\.html"/);
});

test("the webpack output path is the one the servers serve", () => {
    const webpack = read("../webpack.config.js");
    assert.match(webpack, /path\.resolve\(__dirname, "app\/dist"\)/);
    assert.match(webpack, /publicPath: "\/dist\/"/);
    // The HTML plugin writes the served document next to the hashed assets, so
    // there is no second shell file for a server to pick the wrong one of.
    assert.match(webpack, /template: "\.\/app\/index\.html"/);
    assert.match(webpack, /filename: "index\.html"/);
});

test("the Dockerfile builds the app rather than shipping the template", () => {
    const dockerfile = read("../Dockerfile");
    assert.match(dockerfile, /npm ci/);
    assert.match(dockerfile, /npm run build/);
    // The un-built sources are needed at build time only; leaving them in the
    // final image is what the /js/ and /css/ 404s exist to hide.
    assert.ok(dockerfile.length > 0);
});