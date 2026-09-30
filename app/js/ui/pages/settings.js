// Settings: the language, the sync configuration, the key, and the two ways out.
//
// Four sections in the order somebody reaches for them. Two of them are things
// this app cannot do for the reader, and they are the two that are worded as
// such:
//
//   * THE KEY SECTION SAYS THE KEY IS NOT HERE. It shows the sync space id, which
//     is the one value derived from the key that is safe to display, and it says
//     plainly that the master key is not stored. There is no "show my key", and
//     there cannot be one: `identity-service` never keeps the master and throws
//     the bytes away after deriving, so a button for it would either do nothing
//     or re-implement the storage this app refuses to have.
//
//   * "FORGET EVERYTHING ON THIS DEVICE" IS OFFERED, CONFIRMED, AND SAYS WHAT
//     IT COSTS. Not "sign out" — there is no session to end — and not a hidden
//     corner. It is the only way any key material leaves storage, it confirms
//     first, and the confirmation says that a device which has synced can bring
//     the data back with the key. A destructive action that is hard to find is
//     a support ticket.
//
// The sync section is the only one with a state worth watching, so it subscribes
// to the bus and redraws itself; the other three are static once drawn.

import { h, mount } from "../dom.js";
import { head, section, card, destructiveButton } from "../page.js";
import { field, textInput, selectInput, checkboxRow, form, submitButton } from "../fields.js";
import * as toast from "../toast.js";
import { t, formatDateTime, previewLanguage, setLanguage, getLanguage, isLanguage } from "../../i18n/i18n.js";
import { LANGUAGES } from "../../i18n/strings.js";
import { APP_VERSION } from "../../config.js";
import { now } from "../../domain/time.js";
import { getState, onState, setState } from "../../app/bus.js";
import { getIdentity, forgetIdentity } from "../../services/identity-service.js";
import { unregisterServiceWorker } from "../../app/sw-register.js";
import { needsBackupReminder, lastBackupAt } from "../../services/export-service.js";
import { downloadBackup, readBackupFile, writeBackupTables } from "../../services/backup-service.js";
import * as sync from "../../services/sync-service.js";
import { go } from "../../app/router.js";

export async function render() {
    const [config, identity, reminder] = await Promise.all([
        sync.getConfig(),
        getIdentity().catch(() => null),
        needsBackupReminder()
    ]);

    const node = h("div.stack", null);
    node.appendChild(head("settings.title", "settings.subtitle"));

    // Built here rather than inside `syncCard` because the bus subscription in
    // this function is what fills it — see below. A card that drew its own first
    // status line and was then repainted by the subscription would be two
    // sources for the same sentence, one of them thrown away immediately.
    const statusBox = h("div.sync-body");

    node.appendChild(section("settings.section_language", languageCard()));
    node.appendChild(section("settings.section_key", await keyCard(identity, reminder)));
    node.appendChild(section("settings.section_sync", syncCard(config, statusBox)));
    node.appendChild(section("settings.section_backup", await backupCard()));
    node.appendChild(section("settings.section_danger", dangerCard()));
    node.appendChild(h("p.tiny.muted", { text: `${t("settings.version")} ${APP_VERSION}` }));

    function paint() {
        // `mount`, not `replaceChildren`: the native method prints "null" into a
        // container handed something that turned out to be nothing, and every
        // container in this app is repainted through here.
        mount(statusBox, statusRow(getState()));
    }

    // The only subscription in the app that is not the language. It is released
    // on the way out, because the bus is a module-level set and a settings page
    // left in it keeps a page's worth of DOM alive for as long as the tab is
    // open.
    const off = onState(paint);
    paint();

    return { node, destroy: off };
}

/* -------------------------------- language --------------------------------- */

function languageCard() {
    const control = selectInput({
        value: getLanguage(),
        options: LANGUAGES.map((l) => ({ value: l.code, labelKey: `lang.${l.code}` }))
    });
    // Previewed, then saved. The preview is what makes the switch feel like a
    // switch: the listener in main.js redraws the page and the navigation in the
    // new language, and the write follows it. Saved first, a language that failed
    // to redraw would leave a page in the new language with the old one stored,
    // and the reader would have no way to tell that from a bug.
    //
    // A code that is not a language the app ships is refused outright, so the
    // control can never be the reason every string on the screen turns into a key
    // name — `isLanguage`, checked before anything is stored.
    control.addEventListener("change", () => {
        if (!isLanguage(control.value)) {
            control.value = getLanguage();
            return;
        }
        previewLanguage(control.value);
        setLanguage(control.value).catch(() => {});
    });

    // "App language", not "Language". The card is already headed "Language", and a
    // label that repeats the heading directly under it reads as a mistake — and it
    // is the label a screen reader announces for the control, so it has to name
    // the control rather than the section.
    return card(field({ labelKey: "settings.field_language", control }).node);
}

/* ----------------------------------- key ----------------------------------- */

