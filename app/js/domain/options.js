// One rule about how options are ordered, in one file with no dependencies.
//
// IT MOVED HERE OUT OF `data/repos.js` because it is not a data-access concern at
// all, and because two things that do not import IndexedDB need it: `domain/session.js`,
// which draws a frozen copy an item carries and cannot ask any store, and the tests,
// which run in node where `repos.js` would drag in the whole database layer to assert
// a sort.
//
// The rule itself is three lines and the reasoning is the part worth keeping:
//
//   * OPTIONS ARE SHOWN IN THE ORDER THEY WERE TYPED. Always. "The third option" has
//     to mean the same thing in the editor, in a session, on the second device and in
//     a report from last Tuesday. There was a version that shuffled them per question
//     on the theory that a fixed layout lets a reader learn the positions instead of
//     the material; it did what it said on two devices at once and it made the
//     numbering on the option row decoration.
//
//   * THE `id` TIE-BREAK IS NOT OPTIONAL. Two options can carry the same `order` —
//     one added by a sync merge from another device whose numbering overlapped — and
//     without a fixed second key those two could swap places between reads. An id is
//     stable across devices, so a sort on it merges the same way everywhere.
//
//   * TOMBSTONES ARE DROPPED, because a deleted option is not an option. A question
//     offering a row with no text and no mark is unanswerable, and it is unanswerable
//     in a way the reader cannot see the cause of.

/** Options in the order they were typed. The ONE place that rule is written. */
export function orderOptions(options) {
    return (options ?? [])
        .filter((o) => o && !o.deletedAt)
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)
            || ((a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0));
}
