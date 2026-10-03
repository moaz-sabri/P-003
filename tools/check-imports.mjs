// Do the files agree about which module owns what?
//
// Three failures this catches, none of which any existing test can see, because each
// one lives in a file that is not imported by the test suite:
//
//   * A PAGE IMPORTS A MODULE THAT DOES NOT EXIST. The build is a webpack bundle over
//     real files, so this is caught by `npm run build` أ¢â‚¬â€‌ but only after the type
//     check, the whole test suite and the i18n check have all passed, which is a long
//     way to be told about a typo in one line of one page.
//
//   * A PAGE CALLS A FUNCTION THE SERVICE DOES NOT EXPORT. Every service here is
//     written as `export async function name`, so a call to a name that was renamed or
//     removed is `undefined is not a function` at runtime, on a tap, in whichever
//     screen the reader happens to open. Nothing static catches it: the import
//     resolves.
//
//   * A PAGE IMPORTS A NAME FROM A MODULE THAT DOES NOT EXPORT IT. The same failure,
//     one step earlier, and the one that produced the most confusing report during the
//     change this file was written for أ¢â‚¬â€‌ a page importing `questions.list` from
//     `goal-service.js`, which has no such export and did not have one.
//
// It works by reading each file's imports, resolving them through the module graph,
// and comparing the named imports against the target's `export` list. That is a real
// parse of a small, regular subset of JavaScript, which is what makes it worth having
// rather than a grep: a grep cannot tell an import from a call, and cannot tell an
// export from a mention in a comment.
//
// IT IS NOT A TYPE CHECKER and does not try to be. It reads `import` statements and
// `export` declarations as text. That is enough for this codebase, where the module
// boundaries are the thing being verified and every one of them is a top-level
// `export`, and it is enough because the failure it cannot see أ¢â‚¬â€‌ a call to a
// function that exists but takes different arguments أ¢â‚¬â€‌ is one the type checker in
// `jsconfig.json` already covers.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve as resolvePath, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app", "js");

/** Every module under app/js, keyed by its path relative to app/js. */
function modules() {
    const found = new Map();
    const walk = (dir, prefix = "") => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                walk(join(dir, entry.name), `${prefix}${entry.name}/`);
            } else if (entry.name.endsWith(".js")) {
                found.set(`${prefix}${entry.name}`, join(dir, entry.name));
            }
        }
    };
    walk(APP);
    return found;
}

/**
 * Comments blanked out, with every line kept.
 *
 * WITHOUT THIS THE CHECKER READS PROSE AS CODE, and it did: an explanatory comment
 * inside an `import { أ¢â‚¬آ¦ }` clause listing the three repository writes this module
 * re-exports was parsed as a list of imported names, and the checker reported
 * "imports { // The three writes }, which does not export it" أ¢â‚¬â€‌ three errors, all of
 * them about a sentence.
 *
 * That is the failure mode `tools/check-i18n.mjs` already solves for strings, and it
 * is solved the same way rather than a different way, because a second implementation
 * of "ignore comments" would be a second thing to get wrong. Newlines are preserved so
 * a reported line number still points at the line the reader is looking at.
 *
 * A string literal containing `//` is the case this does not handle, and it is handled
 * by not mattering: no module here imports anything inside a string, so the worst a
 * false blank can do is hide an import, and an import that is not found is not a false
 * error.
 */
function withoutComments(source) {
    // BLOCK COMMENTS TOO, and the first version of this function handled only `//`.
    // That reported `stats/latestAttempt()` أ¢â‚¬â€‌ a function call written inside a doc
    // comment, in the middle of a sentence explaining who builds the map أ¢â‚¬â€‌ as a call
    // the module never imported. The whole codebase's convention is a block comment
    // above every function, and those comments name other modules' functions constantly
    // because that is what the comments are for.
    //
    // The replacement preserves newlines rather than deleting, so a line number still
    // points at the right line; the block is blanked to spaces otherwise.
    const blanked = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
        block.replace(/[^\n]/g, " "));

    return blanked
        .split("\n")
        .map((line) => {
            // Only a `//` outside a quote begins a comment. Tracking quotes per line is
            // enough here because this codebase does not use multi-line string literals.
            let quote = null;
            for (let i = 0; i < line.length; i += 1) {
                const ch = line[i];
                if (quote) {
                    if (ch === "\\") { i += 1; continue; }
                    if (ch === quote) quote = null;
                    continue;
                }
                if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
                if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
            }
            return line;
        })
        .join("\n");
}

