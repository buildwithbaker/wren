// @vitest-environment jsdom
//
// Keyed reconciliation in the sidebar list (src/ui/card-reconciler.js, used by
// notes-list.js render()). A post-save setNotes() must reuse every unchanged
// card element and rebuild only the card that changed, while producing exactly
// the DOM a from-scratch render would. Perf numbers live in docs/internal/perf.md.
import { describe, it, expect, beforeEach } from 'vitest';
import { createNotesList } from '../src/ui/notes-list.js';
import { cardSignature } from '../src/ui/card-reconciler.js';
import { SORT_OPTIONS, sortNotes } from '../src/ui/note-sort.js';

function note(i, over = {}) {
  const n = String(i).padStart(3, '0');
  return {
    id: `note-${n}.md`,
    title: `Title ${n}`,
    firstLine: `Preview text ${n}`,
    color: 'default',
    tags: [],
    due: '',
    hideDue: false,
    hideTags: false,
    created: `2026-01-${String((i % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
    modified: `2026-02-${String((i % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
    createdBy: '',
    lastEditedBy: '',
    ...over,
  };
}

const NOTES = () => Array.from({ length: 12 }, (_, i) => note(i));

function setup(notes = NOTES()) {
  const list = createNotesList({});
  document.body.replaceChildren(list.element);
  list.setNotes(notes);
  return list;
}
const scrollOf = (list) => list.element.querySelector('.sc-list-scroll');
const cardsOf = (list) => [...scrollOf(list).querySelectorAll('.sc-card')];
const idsOf = (list) => cardsOf(list).map((c) => c.dataset.id);
const cardFor = (list, id) => cardsOf(list).find((c) => c.dataset.id === id);

// What a from-scratch render of the same state would produce (the oracle).
function freshHtml(notes, { activeId = null } = {}) {
  const ref = createNotesList({});
  document.body.appendChild(ref.element);
  ref.setNotes(notes);
  if (activeId) ref.setActive(activeId);
  const html = scrollOf(ref).innerHTML;
  ref.element.remove();
  return html;
}

// Mimics handleSave: same objects mutated in place, re-sorted by modified, then
// setNotes(notes).
function save(list, notes, id, patch) {
  const target = notes.find((n) => n.id === id);
  Object.assign(target, patch, { modified: '2026-03-01T12:00:00.000Z' });
  notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  list.setNotes(notes);
}

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

describe('notes-list keyed reconcile', () => {
  it('keeps every other card as the SAME element after one note is edited', () => {
    const notes = NOTES();
    const list = setup(notes);
    const before = new Map(cardsOf(list).map((c) => [c.dataset.id, c]));

    save(list, notes, 'note-005.md', { title: 'Edited five' });

    for (const c of cardsOf(list)) {
      if (c.dataset.id === 'note-005.md') {
        expect(c).not.toBe(before.get('note-005.md')); // the edited card is rebuilt
      } else {
        expect(c).toBe(before.get(c.dataset.id)); // everything else is untouched
      }
    }
    expect(cardsOf(list)).toHaveLength(12);
  });

  it('does not touch the DOM at all when setNotes is called with nothing changed', () => {
    const notes = NOTES();
    const list = setup(notes);
    const before = cardsOf(list);
    const mutations = [];
    const mo = new MutationObserver((r) => mutations.push(...r));
    mo.observe(scrollOf(list), { childList: true, subtree: true, attributes: true, characterData: true });
    list.setNotes(notes);
    expect(mo.takeRecords()).toHaveLength(0);
    expect(cardsOf(list)).toEqual(before);
  });

  it('shows the edited note\'s new title, preview, color, tags and due on its card', () => {
    const notes = NOTES();
    const list = setup(notes);
    save(list, notes, 'note-003.md', {
      title: 'Brand new title',
      firstLine: 'Brand new preview',
      color: 'amber',
      tags: ['project:wren', 'status:doing'],
      due: '2030-01-15',
    });
    const card = cardFor(list, 'note-003.md');
    expect(card.querySelector('.sc-card-title').textContent).toBe('Brand new title');
    expect(card.querySelector('.sc-card-preview').textContent).toBe('Brand new preview');
    expect(card.style.background).toContain('--wr-note-amber');
    expect(card.querySelector('.sc-mtags').textContent).toContain('wren');
    expect(card.querySelector('.sc-due-chip')).not.toBeNull();
  });

  it('updates the card when a tag, the due date or the hide flags change', () => {
    const notes = NOTES();
    const list = setup(notes);
    save(list, notes, 'note-001.md', { tags: ['a:b'], due: '2030-02-02' });
    expect(cardFor(list, 'note-001.md').querySelector('.sc-mtags')).not.toBeNull();
    save(list, notes, 'note-001.md', { hideTags: true, hideDue: true });
    const card = cardFor(list, 'note-001.md');
    expect(card.querySelector('.sc-mtags')).toBeNull();
    expect(card.querySelector('.sc-due-chip')).toBeNull();
    save(list, notes, 'note-001.md', { lastEditedBy: 'ai' });
    expect(cardFor(list, 'note-001.md').querySelector('.sc-ai-badge')).not.toBeNull();
  });

  describe.each(SORT_OPTIONS.map((o) => o.value))('order after an edit, sort = %s', (sortBy) => {
    it('matches the sorted order and a from-scratch render', () => {
      localStorage.setItem('wren.sortBy', sortBy);
      const notes = NOTES();
      notes[2].due = '2030-05-05';
      notes[7].due = '2029-01-01';
      const list = setup(notes);
      const sorted0 = sortNotes(notes, sortBy).map((n) => n.id);
      expect(idsOf(list)).toEqual(sorted0);

      // An edit that changes title, due and modified, so every sort key can move.
      save(list, notes, 'note-009.md', { title: 'AAA first alphabetically', due: '2028-12-12' });
      expect(idsOf(list)).toEqual(sortNotes(notes, sortBy).map((n) => n.id));
      expect(scrollOf(list).innerHTML).toBe(freshHtml(notes));

      // And a second edit that moves a different note.
      save(list, notes, 'note-000.md', { title: 'ZZZ last alphabetically', due: '' });
      expect(idsOf(list)).toEqual(sortNotes(notes, sortBy).map((n) => n.id));
      expect(scrollOf(list).innerHTML).toBe(freshHtml(notes));
    });
  });

  it('search: a note edited so it stops matching leaves the list, and one edited to match joins', () => {
    const notes = NOTES();
    const list = setup(notes);
    const input = list.element.querySelector('.sc-search-input');
    input.value = 'title 00';
    input.dispatchEvent(new Event('input'));
    const initial = idsOf(list);
    expect(initial).toContain('note-003.md');
    expect(initial).not.toContain('note-010.md');

    save(list, notes, 'note-003.md', { title: 'Gone', firstLine: 'nothing relevant' });
    expect(idsOf(list)).not.toContain('note-003.md');

    save(list, notes, 'note-010.md', { title: 'Now title 00 something' });
    expect(idsOf(list)).toContain('note-010.md');
    expect(scrollOf(list).innerHTML).toBe(freshHtml(notes.filter((n) => /title 00/i.test(n.title + n.firstLine))));
  });

  it('tag filter: a note edited so it stops matching leaves, and one edited to match joins', () => {
    localStorage.setItem('wren.filterTags', JSON.stringify(['status:doing']));
    const notes = NOTES();
    notes[1].tags = ['status:doing'];
    notes[4].tags = ['status:doing'];
    const list = setup(notes);
    expect(idsOf(list).sort()).toEqual(['note-001.md', 'note-004.md']);

    save(list, notes, 'note-001.md', { tags: ['status:done'] });
    expect(idsOf(list)).toEqual(['note-004.md']);

    save(list, notes, 'note-008.md', { tags: ['status:doing'] });
    expect(idsOf(list).sort()).toEqual(['note-004.md', 'note-008.md']);
  });

  it('shows the empty-state message when nothing matches, then restores the cards', () => {
    const notes = NOTES();
    const list = setup(notes);
    const input = list.element.querySelector('.sc-search-input');
    input.value = 'zzz-no-such-note';
    input.dispatchEvent(new Event('input'));
    expect(cardsOf(list)).toHaveLength(0);
    expect(scrollOf(list).textContent).toContain('Nothing matches "zzz-no-such-note"');

    // A save while the list is empty must not resurrect stale cards.
    save(list, notes, 'note-002.md', { title: 'Edited while filtered out' });
    expect(cardsOf(list)).toHaveLength(0);

    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(cardsOf(list)).toHaveLength(12);
    expect(scrollOf(list).querySelector('.sc-list-empty')).toBeNull();
  });

  it('shows the no-tag-match empty state with a working Clear filter button', () => {
    localStorage.setItem('wren.filterTags', JSON.stringify(['no:such']));
    const list = setup();
    expect(scrollOf(list).textContent).toContain('No notes match the selected tags.');
    scrollOf(list).querySelector('.sc-btn').click();
    expect(cardsOf(list)).toHaveLength(12);
  });

  it('shows "No notes yet" for an empty collection and recovers when notes arrive', () => {
    const list = setup([]);
    expect(scrollOf(list).textContent).toContain('No notes yet');
    list.setNotes(NOTES());
    expect(cardsOf(list)).toHaveLength(12);
    expect(scrollOf(list).querySelector('.sc-list-empty')).toBeNull();
  });

  it('keeps the active highlight across a re-render and moves it on switch', () => {
    const notes = NOTES();
    const list = setup(notes);
    list.setActive('note-004.md');
    expect(cardFor(list, 'note-004.md').classList.contains('is-active')).toBe(true);

    save(list, notes, 'note-004.md', { title: 'Active note edited' }); // rebuilt card
    expect(cardFor(list, 'note-004.md').classList.contains('is-active')).toBe(true);
    save(list, notes, 'note-006.md', { title: 'Other note edited' }); // reused active card
    expect(cardFor(list, 'note-004.md').classList.contains('is-active')).toBe(true);

    list.setActive('note-006.md');
    expect(list.element.querySelectorAll('.sc-card.is-active')).toHaveLength(1);
    expect(cardFor(list, 'note-006.md').classList.contains('is-active')).toBe(true);
    expect(cardFor(list, 'note-004.md').classList.contains('is-active')).toBe(false);
  });

  it('create: the new note appears at the top and no other card is rebuilt', () => {
    const notes = NOTES();
    const list = setup(notes);
    const before = new Map(cardsOf(list).map((c) => [c.dataset.id, c]));
    const fresh = note(99, { title: 'Brand new note', modified: '2026-04-01T00:00:00.000Z' });
    notes.unshift(fresh);
    list.setNotes(notes);
    expect(idsOf(list)[0]).toBe('note-099.md');
    expect(cardsOf(list)).toHaveLength(13);
    for (const [id, el] of before) expect(cardFor(list, id)).toBe(el);
  });

  it('delete then Undo: the card goes away and comes back in its sorted place', () => {
    const notes = NOTES();
    const list = setup(notes);
    const orderBefore = idsOf(list);
    const victim = notes.find((n) => n.id === 'note-005.md');

    list.setNotes(notes.filter((n) => n.id !== victim.id));
    expect(idsOf(list)).not.toContain('note-005.md');
    expect(cardsOf(list)).toHaveLength(11);

    list.setNotes(notes); // restored from .trash by Undo
    expect(idsOf(list)).toEqual(orderBefore);
    expect(scrollOf(list).innerHTML).toBe(freshHtml(notes));
  });

  it('rename-on-title-change: the id change replaces the card and moves the active highlight', () => {
    const notes = NOTES();
    const list = setup(notes);
    list.setActive('note-002.md');
    const oldCard = cardFor(list, 'note-002.md');

    // FS identity: renaming changes note.id (handleSave -> syncBackendFilename).
    const target = notes.find((n) => n.id === 'note-002.md');
    target.id = '2026-01-03 - Renamed title.md';
    target.title = 'Renamed title';
    target.modified = '2026-03-01T12:00:00.000Z';
    notes.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    list.setNotes(notes);
    list.setActive(target.id);

    expect(cardFor(list, 'note-002.md')).toBeUndefined();
    expect(oldCard.isConnected).toBe(false);
    const renamed = cardFor(list, target.id);
    expect(renamed.classList.contains('is-active')).toBe(true);
    expect(renamed.querySelector('.sc-card-title').textContent).toBe('Renamed title');
    expect(cardsOf(list)).toHaveLength(12);
  });

  it('opens the right note from a reused card after other notes changed', () => {
    const picked = [];
    const list = createNotesList({ onSelect: (id) => picked.push(id) });
    document.body.replaceChildren(list.element);
    const notes = NOTES();
    list.setNotes(notes);
    save(list, notes, 'note-001.md', { title: 'x' });
    cardFor(list, 'note-008.md').querySelector('.sc-card-open').click();
    cardFor(list, 'note-001.md').querySelector('.sc-card-open').click();
    expect(picked).toEqual(['note-008.md', 'note-001.md']);
  });

  it('matches a from-scratch render after a burst of mixed mutations', () => {
    const notes = NOTES();
    const list = setup(notes);
    list.setActive('note-007.md');
    save(list, notes, 'note-007.md', { title: 'a', tags: ['x:y'], color: 'rose' });
    save(list, notes, 'note-002.md', { due: '2031-03-03', firstLine: 'changed preview' });
    notes.splice(
      notes.findIndex((n) => n.id === 'note-010.md'),
      1
    );
    list.setNotes(notes);
    notes.push(note(50, { modified: '2025-01-01T00:00:00.000Z' }));
    list.setNotes(notes);
    save(list, notes, 'note-011.md', { hideTags: true, tags: ['q:r'] });
    expect(scrollOf(list).innerHTML).toBe(freshHtml(notes, { activeId: 'note-007.md' }));
  });
});

describe('cardSignature', () => {
  it('changes when any displayed field changes, and not otherwise', () => {
    const base = note(1);
    const sig = cardSignature(base, 'Fri Oct 23 2026');
    expect(cardSignature({ ...base }, 'Fri Oct 23 2026')).toBe(sig);
    for (const patch of [
      { title: 'x' },
      { firstLine: 'x' },
      { color: 'rose' },
      { tags: ['a:b'] },
      { due: '2030-01-01' },
      { hideDue: true },
      { hideTags: true },
      { modified: '2030-01-01T00:00:00.000Z' },
      { createdBy: 'ai' },
      { lastEditedBy: 'ai' },
    ]) {
      expect(cardSignature({ ...base, ...patch }, 'Fri Oct 23 2026')).not.toBe(sig);
    }
  });

  it('changes at midnight (Yesterday label and due-chip status depend on today)', () => {
    const n = note(1, { due: '2026-10-23' });
    expect(cardSignature(n, 'Fri Oct 23 2026')).not.toBe(cardSignature(n, 'Sat Oct 24 2026'));
  });
});
