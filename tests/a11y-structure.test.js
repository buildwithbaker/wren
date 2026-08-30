// @vitest-environment jsdom
//
// Regression (audit U14, U19, 2026-07-25):
//
//  U14 — sidebar note cards were <button> elements containing a clickable
//        tag-chip row and two role="button" spans. Interactive content nested
//        inside a button is invalid HTML and screen readers handle it
//        inconsistently — the inner controls are frequently unreachable, and
//        the outer button's accessible name absorbs their text.
//
//  U19 — the "Skip to content" link pointed at #main-content unconditionally,
//        but Compact (the default landing view) sets .sc-main to display:none.
//        A skip link whose target is not rendered does nothing at all, on the
//        very first Tab press a keyboard user makes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNotesList } from '../src/ui/notes-list.js';

const NOTES = [
  {
    id: 'a.md',
    title: 'Alpha',
    firstLine: 'first line',
    modified: '2026-07-20T10:00:00.000Z',
    tags: ['status:todo', 'area:home'],
    color: 'default',
  },
];

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
});

function mountList(opts = {}) {
  const list = createNotesList({
    onSelect: vi.fn(),
    onPopOut: vi.fn(),
    onArchive: vi.fn(),
    ...opts,
  });
  document.body.appendChild(list.element);
  list.setNotes(NOTES);
  return list;
}

describe('Sidebar card structure (U14)', () => {
  it('the card is a container, not a button', () => {
    mountList();
    const card = document.querySelector('.sc-card');
    expect(card).toBeTruthy();
    expect(card.tagName).toBe('DIV');
  });

  it('opening the note is a real button', () => {
    const onSelect = vi.fn();
    mountList({ onSelect });
    const openBtn = document.querySelector('.sc-card .sc-card-open');
    expect(openBtn.tagName).toBe('BUTTON');
    openBtn.click();
    expect(onSelect).toHaveBeenCalledWith('a.md');
  });

  it('archive, pop-out and tag chips are buttons, and none is nested in another', () => {
    mountList();
    const card = document.querySelector('.sc-card');
    expect(card.querySelector('.sc-card-archive').tagName).toBe('BUTTON');
    expect(card.querySelector('.sc-card-popout').tagName).toBe('BUTTON');
    expect(card.querySelector('.sc-mtag--clickable').tagName).toBe('BUTTON');

    const interactive = card.querySelectorAll('button, [role="button"], a[href], input, select, textarea');
    expect(interactive.length).toBeGreaterThan(3);
    for (const el of interactive) {
      expect(el.parentElement.closest('button, [role="button"]')).toBeNull();
    }
  });

  it('a chip click filters instead of opening the note', () => {
    const onSelect = vi.fn();
    mountList({ onSelect });
    document.querySelector('.sc-mtag--clickable').click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('the secondary actions do not open the note either', () => {
    const onSelect = vi.fn();
    const onArchive = vi.fn();
    mountList({ onSelect, onArchive });
    document.querySelector('.sc-card-archive').click();
    expect(onArchive).toHaveBeenCalledWith('a.md');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('Skip link target follows the visible container (U19)', () => {
  it('lands on Compact and points the skip link at the Compact container', async () => {
    // Uses the shared app harness (tests/helpers/mount-app.js) rather than a
    // local set of module mocks — it boots the real controller against a fake
    // StorageAdapter, which is the only way the Compact landing view renders in
    // a headless DOM.
    const { mountApp } = await import('./helpers/mount-app.js');
    const app = await mountApp({ notes: [] });

    // Default landing view is Compact — the exact state the old skip link broke in.
    expect(app.app.dataset.view).toBe('compact');

    const skip = document.querySelector('.sc-skip-link');
    expect(skip.getAttribute('href')).toBe('#compact-content');

    const target = document.getElementById('compact-content');
    expect(target).toBeTruthy();
    expect(target.style.display).not.toBe('none');
    // #main-content is the container Compact hides — the old dead target.
    // An anchor only MOVES FOCUS to a target that can hold it, so both carry
    // tabindex="-1".
    expect(target.getAttribute('tabindex')).toBe('-1');
    expect(document.querySelector('#main-content').getAttribute('tabindex')).toBe('-1');
  });

  it('follows the switch out of Compact back to #main-content', async () => {
    const { mountApp } = await import('./helpers/mount-app.js');
    const app = await mountApp({ notes: [] });
    expect(document.querySelector('.sc-skip-link').getAttribute('href')).toBe('#compact-content');

    app.setView('list');

    const retargeted = await app.waitFor(
      () => document.querySelector('.sc-skip-link').getAttribute('href') === '#main-content'
    );
    expect(retargeted).toBeTruthy();
    expect(app.app.dataset.view).not.toBe('compact');
  });
});
