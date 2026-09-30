// Modals: confirm, choose, prompt.
//
// A native `<dialog>` and `showModal()`, which is the only modal here that gets
// focus trapping, the Escape key, the backdrop and the inert background for free
// from the platform. Three of them are the whole set — a fourth "are you sure
// you are sure" dialog is a sign the third one is asking the wrong question, and
// the reason this file has exactly three exports is that each one answers a
// question the app really asks:
//
//   confirm()  a destructive thing is about to happen
//   choose()   there are two or three things that could happen next
//   prompt()   one line of text is wanted
//
// Every one takes KEYS rather than strings, so the dialogs are translatable
// without the pages passing translations in. Every one resolves — nothing is
// thrown at a caller for having dismissed one — and a dismissal resolves to
// `null` (or `false`), which is the difference between "said no" and "did not
// answer" that a caller can act on.

import { h } from "./dom.js";
import { t } from "../i18n/i18n.js";

const root = () => document.getElementById("dialog-root");

function open(build) {
    return new Promise((resolve) => {
        const element = h("dialog", { "aria-modal": "true" });
        let settled = false;

        const finish = (value) => {
            if (settled) return;
            settled = true;
            // `close()` first, then remove: removing a dialog that is still open
            // leaves the browser's own modal state — the inert backdrop and the
            // Escape handling — pointing at a node that is not in the document.
            if (element.open) element.close();
            element.remove();
            resolve(value);
        };

        element.addEventListener("cancel", (event) => {
            // Escape. Prevented and turned into a normal dismissal so that every
            // way out of the dialog goes through one function; without this the
            // `close` event and the click handlers below would each have to
            // settle the promise themselves.
            event.preventDefault();
            finish(null);
        });

        // A click on the backdrop is a click on the dialog element itself,
        // because the backdrop is not an element you can attach to. The
        // coordinate test is what tells the two apart: `offsetX`/`offsetY` are 0
        // for a click that landed outside the box.
        element.addEventListener("click", (event) => {
            if (event.target !== element) return;
            if (event.offsetX <= 0 || event.offsetY <= 0) finish(null);
        });

        build(element, finish);
        root()?.appendChild(element);
        element.showModal();

        // Focus the first control rather than the dialog. A modal that opens with
        // focus on the container puts a screen reader in "dialog" mode and then
        // makes the reader tab to the button they want, which is the opposite of
        // what a modal is for.
        const first = element.querySelector(
            "input:not([type=hidden]), textarea, select, .btn-primary, .btn"
        );
        (first ?? element).focus?.();
    });
}

function actions(element, buttons) {
    return h("div.dialog-actions", null, buttons.map((b) =>
        h("button", {
            type: "button",
            class: b.variant ? `btn btn-${b.variant}` : "btn btn-secondary",
            onclick: () => b.onClick()
        }, b.label)
    ));
}

/** One Yes/No. Resolves true only on the affirmative button.
 *
 *  `params` exists for the one body that has numbers in it — a restore has to say
 *  how much is about to be overwritten, and "everything" is not an answer. The
 *  key is still a key, so the sentence stays translatable; only the numbers are
 *  filled in by the caller. */
export function confirm({ titleKey, bodyKey = null, params = null, yesKey = "common.yes", noKey = "common.cancel" }) {
    return open((element, finish) => {
        element.appendChild(h("h2", { text: t(titleKey) }));
        if (bodyKey) element.appendChild(h("p.muted", { text: t(bodyKey, params) }));
        element.appendChild(actions(element, [
            { label: t(noKey), onClick: () => finish(false) },
            { label: t(yesKey), variant: "primary", onClick: () => finish(true) }
        ]));
    });
}

/**
 * A list of choices. Resolves the chosen value, or null when dismissed.
 *
 * @param {{titleKey: string, bodyKey?: string,
 *          options: {value: any, labelKey: string, variant?: string}[]}} input
 */
export function choose({ titleKey, bodyKey = null, options }) {
    return open((element, finish) => {
        element.appendChild(h("h2", { text: t(titleKey) }));
        if (bodyKey) element.appendChild(h("p.muted", { text: t(bodyKey) }));
        element.appendChild(actions(element, [
            { label: t("common.cancel"), onClick: () => finish(null) },
            ...options.map((option) => ({
                label: t(option.labelKey),
                variant: option.variant ?? "primary",
                onClick: () => finish(option.value)
            }))
        ]));
    });
}

/**
 * One line of text. Resolves the string, or null when dismissed.
 *
 * The value is read from the field when the form is submitted AND when Enter is
 * pressed. Wiring only the button misses the keyboard, and wiring only a form
 * submit misses a caller that put the button somewhere other than in the form.
 */
export function prompt({ titleKey, bodyKey = null, labelKey = null, value = "", placeholder = "" }) {
    return open((element, finish) => {
        const input = h("input.input", {
            type: "text",
            value,
            placeholder,
            autocomplete: "off",
            spellcheck: "false"
        });

        const submit = () => finish(input.value.trim());

        element.appendChild(h("h2", { text: t(titleKey) }));
        if (bodyKey) element.appendChild(h("p.muted", { text: t(bodyKey) }));
        element.appendChild(h("form", {
            onsubmit: (event) => {
                event.preventDefault();
                submit();
            }
        },
        labelKey ? h("div.field", null, h("label", { text: t(labelKey) }), input) : input
        ));

        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                submit();
            }
        });

        element.appendChild(actions(element, [
            { label: t("common.cancel"), onClick: () => finish(null) },
            { label: t("common.save"), variant: "primary", onClick: submit }
        ]));
    });
}