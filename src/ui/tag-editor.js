// tag-editor.js
// Inline tag editor shown in the note header (below the color row).
// Renders the open note's tags as removable chips and an "+ Add tag" input
// with native datalist autocomplete drawn from tags used across all notes.
//
// The component is presentational: it never mutates a note. It emits
// onAdd(rawTag) / onRemove(rawTag) and the parent (note-editor.js) applies the
// change to its working copy and schedules the save. Call setTags() to
// re-render chips after the parent updates the note's tags.
//
// Tag semantics live in src/tags/tag-parser.js (colon-namespaced strings).
// Decision provenance: project-blueprints/wren/backlog.md (2026-05-28 item).

import { parseTag, isValidTag } from '@/tags/tag-parser.js';

let suggestListSeq = 0;

export function createTagEditor({ onAdd, onRemove, getSuggestions } = {}) {
  const root = document.createElement('div');
  root.className = 'sc-tagrow';
  root.setAttribute('aria-label', 'Note tags');

  const chips = document.createElement('div');
  chips.className = 'sc-tagchips';

  // --- add form ------------------------------------------------------------
  const form = document.createElement('form');
  form.className = 'sc-tagadd';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sc-taginput';
  input.placeholder = '+ Add tag';
  input.setAttribute('aria-label', 'Add a tag (e.g. status:todo or important)');
  input.autocomplete = 'off';
  input.spellcheck = false;

  // Native datalist gives namespace + value autocomplete with zero custom
  // dropdown state. Unique id so multiple editor instances never collide.
  const listId = `sc-tag-suggest-${++suggestListSeq}`;
  const datalist = document.createElement('datalist');
  datalist.id = listId;
  input.setAttribute('list', listId);

  // Mirror of the datalist contents, used by the input handler's
  // commit-on-pick exact-match check (cheaper than querying the DOM per
  // keystroke). Refreshed alongside the datalist in refreshSuggestions().
  let currentSuggestions = new Set();

  form.append(input, datalist);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    commitInput();
  });
  // Selecting a datalist option fires 'input'; commit immediately when the
  // typed value exactly matches a full VALID suggestion so picking is one
  // action. Namespace prefixes ("status:") are suggestions too but are not
  // valid tags — leave those in the input so the user can type the value.
  // (Bug fixed 2026-06-11: this commit-on-pick was promised by the original
  // comment but never implemented — picked tags were silently discarded.)
  input.addEventListener('input', () => {
    input.classList.remove('is-invalid');
    const raw = input.value.trim();
    if (raw && currentSuggestions.has(raw) && isValidTag(raw)) {
      commitInput();
    }
  });
  // Commit a pending valid tag when focus leaves the input — typing a tag and
  // clicking elsewhere previously discarded it silently. Invalid partial text
  // is left in place (no is-invalid flash on a mere focus change).
  input.addEventListener('blur', () => {
    const raw = input.value.trim();
    if (raw && isValidTag(raw)) commitInput({ refocus: false });
  });

  function commitInput({ refocus = true } = {}) {
    const raw = input.value.trim();
    if (!raw) return;
    if (!isValidTag(raw)) {
      input.classList.add('is-invalid');
      return;
    }
    input.value = '';
    input.classList.remove('is-invalid');
    onAdd?.(raw);
    if (refocus) input.focus();
  }

  root.append(chips, form);

  // --- chip rendering ------------------------------------------------------
  function renderChips(tags) {
    chips.replaceChildren();
    const list = Array.isArray(tags) ? tags.filter(isValidTag) : [];
    for (const raw of list) {
      const parsed = parseTag(raw);
      if (!parsed) continue;

      const chip = document.createElement('span');
      chip.className = 'sc-tag-chip';

      if (parsed.namespace !== '_uncategorized') {
        const ns = document.createElement('span');
        ns.className = 'sc-tag-chip__ns';
        ns.textContent = `${parsed.namespace}:`;
        chip.appendChild(ns);
      }
      const val = document.createElement('span');
      val.className = 'sc-tag-chip__val';
      val.textContent = parsed.value;
      chip.appendChild(val);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sc-tag-remove';
      remove.title = `Remove tag "${raw}"`;
      remove.setAttribute('aria-label', `Remove tag ${raw}`);
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      remove.addEventListener('click', () => onRemove?.(raw));

      chip.appendChild(remove);
      chips.appendChild(chip);
    }
  }

  // --- autocomplete --------------------------------------------------------
  // Suggestions are full raw tags ("status:todo") plus namespace prefixes
  // ("status:") so the user can start a namespace and get its values next.
  function refreshSuggestions() {
    const suggestions = getSuggestions?.() || [];
    currentSuggestions = new Set(suggestions);
    datalist.replaceChildren();
    for (const s of suggestions) {
      const opt = document.createElement('option');
      opt.value = s;
      datalist.appendChild(opt);
    }
  }

  function setTags(tags) {
    renderChips(tags);
    refreshSuggestions();
  }

  function clear() {
    chips.replaceChildren();
    datalist.replaceChildren();
    input.value = '';
    input.classList.remove('is-invalid');
  }

  return { element: root, setTags, refreshSuggestions, clear };
}
