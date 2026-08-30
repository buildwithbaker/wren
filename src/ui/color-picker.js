// color-picker.js
// Two related concerns:
//  1. The 7-swatch CARD color picker shown in the note header (full-card color).
//  2. Palettes used by the toolbar's text-color and highlight pickers.

import { CARD_COLORS } from '@/notes-store.js';

// Foreground text colors for the Tiptap Color extension.
//
// Values are CSS variables (not literal hexes) so the same note renders legible
// ink in BOTH themes — a fixed dark "Ink" #2A3540 was invisible on dark paper
// (audit U9). The Color extension stores the value verbatim as
// `style="color: var(--wr-tc-…)"`, which tiptap-markdown round-trips unchanged
// (verified) and resolves per theme at render time (see --wr-tc-* in style.css).
// Notes authored before this change keep their baked-in hex; only new picks
// adapt.
export const TEXT_COLORS = [
  { label: 'Default', value: null },
  { label: 'Ink', value: 'var(--wr-tc-ink)' },
  { label: 'Amber', value: 'var(--wr-tc-amber)' },
  { label: 'Red', value: 'var(--wr-tc-red)' },
  { label: 'Green', value: 'var(--wr-tc-green)' },
  { label: 'Blue', value: 'var(--wr-tc-blue)' },
  { label: 'Purple', value: 'var(--wr-tc-purple)' },
  { label: 'Rose', value: 'var(--wr-tc-rose)' },
];

// Highlight (text background) colors for the Highlight extension.
export const HIGHLIGHT_COLORS = [
  { label: 'None', value: null },
  { label: 'Amber', value: '#FFF4DC' },
  { label: 'Yellow', value: '#FFF3A3' },
  { label: 'Green', value: '#D6F5C9' },
  { label: 'Blue', value: '#D6E6FB' },
  { label: 'Rose', value: '#FCD9E8' },
  { label: 'Purple', value: '#E7DBFA' },
];

// Builds the note-header card color picker. Returns { element, setValue }.
//
// role="radiogroup" is a promise about keyboard behaviour, not just a label:
// a radio group is ONE tab stop, and arrow keys move (and select) within it.
// This group was announcing itself as a radiogroup while leaving all seven
// swatches individually tabbable and arrow keys inert (audit U20). It now
// implements the roving-tabindex pattern the role implies.
export function createCardColorPicker({ value = 'default', onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'sc-cardcolors';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'Note color');

  const buttons = new Map();
  const order = [];
  for (const color of CARD_COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-swatch';
    btn.style.setProperty('--swatch', `var(--wr-note-${color.id})`);
    btn.title = color.label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', color.label);
    btn.tabIndex = -1;
    btn.addEventListener('click', () => {
      setValue(color.id);
      onChange?.(color.id);
    });
    buttons.set(color.id, btn);
    order.push({ id: color.id, btn });
    wrap.appendChild(btn);
  }

  // Arrow keys move to the adjacent swatch AND select it (the standard radio
  // group behaviour — a radio group has no "focused but unselected" state).
  // Home/End jump to the ends. The list wraps, matching native radios.
  wrap.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const current = order.findIndex(({ btn }) => btn === document.activeElement);
    if (current === -1) return;
    e.preventDefault();
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    else {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      next = (current + step + order.length) % order.length;
    }
    const target = order[next];
    setValue(target.id);
    target.btn.focus();
    onChange?.(target.id);
  });

  function setValue(id) {
    // Fall back to the first swatch so the group always has exactly one tab
    // stop, even when the note carries a colour that is no longer in the
    // palette.
    const known = buttons.has(id);
    for (const [cid, btn] of buttons) {
      const active = known ? cid === id : cid === order[0]?.id;
      btn.classList.toggle('is-active', known && cid === id);
      btn.setAttribute('aria-checked', known && cid === id ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    }
  }

  setValue(value);
  return { element: wrap, setValue };
}
