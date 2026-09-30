// Nothing here.
//
// The 404 is a page rather than a blank screen because the router can reach it in
// two ways that look identical to a reader: a mistyped path, and a deep link to a
// question this device does not have. Both are answered by the same sentence —
// that address is not here — and both offer the same way out, which is Home. The
// error string is `error.not_found` rather than a key of its own because it is the
// same thing that is said when a question has been deleted, and two sentences for
// one situation is how the two drift apart.
//
// No retry, no search, no list of everything else in the app. This app has five
// destinations and they are all in the bar underneath.

import { h, link } from "../dom.js";
import { head, card } from "../page.js";
import { t } from "../../i18n/i18n.js";

export async function render() {
    return {
        node: h("div.stack", null,
            head("error.not_found"),
            card(
                link("/", t("common.back"), { class: "btn" })
            )
        )
    };
}