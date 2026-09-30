// The one place that knows which language the app is in.
//
// `t()` is a lookup and a substitution, and it never throws and never returns
// undefined. A missing key falls back to English, then to the key itself — and
// returning the key rather than an empty string is deliberate: a screen that
// silently renders nothing in one language is found weeks later, while a screen
// that renders `goal.field_title` in one language is found by opening it.
//
// Formatting lives here rather than in domain/time.js because formatting is the
// part that has a language in it. The arithmetic stays pure and testable; the
// words, the separators and the direction do not.

import { TABLES, LANGUAGES, DEFAULT_LANGUAGE } from "./strings.js";
import { META_KEY } from "../data/stores.js";
import { getMeta, setMeta } from "../data/repos.js";
import { countdownParts, COUNTDOWN_UNITS, formatStopwatch } from "../domain/time.js";

let language = DEFAULT_LANGUAGE;
const listeners = new Set();

export { formatStopwatch };

/** Is this a language the app actually ships? Checked before anything is stored
 *  or applied, because the value comes from a stored setting and from a form
 *  control, and a language that is not in the tables turns every `t()` into the
 *  fallback path — an app that works and shows nothing but key names. */
export function isLanguage(code) {
    return LANGUAGES.some((l) => l.code === code);
}

export function getLanguage() {
    return language;
}

/** Right-to-left or left-to-right. `dir` on <html> is the only thing that
 *  flips the whole layout, and it is set here rather than by each page — a page
 *  that sets its own direction gets it wrong exactly once and then looks broken
 *  in one language only. */
export function direction() {
    return LANGUAGES.find((l) => l.code === language)?.dir ?? "ltr";
}

/**
 * The translated string for `key`, with `{name}` replaced from `params`.
 *
 * The argument is an object rather than a positional list so that adding a
 * parameter later cannot silently swap two values into the wrong places — which
 * is the failure a positional list produces and nobody notices, because both
 * placeholders are usually numbers.
 */
export function t(key, params) {
    const table = TABLES[language] ?? TABLES[DEFAULT_LANGUAGE];
    let text = table[key];
    if (text === undefined) text = TABLES[DEFAULT_LANGUAGE][key];
    if (text === undefined) return key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
        (params[name] === undefined ? match : String(params[name]))
    );
}

/** Register a listener. The language control calls this and re-renders. */
export function onLanguageChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Apply a language, and optionally remember it.
 *
 *  The write is NOT conditional on the language having changed, which is the one
 *  thing here that is not obvious. The settings switcher previews a language and
 *  then saves it — two calls, the second of which arrives with `code === language`
 *  because the first already applied it. An early return on "no change" is the
 *  correct behaviour for the listeners and the wrong behaviour for the write, and
 *  the version that returned early for both is why the switch appeared to work and
 *  then came back in the old language on the next load.
 *
 *  So the two concerns are separated: `meta` is written whenever `persist` is set,
 *  and the listeners are told only about a real change — a redraw for a language
 *  that is already on screen would rebuild the page under the reader's finger. */
async function apply(code, persist) {
    if (!isLanguage(code)) return;
    const changed = code !== language;
    language = code;
    if (persist) await setMeta(META_KEY.LANGUAGE, code).catch(() => {});
    if (!changed) return;
    for (const fn of listeners) fn(code);
}

/** Read the stored language at boot. A stored value that is not a language the
 *  app ships falls back to the default rather than being applied — see
 *  `isLanguage`. */
export async function loadLanguage() {
    try {
        const stored = await getMeta(META_KEY.LANGUAGE);
        if (isLanguage(stored?.value)) language = stored.value;
    } catch {
        // A device that cannot read its own settings still gets a working app in
        // the default language. Refusing to start here would turn a storage
        // problem into an app that does not open.
    }
    return language;
}

export function setLanguage(code) {
    return apply(code, true);
}

/** Apply without persisting. For the language switcher, which wants the page to
 *  change first and the write to follow — a switch that failed to save would
 *  silently come back on the next load, and the reader would have no way to tell
 *  that from a bug. */
export function previewLanguage(code) {
    return apply(code, false);
}

/* ------------------------------- formatting ------------------------------- */

/** A date, medium style, in the current language. `dateStyle` rather than a hand
 *  -built pattern: the Arabic form starts with the day, the English form with
 *  the month, and a pattern written for one of them is wrong in the other. */
export function formatDate(ts) {
    if (!ts) return "";
    return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(ts));
}

/** A date and a time, for the two places a timestamp is shown next to its
 *  meaning (when an exercise was finished, when a backup was taken). */
export function formatDateTime(ts) {
    if (!ts) return "";
    return new Intl.DateTimeFormat(language, {
        dateStyle: "medium",
        timeStyle: "short"
    }).format(new Date(ts));
}

/**
 * A countdown, in the shortest honest form: two units at most, largest first.
 *
 * The space before the Arabic unit is not decoration. A number immediately
 * followed by an Arabic letter is one bidi run, and it renders with the number on
 * the left — "4h" becomes "س4" on screen, which reads as "hours four". The space
 * starts a second run and puts the number back where the eye expects it.
 */
export function formatCountdown(ms) {
    const parts = countdownParts(ms);
    const separator = language === "ar" ? " " : "";
    return COUNTDOWN_UNITS
        .filter((unit) => parts[unit] > 0)
        .map((unit) => `${parts[unit]}${separator}${t(`unit.${unit}`)}`)
        .join(" ");
}

/** A percentage, as a plain number with a percent sign.
 *
 * Not localized. The Arabic percent sign is a bidi-neutral character, so writing
 * it in place of the ASCII one changes how the string is shaped without changing
 * what it means, and the gain is not worth a key in the tables for a character
 * that already sits correctly next to the digits on both sides. */
export function formatPercent(value) {
    return `${value}%`;
}