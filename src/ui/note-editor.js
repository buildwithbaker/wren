// note-editor.js
// The editor panel: title input, color picker, export/delete actions, Tiptap
// toolbar + body. Owns a working copy of the open note and emits debounced
// save requests; the parent performs the actual disk write.
// Returns { element, openNote, flush, clear, focusTitle, destroy }.

import { createEditor, getMarkdown } from '@/editor.js';
import { createToolbar } from './toolbar.js';
import { createCardColorPicker } from './color-picker.js';
import { createTagEditor } from './tag-editor.js';
import { confirmDialog } from './dialog.js';
import { CARD_COLORS } from '@/notes-store.js';
import { parseTag } from '@/tags/tag-parser.js';
import { formatModified } from './format.js';
import { dueStatus, normalizeDue } from '@/due.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));
const SAVE_DELAY = 500;

export function createNoteEditor({
  onSave,
  onDelete,
  onExport,
  onArchive,
  onBack,
  onPopOut,
  onTitleChange,
  getTagSuggestions,
  showBack = false,
  sticky = false,
}) {
  let note = null;
  let editor = null;
  let toolbar = null;
  let saveTimer = null;

  const root = document.createElement('div');
  root.className = 'sc-editor';

  // --- empty placeholder (no note open) ------------------------------------
  const placeholder = document.createElement('div');
  placeholder.className = 'sc-editor-empty';
  placeholder.innerHTML =
    '<div class="sc-editor-empty-inner"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 4h9l5 5v11a0 0 0 0 1 0 0H5z"/><path d="M14 4v5h5"/></svg><p>Select a note, or create a new one.</p></div>';

  // --- note surface --------------------------------------------------------
  const surface = document.createElement('div');
  surface.className = 'sc-editor-surface';
  surface.hidden = true;

  // Header
  const head = document.createElement('div');
  head.className = 'sc-editor-head';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'sc-iconbtn sc-back';
  back.title = 'Back to notes';
  back.setAttribute('aria-label', 'Back to notes');
  back.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 6-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  back.addEventListener('click', () => {
    flush();
    onBack?.();
  });
  if (!showBack) back.hidden = true;

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'sc-title-input';
  titleInput.placeholder = 'Note title';
  titleInput.setAttribute('aria-label', 'Note title');
  titleInput.addEventListener('input', () => {
    if (!note) return;
    note.title = titleInput.value;
    // Live hook so a sticky window can keep its OS title/taskbar label in sync
    // as the user types (additive — main app passes no handler).
    onTitleChange?.(titleInput.value);
    scheduleSave();
  });

  const actions = document.createElement('div');
  actions.className = 'sc-editor-actions';

  // Overflow ("more") menu (Sticky Float Phase 2). Currently holds a single
  // action — Pop out into its own window — kept out of the main action row so
  // export / Archive / Delete read as the primary actions. Main app only:
  // hidden in sticky mode (a sticky can't pop itself out) and when no onPopOut
  // handler was wired.
  const moreWrap = document.createElement('div');
  moreWrap.className = 'sc-editor-more';
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'sc-iconbtn';
  moreBtn.title = 'More actions';
  moreBtn.setAttribute('aria-label', 'More actions');
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';
  const moreMenu = document.createElement('div');
  moreMenu.className = 'sc-editor-more-menu';
  moreMenu.setAttribute('role', 'menu');
  moreMenu.hidden = true;
  const popOutItem = document.createElement('button');
  popOutItem.type = 'button';
  popOutItem.className = 'sc-editor-more-item';
  popOutItem.setAttribute('role', 'menuitem');
  popOutItem.innerHTML =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 4l-8 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Pop out into its own window</span>';
  popOutItem.addEventListener('click', async () => {
    closeMore();
    if (!note) return;
    // Flush pending edits so the popped-out window reads the latest content.
    await flush();
    onPopOut?.(note);
  });
  moreMenu.appendChild(popOutItem);
  moreWrap.append(moreBtn, moreMenu);
  moreWrap.hidden = sticky || !onPopOut;

  function onDocClickForMore(e) {
    if (!moreWrap.contains(e.target)) closeMore();
  }
  function onKeyForMore(e) {
    if (e.key === 'Escape') {
      closeMore();
      moreBtn.focus();
    }
  }
  function openMore() {
    moreMenu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClickForMore, true);
    document.addEventListener('keydown', onKeyForMore, true);
  }
  function closeMore() {
    moreMenu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClickForMore, true);
    document.removeEventListener('keydown', onKeyForMore, true);
  }
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moreMenu.hidden) openMore();
    else closeMore();
  });

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'sc-iconbtn';
  exportBtn.title = 'Export as .md';
  exportBtn.setAttribute('aria-label', 'Export note as Markdown file');
  exportBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 4v11M8 11l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 20h14" stroke-linecap="round"/></svg>';
  exportBtn.addEventListener('click', () => {
    if (note) onExport?.(note);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'sc-iconbtn sc-iconbtn--danger';
  deleteBtn.title = 'Delete note';
  deleteBtn.setAttribute('aria-label', 'Delete note');
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  deleteBtn.addEventListener('click', async () => {
    if (!note) return;
    const ok = await confirmDialog({
      title: 'Delete note?',
      message: `"${note.title || 'Untitled'}" will be permanently deleted from your notes folder. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) {
      cancelSave();
      onDelete?.(note);
    }
  });

  // Archive (Note Lifecycle B2): move the note out of the main views into
  // _archive/. Shown only when an onArchive handler is wired and the note is
  // editable (hidden for read-only staged/archived views and in stickies).
  const archiveBtn = document.createElement('button');
  archiveBtn.type = 'button';
  archiveBtn.className = 'sc-iconbtn';
  archiveBtn.title = 'Archive note';
  archiveBtn.setAttribute('aria-label', 'Archive note');
  archiveBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
  archiveBtn.hidden = !onArchive || sticky;
  archiveBtn.addEventListener('click', () => {
    if (note) onArchive?.(note);
  });

  // Sticky chrome is slim: title + color + toolbar + body only. Hide export and
  // delete in a sticky window (those actions stay in the main app).
  if (sticky) {
    exportBtn.hidden = true;
    deleteBtn.hidden = true;
  }

  // Main row: export · Archive · Delete (Archive adjacent to Delete). The
  // overflow menu (Pop-out) sits to the left, visually separated.
  actions.append(moreWrap, exportBtn, archiveBtn, deleteBtn);
  head.append(back, titleInput, actions);

  // Color picker row
  const colorRow = document.createElement('div');
  colorRow.className = 'sc-editor-colorrow';
  const cardColor = createCardColorPicker({
    value: 'default',
    onChange: (id) => {
      if (!note) return;
      note.color = id;
      applyColor(id);
      scheduleSave();
    },
  });
  // Due-date control (Note Lifecycle A1): a native date input writing the
  // existing `due` frontmatter field (YYYY-MM-DD). The × clears it (removes the
  // field). Reflects status (overdue/today/upcoming) via a class for tinting.
  const dueWrap = document.createElement('div');
  dueWrap.className = 'sc-due-control';
  const dueLabel = document.createElement('span');
  dueLabel.className = 'sc-due-label';
  dueLabel.textContent = 'Due';
  const dueInput = document.createElement('input');
  dueInput.type = 'date';
  dueInput.className = 'sc-due-input';
  dueInput.setAttribute('aria-label', 'Due date');
  const dueClear = document.createElement('button');
  dueClear.type = 'button';
  dueClear.className = 'sc-due-clear';
  dueClear.textContent = '×';
  dueClear.title = 'Clear due date';
  dueClear.setAttribute('aria-label', 'Clear due date');
  dueInput.addEventListener('change', () => {
    if (!note) return;
    note.due = dueInput.value || '';
    updateDueControl();
    scheduleSave();
  });
  dueClear.addEventListener('click', () => {
    if (!note) return;
    note.due = '';
    dueInput.value = '';
    updateDueControl();
    scheduleSave();
  });
  dueWrap.append(dueLabel, dueInput, dueClear);

  const savedHint = document.createElement('span');
  savedHint.className = 'sc-saved-hint';
  savedHint.setAttribute('aria-live', 'polite');
  // Color swatches on the left; the Due control pinned to the far right (CSS
  // margin-left:auto). The save status moved out of this row into the tag row.
  colorRow.append(cardColor.element, dueWrap);

  function updateDueControl() {
    const status = dueStatus(note?.due || '');
    dueWrap.dataset.status = status; // '', 'overdue', 'today', 'upcoming'
    dueClear.hidden = !(note && note.due);
  }

  // Provenance mini-panel (AI-write visibility P2): a single tucked, collapsible
  // line showing when the note was last updated and by whom (you / AI). Reads the
  // frontmatter provenance fields; falls back to the modified time — and hides
  // entirely — for legacy notes with no usable timestamp. NOT a version history.
  const provenanceEl = document.createElement('details');
  provenanceEl.className = 'sc-provenance';
  provenanceEl.hidden = true;
  const provenanceSummary = document.createElement('summary');
  provenanceSummary.className = 'sc-provenance-summary';
  const provenanceDetail = document.createElement('div');
  provenanceDetail.className = 'sc-provenance-detail';
  provenanceEl.append(provenanceSummary, provenanceDetail);

  function whoLabel(by) {
    if (by === 'ai') return 'AI';
    if (by === 'human') return 'you';
    return '';
  }

  function updateProvenance(n) {
    const lastWhen = formatModified(n?.lastEdited || n?.modified || '');
    if (!lastWhen) {
      provenanceEl.hidden = true;
      provenanceEl.open = false;
      return;
    }
    provenanceEl.hidden = false;
    const editedWho = whoLabel(n.lastEditedBy);
    provenanceSummary.textContent = editedWho
      ? `Updated ${lastWhen} · by ${editedWho}`
      : `Updated ${lastWhen}`;

    provenanceDetail.replaceChildren();
    const createdWho = whoLabel(n.createdBy);
    const createdWhen = formatModified(n.created);
    const rows = [];
    if (createdWhen) rows.push(`Created ${createdWhen}${createdWho ? ` · by ${createdWho}` : ''}`);
    rows.push(`Last edited ${lastWhen}${editedWho ? ` · by ${editedWho}` : ''}`);
    for (const text of rows) {
      const row = document.createElement('div');
      row.className = 'sc-provenance-row';
      row.textContent = text;
      provenanceDetail.appendChild(row);
    }
  }

  // Tag editor row
  const tagEditor = createTagEditor({
    getSuggestions: () => getTagSuggestions?.() || [],
    onAdd: (raw) => {
      if (!note) return;
      const parsed = parseTag(raw);
      if (!parsed) return;
      const existing = note.tags || [];
      // Exact duplicate -> no-op.
      if (existing.includes(parsed.raw)) return;
      // Explicit namespaces are single-value (mirrors Kanban move semantics):
      // adding "status:doing" replaces "status:todo". Un-namespaced tags stack.
      const filtered =
        parsed.namespace === '_uncategorized'
          ? existing
          : existing.filter((t) => {
              const tp = parseTag(t);
              return !tp || tp.namespace !== parsed.namespace;
            });
      note.tags = [...filtered, parsed.raw];
      tagEditor.setTags(note.tags);
      scheduleSave();
    },
    onRemove: (raw) => {
      if (!note) return;
      note.tags = (note.tags || []).filter((t) => t !== raw);
      tagEditor.setTags(note.tags);
      scheduleSave();
    },
  });

  // Toolbar + editor body mounts
  const toolbarMount = document.createElement('div');
  toolbarMount.className = 'sc-toolbar-mount';
  const bodyMount = document.createElement('div');
  bodyMount.className = 'sc-editor-body';

  // Tag chips are part of the full editor only — a sticky keeps slim chrome.
  // The save status sits to their right; it stays visible even in a sticky
  // (only the tag-chips input is hidden, not the whole row).
  if (sticky) tagEditor.element.hidden = true;
  const tagRow = document.createElement('div');
  tagRow.className = 'sc-editor-tagrow';
  tagRow.append(tagEditor.element, savedHint);

  // Provenance ("Updated … by you") sits at the very bottom of the surface,
  // below the editor body — out of the way of the title/tag/save controls.
  surface.append(head, colorRow, tagRow, toolbarMount, bodyMount, provenanceEl);
  root.append(placeholder, surface);

  // --- save scheduling ------------------------------------------------------
  function scheduleSave() {
    setHint('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DELAY);
  }
  function cancelSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  async function doSave() {
    saveTimer = null;
    if (!note) return;
    const target = note;
    await onSave?.(target);
    // onSave (app-controller handleSave) stamped modified + human provenance on
    // the same note object; reflect it in the panel + hint if still open.
    if (note === target) {
      updateProvenance(target);
      setHint(`Saved ${formatModified(target.modified)}`);
    }
  }
  // Flush any pending save immediately (e.g. when leaving the note).
  function flush() {
    if (saveTimer) {
      cancelSave();
      return doSave();
    }
    return Promise.resolve();
  }
  function setHint(text) {
    savedHint.textContent = text;
  }

  function applyColor(id) {
    const safeId = COLOR_BG[id] ? id : 'default';
    surface.style.setProperty('--wr-note-bg', `var(--wr-note-${safeId})`);
  }

  function teardownEditor() {
    if (toolbar) {
      toolbar.destroy();
      toolbar = null;
    }
    if (editor) {
      editor.destroy();
      editor = null;
    }
    toolbarMount.replaceChildren();
    bodyMount.replaceChildren();
  }

  async function openNote(next, { focusTitle = false, readOnly = false, readOnlyLabel = 'Read-only' } = {}) {
    await flush();
    teardownEditor();
    closeMore();
    note = next;

    placeholder.hidden = true;
    surface.hidden = false;

    // Read-only mode (AI phase 4): staged _inbox/ notes are view-only — no edits
    // flow back, so disable inputs and don't wire autosave. The promote/discard
    // actions live in the sidebar inbox section, not the editor.
    surface.classList.toggle('is-readonly', readOnly);
    titleInput.value = note.title || '';
    titleInput.readOnly = readOnly;
    titleInput.disabled = readOnly;
    cardColor.setValue(note.color);
    applyColor(note.color);
    tagEditor.setTags(note.tags || []);
    // Due control: read-only views (staged/archived) can't edit it.
    dueInput.value = normalizeDue(note.due);
    dueInput.disabled = readOnly;
    updateDueControl();
    dueWrap.hidden = readOnly;
    // Archive is a normal-note action; hide it on read-only/sticky surfaces.
    archiveBtn.hidden = !onArchive || sticky || readOnly;
    updateProvenance(note);
    setHint(readOnly ? readOnlyLabel : note.modified ? `Saved ${formatModified(note.modified)}` : '');

    editor = createEditor({
      element: bodyMount,
      content: note.body || '',
      editable: !readOnly,
      onUpdate: (ed) => {
        if (!note || readOnly) return;
        note.body = getMarkdown(ed);
        scheduleSave();
        toolbar?.update();
      },
      onSelectionUpdate: () => toolbar?.update(),
    });
    // Toolbar would offer edits that can't be saved in read-only mode; skip it.
    if (!readOnly) {
      toolbar = createToolbar({ editor });
      toolbarMount.appendChild(toolbar.element);
    }

    if (focusTitle && !readOnly) {
      titleInput.focus();
    }
  }

  function clear() {
    cancelSave();
    teardownEditor();
    closeMore();
    tagEditor.clear();
    note = null;
    surface.hidden = true;
    placeholder.hidden = false;
  }

  function destroy() {
    cancelSave();
    teardownEditor();
    closeMore();
  }

  return {
    element: root,
    openNote,
    flush,
    clear,
    focusTitle: () => titleInput.focus(),
    getNote: () => note,
    // True while a debounced save is queued — lets callers (cross-window sync)
    // avoid clobbering in-progress local edits with a remote re-read.
    hasPendingSave: () => saveTimer !== null,
    destroy,
  };
}
