// focus-trap.js
//
// Modal focus containment (audit U10/U11). Rather than hand-rolling a Tab cycle
// in every modal, we mark the rest of the page `inert` while the modal is open:
// inert elements can't receive focus, clicks, or AT interaction, so Tab is
// automatically trapped in the one subtree left active (the overlay). Call the
// returned function on close to restore.

/**
 * Make every top-level body child EXCEPT `keepEl` inert. Returns an unlock
 * function that restores exactly the elements this call changed (so nested or
 * stacked modals don't clobber each other's state).
 *
 * @param {Element} keepEl - the overlay to keep interactive.
 * @returns {() => void} unlock
 */
export function lockPageExcept(keepEl) {
  const changed = [];
  for (const el of Array.from(document.body.children)) {
    if (el === keepEl) continue;
    if (el.inert) continue; // already inert (e.g. an outer modal) — leave as-is
    el.inert = true;
    changed.push(el);
  }
  return function unlock() {
    for (const el of changed) el.inert = false;
  };
}

/**
 * True while any modal overlay is mounted. Global keyboard shortcuts check this
 * so they stand down "underneath" a modal (e.g. Ctrl+1/2/3 view switching).
 */
export function isModalOpen() {
  return !!document.querySelector('.sc-overlay');
}
