// compact-view.js
// Compact View — a third view mode that shows every note as a narrow single-
// column stack of mini cards, modeled on the Windows Sticky Notes hub panel.
// It is the default landing layer (session-only; see app-controller's view-mode
// system). Purely presentational: card click opens the full editor, there is no
// inline editing here.
//
// Mirrors the createNotesList contract (build once, push notes via setNotes) so
// app-controller wires it the same way. Reuses the exact sidebar-card fields:
// CARD_COLORS (color strip), formatModified (date), title, firstLine (preview),
// and buildTagChips (tag row).
//
// Decision provenance: project-blueprints/wren/future-enhancements/compact-view-sow.md

import { CARD_COLORS, toPreviewText } from '@/notes-store.js';
import { buildTagChips } from './tag-chips.js';
import { formatModified } from './format.js';
import { noteMatchesQuery } from './note-search.js';
import { loadSortBy, sortNotes } from './note-sort.js';
import { createPinButton } from './pin-button.js';
import { isAiNote, buildAiBadge } from './ai-badge.js';
import { buildDueChip } from './due-chip.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));

/**
 * @param {{
 *   onSelect?: (noteId: string) => void,
 *   onNew?: () => void,
 *   onExpand?: () => void,
 * }} [deps]
 * @returns {{ element: HTMLElement, setNotes: (next: any[]) => void, focusSearch: () => void }}
 */
export function createCompactView({ onSelect, onNew, onExpand } = {}) {
  let notes = [];
  let query = '';

  const root = document.createElement('div');
  root.className = 'sc-compact';

  // Top bar: New note (+) on the left, Expand (return to full app) on the right.
  const bar = document.createElement('div');
  bar.className = 'sc-compact-bar';

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'sc-compact-new';
  newBtn.title = 'New note';
  newBtn.setAttribute('aria-label', 'New note');
  // Icon + label — the bare "+" was too easy to miss in the compact bar.
  newBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg><span>New Note</span>';
  newBtn.addEventListener('click', () => onNew?.());

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'sc-compact-expand';
  expandBtn.title = 'Expand to the full app';
  expandBtn.setAttribute('aria-label', 'Expand to the full app');
  expandBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg><span>Expand</span>';
  expandBtn.addEventListener('click', () => onExpand?.());

  // Always-on-top pin toggle — desktop (Tauri) only; createPinButton returns
  // null in the PWA/extension so nothing renders there. Window-level: applies
  // in both Compact and Expanded views (the Expanded view has its own copy).
  const pin = createPinButton();
  if (pin) {
    // Keep the + on the left; group pin + expand on the right.
    const right = document.createElement('div');
    right.className = 'sc-compact-bar-right';
    right.append(pin.element, expandBtn);
    bar.append(newBtn, right);
  } else {
    bar.append(newBtn, expandBtn);
  }

  // Search
  const searchWrap = document.createElement('div');
  searchWrap.className = 'sc-compact-search';
  searchWrap.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2" stroke-linecap="round"/></svg>';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'sc-compact-search-input';
  search.placeholder = 'Search notes';
  search.setAttribute('aria-label', 'Search notes by title or preview');
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    render();
  });
  searchWrap.appendChild(search);

  // Scroll area (the mini-card stack)
  const scroll = document.createElement('div');
  scroll.className = 'sc-compact-scroll';

  root.append(bar, searchWrap, scroll);

  function render() {
    scroll.replaceChildren();

    if (notes.length === 0) {
      scroll.appendChild(emptyState('No notes yet', 'Create your first note to get started.'));
      return;
    }

    // Same filter + sort pipeline as the List view (reads wren.sortBy) so the
    // two views show notes in a consistent order.
    const filtered = sortNotes(notes.filter((n) => noteMatchesQuery(n, query)), loadSortBy());
    if (filtered.length === 0) {
      scroll.appendChild(emptyState('No matches', `Nothing matches "${search.value.trim()}".`));
      return;
    }

    for (const note of filtered) {
      scroll.appendChild(renderCard(note));
    }
  }

  function renderCard(note) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sc-compact-card';
    const safeId = COLOR_BG[note.color] ? note.color : 'default';
    card.style.setProperty('--sc-strip', `var(--wr-note-${safeId})`);
    card.dataset.id = note.id;

    const head = document.createElement('div');
    head.className = 'sc-compact-card-head';
    const title = document.createElement('div');
    title.className = 'sc-compact-card-title';
    if (isAiNote(note)) title.appendChild(buildAiBadge());
    title.append(note.title || 'Untitled');
    const meta = document.createElement('div');
    meta.className = 'sc-compact-card-meta';
    meta.textContent = formatModified(note.modified);
    head.append(title, meta);

    const preview = document.createElement('div');
    preview.className = 'sc-compact-card-preview';
    preview.textContent = toPreviewText(note.firstLine) || 'No additional text';

    card.append(head, preview);

    // Due-date chip (Note Lifecycle A2) — skipped when hidden per-note.
    const dueChip = note.hideDue ? null : buildDueChip(note.due);
    if (dueChip) card.appendChild(dueChip);

    // Tag chips — read-only here (no filter UI in compact v1). Chip clicks are
    // swallowed by buildTagChips only when onTagClick is passed; without it the
    // chips are inert and the click falls through to open the note. Skipped when
    // the note hides its tags.
    const chips = note.hideTags ? null : buildTagChips(note.tags);
    if (chips) card.appendChild(chips);

    card.addEventListener('click', () => onSelect?.(note.id));
    return card;
  }

  function emptyState(heading, body) {
    const el = document.createElement('div');
    el.className = 'sc-compact-empty';
    const h = document.createElement('p');
    h.className = 'sc-compact-empty-h';
    h.textContent = heading;
    const p = document.createElement('p');
    p.className = 'sc-compact-empty-b';
    p.textContent = body;
    el.append(h, p);
    return el;
  }

  return {
    element: root,
    setNotes(next) {
      notes = next || [];
      // Reflect the current pin state — it may have been toggled from the
      // Expanded view's pin button while this view was hidden.
      pin?.sync();
      render();
    },
    focusSearch() {
      search.focus();
    },
  };
}