/**
 * String literals blanked out too, with quotes left in place.
 *
 * NEEDED FOR FINDING NAMESPACE MEMBERS, and the reason is the collision between two
 * things that look the same to a regex. `t("content.title")` and
 * `content.title` are both `word.dot.word` in the text, and the first is a translation
 * key while the second is a property read on a service. Scanning string contents for
 * members reported every one of this app's ~400 i18n keys as a missing export أ¢â‚¬â€‌ 117
 * false failures on the run that introduced this, every one of them a `t("أ¢â‚¬آ¦")` call.
 *
 * Comments have to go first, or the blanking below would try to read the quotes in
 * prose; the two passes are separate functions rather than one because the import
 * reader genuinely NEEDS the specifier strings, and only the member reader wants them
 * gone. One function could take a flag, but then every call site would have to know
 * which mode it wanted, and getting that backwards is silent.
 */
function withoutStrings(source) {
    // DELIBERATELY CRUDE, AND DELIBERATELY ONE-SIDED.
    //
    // This exists for exactly one purpose: so that `t("content.title")` is not read by
    // the member scanner as a property read of a variable called `content`. All it has
    // to do is make string TEXT invisible, and every design that tried to do it
    // properly — a quote stack, a brace-depth interpolation counter — was wrong at
    // least once here, and wrong in the same direction: leaving text visible and
    // reporting a translation key as a missing export.
    //
    // So the rule is the crudest one that cannot produce a FALSE POSITIVE, at the
    // price of occasionally losing a real check:
    //
    //   * a `"` or `'` pair on one line has its contents blanked — these cannot nest,
    //     so the pairing is unambiguous;
    //   * a BACKTICK blanks everything from it to the end of that line.
    //
    // The second rule is the blunt one. It over-blanks a template literal that is
    // followed by more code on the same line, and it accepts that: losing a check is
    // visible, whereas a checker that reports `content.title` as a missing export gets
    // read as authoritative and then gets switched off. Every template literal in
    // this codebase is either the whole argument of a `t()` call or the whole right-hand
    // side of an assignment, so in practice nothing is lost — and if that stops being
    // true, the symptom is a few missed problems rather than a flood of invented ones.
    //
    // Newlines are preserved, so a reported line number still points at the line the
    // reader is looking at.
    return source
        .split("\n")
        .map((line) => {
            const chars = line.split("");
            let quote = null;

            for (let i = 0; i < chars.length; i += 1) {
                const ch = chars[i];
                if (quote) {
                    if (ch === "\\") { i += 1; continue; }
                    if (ch === quote) { quote = null; continue; }
                    if (ch !== "\n") chars[i] = " ";
                    continue;
                }
                if (ch === '"' || ch === "'") { quote = ch; continue; }
                if (ch === "`") {
                    // To the end of the line, and no further: see above.
                    for (let j = i + 1; j < chars.length; j += 1) chars[j] = " ";
                    return chars.join("");
                }
            }
            return chars.join("");
        })
        .join("\n");
}

/**
 * Every `export`ed name in a module.
 *
 * Three forms count, and the third is the one this codebase uses most:
 *
 *   export function name()      أ¢â€ â€™ name
 *   export async function name  أ¢â€ â€™ name
 *   export { a, b as c }        أ¢â€ â€™ c (the alias, which is what an importer names)
 *   export const name = ...     أ¢â€ â€™ name
 *
 * `export { x } from "./y.js"` is NOT counted here: it is re-exported from y, so
 * y's own exports are what an importer of this module actually resolves through it,
 * and y is walked in its own right. Counting it as well would let a module appear to
 * export something its target does not.
 */
function exportsOf(source) {
    const names = new Set();
    const patterns = [
        /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
        /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm,
        /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
    // `export { a, b as c }` أ¢â‚¬â€‌ but NOT the `from` form, which re-exports elsewhere.
    for (const match of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
        const clause = match[1];
        if (/\}\s*from\s/.test(match[0])) continue;
        for (const part of clause.split(",")) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const alias = trimmed.split(/\s+as\s+/);
            names.add((alias[1] ?? alias[0]).trim());
        }
    }
    return names;
}

