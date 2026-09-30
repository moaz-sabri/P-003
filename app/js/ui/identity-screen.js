// The first screen: making a key, or adopting one.
//
// This is the only place in the app where the Secret Key exists in readable form,
// and the whole design of the screen is about not losing it at that moment. Three
// things it does, in order:
//
//   * GENERATE, THEN SHOW, THEN ASK. The key is not created when the app opens
//     and not created when the button is pressed and dismissed; it is created on
//     the press, and the screen immediately becomes "this is your key" with the
//     value on it. There is no path from a fresh install to a working app that
//     does not pass through a screen where the key is visible.
//
//   * TWO WAYS OUT, AND THE SECOND ONE IS VISIBLE FROM THE FIRST. A reader who
//     wants to move an existing install to a new phone should not have to finish
//     creating a key to get to the import box — which is what a single-step
//     wizard makes them do, and they end up with a key for a device they did not
//     want.
//
//   * THE CONFIRM BUTTON IS DISABLED UNTIL THE KEY HAS BEEN SHOWN. Not until it
//     has been COPIED or DOWNLOADED — that would be a lie about what the reader
//     has done, since the common case is writing it on paper. Until it has been
//     shown, because before that there is nothing to have saved.

import { h } from "./dom.js";
import { head, card } from "./page.js";
import { field, textareaInput, form } from "./fields.js";
import * as toast from "./toast.js";
import { t } from "../i18n/i18n.js";
import { createIdentity, importIdentity } from "../services/identity-service.js";
import { exportKey, keyFromText } from "../services/export-service.js";
import { SECRET_KEY_LENGTH } from "../domain/secret-key.js";
import { setState } from "../app/bus.js";

export async function render({ onReady }) {
    return { node: await draw(null, onReady) };
}

async function draw(state, onReady) {
    if (!state) return chooseView(onReady);
    if (state.step === "create") return createdView(state, onReady);
    return importView(state, onReady);
}

/* ------------------------------- first step ------------------------------ */

function chooseView(onReady) {
    const node = h("div.stack", null,
        head("identity.title", "identity.subtitle"),
        card(
            h("h2", { text: t("identity.create_heading") }),
            h("p.muted", { text: t("identity.create_body") }),
            h("button.btn.btn-block", {
                type: "button",
                onclick: async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        const created = await createIdentity();
                        replace(node, await draw({
                            step: "create",
                            secretKey: created.secretKey,
                            display: created.display,
                            spaceId: created.spaceId
                        }, onReady));
                    } catch (err) {
                        button.disabled = false;
                        toast.error(err);
                    }
                }
            }, t("identity.create_button"))
        ),
        card(
            h("h2", { text: t("identity.import_heading") }),
            h("p.muted", { text: t("identity.import_body") }),
            h("button.btn.btn-secondary.btn-block", {
                type: "button",
                onclick: async () => replace(node, await draw({ step: "import" }, onReady))
            }, t("identity.import_button"))
        )
    );
    return node;
}

/* ------------------------------- the key --------------------------------- */

