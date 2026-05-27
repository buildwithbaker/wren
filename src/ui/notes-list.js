// notes-list.js
// Sidebar list: search field + New Note button + scrollable note cards.
// Returns { element, setNotes, setActive, focusSearch, getQuery }.

import { CARD_COLORS } from '@/notes-store.js';
import { formatModified } from './format.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));

export function createNotesList({ onSelect, onNew, compact = false }) {
  let notes = [];
  let activeId = null;
  let query = '';

  const root = document.createElement('div');
  root.className = 'sc-list' + (compact ? ' sc-list--compact' : '');

  // Header: New Note
  const header = document.createElement('div');
  header.className = 'sc-list-head';
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'sc-newbtn';
  newBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg><span>New Note</span>';
  newBtn.addEventListener('click', () => onNew?.());
  header.appendChild(newBtn);

  // Search
  const searchWrap = document.createElement('div');
  searchWrap.className = 'sc-search';
  searchWrap.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2" stroke-linecap="round"/></svg>';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'sc-search-input';
  search.placeholder = 'Search notes';
  search.setAttribute('aria-label', 'Search notes by title');
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    render();
  });
  searchWrap.appendChild(search);

  // Scroll area
  const scroll = document.createElement('div');
  scroll.className = 'sc-list-scroll';

  root.append(header, searchWrap, scroll);

  function matches(note) {
    if (!query) return true;
    const title = (note.title || '').toLowerCase();
    const preview = (note.firstLine || '').toLowerCase();
    return title.includes(query) || preview.includes(query);
  }

  function render() {
    scroll.replaceChildren();
    const filtered = notes.filter(matches);

    if (notes.length === 0) {
      scroll.appendChild(emptyState('No notes yet', 'Create your first note to get started.'));
      return;
    }
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
    card.className = 'sc-card';
    const safeId = COLOR_BG[note.color] ? note.color : 'default';
    card.style.background = `var(--wr-note-${safeId})`;
    card.dataset.id = note.id;
    if (note.id === activeId) card.classList.add('is-active');

    const title = document.createElement('div');
    title.className = 'sc-card-title';
    title.textContent = note.title || 'Untitled';

    const preview = document.createElement('div');
    preview.className = 'sc-card-preview';
    preview.textContent = note.firstLine || 'No additional text';

    const meta = document.createElement('div');
    meta.className = 'sc-card-meta';
    meta.textContent = formatModified(note.modified);

    card.append(title, preview, meta);
    card.addEventListener('click', () => onSelect?.(note.id));
    return card;
  }

  function emptyState(heading, body) {
    const el = document.createElement('div');
    el.className = 'sc-list-empty';
    const h = document.createElement('p');
    h.className = 'sc-list-empty-h';
    h.textContent = heading;
    const p = document.createElement('p');
    p.className = 'sc-list-empty-b';
    p.textContent = body;
    el.append(h, p);
    return el;
  }

  return {
    element: root,
    setNotes(next) {
      notes = next || [];
      render();
    },
    setActive(id) {
      activeId = id;
      for (const card of scroll.querySelectorAll('.sc-card')) {
        card.classList.toggle('is-active', card.dataset.id === id);
      }
    },
    focusSearch() {
      search.focus();
    },
    getQuery() {
      return query;
    },
  };
}
