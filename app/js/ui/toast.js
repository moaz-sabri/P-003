// Transient messages.
//
// Two kinds, and the difference is not decoration:
//
//   * `toast.show(key)` says something happened. It goes away on its own.
//   * `toast.error(err)` says something did NOT happen, and it is built from the
//     error's CODE rather than its message — every error in domain/errors.js
//     carries a `code` that exists as a string in both tables, so this one
//     function covers every failure in the app without any call site having to
//     invent a fallback. An error with no code falls back to its message, which
//     for a transition error is the *action name* and reads as "error.finish".
//
// Every toast carries its own timer and removes itself. There is no queue: a
// message about a write belongs where the reader's thumb already is, and a
// second message arriving while the first is on screen replaces it rather than
// pushing it up — a stack of toasts is a log, and this is not one.

import { h } from "./dom.js";
import { t } from "../i18n/i18n.js";

const DEFAULT_MS = 2600;

/** Errors stay up longer than confirmations, because an error is the one thing
 *  here that can cost the reader their work if they do not read it. */
const ERROR_MS = 5000;

let timer = null;

/**
 * @param {string} key  a key in the tables. A translated string is also
 *   accepted, which is what a caller that built one itself passes.
 */
export function show(key, ms = DEFAULT_MS) {
    const root = document.getElementById("toast-root");
    if (!root) return;
    const message = String(key).includes(".") ? t(key) : key;
    root.replaceChildren(h("div.toast", { role: "status" }, message));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        root.replaceChildren();
        timer = null;
    }, ms);
}

/**
 * Say that something failed.
 *
 * `error` may be anything with a `code`; anything else is rendered as itself,
 * which is what makes this safe to call from a `catch` with no inspection. It
 * must never be called with a value that could contain a secret: the messages
 * here are codes, and codes are safe.
 */
export function error(err, ms = ERROR_MS) {
    const code = err && typeof err === "object" ? err.code : null;
    show(code ? `error.${code}` : String(err?.message ?? err ?? ""), ms);
}

export function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
    document.getElementById("toast-root")?.replaceChildren();
}