async function keyCard(identity, reminder) {
    return card(
        // The reminder lives in this card and not in the backup card below,
        // because it is about the KEY FILE, which is what this section is about.
        // The backup section explains what a backup is here; repeating the same
        // sentence in both would make one of the two read as filler.
        h("p.banner.banner-warn", {
            hidden: !reminder,
            text: t("settings.backup_stale")
        }),
        h("p", { text: t("settings.key_body") }),
        identity
            ? h("p.small.mono", { text: `${t("settings.key_space")}: ${identity.spaceId}` })
            : null
    );
}

/* ---------------------------------- sync ----------------------------------- */

function syncCard(config, statusBox) {
    const urlField = field({
        labelKey: "settings.sync_url",
        hintKey: "settings.sync_url_hint",
        control: textInput({ value: config.baseUrl, placeholderKey: "settings.sync_url_placeholder" })
    });
    urlField.control.setAttribute("dir", "ltr");

    // An absolute URL is refused by the service rather than rewritten — see
    // `normaliseBaseUrl` — so the field says so, in the field, at the moment the
    // paste happens. A silent rewrite would be worse: the reader would believe
    // they had pointed the app at their own server and it would be pointed
    // somewhere else.
    urlField.control.addEventListener("input", () => {
        const raw = urlField.control.value.trim();
        const looksAbsolute = raw !== "" && !raw.startsWith("/");
        urlField.setError(looksAbsolute ? "bad_endpoint" : null);
    });

    const enable = checkboxRow({
        checked: config.enabled,
        labelKey: "settings.sync_enable",
        onChange: () => {
            saveConfig({ enabled: enable.control.checked });
        }
    });

    const save = submitButton("common.save");

    const urlForm = form(() => {
        save.setBusy(true);
        saveConfig({ baseUrl: urlField.control.value })
            .then((result) => {
                if (!result.ok) {
                    urlField.setError("bad_endpoint");
                    return;
                }
                urlField.setError(null);
                // Written back from the saved config, not from the field: the
                // service trims and normalises, and a field left holding what the
                // reader typed is a field that will be rejected on the next save.
                urlField.control.value = result.config.baseUrl;
                toast.show("toast.sync_saved");
            })
            .finally(() => save.setBusy(false));
    },
    h("div.stack", null,
        urlField.node,
        save.node
    )
    );

    const nowButton = h("button.btn.btn-secondary.btn-block", {
        type: "button",
        onclick: async () => {
            nowButton.disabled = true;
            await sync.resetBackoff();
            const result = await sync.syncNow({ reason: "manual" });
            nowButton.disabled = false;
            if (result.ok) {
                toast.show(result.pushed || result.pulled ? "toast.synced" : "toast.sync_nothing");
            } else if (result.reason !== "off") {
                // "off" is not a failure: the reader asked for a run with sync
                // switched off, which is a no-op they can see the cause of two
                // lines above. A toast about it would be a complaint about a
                // setting they can see the cause of.
                toast.show("toast.sync_failed");
            }
        }
    }, t("settings.sync_now"));

    return card(
        h("div.stack", null,
            enable.node,
            urlForm,
            statusBox,
            // Offered whether or not sync is on. A reader who has not turned it on
            // yet still wants to know the button is there, and a disabled button
            // with no explanation is the thing that makes people think the app
            // cannot sync at all.
            nowButton
        )
    );
}

/** One line describing what sync is doing. Derived entirely from the bus, so the
 *  home screen, this page and the backoff can never tell three different stories
 *  about the same run. */
function statusRow(state) {
    let text;
    if (!state.syncMode || state.syncMode === "off") {
        text = t("settings.sync_status_idle");
    } else if (state.syncStatus === "error") {
        text = `${t("settings.sync_status_error")} (${t(`error.${state.syncError ?? "sync_failed"}`)})`;
    } else if (state.syncStatus === "ok") {
        text = state.lastSyncAt
            ? `${t("settings.sync_status_ok")} · ${formatDateTime(state.lastSyncAt)}`
            : t("settings.sync_status_ok");
    } else {
        text = t("common.loading");
    }

    const node = h("p.small.muted", { text });

    if (state.syncMode === "on" && state.syncPending > 0) {
        node.appendChild(document.createTextNode(" · "));
        node.appendChild(h("span", { text: t("settings.sync_status_pending", { n: state.syncPending }) }));
    }
    return node;
}

async function saveConfig(patch) {
    const result = await sync.setConfig(patch);
    // A settings change is not owed the backoff the previous configuration earned:
    // a reader who has just corrected the address after an hour of failures
    // should not then be told to wait five minutes.
    if (result.ok) await sync.resetBackoff();
    return result;
}

/* --------------------------------- backup ---------------------------------- */

