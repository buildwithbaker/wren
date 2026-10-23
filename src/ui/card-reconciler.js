// card-reconciler.js
// Keyed DOM reconciliation for the note-card stacks (sidebar list + compact
// view). A save used to rebuild every card (~1,500 nodes at 500 notes) and the
// browser then paid for style + layout of all of them. This keeps one element
// per note id and only rebuilds a card whose displayed fields changed, so a
// post-save update touches one card and moves at most the nodes whose order
// changed. Internal helper: the lists' public setNotes() contract is untouched.

/**
 * Everything a card DISPLAYS, flattened to one string. A card is rebuilt only
 * when this changes. The active highlight is deliberately NOT part of it (it is
 * toggled in place). `day` is folded in because the "Yesterday" label and the
 * due chip's overdue/today status depend on today's date.
 *
 * @param {object} note
 * @param {string} day - today's date key, e.g. new Date().toDateString()
 * @returns {string}
 */
export function cardSignature(note, day) {
  return [
    note.id,
    note.title || '',
    note.firstLine || '',
    note.color || '',
    (note.tags || []).join('\u0001'),
    note.due || '',
    note.hideDue ? 1 : 0,
    note.hideTags ? 1 : 0,
    note.modified || '',
    note.createdBy || '',
    note.lastEditedBy || '',
    day,
  ].join('\u0000');
}

/**
 * @param {HTMLElement} container - the scroll area that holds the cards
 * @param {{ build: (note:object) => HTMLElement }} deps
 */
export function createCardReconciler(container, { build }) {
  /** @type {Map<string, {el: HTMLElement, sig: string}>} */
  let cache = new Map();

  return {
    /**
     * Make `container` hold exactly one card per note, in order. Unchanged
     * cards are reused as-is (same element), changed ones are rebuilt, removed
     * ones dropped, new ones created. Nodes are moved only where the order
     * differs from what is already in the DOM.
     *
     * @param {object[]} notes - the visible notes, already filtered + sorted
     * @param {(el: HTMLElement, note: object) => void} [decorate] - applied to
     *   every card (reused or new) each pass, e.g. to sync the active highlight
     */
    sync(notes, decorate) {
      const day = new Date().toDateString();
      const next = new Map();
      const ordered = [];
      for (const note of notes) {
        const sig = cardSignature(note, day);
        const hit = cache.get(note.id);
        const entry = hit && hit.sig === sig ? hit : { el: build(note), sig };
        next.set(note.id, entry);
        ordered.push(entry.el);
        decorate?.(entry.el, note);
      }
      cache = next;

      // Drop anything that is not a current card (removed notes, empty state).
      const keep = new Set(ordered);
      for (const child of Array.from(container.children)) {
        if (!keep.has(child)) child.remove();
      }
      // Walk both orders together; only touch nodes that are out of place.
      let cur = container.firstElementChild;
      for (const el of ordered) {
        if (el === cur) {
          cur = cur.nextElementSibling;
        } else {
          container.insertBefore(el, cur);
        }
      }
    },

    /** Forget every card and empty the container (empty / no-match states). */
    clear() {
      cache = new Map();
      container.replaceChildren();
    },
  };
}
