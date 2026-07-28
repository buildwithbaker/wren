// kanban-view.js
// Board view: notes grouped into columns by the value of a chosen tag
// namespace. Cards are click-to-open; drag-and-drop (Phase C2) re-tags a note
// by moving it between columns.
//
// Factory returns { element, refresh, destroy }. The host (app-controller)
// owns the notes array and passes it in via getNotes(); the board never
// fetches or mutates storage directly except through the onMoveNote callback.
//
// Decision provenance: project-blueprints/wren/future-enhancements/kanban-view-sow.md (Phase C)

import { CARD_COLORS, toPreviewText } from '@/notes-store.js';
import { getAllNamespaces, groupNotesByNamespace, isValidTag } from '@/tags/tag-parser.js';
import { buildTagChips } from './tag-chips.js';
import { isAiNote, buildAiBadge } from './ai-badge.js';
import { buildDueChip } from './due-chip.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));
const GROUPBY_KEY = 'wren.kanbanGroupBy';

/**
 * @param {{
 *   getNotes: () => Array<Object>,
 *   onNoteOpen: (noteId: string) => void,
 *   onMoveNote?: (noteId: string, namespace: string, value: string) => Promise<void>|void,
 * }} opts
 */
export function createKanbanView({ getNotes, onNoteOpen, onMoveNote }) {
  let groupBy = loadGroupBy();
  // Manually-added empty columns, keyed by namespace → Set of values. Session-
  // only (not persisted): "+ New Tag" creates an empty, droppable column so a
  // user can stage a new tag value and drag cards into it. A column disappears
  // on reload unless a note actually carries the tag by then.
  const manualColumns = new Map();
  // True while the inline "+ New Tag" input is open (drives toolbar rendering).
  let addingTag = false;
  // The text currently typed into the open "+ New Tag" input. Preserved across
  // re-renders so an external refresh() (a note being created/saved elsewhere)
  // never wipes what the user is mid-typing — the bug where New Tag "stopped
  // working" after New Note. See render()'s rebuildToolbar guard.
  let addingTagValue = '';
  // Column values in the order they were last rendered — the destination list
  // for a card's keyboard "Move to" menu.
  let renderedColumns = [];
  // The open move menu, or null. { menu, trigger, onDocPointer, onDocKeydown }.
  let openMenu = null;

  function addManualColumn(namespace, value) {
    if (!manualColumns.has(namespace)) manualColumns.set(namespace, new Set());
    manualColumns.get(namespace).add(value);
  }

  const root = document.createElement('div');
  root.className = 'sc-kanban';

  const toolbar = document.createElement('div');
  toolbar.className = 'sc-kanban-toolbar';

  const columnsWrap = document.createElement('div');
  columnsWrap.className = 'sc-kanban-columns';

  root.append(toolbar, columnsWrap);

  function loadGroupBy() {
    try {
      return localStorage.getItem(GROUPBY_KEY) || null;
    } catch {
      return null;
    }
  }

  function saveGroupBy() {
    try {
      if (groupBy) localStorage.setItem(GROUPBY_KEY, groupBy);
    } catch {
      /* ignore */
    }
  }

  // Resolve the active namespace: persisted choice if still present in the
  // data, otherwise the alphabetically-first namespace.
  function resolveGroupBy(namespaces) {
    if (groupBy && namespaces.includes(groupBy)) return groupBy;
    return namespaces[0] || null;
  }

  function nsLabel(ns) {
    return ns === '_uncategorized' ? 'uncategorized' : ns;
  }

  function renderToolbar(namespaces, activeNs) {
    toolbar.replaceChildren();

    const label = document.createElement('span');
    label.className = 'sc-kanban-toolbar-label';
    label.textContent = 'Group by:';

    const select = document.createElement('select');
    select.className = 'sc-tagfilter-dropdown';
    select.setAttribute('aria-label', 'Group notes by tag namespace');
    if (namespaces.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = '(no tags yet)';
      select.appendChild(opt);
      select.disabled = true;
    } else {
      for (const ns of namespaces) {
        const opt = document.createElement('option');
        opt.value = ns;
        opt.textContent = nsLabel(ns);
        if (ns === activeNs) opt.selected = true;
        select.appendChild(opt);
      }
    }
    select.addEventListener('change', () => {
      groupBy = select.value;
      saveGroupBy();
      render();
    });

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    toolbar.append(label, select, spacer);

    // "+ New Tag" — adds an empty, droppable column for a new value in the
    // active namespace (New Note lives in the sidebar; the board only organizes
    // by tag). Clicking swaps the button for an inline input.
    if (addingTag && activeNs) {
      const form = document.createElement('form');
      form.className = 'sc-kanban-newtag';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sc-kanban-newtag-input';
      input.placeholder = `New ${nsLabel(activeNs)}…`;
      input.setAttribute('aria-label', `New ${nsLabel(activeNs)} value`);
      input.autocomplete = 'off';
      // Restore any in-progress text so a re-render doesn't lose the user's typing.
      input.value = addingTagValue;
      input.addEventListener('input', () => {
        addingTagValue = input.value;
      });
      form.appendChild(input);

      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        addingTag = false;
        addingTagValue = '';
        // Reject the reserved "_untagged" key — render() always appends that
        // column, so a manual one would duplicate/conflict with it.
        if (value && value !== '_untagged' && isValidTag(`${activeNs}:${value}`)) {
          addManualColumn(activeNs, value);
        }
        render();
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        commit();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          done = true;
          addingTag = false;
          addingTagValue = '';
          render();
        }
      });
      input.addEventListener('blur', commit);
      toolbar.appendChild(form);
      // Focus once it's attached so the user can type immediately; caret at end.
      queueMicrotask(() => {
        input.focus();
        const end = input.value.length;
        try {
          input.setSelectionRange(end, end);
        } catch {
          /* ignore (non-text input) */
        }
      });
    } else {
      const newTagBtn = document.createElement('button');
      newTagBtn.type = 'button';
      newTagBtn.className = 'sc-btn sc-btn--ghost';
      newTagBtn.textContent = '+ New Tag';
      newTagBtn.disabled = !activeNs;
      if (!activeNs) {
        newTagBtn.title = 'Add a tag to a note first to start a board';
      }
      newTagBtn.addEventListener('click', () => {
        addingTag = true;
        render();
      });
      toolbar.appendChild(newTagBtn);
    }
  }

  // @param {{ rebuildToolbar?: boolean }} [opts] - when false, the toolbar is
  //   left untouched so an open "+ New Tag" input (its live DOM, focus, and
  //   typed text) survives the re-render. External refresh() passes this while
  //   the input is open; internal calls rebuild normally.
  function render({ rebuildToolbar = true } = {}) {
    const notes = getNotes() || [];
    const namespaces = getAllNamespaces(notes);
    const activeNs = resolveGroupBy(namespaces);
    groupBy = activeNs; // keep internal state aligned with what's shown

    // A re-render throws away the trigger button the open menu is anchored to.
    closeMoveMenu();
    if (rebuildToolbar) renderToolbar(namespaces, activeNs);
    columnsWrap.replaceChildren();

    if (!activeNs) {
      if (notes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sc-kanban-empty';
        empty.textContent =
          'No notes yet. Create a note, then tag it like "status:todo" to organize into columns.';
        columnsWrap.appendChild(empty);
        return;
      }
      // No namespaced tags exist yet — instead of a blank board, show every note
      // in a single "Untagged" column so the board is immediately usable. Real
      // value columns appear as soon as a note carries a namespace:value tag.
      columnsWrap.appendChild(renderColumn('_untagged', notes, '_uncategorized'));
      return;
    }

    const groups = groupNotesByNamespace(notes, activeNs);
    // Column order: values alphabetically, with the catch-all _untagged last.
    // Manually-added (empty) columns for the active namespace are merged in so
    // they render even with no notes yet — droppable targets for re-tagging.
    const valueSet = new Set(Array.from(groups.keys()).filter((k) => k !== '_untagged'));
    const manual = manualColumns.get(activeNs);
    if (manual) for (const v of manual) valueSet.add(v);
    const keys = Array.from(valueSet).sort();
    keys.push('_untagged');

    // The column set each card's "Move to" menu offers. Recomputed on every
    // render so the menu can never list a column that is no longer on screen.
    // _untagged is always offered as a destination (moving there strips the
    // grouping tag) even when its column is hidden for being empty.
    renderedColumns = keys.slice();

    for (const value of keys) {
      const colNotes = groups.get(value) || [];
      // Hide an empty _untagged column to reduce clutter; always show real
      // value columns even when empty so users can drop into them (Phase C2).
      if (value === '_untagged' && colNotes.length === 0) continue;
      columnsWrap.appendChild(renderColumn(value, colNotes, activeNs));
    }
  }

  function renderColumn(value, colNotes, namespace) {
    const col = document.createElement('div');
    col.className = 'sc-kanban-col';
    col.dataset.value = value;
    col.dataset.namespace = namespace;

    const header = document.createElement('div');
    header.className = 'sc-kanban-col-header';
    const title = document.createElement('span');
    title.textContent = value === '_untagged' ? 'Untagged' : value;
    const count = document.createElement('span');
    count.className = 'sc-kanban-col-count';
    count.textContent = String(colNotes.length);
    header.append(title, count);
    col.appendChild(header);

    for (const note of colNotes) {
      col.appendChild(renderCard(note, namespace, value));
    }

    wireColumnDrop(col, namespace, value);
    return col;
  }

  // Cards are keyboard-operable (audit U13). The card itself stays a plain
  // div — it is the drag source, and it holds non-interactive chips — while
  // the two things a user can *do* with it are real <button>s:
  //   • .sc-kanban-card-open  — full-bleed title/preview button, Enter/Space
  //     opens the note (native button semantics; no role=button emulation).
  //   • .sc-kanban-card-move  — opens a menu listing every other column, which
  //     is the keyboard equivalent of dragging the card. HTML5 drag-and-drop
  //     has no keyboard story at all, so without this the board was reachable
  //     but not operable.
  // The buttons are siblings, never nested, so this does not reintroduce the
  // interactive-inside-interactive problem fixed in notes-list.js (audit U14).
  function renderCard(note, namespace, columnValue) {
    const card = document.createElement('div');
    card.className = 'sc-kanban-card';
    const safeColor = COLOR_BG[note.color] ? note.color : 'default';
    card.style.setProperty('--wr-note-bg', `var(--wr-note-${safeColor})`);
    card.dataset.id = note.id;

    const label = note.title || 'Untitled';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'sc-kanban-card-open';
    openBtn.setAttribute('aria-label', `Open note: ${label}`);

    const title = document.createElement('span');
    title.className = 'sc-kanban-card-title';
    if (isAiNote(note)) title.appendChild(buildAiBadge());
    title.append(label);

    const preview = document.createElement('span');
    preview.className = 'sc-kanban-card-preview';
    preview.textContent = toPreviewText(note.firstLine || note.body) || 'No additional text';

    openBtn.append(title, preview);
    openBtn.addEventListener('click', () => onNoteOpen?.(note.id));
    card.appendChild(openBtn);

    // Due-date chip (Note Lifecycle A2) — skipped when hidden per-note.
    const dueChip = note.hideDue ? null : buildDueChip(note.due);
    if (dueChip) card.appendChild(dueChip);
    // Tag chips (Sticky Float Phase 1): display-only on the board — the column
    // already encodes the grouping tag; chips show the note's full tag set.
    // Skipped when the note hides its tags.
    const chips = note.hideTags ? null : buildTagChips(note.tags);
    if (chips) card.appendChild(chips);

    if (onMoveNote) {
      const moveBtn = document.createElement('button');
      moveBtn.type = 'button';
      moveBtn.className = 'sc-kanban-card-move';
      moveBtn.title = 'Move to column';
      moveBtn.setAttribute('aria-label', `Move "${label}" to another column`);
      moveBtn.setAttribute('aria-haspopup', 'menu');
      moveBtn.setAttribute('aria-expanded', 'false');
      moveBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>';
      moveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openMenu && openMenu.trigger === moveBtn) closeMoveMenu();
        else openMoveMenu(moveBtn, note, namespace, columnValue);
      });
      card.appendChild(moveBtn);
    }

    // Mouse convenience: clicking the card's dead space opens the note. Clicks
    // that land on either button are handled by that button, so bail out
    // rather than firing onNoteOpen a second time.
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      onNoteOpen?.(note.id);
    });

    wireCardDrag(card, note);
    return card;
  }

  // ---- Move-to-column menu (keyboard equivalent of a drag, audit U13) ------

  function columnLabel(value) {
    return value === '_untagged' ? 'Untagged' : value;
  }

  function closeMoveMenu({ restoreFocus = false } = {}) {
    if (!openMenu) return;
    const { menu, trigger, onDocPointer, onDocKeydown } = openMenu;
    openMenu = null;
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKeydown, true);
    menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger.isConnected) trigger.focus();
  }

  function openMoveMenu(trigger, note, namespace, columnValue) {
    const destinations = renderedColumns.filter((v) => v !== columnValue);
    const menu = document.createElement('div');
    menu.className = 'sc-kanban-movemenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `Move "${note.title || 'Untitled'}" to column`);

    if (destinations.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sc-kanban-movemenu-empty';
      empty.textContent = 'No other columns yet';
      menu.appendChild(empty);
    }

    const items = destinations.map((value) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sc-kanban-movemenu-item';
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      item.textContent = columnLabel(value);
      item.addEventListener('click', async () => {
        closeMoveMenu({ restoreFocus: true });
        await onMoveNote?.(note.id, namespace, value);
      });
      menu.appendChild(item);
      return item;
    });

    // Fixed positioning: the board's columns scroll and clip, and a menu
    // parented inside a column would be cut off by that overflow (the class of
    // bug audit U16 caught elsewhere).
    const rect = trigger.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.left = `${Math.round(rect.left)}px`;
    document.body.appendChild(menu);
    // Nudge back inside the viewport if the card sits near an edge.
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, Math.round(window.innerWidth - menuRect.width - 8))}px`;
    }
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, Math.round(rect.top - menuRect.height - 4))}px`;
    }

    const focusItem = (i) => {
      if (items.length === 0) return;
      const next = (i + items.length) % items.length;
      items[next].focus();
    };

    const onDocPointer = (e) => {
      if (!menu.contains(e.target) && e.target !== trigger) closeMoveMenu();
    };
    const onDocKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMoveMenu({ restoreFocus: true });
        return;
      }
      if (e.key === 'Tab') {
        closeMoveMenu();
        return;
      }
      if (!items.length) return;
      const current = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusItem(current + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusItem(current <= 0 ? items.length - 1 : current - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        focusItem(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        focusItem(items.length - 1);
      }
    };
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKeydown, true);

    openMenu = { menu, trigger, onDocPointer, onDocKeydown };
    trigger.setAttribute('aria-expanded', 'true');
    focusItem(0);
  }

  // ---- Drag and drop (Phase C2) --------------------------------------------

  function wireCardDrag(card, note) {
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', note.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('sc-kanban-card--dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('sc-kanban-card--dragging');
    });
  }

  function wireColumnDrop(col, namespace, value) {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('sc-kanban-col--dragover');
    });
    col.addEventListener('dragleave', (e) => {
      // dragleave also fires when moving onto child cards; only clear the
      // highlight when the pointer actually leaves the column subtree.
      if (!col.contains(e.relatedTarget)) {
        col.classList.remove('sc-kanban-col--dragover');
      }
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('sc-kanban-col--dragover');
      const noteId = e.dataTransfer.getData('text/plain');
      if (!noteId || !onMoveNote) return;
      // The host re-tags the note (replace same-namespace; _untagged removes it),
      // persists, updates state, and calls refresh(). It is idempotent when the
      // card is dropped back into its origin column.
      await onMoveNote(noteId, namespace, value);
    });
  }

  return {
    element: root,
    // External refresh: re-render the columns, but leave an open "+ New Tag"
    // input in place so a note created/saved elsewhere can't wipe it mid-type.
    refresh: () => render({ rebuildToolbar: !addingTag }),
    destroy() {
      closeMoveMenu();
      root.replaceChildren();
    },
  };
}