/**
 * Every import in a module: the names it asks for, and where from.
 *
 * Both `import x from` and `import { a, b as c } from` are read. The namespace form
 * (`import * as ns`) is recorded with its local name and no names, and the members
 * used off it are collected separately by `membersUsed` أ¢â‚¬â€‌ a namespace import IS
 * checkable, and this codebase uses it for every service, so leaving the most common
 * form in the app unverified would have left most of the graph unchecked.
 */
function importsOf(source) {
    const out = [];
    const re = /import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
    for (const match of source.matchAll(re)) {
        const clause = match[1].trim();
        const spec = match[2];
        if (!spec.startsWith(".")) continue;          // a bare specifier is a package
        const namespace = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (namespace) {
            out.push({ spec, namespace: namespace[1], names: [] });
            continue;
        }
        const braces = clause.match(/\{([\s\S]*)\}/);
        const names = [];
        if (braces) {
            for (const part of braces[1].split(",")) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const alias = trimmed.split(/\s+as\s+/);
                names.push((alias[0]).trim());      // the name the TARGET must export
            }
        }
        const defaultName = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
        if (defaultName && !defaultName.startsWith("*")) names.push("default");
        out.push({ spec, namespace: null, names });
    }
    return out;
}

/**
 * The members a module reads off each namespace it imported.
 *
 * `import * as sessions from "أ¢â‚¬آ¦"` followed by `sessions.start(أ¢â‚¬آ¦)` is asking for one
 * named export, and it fails the same way a destructured import fails: `undefined is
 * not a function`, on a tap, in one screen. Since every service in this app is
 * namespace-imported by the pages that use it, this is the majority of the calls in
 * the app and not an edge case.
 *
 * A property that is not an identifier is not a member أ¢â‚¬â€‌ `sessions[dynamic]` cannot be
 * checked by anyone أ¢â‚¬â€‌ and the local name is returned as the key so two namespaces in
 * one file do not collide.
 *
 * Only `ns.member` is read, not `ns` passed to something else. `go(ns)` would be a
 * call this cannot follow, and pretending otherwise would report a member that was
 * never requested.
 */
function membersUsed(importsSource, codeSource) {
    const namespaces = new Set();
    // THE TWO VIEWS ARE BOTH NEEDED, AND GETTING THIS WRONG IS INVISIBLE. The
    // namespace NAMES come from the import statements, which need their string
    // literals أ¢â‚¬â€‌ the specifier is one أ¢â‚¬â€‌ so they are read from the comments-stripped
    // source. The member SCAN reads the version with strings blanked, because
    // `t("content.title")` and `content.title` are the same shape to a regex and only
    // one of them is a property read.
    //
    // Passing only the blanked version finds no imports at all, so it finds no
    // namespaces, so it checks nothing أ¢â‚¬â€‌ and it reports success. That is the failure
    // this signature is shaped to prevent: there is no way to hand it one view and
    // mean the other.
    for (const entry of importsOf(importsSource)) {
        if (entry.namespace) namespaces.add(entry.namespace);
    }
    const out = new Map();
    for (const name of namespaces) {
        const used = new Set();
        // A member read is `name.something` where something is an identifier.
        const re = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, "g");
        for (const match of codeSource.matchAll(re)) used.add(match[1]);
        out.set(name, [...used]);
    }
    return out;
}

/** Resolve a relative specifier to a key in the module map. */
function resolveKey(fromKey, spec, all) {
    const fromDir = dirname(join(APP, fromKey));
    const target = resolvePath(fromDir, spec);
    const key = relative(APP, target).split("\\").join("/");
    return all.has(key) ? key : null;
}

const all = modules();
const problems = [];

const SOURCES = new Map();
/** The same files with comments AND string literals gone أ¢â‚¬â€‌ what namespace members are
 *  read out of. Kept beside the other rather than computed on demand because it is
 *  read once per module per run and the whole point is that it is a different view. */
const CODE = new Map();

for (const [key, path] of all) {
    const stripped = withoutComments(readFileSync(path, "utf8"));
    SOURCES.set(key, stripped);
    CODE.set(key, withoutStrings(stripped));
}