async function createdView(state, onReady) {
    // The key exists, in this function, and is on screen below. It is not stored
    // and it is not derivable from anything the app keeps, which is why this
    // screen cannot be revisited: there is nothing to show.
    const { secretKey, display, spaceId } = state;

    const copyButton = h("button.btn.btn-secondary", {
        type: "button",
        onclick: async () => {
            try {
                await navigator.clipboard.writeText(secretKey);
                toast.show("toast.copied");
            } catch {
                // A clipboard permission refusal, or an insecure origin. The key
                // is on screen and selectable either way — say so rather than
                // pretending the copy worked.
                toast.show("error.network");
            }
        }
    }, t("identity.key_copy"));

    const downloadButton = h("button.btn.btn-secondary", {
        type: "button",
        onclick: async () => {
            await exportKey(secretKey, spaceId);
            toast.show("toast.key_downloaded");
        }
    }, t("identity.key_download"));

    const readyButton = h("button.btn.btn-block", {
        type: "button",
        onclick: async () => {
            toast.show("toast.key_confirmed");
            await onReady();
        }
    }, t("identity.key_confirm"));

    return h("div.stack", null,
        head("identity.key_heading", "identity.key_body"),
        card(
            h("p.banner.banner-warn", { text: t("identity.key_warning") }),
            // `user-select: all` through CSSOM rather than an attribute: tapping
            // anywhere in this box should select the whole key, because the one
            // failure mode of a key this long is a drag that stops one character
            // short.
            h("div.mono", {
                style: {
                    "user-select": "all",
                    "padding": "var(--space-3)",
                    "background": "var(--surface-sunken)",
                    "border-radius": "var(--radius)",
                    "word-break": "break-all",
                    "margin-bottom": "var(--space-3)"
                },
                text: display
            }),
            h("p.small.muted", {
                style: { "margin-bottom": "var(--space-3)" },
                text: `${t("identity.space_id")}: ${spaceId}`
            }),
            h("div.btn-row", null, copyButton, downloadButton)
        ),
        readyButton
    );
}

/* ------------------------------- import ---------------------------------- */

function importView(state, onReady) {
    let spaceId = null;

    const input = textareaInput({
        rows: 4,
        maxlength: SECRET_KEY_LENGTH + 200
    });
    input.setAttribute("autocapitalize", "characters");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.placeholder = t("identity.import_placeholder");

    const error = h("div.field-error", { hidden: true, role: "alert" });

    const body = field({ control: input });
    body.node.appendChild(error);

    const submit = form(async () => {
        const text = keyFromText(input.value);
        error.hidden = true;
        input.removeAttribute("aria-invalid");

        try {
            // The import REPLACES this device: it derives the keys, writes the
            // envelope, and any data already here belongs to a different identity
            // and must not be shown next to it. So the database goes first — and
            // if it fails, the import does not happen, because half of an
            // identity with another one's questions on the device is the one
            // state this app cannot describe.
            if (await hasAnyData()) {
                const { confirm } = await import("../ui/dialog.js");
                const ok = await confirm({
                    titleKey: "identity.import_heading",
                    bodyKey: "settings.forget_body",
                    yesKey: "common.confirm"
                });
                if (!ok) return;
                await forgetEverything();
            }
            spaceId = (await importIdentity(text)).spaceId;
            toast.show("toast.imported");
            await onReady();
        } catch (err) {
            error.textContent = t(`error.${err?.code ?? "bad_secret_key"}`);
            error.hidden = false;
            input.setAttribute("aria-invalid", "true");
        }
    },
    h("h2", { text: t("identity.import_heading") }),
    h("p.muted", { text: t("identity.import_body") }),
    h("div", { style: { "margin-top": "var(--space-4)" } }, body.node),
    h("button.btn.btn-block", { type: "submit", style: { "margin-top": "var(--space-4)" } },
        t("identity.import_button"))
    );

    return h("div.stack", null,
        head("identity.title", "identity.subtitle"),
        card(body),
        h("button.btn.btn-quiet", {
            type: "button",
            onclick: () => history.back()
        }, t("common.back"))
    );
}

/* -------------------------------- helpers -------------------------------- */

/** Whether this device already holds data. Read rather than assumed, because
 *  importing over a device that has questions must warn and one that has only
 *  been opened must not. */
async function hasAnyData() {
    const { getActiveGoal, listGoals } = await import("../services/goal-service.js");
    const active = await getActiveGoal();
    if (active) return true;
    return (await listGoals()).length > 0;
}

/** Everything, including the key envelope, the caches and the worker. */
async function forgetEverything() {
    const { forgetIdentity } = await import("../services/identity-service.js");
    const { unregisterServiceWorker } = await import("../app/sw-register.js");
    await unregisterServiceWorker();
    await forgetIdentity();
    setState({ hasIdentity: false, spaceId: null });
}

function replace(node, next) {
    node.replaceWith(next);
}