/**
 * The encrypted backup file, in both directions.
 *
 * The KEY FILE is what gets the reader back into an identity; the BACKUP FILE is
 * what gets their questions back. Both are needed and neither replaces the other,
 * which is why this card offers two buttons and why the key card above refuses to
 * pretend it can show the key again.
 *
 * The file is sealed with the data key already on this device (see
 * domain/backup.js), so restoring is: import the key on the new machine, then pick
 * the file. No second secret, and a file that leaks tells whoever has it nothing.
 */
async function backupCard() {
    const last = await lastBackupAt();

    // A real <input type="file"> driven by a button, rather than a drop target and
    // a drag-and-drop handler: the picker is the one file chooser that works on
    // every platform, in every browser, including one this app has never seen. A
    // drop-only control is a control that does nothing on a phone.
    const picker = h("input", {
        type: "file",
        accept: ".recall,.json,application/json",
        hidden: true,
        onchange: (event) => {
            const file = event.target.files?.[0];
            // Cleared before the work starts, so choosing the same file twice in a
            // row is two restores rather than one restore and a control that has
            // silently stopped reporting changes.
            event.target.value = "";
            if (file) restoreFrom(file);
        }
    });

    const downloadButton = h("button.btn.btn-secondary", {
        type: "button",
        onclick: async () => {
            downloadButton.disabled = true;
            try {
                await downloadBackup();
                toast.show("toast.backup_downloaded");
                backupLine.textContent = `${t("settings.backup_done")} · ${formatDateTime(now())}`;
            } catch (err) {
                toast.error(err);
            } finally {
                downloadButton.disabled = false;
            }
        }
    }, t("settings.backup_download"));

    const restoreButton = h("button.btn.btn-secondary", {
        type: "button",
        onclick: () => picker.click()
    }, t("settings.backup_restore"));

    const backupLine = h("p.small.muted", {
        text: last
            ? `${t("settings.backup_done")} · ${formatDateTime(last)}`
            : t("settings.backup_never")
    });

    async function restoreFrom(file) {
        // Decrypted and checked BEFORE the confirmation, so the dialog can say how
        // much is about to be replaced and a file that is not this device's backup
        // is refused without ever asking the reader to agree to it.
        let prepared;
        try {
            prepared = await readBackupFile(file);
        } catch (err) {
            toast.error(err);
            return;
        }

        const { confirm } = await import("../dialog.js");
        const ok = await confirm({
            titleKey: "dialog.restore_title",
            bodyKey: "dialog.restore_body",
            params: {
                questions: prepared.counts.questions ?? 0,
                exercises: prepared.counts.exercises ?? 0,
                answers: prepared.counts.attempts ?? 0
            },
            yesKey: "common.restore"
        });
        if (!ok) return;

        restoreButton.disabled = true;
        downloadButton.disabled = true;
        try {
            const result = await writeBackupTables(prepared.tables);
            if (result.skipped) {
                // Said out loud rather than swallowed: a row this build could not
                // read is a record the reader believes is in the file and is not.
                // `show()` takes a key or an already-translated string, and the
                // count is the reason this one is not just the key.
                toast.show(t("toast.backup_partial", { n: result.skipped }));
            } else {
                toast.show("toast.backup_restored");
            }
            // Replace rather than push: everything on screen was read before these
            // rows existed, and Back should not walk back into a settings page whose
            // "last backup" line is now a lie.
            go("/", { replace: true });
        } catch (err) {
            toast.error(err);
            restoreButton.disabled = false;
            downloadButton.disabled = false;
        }
    }

    return card(
        h("p", { text: t("settings.backup_body") }),
        h("p.small.muted", { style: { "margin-bottom": "var(--space-3)" }, text: t("settings.backup_hint") }),
        picker,
        h("div.btn-row", null, downloadButton, restoreButton),
        backupLine
    );
}

/* --------------------------------- danger ---------------------------------- */

function dangerCard() {
    return card(
        h("p.small.muted", { style: { "margin-bottom": "var(--space-3)" }, text: t("settings.forget_body") }),
        destructiveButton("settings.forget_button", {
            titleKey: "settings.forget_title",
            bodyKey: "settings.forget_body",
            // "Delete", not a second copy of the button label. A confirm whose
            // affirmative is the same sentence as the button it confirms is a
            // confirm nobody reads, because the eye reads it as the button again.
            yesKey: "common.delete"
        }, async () => {
            // The worker goes first. It holds this origin's copy of the app, and
            // an app that comes back with no key and an old cached shell is a
            // state nobody can leave — so the caches and the registration are
            // removed before the data, while a key still exists to reinstall the
            // app with. (sw-register.js says the same thing the other way round.)
            await unregisterServiceWorker();
            await forgetIdentity();
            setState({
                hasIdentity: false,
                spaceId: null,
                syncStatus: "idle",
                syncPending: 0,
                syncMode: "off"
            });
            // Replace, not push: the settings page this came from is gone, and
            // Back should not walk onto a page for a key that no longer exists.
            go("/", { replace: true });
        })
    );
}