// Groups: the shelf a question is filed on.
//
// A GROUP ORGANISES QUESTIONS AND NOTHING ELSE. It is not a goal, it is not a
// session, and — since the `goalId` column came off it — it does not belong to a
// goal either. What a goal does with a group is point at it, and the point is a
// `goalRefs` row written by goal-content-service.js, not a field on this record.
//
// Three things about the shape, each forced by a case that came up while this was
// being built:
//
//   * A GROUP IS A RECORD, NOT A FIELD. A bare `groupId` on every question cannot
//     answer "which of my questions are in no group at all" — the state every
//     question written before this existed is in, and a state a reader can create on
//     purpose by clearing the picker. It also cannot carry a name, and the name is
//     the entire thing the reader recognises.
//
//   * "NOT FILED" IS A GROUP LIKE ANY OTHER. Created on demand, rather than a `null`
//     with a branch in every reader. A branch is one more place for the builder and
//     the question list to disagree about what unfiled means.
//
//   * NOTHING IS DESTROYED BY A GROUP. Deleting one files its questions as unfiled,
//     tombstones the group, and tombstones the goals' references to it. A shelf taken
//     away with the books still on it is the exact failure this feature exists to
//     prevent, and a shelf shared between three goals is worse: without the last
//     part, deleting it would leave all three quietly short of material they were
//     still drawing from.
//
// The reader who wants a question asked in a particular session says so by attaching
// things to a goal or by naming them at build time, and neither of those is a
// question's own business.

import { validateGroup } from "../domain/validation.js";
import {
    listGroups, getGroup, createGroup as createGroupRecord,
    renameGroup as renameGroupRecord, deleteGroup as deleteGroupRecord,
    unfiledGroupFor
} from "../data/repo-groups.js";
import { t } from "../i18n/i18n.js";

/** Every group on the device, in the reader's order. */
export async function list() {
    return listGroups();
}

export { getGroup };

/**
 * Create a group. `name` is validated here rather than in the repository so the
 * form gets a per-field result and the API gets the same rule.
 *
 * NO GOAL ARGUMENT. This used to take one and every caller passed `goalId`, and the
 * only thing it did with it was to decide which goal the new shelf belonged to — a
 * decision that no longer exists. A group created from the questions page is in no
 * goal until the reader attaches it, and that is the state a question organiser
 * expects: a new folder is a folder, not a subfolder of whatever page you made it
 * from.
 */
export async function create(draft) {
    const existing = await listGroups();
    const result = validateGroup(draft, existing.map((g) => g.name));
    if (!result.ok) return { ok: false, errors: result.errors };
    const group = await createGroupRecord({ name: result.values.name, category: result.values.category });
    return { ok: true, group };
}

export async function rename(id, draft) {
    const group = await getGroup(id);
    const siblings = await listGroups();
    // The group's own name is not a clash with itself, or renaming "Verbs" to
    // "Verbs" would be refused for being a duplicate of "Verbs".
    const result = validateGroup(draft, siblings.filter((g) => g.id !== id).map((g) => g.name));
    if (!result.ok) return { ok: false, errors: result.errors };
    return { ok: true, group: await renameGroupRecord(id, result.values.name) };
}

/**
 * Remove a group. Its questions go to the unfiled group, so they can still be put
 * into a session and still be found.
 *
 * THE UNFILED GROUP IS CREATED IF IT IS NOT THERE. A device whose only group is being
 * deleted needs somewhere for its questions to land, and the alternative — leaving
 * them with a `groupId` pointing at a tombstone — is a question the builder cannot
 * offer and the list cannot name.
 *
 * The group's references are tombstoned by the repository in the same transaction.
 * That is new and it is load-bearing: a group is shared now, so this function can be
 * called on a shelf that three goals draw from, and each of them would otherwise be
 * left pointing at something that no longer exists — a material list that quietly lost
 * a shelf, with nothing on screen saying so.
 */
export async function remove(id) {
    const unfiled = await unfiledGroupFor(t("group.unfiled"));
    await deleteGroupRecord(id, { unfiledId: unfiled.id });
    return unfiled;
}

/**
 * The group a question goes into when the reader has not chosen one.
 *
 * Created on demand, and named in the reader's own language — `t()` is called HERE,
 * in the service, rather than in the repository, because the name is a word the reader
 * sees on a chip and repositories.js is data.
 *
 * ONE OF THEM PER DEVICE, not one per goal, which is what a shelf with no owner means.
 * Two unfiled groups would split the questions between them and either would look
 * empty, and "not filed" is one concept rather than one per subject.
 */
export async function unfiled() {
    return unfiledGroupFor(t("group.unfiled"));
}
