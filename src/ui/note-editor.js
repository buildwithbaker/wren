// note-editor.js
// The editor panel: title input, color picker, export/delete actions, Tiptap
// toolbar + body. Owns a working copy of the open note and emits debounced
// save requests; the parent performs the actual disk write.
// Returns { element, openNote, flush, clear, focusTitle, destroy }.

import { createEditor, getMarkdown } from '@/editor.js';
import { createToolbar } from './toolbar.js';
import { createCardColorPicker } from './color-picker.js';
import { confirmDialog } from './dialog.js';
import { CARD_COLORS } from '@/notes-store.js';
import { formatModified } from './format.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));
const SAVE_DELAY = 500;

export function createNoteEditor({ onSave, onDelete, onExport, onBack, showBack = false }) {
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
    scheduleSave();
  });

  const actions = document.createElement('div');
  actions.className = 'sc-editor-actions';

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

  actions.append(exportBtn, deleteBtn);
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

  // Toolbar + editor body mounts
  const toolbarMount = document.createElement('div');
  toolbarMount.className = 'sc-toolbar-mount';
  const bodyMount = document.createElement('div');
  bodyMount.className = 'sc-editor-body';

  surface.append(head, colorRow, toolbarMount, bodyMount);
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
    const bg = COLOR_BG[id] || COLOR_BG.default;
    surface.style.setProperty('--sc-note-bg', bg);
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

  async function openNote(next, { focusTitle = false } = {}) {
    await flush();
    teardownEditor();
    note = next;

    placeholder.hidden = true;
    surface.hidden = false;

    titleInput.value = note.title || '';
    cardColor.setValue(note.color);
    applyColor(note.color);
    setHint(note.modified ? `Saved ${formatModified(note.modified)}` : '');

    editor = createEditor({
      element: bodyMount,
      content: note.body || '',
      onUpdate: (ed) => {
        if (!note) return;
        note.body = getMarkdown(ed);
        scheduleSave();
        toolbar?.update();
      },
      onSelectionUpdate: () => toolbar?.update(),
    });
    toolbar = createToolbar({ editor });
    toolbarMount.appendChild(toolbar.element);

    if (focusTitle) {
      titleInput.focus();
    }
  }

  function clear() {
    cancelSave();
    teardownEditor();
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
    destroy,
  };
}
