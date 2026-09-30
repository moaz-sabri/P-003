// Form fields.
//
// A field is three elements — label, control, message — and the three have to
// stay associated or the error is invisible: a red border under a box with no
// label next to it, on a phone, in the one field that happens to be empty.
//
// So each factory returns an object with the wrapper and the control, and
// `setError()` on that object puts the message in the right place, marks the
// control with `aria-invalid`, and points `aria-describedby` at the message.
// That last part is what makes a screen reader announce WHY a field is refused
// instead of only that something is.
//
// The message is a translated KEY (`error.too_long`), never a sentence built at
// the call site, and validation decides the code — domain/validation.js, which
// is the same code the API runs on the same input.

import { h } from "./dom.js";
import { t } from "../i18n/i18n.js";

let counter = 0;
const nextId = (prefix) => `${prefix}-${++counter}`;

/**
 * @param {{labelKey?: string, hintKey?: string, control: HTMLElement}} input
 * @returns {{node: HTMLElement, control: HTMLElement, setError: (code: string|null) => void}}
 */
export function field({ labelKey, hintKey = null, control }) {
    const id = control.id || nextId("f");
    control.id = id;

    const hint = hintKey ? h("div.field-hint", { id: `${id}-hint`, text: t(hintKey) }) : null;
    const message = h("div.field-error", { id: `${id}-error`, hidden: true, role: "alert" });

    const node = h("div.field", null,
        labelKey ? h("label", { for: id, text: t(labelKey) }) : null,
        control,
        hint,
        message
    );

    let currentError = null;
    const described = [];

    const setError = (code) => {
        currentError = code ?? null;
        if (currentError) {
            message.textContent = t(`error.${currentError}`);
            message.hidden = false;
            control.setAttribute("aria-invalid", "true");
            described.push(`${id}-error`);
        } else {
            message.textContent = "";
            message.hidden = true;
            control.removeAttribute("aria-invalid");
        }
        if (hint) described.push(`${id}-hint`);
        control.setAttribute("aria-describedby", described.join(" "));
    };

    return { node, control, setError, get error() { return currentError; } };
}

export function textInput({ value = "", placeholderKey = null, maxlength = null, autocomplete = null, inputmode = null }) {
    return h("input.input", {
        type: "text",
        value,
        maxlength,
        autocomplete,
        inputmode,
        placeholder: placeholderKey ? t(placeholderKey) : null
    });
}

export function textareaInput({ value = "", maxlength = null, rows = 4 }) {
    const node = h("textarea.textarea", { maxlength, rows });
    node.value = value;
    return node;
}

/** A number field.
 *
 *  `inputmode="numeric"` rather than `type="number"`. The number input brings a
 *  stepper with it, whose arrows are unusable on a phone and which silently
 *  produces empty values for the digits an Arabic keyboard puts on the sign; a
 *  text input with a numeric keyboard and a pattern is the same field to the
 *  reader and the same number to the code. */
export function numberInput({ value = "", min = null, max = null }) {
    return h("input.input", {
        type: "text",
        value: value === null || value === undefined ? "" : String(value),
        inputmode: "numeric",
        pattern: "[0-9]*",
        min,
        max
    });
}

export function selectInput({ value, options }) {
    const node = h("select.select", null, options.map((o) =>
        h("option", { value: String(o.value), text: t(o.labelKey), selected: String(o.value) === String(value) })
    ));
    node.value = String(value);
    return node;
}

/** A checkbox as a tap row. The input stays a real checkbox inside the label —
 *  it keeps its own state, its own keyboard behaviour and its place in the
 *  accessibility tree, and only its appearance is replaced.
 *
 *  `{node, control}` rather than the element, because the caller needs the input
 *  to read and to set the state: the label is a box with text and a mark, and
 *  `label.checked` is `undefined`. */
export function checkboxRow({ checked = false, labelKey, onChange = null }) {
    const input = h("input", { type: "checkbox", checked, onchange: onChange });
    const node = h("label.choice", null,
        input,
        h("span", { text: t(labelKey) }),
        h("span.choice-mark", { text: "" })
    );
    return { node, control: input };
}

/** A row of two fields, side by side where there is room. */
export function row(...fields) {
    return h("div.field-row", null, fields.filter(Boolean).map((f) => f.node ?? f));
}

/** A whole form: it exists so that Enter submits, which is how every keyboard
 *  and most of every mobile keyboard expects a form to behave. */
export function form(onSubmit, ...children) {
    return h("form", {
        novalidate: true,
        onsubmit: (event) => {
            event.preventDefault();
            onSubmit();
        }
    }, children);
}

/** A submit button that shows a busy state without changing its width.
 *
 *  The label swap happens in place and the button keeps its box, because a
 *  button that grows when it says "Saving…" moves the Cancel button under the
 *  reader's thumb at the exact moment they are most likely to tap it. */
export function submitButton(labelKey, busyLabelKey = "common.saving") {
    const button = h("button.btn", { type: "submit" }, t(labelKey));
    let busy = false;
    return {
        node: button,
        setBusy(value) {
            if (busy === value) return;
            busy = value;
            button.textContent = t(value ? busyLabelKey : labelKey);
            button.disabled = value;
        }
    };
}