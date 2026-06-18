// archive-panel.js
// The Archive view (Note Lifecycle B3): a dialog listing the notes in
// `_archive/` with Open + Unarchive. The list is read from disk by the caller
// (app-controller via adapter.listArchiveNotes) because archived notes are
// outside the indexed roots and never appear in .wren-index.json.

import { formatModified } from './format.js';
import { buildDueChip } from './due-chip.js';

/**
 * @param {{
 *   notes?: Array<Object>,
 *   onOpen?: (id: string) => void,
 *   onUnarchive?: (id: string) => Promise<boolean>|boolean,
 * }} [opts]
 */
export function openArchiveDialog({ notes = [], onOpen, onUnarchive } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'sc-overlay';

  const modal = document.createElement('div');
  modal.className = 'sc-modal sc-archive-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Archived notes');

  const title = document.createElement('h2');
  title.className = 'sc-modal-title';
  title.textContent = `Archived notes${notes.length ? ` (${notes.length})` : ''}`;
  modal.appendChild(title);

  const listEl = document.createElement('div');
  listEl.className = 'sc-archive-list';
  modal.appendChild(listEl);

  const emptyEl = document.createElement('p');
  emptyEl.className = 'sc-help-note';
  emptyEl.textContent = 'No archived notes. Archive a note to tuck it out of the way without deleting it.';

  function renderEmptyIfNeeded() {
    if (!listEl.querySelector('.sc-archive-row')) {
      listEl.replaceChildren(emptyEl);
    }
  }

  if (notes.length === 0) {
    listEl.appendChild(emptyEl);
  } else {
    for (const note of notes) listEl.appendChild(buildRow(note));
  }

  const actions = document.createElement('div');
  actions.className = 'sc-modal-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sc-btn sc-btn--primary';
  close.textContent = 'Done';
  actions.appendChild(close);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  close.focus();

  function cleanup() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') cleanup();
  }
  close.addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKey);

  function buildRow(note) {
    const row = document.createElement('div');
    row.className = 'sc-archive-row';

    const main = document.createElement('div');
    main.className = 'sc-archive-row-main';
    const t = document.createElement('div');
    t.className = 'sc-archive-row-title';
    t.textContent = note.title || 'Untitled';
    const meta = document.createElement('div');
    meta.className = 'sc-archive-row-meta';
    meta.textContent = note.summary || note.firstLine || formatModified(note.modified) || '';
    main.append(t, meta);
    const dueChip = buildDueChip(note.due);
    if (dueChip) main.appendChild(dueChip);

    const btns = document.createElement('div');
    btns.className = 'sc-archive-row-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'sc-btn sc-btn--ghost sc-archive-btn';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => {
      cleanup();
      onOpen?.(note.id);
    });
    const unBtn = document.createElement('button');
    unBtn.type = 'button';
    unBtn.className = 'sc-btn sc-btn--primary sc-archive-btn';
    unBtn.textContent = 'Unarchive';
    unBtn.addEventListener('click', async () => {
      unBtn.disabled = true;
      const ok = onUnarchive ? await onUnarchive(note.id) : false;
      if (ok) {
        row.remove();
        renderEmptyIfNeeded();
      } else {
        unBtn.disabled = false;
      }
    });
    btns.append(openBtn, unBtn);

    row.append(main, btns);
    return row;
  }
}
