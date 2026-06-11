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

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));
const SAVE_DELAY = 500;

export function createNoteEditor({
  onSave,
  onDelete,
  onExport,
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

  // Pop-out button (Sticky Float Phase 2) — opens the note in its own floating
  // window. Main app only: hidden in sticky mode (a sticky can't pop itself
  // out) and when no onPopOut handler was wired.
  const popOutBtn = document.createElement('button');
  popOutBtn.type = 'button';
  popOutBtn.className = 'sc-iconbtn';
  popOutBtn.title = 'Pop out into its own window';
  popOutBtn.setAttribute('aria-label', 'Pop out note into its own window');
  popOutBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 4l-8 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  popOutBtn.hidden = sticky || !onPopOut;
  popOutBtn.addEventListener('click', async () => {
    if (!note) return;
    // Flush pending edits so the popped-out window reads the latest content.
    await flush();
    onPopOut?.(note);
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

  // Sticky chrome is slim: title + color + toolbar + body only. Hide export and
  // delete in a sticky window (those actions stay in the main app).
  if (sticky) {
    exportBtn.hidden = true;
    deleteBtn.hidden = true;
  }

  actions.append(popOutBtn, exportBtn, deleteBtn);
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
  const savedHint = document.createElement('span');
  savedHint.className = 'sc-saved-hint';
  savedHint.setAttribute('aria-live', 'polite');
  colorRow.append(cardColor.element, savedHint);

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

  // Tag row is part of the full editor only — a sticky keeps slim chrome.
  if (sticky) tagEditor.element.hidden = true;

  surface.append(head, colorRow, tagEditor.element, toolbarMount, bodyMount);
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
    if (note === target) setHint(`Saved ${formatModified(target.modified)}`);
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

  async function openNote(next, { focusTitle = false, readOnly = false } = {}) {
    await flush();
    teardownEditor();
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
    setHint(readOnly ? 'Staged · read-only' : note.modified ? `Saved ${formatModified(note.modified)}` : '');

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
    tagEditor.clear();
    note = null;
    surface.hidden = true;
    placeholder.hidden = false;
  }

  function destroy() {
    cancelSave();
    teardownEditor();
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
