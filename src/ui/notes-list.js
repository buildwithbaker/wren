// notes-list.js
// Sidebar list: tag filter + search field + New Note button + scrollable cards.
// Returns { element, setNotes, setActive, focusSearch, getQuery }.

import { CARD_COLORS } from '@/notes-store.js';
import { getAllTags } from '@/tags/tag-parser.js';
import { formatModified } from './format.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));
const FILTER_KEY = 'wren.filterTags';

export function createNotesList({
  onSelect,
  onNew,
  compact = false,
  onInboxSelect,
  onInboxPromote,
  onInboxDiscard,
} = {}) {
  let notes = [];
  let inboxNotes = []; // staged _inbox/ notes (AI phase 4), kept separate
  let activeId = null;
  let query = '';
  let filterTags = loadFilterTags(); // AND-filter: note must have all of these

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

  // Inbox section (AI phase 4) — staged notes from `_inbox/`. Hidden unless at
  // least one staged note exists. Rebuilt by renderInbox().
  const inboxEl = document.createElement('div');
  inboxEl.className = 'sc-inbox';
  inboxEl.hidden = true;

  // Tag filter (Phase B) — rendered above the search bar. Contents are rebuilt
  // by renderFilter() since available tags depend on the current notes set.
  const tagFilterEl = document.createElement('div');
  tagFilterEl.className = 'sc-tagfilter';

  // Scroll area
  const scroll = document.createElement('div');
  scroll.className = 'sc-list-scroll';

  root.append(header, inboxEl, tagFilterEl, searchWrap, scroll);

  function matches(note) {
    // Tag AND-filter: note must contain every selected filter tag.
    if (filterTags.length > 0) {
      const noteTags = note.tags || [];
      for (const ft of filterTags) {
        if (!noteTags.includes(ft)) return false;
      }
    }
    // Text query against title + preview.
    if (query) {
      const title = (note.title || '').toLowerCase();
      const preview = (note.firstLine || '').toLowerCase();
      if (!title.includes(query) && !preview.includes(query)) return false;
    }
    return true;
  }

  function render() {
    renderInbox();
    renderFilter();
    scroll.replaceChildren();
    const filtered = notes.filter(matches);

    if (notes.length === 0) {
      scroll.appendChild(emptyState('No notes yet', 'Create your first note to get started.'));
      return;
    }
    if (filtered.length === 0) {
      if (filterTags.length > 0) {
        scroll.appendChild(filterEmptyState());
      } else {
        scroll.appendChild(emptyState('No matches', `Nothing matches "${search.value.trim()}".`));
      }
      return;
    }

    for (const note of filtered) {
      scroll.appendChild(renderCard(note));
    }
  }

  // ---- Inbox (_inbox/) — AI write-back staging (phase 4) --------------------

  function renderInbox() {
    if (!inboxNotes || inboxNotes.length === 0) {
      inboxEl.hidden = true;
      inboxEl.replaceChildren();
      return;
    }
    inboxEl.hidden = false;
    inboxEl.replaceChildren();

    const head = document.createElement('div');
    head.className = 'sc-inbox-head';
    const label = document.createElement('span');
    label.className = 'sc-inbox-label';
    label.textContent = 'Inbox';
    const badge = document.createElement('span');
    badge.className = 'sc-inbox-badge';
    badge.textContent = String(inboxNotes.length);
    head.append(label, badge);
    inboxEl.appendChild(head);

    const hint = document.createElement('p');
    hint.className = 'sc-inbox-hint';
    hint.textContent = 'AI-captured, pending your review.';
    inboxEl.appendChild(hint);

    for (const note of inboxNotes) {
      inboxEl.appendChild(renderInboxCard(note));
    }
  }

  function renderInboxCard(note) {
    const card = document.createElement('div');
    card.className = 'sc-inbox-card';
    if (note.id === activeId) card.classList.add('is-active');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'sc-inbox-open';
    open.dataset.id = note.id;

    const titleRow = document.createElement('div');
    titleRow.className = 'sc-inbox-card-titlerow';
    const title = document.createElement('span');
    title.className = 'sc-inbox-card-title';
    title.textContent = note.title || 'Untitled';
    const chip = document.createElement('span');
    chip.className = 'sc-inbox-chip';
    chip.textContent = 'AI';
    titleRow.append(chip, title);

    const preview = document.createElement('div');
    preview.className = 'sc-inbox-card-preview';
    preview.textContent = note.summary || note.firstLine || 'No additional text';

    open.append(titleRow, preview);
    open.addEventListener('click', () => onInboxSelect?.(note.id));

    const actions = document.createElement('div');
    actions.className = 'sc-inbox-actions';
    const promote = document.createElement('button');
    promote.type = 'button';
    promote.className = 'sc-btn sc-btn--primary sc-inbox-btn';
    promote.textContent = 'Move to Notes';
    promote.addEventListener('click', () => onInboxPromote?.(note.id));
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'sc-btn sc-btn--ghost sc-inbox-btn';
    discard.textContent = 'Discard';
    discard.addEventListener('click', () => onInboxDiscard?.(note.id));
    actions.append(promote, discard);

    card.append(open, actions);
    return card;
  }

  // ---- Tag filter -----------------------------------------------------------

  function loadFilterTags() {
    try {
      const raw = localStorage.getItem(FILTER_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : [];
    } catch {
      return [];
    }
  }

  function saveFilterTags() {
    try {
      if (filterTags.length === 0) localStorage.removeItem(FILTER_KEY);
      else localStorage.setItem(FILTER_KEY, JSON.stringify(filterTags));
    } catch {
      /* ignore quota / disabled storage */
    }
  }

  function addFilterTag(tag) {
    if (!filterTags.includes(tag)) {
      filterTags.push(tag);
      saveFilterTags();
      render();
    }
  }

  function removeFilterTag(tag) {
    filterTags = filterTags.filter((t) => t !== tag);
    saveFilterTags();
    render();
  }

  function renderFilter() {
    const allTags = getAllTags(notes);
    const available = allTags.filter((t) => !filterTags.includes(t));

    // Hide the affordance entirely when there are no tags anywhere AND nothing
    // is selected — keeps the sidebar clean for users who don't tag.
    if (allTags.length === 0 && filterTags.length === 0) {
      tagFilterEl.hidden = true;
      tagFilterEl.replaceChildren();
      return;
    }
    tagFilterEl.hidden = false;
    tagFilterEl.replaceChildren();

    // Selected-tag chips with click-to-remove.
    if (filterTags.length > 0) {
      const chips = document.createElement('div');
      chips.className = 'sc-tagfilter-chips';
      for (const tag of filterTags) {
        const chip = document.createElement('span');
        chip.className = 'sc-tagfilter-chip';
        const label = document.createElement('span');
        label.textContent = tag;
        const x = document.createElement('button');
        x.type = 'button';
        x.setAttribute('aria-label', `Remove filter ${tag}`);
        x.textContent = '×';
        x.addEventListener('click', () => removeFilterTag(tag));
        chip.append(label, x);
        chips.appendChild(chip);
      }
      tagFilterEl.appendChild(chips);
    }

    // Dropdown to add a filter (only if unselected tags remain).
    if (available.length > 0) {
      const select = document.createElement('select');
      select.className = 'sc-tagfilter-dropdown';
      select.setAttribute('aria-label', 'Filter by tag');
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = filterTags.length > 0 ? '+ Add another tag…' : 'Filter by tag…';
      placeholder.selected = true;
      select.appendChild(placeholder);
      for (const tag of available) {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        if (select.value) addFilterTag(select.value);
      });
      tagFilterEl.appendChild(select);
    }
  }

  function filterEmptyState() {
    const el = document.createElement('div');
    el.className = 'sc-list-empty';
    const h = document.createElement('p');
    h.className = 'sc-list-empty-h';
    h.textContent = 'No notes match the selected tags.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-btn sc-btn--ghost';
    btn.style.marginTop = '8px';
    btn.textContent = 'Clear filter';
    btn.addEventListener('click', () => {
      filterTags = [];
      saveFilterTags();
      render();
    });
    el.append(h, btn);
    return el;
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
    setInboxNotes(next) {
      inboxNotes = next || [];
      renderInbox();
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
