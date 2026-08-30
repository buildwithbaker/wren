// tag-chips.js
// Shared mini tag-chip row for note cards (sidebar list + Kanban). Read-only
// presentation of a note's tags: namespace prefix dimmed, value emphasized,
// capped at MAX_CHIPS with a "+N" overflow indicator so card height stays
// predictable. Optionally clickable — the sidebar passes onTagClick to add the
// tag to the AND-filter; clicks never bubble to the card's open handler.
//
// A clickable chip is a real <button> (audit U14). It used to be a
// role="button" span, because the card itself was a <button> and nesting one
// button inside another is invalid HTML. The cards are containers now, so the
// chip can carry native button semantics instead of emulating them.
//
// Decision provenance: project-blueprints/wren/future-enhancements/sticky-float-sow.md (Phase 1)

import { parseTag, isValidTag } from '@/tags/tag-parser.js';

const MAX_CHIPS = 3;

/**
 * Build a chip row element for a note's tags, or null when there are none
 * (callers append the result only when non-null, so untagged cards render
 * exactly as before).
 *
 * @param {string[]|undefined} tags
 * @param {{ onTagClick?: (raw: string) => void, max?: number }} [opts]
 * @returns {HTMLElement|null}
 */
export function buildTagChips(tags, { onTagClick, max = MAX_CHIPS } = {}) {
  const list = Array.isArray(tags) ? tags.filter(isValidTag) : [];
  if (list.length === 0) return null;

  const row = document.createElement('div');
  row.className = 'sc-mtags';

  for (const raw of list.slice(0, max)) {
    const parsed = parseTag(raw);
    if (!parsed) continue;

    const chip = document.createElement(onTagClick ? 'button' : 'span');
    chip.className = 'sc-mtag';

    if (parsed.namespace !== '_uncategorized') {
      const ns = document.createElement('span');
      ns.className = 'sc-mtag__ns';
      ns.textContent = `${parsed.namespace}:`;
      chip.appendChild(ns);
    }
    const val = document.createElement('span');
    val.className = 'sc-mtag__val';
    val.textContent = parsed.value;
    chip.appendChild(val);

    if (onTagClick) {
      chip.type = 'button';
      chip.classList.add('sc-mtag--clickable');
      chip.title = `Filter by "${raw}"`;
      chip.setAttribute('aria-label', `Filter by "${raw}"`);
      chip.addEventListener('click', (e) => {
        // The chip sits on a clickable card — filter, never open the note.
        e.stopPropagation();
        onTagClick(raw);
      });
      // Enter/Space are native on <button>; no keydown shim needed.
    }
    row.appendChild(chip);
  }

  if (list.length > max) {
    const more = document.createElement('span');
    more.className = 'sc-mtag sc-mtag--more';
    more.textContent = `+${list.length - max}`;
    more.title = list.slice(max).join(', ');
    row.appendChild(more);
  }

  return row;
}
