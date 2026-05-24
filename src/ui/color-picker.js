// color-picker.js
// Two related concerns:
//  1. The 7-swatch CARD color picker shown in the note header (full-card color).
//  2. Palettes used by the toolbar's text-color and highlight pickers.

import { CARD_COLORS } from '@/notes-store.js';

// Foreground text colors for the Tiptap Color extension.
export const TEXT_COLORS = [
  { label: 'Default', value: null },
  { label: 'Ink', value: '#2A3540' },
  { label: 'Amber', value: '#A07020' },
  { label: 'Red', value: '#C0392B' },
  { label: 'Green', value: '#2E7D46' },
  { label: 'Blue', value: '#2E5082' },
  { label: 'Purple', value: '#7A4FB5' },
  { label: 'Rose', value: '#C2407A' },
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
export function createCardColorPicker({ value = 'default', onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'sc-cardcolors';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'Note color');

  const buttons = new Map();
  for (const color of CARD_COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-swatch';
    btn.style.setProperty('--swatch', color.bg);
    btn.title = color.label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', color.label);
    btn.addEventListener('click', () => {
      setValue(color.id);
      onChange?.(color.id);
    });
    buttons.set(color.id, btn);
    wrap.appendChild(btn);
  }

  function setValue(id) {
    for (const [cid, btn] of buttons) {
      const active = cid === id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  setValue(value);
  return { element: wrap, setValue };
}
