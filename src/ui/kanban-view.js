// kanban-view.js
// Board view: notes grouped into columns by the value of a chosen tag
// namespace. Cards are click-to-open; drag-and-drop (Phase C2) re-tags a note
// by moving it between columns.
//
// Factory returns { element, refresh, destroy }. The host (app-controller)
// owns the notes array and passes it in via getNotes(); the board never
// fetches or mutates storage directly except through the onMoveNote callback.
//
// Decision provenance: project-blueprints/wren/future-enhancements/kanban-view-sow.md (Phase C)

import { CARD_COLORS, firstLineOf } from '@/notes-store.js';
import { getAllNamespaces, groupNotesByNamespace } from '@/tags/tag-parser.js';
import { buildTagChips } from './tag-chips.js';
import { isAiNote, buildAiBadge } from './ai-badge.js';
import { buildDueChip } from './due-chip.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));
const GROUPBY_KEY = 'wren.kanbanGroupBy';

/**
 * @param {{
 *   getNotes: () => Array<Object>,
 *   onNoteOpen: (noteId: string) => void,
 *   onNewNote: () => void,
 *   onMoveNote?: (noteId: string, namespace: string, value: string) => Promise<void>|void,
 * }} opts
 */
export function createKanbanView({ getNotes, onNoteOpen, onNewNote, onMoveNote }) {
  let groupBy = loadGroupBy();

  const root = document.createElement('div');
  root.className = 'sc-kanban';

  const toolbar = document.createElement('div');
  toolbar.className = 'sc-kanban-toolbar';

  const columnsWrap = document.createElement('div');
  columnsWrap.className = 'sc-kanban-columns';

  root.append(toolbar, columnsWrap);

  function loadGroupBy() {
    try {
      return localStorage.getItem(GROUPBY_KEY) || null;
    } catch {
      return null;
    }
  }

  function saveGroupBy() {
    try {
      if (groupBy) localStorage.setItem(GROUPBY_KEY, groupBy);
    } catch {
      /* ignore */
    }
  }

  // Resolve the active namespace: persisted choice if still present in the
  // data, otherwise the alphabetically-first namespace.
  function resolveGroupBy(namespaces) {
    if (groupBy && namespaces.includes(groupBy)) return groupBy;
    return namespaces[0] || null;
  }

  function nsLabel(ns) {
    return ns === '_uncategorized' ? 'uncategorized' : ns;
  }

  function renderToolbar(namespaces, activeNs) {
    toolbar.replaceChildren();

    const label = document.createElement('span');
    label.className = 'sc-kanban-toolbar-label';
    label.textContent = 'Group by:';

    const select = document.createElement('select');
    select.className = 'sc-tagfilter-dropdown';
    select.setAttribute('aria-label', 'Group notes by tag namespace');
    if (namespaces.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = '(no tags yet)';
      select.appendChild(opt);
      select.disabled = true;
    } else {
      for (const ns of namespaces) {
        const opt = document.createElement('option');
        opt.value = ns;
        opt.textContent = nsLabel(ns);
        if (ns === activeNs) opt.selected = true;
        select.appendChild(opt);
      }
    }
    select.addEventListener('change', () => {
      groupBy = select.value;
      saveGroupBy();
      render();
    });

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'sc-btn sc-btn--ghost';
    newBtn.textContent = '+ New Note';
    newBtn.addEventListener('click', () => onNewNote?.());

    toolbar.append(label, select, spacer, newBtn);
  }

  function render() {
    const notes = getNotes() || [];
    const namespaces = getAllNamespaces(notes);
    const activeNs = resolveGroupBy(namespaces);
    groupBy = activeNs; // keep internal state aligned with what's shown

    renderToolbar(namespaces, activeNs);
    columnsWrap.replaceChildren();

    if (!activeNs) {
      const empty = document.createElement('div');
      empty.className = 'sc-kanban-empty';
      empty.textContent =
        'No tags yet. Add a tag like "status:todo" to a note to see it organized into columns here.';
      columnsWrap.appendChild(empty);
      return;
    }

    const groups = groupNotesByNamespace(notes, activeNs);
    // Column order: values alphabetically, with the catch-all _untagged last.
    const keys = Array.from(groups.keys())
      .filter((k) => k !== '_untagged')
      .sort();
    keys.push('_untagged');

    for (const value of keys) {
      const colNotes = groups.get(value) || [];
      // Hide an empty _untagged column to reduce clutter; always show real
      // value columns even when empty so users can drop into them (Phase C2).
      if (value === '_untagged' && colNotes.length === 0) continue;
      columnsWrap.appendChild(renderColumn(value, colNotes, activeNs));
    }
  }

  function renderColumn(value, colNotes, namespace) {
    const col = document.createElement('div');
    col.className = 'sc-kanban-col';
    col.dataset.value = value;
    col.dataset.namespace = namespace;

    const header = document.createElement('div');
    header.className = 'sc-kanban-col-header';
    const title = document.createElement('span');
    title.textContent = value === '_untagged' ? 'Untagged' : value;
    const count = document.createElement('span');
    count.className = 'sc-kanban-col-count';
    count.textContent = String(colNotes.length);
    header.append(title, count);
    col.appendChild(header);

    for (const note of colNotes) {
      col.appendChild(renderCard(note));
    }

    wireColumnDrop(col, namespace, value);
    return col;
  }

  function renderCard(note) {
    const card = document.createElement('div');
    card.className = 'sc-kanban-card';
    const safeColor = COLOR_BG[note.color] ? note.color : 'default';
    card.style.setProperty('--wr-note-bg', `var(--wr-note-${safeColor})`);
    card.dataset.id = note.id;

    const title = document.createElement('div');
    title.className = 'sc-kanban-card-title';
    if (isAiNote(note)) title.appendChild(buildAiBadge());
    title.append(note.title || 'Untitled');

    const preview = document.createElement('div');
    preview.className = 'sc-kanban-card-preview';
    preview.textContent = note.firstLine || firstLineOf(note.body || '') || 'No additional text';

    card.append(title, preview);
    // Due-date chip (Note Lifecycle A2).
    const dueChip = buildDueChip(note.due);
    if (dueChip) card.appendChild(dueChip);
    // Tag chips (Sticky Float Phase 1): display-only on the board — the column
    // already encodes the grouping tag; chips show the note's full tag set.
    const chips = buildTagChips(note.tags);
    if (chips) card.appendChild(chips);
    card.addEventListener('click', () => onNoteOpen?.(note.id));

    wireCardDrag(card, note);
    return card;
  }

  // ---- Drag and drop (Phase C2) --------------------------------------------

  function wireCardDrag(card, note) {
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', note.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('sc-kanban-card--dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('sc-kanban-card--dragging');
    });
  }

  function wireColumnDrop(col, namespace, value) {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('sc-kanban-col--dragover');
    });
    col.addEventListener('dragleave', (e) => {
      // dragleave also fires when moving onto child cards; only clear the
      // highlight when the pointer actually leaves the column subtree.
      if (!col.contains(e.relatedTarget)) {
        col.classList.remove('sc-kanban-col--dragover');
      }
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('sc-kanban-col--dragover');
      const noteId = e.dataTransfer.getData('text/plain');
      if (!noteId || !onMoveNote) return;
      // The host re-tags the note (replace same-namespace; _untagged removes it),
      // persists, updates state, and calls refresh(). It is idempotent when the
      // card is dropped back into its origin column.
      await onMoveNote(noteId, namespace, value);
    });
  }

  return {
    element: root,
    refresh: render,
    destroy() {
      root.replaceChildren();
    },
  };
}
