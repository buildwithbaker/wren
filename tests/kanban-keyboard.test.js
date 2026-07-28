// @vitest-environment jsdom
// Regression (audit U13, U14, U20, 2026-07-25):
//
//  U13 — Kanban cards were plain <div>s wired to click + HTML5 drag-and-drop.
//        HTML5 DnD has no keyboard story, so the board was reachable but not
//        operable: no way to open a card and no way to move one without a
//        mouse. Cards now expose a real open <button> and a "move to column"
//        menu that is the keyboard equivalent of a drag.
//
//  U14 — Interactive controls must not nest inside other interactive controls.
//
//  U20 — role="radiogroup" is a promise of one tab stop + arrow-key movement.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKanbanView } from '../src/ui/kanban-view.js';
import { createCardColorPicker } from '../src/ui/color-picker.js';

const NOTES = [
  { id: 'a.md', title: 'Alpha', body: 'first', tags: ['status:todo'], color: 'default' },
  { id: 'b.md', title: 'Beta', body: 'second', tags: ['status:doing'], color: 'default' },
  { id: 'c.md', title: 'Gamma', body: 'third', tags: ['status:done'], color: 'default' },
];

function mountBoard({ onNoteOpen = vi.fn(), onMoveNote = vi.fn() } = {}) {
  const view = createKanbanView({ getNotes: () => NOTES, onNoteOpen, onMoveNote });
  document.body.appendChild(view.element);
  view.refresh();
  return { view, onNoteOpen, onMoveNote };
}

function cardFor(id) {
  return document.querySelector(`.sc-kanban-card[data-id="${id}"]`);
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('Kanban card keyboard operation (U13)', () => {
  it('exposes each card as a real button that opens the note', () => {
    const { onNoteOpen } = mountBoard();
    const openBtn = cardFor('a.md').querySelector('.sc-kanban-card-open');
    expect(openBtn).toBeTruthy();
    expect(openBtn.tagName).toBe('BUTTON');
    expect(openBtn.type).toBe('button');
    // A <button> is focusable and fires click on Enter/Space natively — no
    // tabindex or keydown shim required, which is the point of using one.
    expect(openBtn.getAttribute('aria-label')).toBe('Open note: Alpha');
    openBtn.click();
    expect(onNoteOpen).toHaveBeenCalledWith('a.md');
  });

  it('offers a move affordance listing every other column', () => {
    mountBoard();
    const moveBtn = cardFor('a.md').querySelector('.sc-kanban-card-move');
    expect(moveBtn.tagName).toBe('BUTTON');
    expect(moveBtn.getAttribute('aria-haspopup')).toBe('menu');
    expect(moveBtn.getAttribute('aria-expanded')).toBe('false');

    moveBtn.click();
    const menu = document.querySelector('.sc-kanban-movemenu');
    expect(menu).toBeTruthy();
    expect(menu.getAttribute('role')).toBe('menu');
    expect(moveBtn.getAttribute('aria-expanded')).toBe('true');

    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent);
    // Alpha is in "todo": every other column is offered, its own is not.
    expect(labels).toContain('doing');
    expect(labels).toContain('done');
    expect(labels).toContain('Untagged');
    expect(labels).not.toContain('todo');
  });

  it('moves the note when a menu item is activated', async () => {
    const { onMoveNote } = mountBoard();
    cardFor('a.md').querySelector('.sc-kanban-card-move').click();
    const items = Array.from(document.querySelectorAll('.sc-kanban-movemenu-item'));
    const done = items.find((i) => i.textContent === 'done');
    done.click();
    await Promise.resolve();
    expect(onMoveNote).toHaveBeenCalledWith('a.md', 'status', 'done');
    expect(document.querySelector('.sc-kanban-movemenu')).toBeNull();
  });

  it('focuses the first menu item and moves focus with arrow keys', () => {
    mountBoard();
    cardFor('a.md').querySelector('.sc-kanban-card-move').click();
    const items = Array.from(document.querySelectorAll('.sc-kanban-movemenu-item'));
    expect(document.activeElement).toBe(items[0]);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(items[items.length - 1]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    mountBoard();
    const moveBtn = cardFor('a.md').querySelector('.sc-kanban-card-move');
    moveBtn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.sc-kanban-movemenu')).toBeNull();
    expect(moveBtn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(moveBtn);
  });

  it('a re-render tears down an open menu instead of orphaning it', () => {
    const { view } = mountBoard();
    cardFor('a.md').querySelector('.sc-kanban-card-move').click();
    expect(document.querySelector('.sc-kanban-movemenu')).toBeTruthy();
    view.refresh();
    expect(document.querySelector('.sc-kanban-movemenu')).toBeNull();
  });
});

describe('No interactive control is nested inside another (U14)', () => {
  it('holds on the Kanban board', () => {
    mountBoard();
    for (const btn of document.querySelectorAll('.sc-kanban-card button')) {
      expect(btn.parentElement.closest('button')).toBeNull();
    }
  });
});

describe('Card colour radiogroup keyboard behaviour (U20)', () => {
  it('is a single tab stop with the checked swatch owning it', () => {
    const { element } = createCardColorPicker({ value: 'default' });
    document.body.appendChild(element);
    const swatches = Array.from(element.querySelectorAll('.sc-swatch'));
    expect(swatches.length).toBeGreaterThan(1);
    expect(swatches.filter((s) => s.tabIndex === 0)).toHaveLength(1);
    expect(swatches.find((s) => s.tabIndex === 0).getAttribute('aria-checked')).toBe('true');
  });

  it('ArrowRight moves focus AND selection, and wraps', () => {
    const onChange = vi.fn();
    const { element } = createCardColorPicker({ value: 'default', onChange });
    document.body.appendChild(element);
    const swatches = Array.from(element.querySelectorAll('.sc-swatch'));

    swatches[0].focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(swatches[1]);
    expect(swatches[1].getAttribute('aria-checked')).toBe('true');
    expect(swatches[0].getAttribute('aria-checked')).toBe('false');
    expect(onChange).toHaveBeenCalledTimes(1);

    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(swatches[swatches.length - 1]);
    expect(element.querySelectorAll('.sc-swatch[tabindex="0"]')).toHaveLength(1);
  });
});
