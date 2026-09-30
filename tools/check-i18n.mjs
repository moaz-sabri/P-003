#!/usr/bin/env node
// Translation coverage for app/js, and of the tables themselves.
//
// The failure this exists for is quiet. `t()` falls back to English and then to
// the key itself, so a typo, a key renamed on one side of a merge, or an error
// code with no string renders as `goal.field_titel` on one screen of one
// language. Nothing throws, nothing is logged, the app is not broken, and the
// only person who can see it is a speaker of that language. There is no other
// layer in this project that can catch it, so it is caught here.
//
// Four things are checked, and the last two are the ones a lint over the call
// sites would miss:
//
//   1. every key the code names exists in the tables;
//   2. the two tables have the same keys, so a screen cannot be half
//      translated with no visible seam;
//   3. the two tables use the SAME placeholder names, and every call site that
//      passes parameters passes the ones the string interpolates — `{n}` left
//      unsubstituted is a screen that shows a brace;
//   4. every code an error can carry has a string, in both languages. The
//      call site is `t(\`error.${code}\`)`, which no call-site scan can read, so
//      the codes are collected from where they are PRODUCED instead: the error
//      constructors, `setError`, and the fallbacks written inside a template.
//
// The tables are read by importing them rather than by parsing strings.js. A
// parser would be a second opinion about what the app ships, and the whole value
// of this tool is that it cannot disagree with the app.
//
// Usage: node tools/check-i18n.mjs   (exits 1 if anything is missing)

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { TABLES, LANGUAGES, DEFAULT_LANGUAGE } from "../app/js/i18n/strings.js";
import { COUNTDOWN_UNITS } from "../app/js/domain/time.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_JS = join(ROOT, "app", "js");

/* --------------------------------- reporting -------------------------------- */

const problems = [];
const notes = [];

const fail = (where, message) => problems.push({ where, message });
const note = (where, message) => notes.push({ where, message });

/* ---------------------------------- scanning -------------------------------- */

function walk(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...walk(path));
        else if (entry.name.endsWith(".js")) found.push(path);
    }
    return found;
}

/** Comments, blanked rather than removed, so the offsets — and therefore the
 *  line numbers in the report — are still the ones in the file.
 *
 *  This matters more than it looks: these files explain the key contract in
 *  their comments, and an example key in a comment is not a use of that key. A
 *  scanner that reads comments marks every key as used (no orphans are ever
 *  reported) and, worse, marks a key that was DELETED as used (a missing key is
 *  never reported), which is exactly backwards. */
const blank = (match) => match.replace(/[^\n]/g, " ");
const withoutComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // A `//` that is not preceded by `:` and not inside a word, so a URL in a
    // string ("https://…") is not mistaken for the start of a comment.
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (match, before) => before + blank(match.slice(before.length)));

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

const KEY = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;

/** Keys named in the source, and the call shape that named them.
 *
 *  The `*Key` and helper rules are what make this a coverage check rather than a
 *  `t()` check: a title passed to `head("goal.title")` or a label passed to
 *  `field({ labelKey: "goal.field_title" })` is looked up in exactly the same
 *  table, and a checker that only looked at `t()` would call every one of them
 *  unused and its own report would be wrong. */