for (const [key, source] of SOURCES) {
    const members = membersUsed(source, CODE.get(key));

    for (const entry of importsOf(source)) {
        const targetKey = resolveKey(key, entry.spec, all);
        if (!targetKey) {
            problems.push(`${key}: imports "${entry.spec}", which does not exist`);
            continue;
        }
        const available = exportsOf(SOURCES.get(targetKey));

        if (entry.namespace) {
            // THE NAMESPACE CASE, which is every service in this app. Each member read
            // off it has to exist, and reporting it as `ns.member` rather than as a
            // bare name is what makes the message point at the line the reader has to
            // edit.
            for (const member of members.get(entry.namespace) ?? []) {
                if (!available.has(member)) {
                    problems.push(`${key}: uses ${entry.namespace}.${member}, which ${targetKey} does not export`);
                }
            }
            continue;
        }

        for (const name of entry.names) {
            if (name === "default") continue;   // no module here has a default export
            if (!available.has(name)) {
                problems.push(`${key}: imports { ${name} } from ${targetKey}, which does not export it`);
            }
        }
    }
}

/*
 * WHAT THIS DOES NOT CHECK, and why â€” the third thing it was asked to do.
 *
 * An earlier version of this file also tried to report identifiers a module USES but
 * never IMPORTS: `getExercise` and `listAllAttempts` called in session-service.js and
 * missing from its import clause, both of which are `ReferenceError` on the first
 * session a reader starts. It is a real class of bug and this was the wrong tool for
 * it.
 *
 * The version that existed worked by asking which names this app exports and testing
 * each against the file's source â€” which needs a JavaScript lexer good enough to tell
 * code from `//` comments, from `/* *\/` comments, from string literals, and from the
 * interpolations of nested template literals. Every one of those was wrong at least
 * once. The failure mode was always the same and always the worst one available: the
 * checker reported a confident, plausible, false list â€” 931 problems, then 67, then 3,
 * then 27 across four revisions â€” and never a wrong *shape* that would have shown up
 * as a crash.
 *
 * A check that is sometimes confidently wrong gets switched off, and then it protects
 * nothing while still appearing to. What is here instead is the one part that needs no
 * lexer: every name a module imports is checked against what the target actually
 * exports. That has no false positives to speak of, and it caught a real typo
 * (`sessions.findExercise`) the first time it was run.
 *
 * The missing-import class is caught by running the app: `app/__e2e.html` drives the
 * real services against a real IndexedDB, which is the only place `ReferenceError` can
 * actually happen, because node has no database and no test in this suite renders a
 * session.
 */
/**
 * Names a module CALLS but never imports, where the callee lives in exactly one other
 * module.
 *
 * WHY IT EXISTS. A helper deleted from one file and still called from another is a
 * `ReferenceError` on the first tap that reaches it — not a compile error, not a lint
 * warning, and not anything the type checker in `jsconfig.json` sees, because the call
 * resolves fine as an identifier. Every other check in this file looks at what a module
 * IMPORTS; this one looks at what it USES. `listGroupsFor` was called from
 * `question-service.js` after its declaration was removed, the bundle built, the other
 * eleven routes worked, and `/questions` rendered the literal text "listGroupsFor is
 * not defined".
 *
 * WHY IT IS NARROW, and not the general version. An earlier attempt at this reported
 * every identifier a module used but did not import, and produced a confident, plausible,
 * FALSE list — 931 problems, then 67, then 3, then 27 across four revisions. It was
 * wrong because deciding whether a bare word is "used as a function" needs a lexer, and
 * every version of that lexer here was wrong at least once. A check that is sometimes
 * confidently wrong gets switched off and then protects nothing while still appearing
 * to. So this reports a name only when all three hold:
 *
 *   1. it is exported by EXACTLY ONE module in the graph — two modules exporting the
 *      same helper is legal, and guessing which one a call meant is the confident wrong
 *      answer this file must not produce;
 *   2. the calling module neither imports it nor declares it — so a file that defines
 *      `function listGroupsFor()` and calls it, or holds it in a `const`, is not
 *      reported, and that clause is what removes almost every false positive;
 *   3. it is called as `name(` — never as a property, because `ns.name` is a member read
 *      checked above and `record.name` is data.
 *
 * What is left is a bare reference to a function that lives in one other file and was
 * not brought over, which is the bug and nothing else.
 */
