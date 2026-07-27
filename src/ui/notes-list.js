// notes-list.js
// Sidebar list: tag filter + search field + New Note button + scrollable cards.
// Returns { element, setNotes, setActive, focusSearch, getQuery }.

import { CARD_COLORS, toPreviewText } from '@/notes-store.js';
import { getAllTags } from '@/tags/tag-parser.js';
import { buildTagChips } from './tag-chips.js';
import { formatModified } from './format.js';
import { noteMatchesQuery } from './note-search.js';
import { isAiNote, buildAiBadge } from './ai-badge.js';
import { buildDueChip } from './due-chip.js';
import { SORT_OPTIONS, loadSortBy, saveSortBy, sortNotes } from './note-sort.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));
const FILTER_KEY = 'wren.filterTags';

export function createNotesList({
  onSelect,
  onNew,
  onPopOut,
  onArchive,
  onArchiveOpen,
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
  let sortBy = loadSortBy(); // wren.sortBy — applied after tag-filter + search

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

  // Archive entry (Note Lifecycle B3): opens the Archive view. Hidden until at
  // least one note is archived (set via setArchiveCount); shows a count badge.
  const archiveBtn = document.createElement('button');
  archiveBtn.type = 'button';
  archiveBtn.className = 'sc-archive-entry';
  archiveBtn.title = 'View archived notes';
  archiveBtn.setAttribute('aria-label', 'View archived notes');
  archiveBtn.hidden = true;
  const archiveCountEl = document.createElement('span');
  archiveCountEl.className = 'sc-archive-entry-count';
  archiveBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg><span>Archive</span>';
  archiveBtn.appendChild(archiveCountEl);
  archiveBtn.addEventListener('click', () => onArchiveOpen?.());
  if (onArchiveOpen) header.appendChild(archiveBtn);

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

  // Sort control — sits beside the tag filter, styled to match. Options are
  // static so it's built once (not rebuilt per render). Always visible (sorting
  // applies even with no tags). The chosen order also drives the Compact view,
  // which reads the same `wren.sortBy` key.
  const sortEl = document.createElement('div');
  sortEl.className = 'sc-sortby';
  const sortSelect = document.createElement('select');
  sortSelect.className = 'sc-tagfilter-dropdown sc-sortby-dropdown';
  sortSelect.setAttribute('aria-label', 'Sort notes by');
  for (const opt of SORT_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    sortSelect.appendChild(o);
  }
  sortSelect.value = sortBy;
  sortSelect.addEventListener('change', () => {
    sortBy = sortSelect.value;
    saveSortBy(sortBy);
    render();
  });
  sortEl.appendChild(sortSelect);

  // Scroll area
  const scroll = document.createElement('div');
  scroll.className = 'sc-list-scroll';

  root.append(header, inboxEl, tagFilterEl, sortEl, searchWrap, scroll);

  function matches(note) {
    // Tag AND-filter: note must contain every selected filter tag.
    if (filterTags.length > 0) {
      const noteTags = note.tags || [];
      for (const ft of filterTags) {
        if (!noteTags.includes(ft)) return false;
      }
    }
    // Text query against title + preview (shared predicate, reused by the
    // compact view so both stay in lockstep).
    return noteMatchesQuery(note, query);
  }

  function render() {
    renderInbox();
    renderFilter();
    scroll.replaceChildren();
    // Sort applied AFTER tag-filter + search so the visible set is ordered;
    // both List and Compact use sortNotes() for a consistent order.
    const filtered = sortNotes(notes.filter(matches), sortBy);

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
    preview.textContent = toPreviewText(note.summary || note.firstLine) || 'No additional text';

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

  // Audit U14: the card used to be a <button> with a clickable tag-chip row and
  // two role=button spans inside it. Interactive content nested in a button is
  // invalid HTML and behaves erratically in screen readers (the inner controls
  // are often unreachable, and the outer button's accessible name swallows
  // them). The card is now a plain container; the open action is one real
  // <button> and every secondary action is a real <button> sibling.
  function renderCard(note) {
    const card = document.createElement('div');
    card.className = 'sc-card';
    const safeId = COLOR_BG[note.color] ? note.color : 'default';
    card.style.background = `var(--wr-note-${safeId})`;
    card.dataset.id = note.id;
    if (note.id === activeId) card.classList.add('is-active');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'sc-card-open';
    openBtn.setAttribute('aria-label', `Open note: ${note.title || 'Untitled'}`);

    const title = document.createElement('span');
    title.className = 'sc-card-title';
    // Subtle AI badge before the title when the note is AI-created/edited.
    if (isAiNote(note)) title.appendChild(buildAiBadge());
    title.append(note.title || 'Untitled');

    const preview = document.createElement('span');
    preview.className = 'sc-card-preview';
    preview.textContent = toPreviewText(note.firstLine) || 'No additional text';

    const meta = document.createElement('span');
    meta.className = 'sc-card-meta';
    meta.textContent = formatModified(note.modified);

    openBtn.append(title, preview);
    openBtn.addEventListener('click', () => onSelect?.(note.id));
    card.appendChild(openBtn);

    // Due-date chip (Note Lifecycle A2) — null when no due date or hidden per-note.
    const dueChip = note.hideDue ? null : buildDueChip(note.due);
    if (dueChip) card.appendChild(dueChip);
    // Tag chips (Sticky Float Phase 1): visible per-note tag feedback. Chip
    // click adds the tag to the AND-filter instead of opening the note. Now a
    // sibling of the open button, so the chips are real buttons rather than
    // role=button spans smuggled inside one.
    const chips = note.hideTags
      ? null
      : buildTagChips(note.tags, { onTagClick: (tag) => addFilterTag(tag) });
    if (chips) card.appendChild(chips);
    card.appendChild(meta);

    // Archive affordance (Note Lifecycle B2): a hover icon in the card's
    // top-right cluster. Real <button> now that it is not inside one.
    if (onArchive) {
      const arch = document.createElement('button');
      arch.type = 'button';
      arch.className = 'sc-card-archive';
      arch.title = 'Archive note';
      arch.setAttribute('aria-label', `Archive note: ${note.title || 'Untitled'}`);
      arch.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
      arch.addEventListener('click', (e) => {
        e.stopPropagation();
        onArchive(note.id);
      });
      card.appendChild(arch);
    }

    // Pop-out affordance (Sticky Float Phase 2): a small icon shown on hover.
    if (onPopOut) {
      const pop = document.createElement('button');
      pop.type = 'button';
      pop.className = 'sc-card-popout';
      pop.title = 'Pop out into its own window';
      pop.setAttribute('aria-label', `Pop out note into its own window: ${note.title || 'Untitled'}`);
      pop.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 4l-8 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      pop.addEventListener('click', (e) => {
        e.stopPropagation();
        onPopOut(note.id);
      });
      card.appendChild(pop);
    }

    // Mouse convenience: a click on the card's dead space still opens the note.
    // Clicks on any of the buttons above are theirs alone.
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      onSelect?.(note.id);
    });
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
    setArchiveCount(n) {
      const count = Number(n) || 0;
      archiveBtn.hidden = count === 0;
      archiveCountEl.textContent = count > 0 ? String(count) : '';
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