const CALL_RULES = [
    { via: "t()", re: /\bt\(\s*(["'`])([a-z][\w]*(?:\.[\w]+)+)\1/g, group: 2 },
    { via: "helper", re: /\b(?:head|section|destructiveButton|submitButton|stat)\(\s*(["'])([a-z][\w]*(?:\.[\w]+)+)\1/g, group: 2 },
    { via: "*Key", re: /\b[A-Za-z]*Key\b\s*[:=]\s*(["'])([a-z][\w]*(?:\.[\w]+)+)\1/g, group: 2 },
    { via: "show()", re: /\.\s*show\(\s*(["'])([a-z][\w]*(?:\.[\w]+)+)\1/g, group: 2 }
];

/** The classes whose `code` is an argument, and which argument.
 *
 *  A code is not the first string in every error constructor: `ValidationError`
 *  takes the field name first and the code second, and `InvalidTransitionError`
 *  and `NotFoundError` take entity or state names that are not codes at all —
 *  both fix theirs with `this.code`, which is read separately below. Reading
 *  `new NotFoundError("goal", id)` as the code "goal" would report a missing
 *  `error.goal` string and send someone looking for a bug in the tables. */
const CODE_ARGUMENT = {
    ValidationError: "last",
    ScheduleError: "first",
    CryptoError: "first",
    SyncError: "first",
    ImportError: "first"
};

/* ------------------------------- dynamic keys ------------------------------- */

/** `t()` and `*Key` values built at runtime, as a prefix plus whatever is known
 *  statically inside the interpolation. A prefix the table below cannot expand is
 *  reported, because a key family nobody checks is a key family nobody
 *  translates. */
const DYNAMIC_RULES = [
    { re: /\bt\(\s*`([a-z][\w]*\.[a-z0-9_]*)\$\{([^`]*)`/g },
    { re: /\b[A-Za-z]*Key\b\s*[:=]\s*`([a-z][\w]*\.[a-z0-9_]*)\$\{([^}]*)`/g }
];

const used = new Map();      // key -> first place it was named
const usedVia = new Map();   // key -> Set of call shapes
const params = [];           // {key, named, where}
const dynamic = new Map();   // prefix -> count
const codes = new Map();     // error code -> first place it was produced

const remember = (key, where, via) => {
    if (!used.has(key)) used.set(key, where);
    if (!usedVia.has(key)) usedVia.set(key, new Set());
    usedVia.get(key).add(via);
};

const rememberCode = (code, where) => {
    if (!codes.has(code)) codes.set(code, where);
};

for (const path of walk(APP_JS)) {
    const name = relative(ROOT, path).split(sep).join("/");
    const raw = readFileSync(path, "utf8");
    const text = withoutComments(raw);

    for (const rule of CALL_RULES) {
        for (const match of text.matchAll(rule.re)) {
            remember(match[rule.group], `${name}:${lineAt(text, match.index)}`, rule.via);
        }
    }

    // `t("key", { n: 1 })` — the shape where the argument names can be compared
    // with the placeholders in the string. The outer regex captures the object
    // literal; the inner one extracts property keys. It handles both
    // `{ key: value }` and `{ key }` (shorthand) by matching an identifier
    // followed by `:`, `,`, `}`, or end of string. A word boundary ensures we
    // match at the start of a key name rather than inside a property access
    // like `row.key`.
    for (const match of text.matchAll(/\bt\(\s*"([a-z][\w]*(?:\.[\w]+)+)"\s*,\s*\{([^{}]*)\}/g)) {
        const named = [...match[2].matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:[:,},]|$)/g)].map((m) => m[1]);
        params.push({ key: match[1], named, where: `${name}:${lineAt(text, match.index)}` });
    }

    for (const rule of DYNAMIC_RULES) {
        for (const match of text.matchAll(rule.re)) {
            const prefix = match[1];
            dynamic.set(prefix, (dynamic.get(prefix) ?? 0) + 1);
            // `error.${state.syncError ?? "sync_failed"}` — the fallback written
            // inside the interpolation is a code the reader can be shown, so it
            // is a code that must have a string.
            for (const literal of match[2].matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                rememberCode(literal[1], `${name}:${lineAt(text, match.index)}`);
            }
        }
    }

    // The error codes the app can produce. `setError` is here because a field
    // message and a toast are the same lookup with a different skin.
    for (const match of text.matchAll(/\bnew\s+([A-Z][\w]*Error)\s*\(([^)]*)\)/g)) {
        const which = CODE_ARGUMENT[match[1]];
        if (!which) continue;
        const literals = [...match[2].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
        const code = which === "last" ? literals.at(-1) : literals[0];
        if (code) rememberCode(code, `${name}:${lineAt(text, match.index)}`);
    }
    for (const match of text.matchAll(/\bsetError\(\s*"([a-z][a-z0-9_]*)"/g)) {
        rememberCode(match[1], `${name}:${lineAt(text, match.index)}`);
    }
    // `this.code = "not_found"` — the classes whose code is not an argument.
    for (const match of text.matchAll(/\bthis\.code\s*=\s*"([a-z][a-z0-9_]*)"/g)) {
        rememberCode(match[1], `${name}:${lineAt(text, match.index)}`);
    }
}

/* -------------------------------- the tables -------------------------------- */

const [primary, ...rest] = LANGUAGES.map((l) => l.code);
const tables = TABLES;
const base = tables[DEFAULT_LANGUAGE];

// Every key the app can ask for, however it is spelled: the tables, the two
// families built from a list, and every code an error can carry.
const expected = new Map();
for (const key of Object.keys(base)) expected.set(key, { where: "strings.js" });
for (const unit of COUNTDOWN_UNITS) expected.set(`unit.${unit}`, { where: "time.js COUNTDOWN_UNITS" });
for (const language of LANGUAGES) expected.set(`lang.${language.code}`, { where: "strings.js LANGUAGES" });
for (const [code, where] of codes) expected.set(`error.${code}`, { where, family: "error" });

/* ---------------------------------- checks ---------------------------------- */

// A KEY THE CODE CAN ASK FOR MUST EXIST. The `expected` map is built from three
// things: the tables themselves, the two families built from a list, and the error
// codes. Only the first kind is checked by walking the call sites below, so the
// other two have to be checked HERE — and one of them was not, which is how
// `unit.hours` and `unit.days` could sit in `COUNTDOWN_UNITS`, be named by the
// formatter every time a countdown was drawn, and be missing from both tables.
//
// `t()` renders a missing key as the key, so the symptom was not a blank: it was
// "Opens in . 23unit.hours 59unit.minutes" on the result page, in both languages,
// and the family check below it was satisfied by the singular keys that happened to
// share the prefix. A family that cannot be checked is a family nobody translates;
// a family that is checked but not verified to exist is worse, because the report
// says OK.
for (const [key, source] of expected) {
    if (typeof base[key] !== "string") {
        fail(source.where, `\`${key}\` is asked for at runtime and is not in the ${primary} table`);
    }
}

for (const [key, source] of used) {
    if (!KEY.test(key)) {
        fail(source.where, `\`${key}\` is not a key name (${source.via}) — keys are dotted lowercase names`);
    } else if (!expected.has(key)) {
        fail(source.where, `\`${key}\` is not in the table (${source.via})`);
    }
}

// A key family built from a list, expanded into `expected` above. Anything else
// built at runtime is invisible to a scan, so it is reported rather than assumed.
for (const [prefix, count] of dynamic) {
    if (prefix === "error.") continue;   // expanded from the codes below
    if (!expected.has(`${prefix}PLACEHOLDER`)) {
        // No generic family: check that the expansion produced at least one key
        // under this prefix, so a family with no keys at all is not silent.
        const any = [...expected.keys()].some((key) => key.startsWith(`${prefix}`));
        if (!any) note("app/js", `${count} key(s) built at runtime from \`${prefix}…\` are not checked: nothing in the tables starts with it`);
    }
}

for (const [code, where] of codes) {
    const key = `error.${code}`;
    if (!tables[primary] || typeof tables[primary][key] !== "string") {
        fail(where, `error code "${code}" has no string in the ${primary} table`);
    }
}

for (const language of LANGUAGES) {
    const table = tables[language.code];
    if (!table) {
        fail("strings.js", `LANGUAGES lists "${language.code}" and TABLES has no table for it`);
        continue;
    }
    for (const key of Object.keys(base)) {
        if (!(key in table)) fail("strings.js", `\`${key}\` is missing from the ${language.code} table`);
    }
    for (const key of Object.keys(table)) {
        if (!(key in base)) fail("strings.js", `\`${key}\` is in the ${language.code} table and in neither the ${primary} table nor any use`);
    }
}

/* ------------------------------- placeholders ------------------------------- */

const placeholders = (text) => new Set([...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

for (const language of rest) {
    const table = tables[language];
    for (const key of Object.keys(base)) {
        if (!(key in table)) continue;
        const en = [...placeholders(base[key])].sort();
        const other = [...placeholders(table[key])].sort();
        if (en.join(",") !== other.join(",")) {
            fail("strings.js", `\`${key}\` interpolates {${en.join("}, {")}} in ${primary} and {${other.join("}, {")}} in ${language}`);
        }
    }
}

for (const { key, named, where } of params) {
    const wanted = placeholders(base[key] ?? "");
    for (const name of wanted) {
        if (!named.includes(name)) {
            fail(where, `\`${key}\` interpolates {${name}} and this call passes {${named.join(", ") || "nothing"}}`);
        }
    }
}

/* ---------------------------------- report ---------------------------------- */

const orphans = [...expected.keys()]
    .filter((key) => !used.has(key) && !key.startsWith("error."))
    .sort();

const rel = (where) => where === "strings.js" ? where : where;

console.log(`i18n: ${Object.keys(base).length} keys x ${LANGUAGES.length} languages, `
    + `${used.size} named in code, ${codes.size} error codes`);

if (problems.length) {
    console.log(`\nMISSING — ${problems.length}`);
    for (const { where, message } of problems) console.log(`  ${where}\n    ${message}`);
}

if (notes.length) {
    console.log(`\nNOT CHECKED — ${notes.length}`);
    for (const { where, message } of notes) console.log(`  ${where}\n    ${message}`);
}

if (orphans.length) {
    console.log(`\nUNUSED — ${orphans.length} (a key nothing names is dead weight, not an error)`);
    console.log(`  ${orphans.join("\n  ")}`);
}

if (problems.length) {
    console.log("\nFAIL");
    process.exitCode = 1;
} else {
    console.log("\nOK");
}