function missingImports() {
    const declaredIn = (source) => {
        const names = new Set();
        for (const [, clause] of source.matchAll(/import\s+([^;]*?)\s+from\s*["'][^"']+["']/g)) {
            for (const part of clause.split("{").slice(1).join("{").split(",")) {
                const trimmed = part.replace(/}/g, "").trim();
                if (!trimmed) continue;
                const alias = trimmed.split(/\s+as\s+/);
                names.add((alias[1] ?? alias[0]).trim());
            }
            const ns = clause.match(/^\s*\*\s+as\s+([A-Za-z_$][\w$]*)/);
            if (ns) names.add(ns[1]);
        }

        // A DYNAMIC IMPORT IS AN IMPORT. `const { confirm } = await import("./dialog.js")`
        // brings `confirm` into scope exactly as a static clause would, and several
        // pages do it deliberately — `destructiveButton` imports the dialog lazily so
        // that a page which never confirms anything never loads it. Without this the
        // check reported `confirm(...)` as missing in every page that uses it.
        //
        // `[^{}]` AND NOT `[^}]`: the class must not contain a brace, or the pattern
        // starts at the first object literal in the file and runs all the way to the
        // next `}` before `= await import`, capturing half the module and reporting
        // every name in it. That is not a hypothetical — it is what the first version
        // did, and it is the whole reason this one is written the way it is.
        for (const [, clause] of source.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(/g)) {
            for (const part of clause.split(",")) {
                const trimmed = part.trim().split(/\s+as\s+/);
                names.add((trimmed[1] ?? trimmed[0]).trim());
            }
        }
        for (const m of source.matchAll(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(/gm)) {
            names.add(m[1]);
        }

        for (const m of source.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
        for (const m of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
        // A `const`/`let` IS A DECLARATION, and `goal-actions.js` is exported entirely
        // as `export const exerciseHref = (…) => …`, so without this clause every one of
        // its own helpers reads as a call to something it does not import.
        for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);

        // A PARAMETER IS A DECLARATION TOO, and this one matters more than it looks:
        // `dialog.js` has `function open(build)` and calls `build(element, finish)`,
        // which is the dialog's own render helper and has nothing to do with
        // report-service's `build`. Treating the name as declared is what stops the
        // check reporting it.
        //
        // The pattern is deliberately over-broad — any `(` or `,` followed by a bare
        // identifier counts — because over-collecting makes this check LESS strict and
        // a check that misses a real case is visible, while one that invents them gets
        // switched off. The cost is bounded by clauses 1 and 3, which still require the
        // name to be exported by exactly one other module and to be called as `name(`.
        for (const m of source.matchAll(/[(,]\s*([A-Za-z_$][\w$]*)\s*[,)=]/g)) names.add(m[1]);

        return names;
    };

    const homes = new Map();
    for (const [key, source] of SOURCES) {
        for (const name of exportsOf(source)) {
            if (!homes.has(name)) homes.set(name, []);
            homes.get(name).push(key);
        }
    }

    const out = [];
    for (const [key, source] of SOURCES) {
        const have = declaredIn(source);
        const code = CODE.get(key);
        for (const [name, where] of homes) {
            if (where.length !== 1) continue;
            if (have.has(name)) continue;
            // `get error()` and `set value()` in an object literal are ACCESSORS, not
            // calls, and `fields.js` has a `get error()` whose name collides with
            // toast's exported `error`. The lookbeheads are what tell the two apart.
            const hit = new RegExp(`(?<![\\w$.'"\\\`/])(?<!get )(?<!set )(?<![\\w])${name}\\s*\\(`, "g").exec(code);
            if (!hit) continue;
            out.push(`${key}: calls ${name}(...) but never imports it — it is exported by ${where[0]}`);
        }
    }
    return out;
}

problems.push(...missingImports());

if (problems.length) {
    console.error(`\nmodule graph: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  أ¢إ“â€“ ${problem}`);
    console.error("");
    process.exit(1);
}

console.log(`module graph: ${all.size} modules, every named import and namespace member resolves to a real export`);
