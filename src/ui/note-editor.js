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
import { createSaveQueue } from './save-queue.js';
import { dueStatus, normalizeDue } from '@/due.js';

const COLOR_BG = Object.fromEntries(CARD_COLORS.map((c) => [c.id, c.bg]));
const SAVE_DELAY = 500;

// Position a (position:fixed) dropdown just under its trigger, right edges
// aligned, flipping ABOVE the trigger when it would overflow the viewport
// bottom. Fixed positioning escapes the editor surface's overflow:hidden clip,
// so items are never cut off in a short window (audit U11). Call after the menu
// is visible (offsetHeight must be measurable).
function positionDropdown(menuEl, triggerEl) {
  const r = triggerEl.getBoundingClientRect();
  menuEl.style.left = 'auto';
  menuEl.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  const h = menuEl.offsetHeight;
  const below = r.bottom + 4;
  menuEl.style.top =
    below + h <= window.innerHeight - 8 ? `${below}px` : `${Math.max(8, r.top - h - 4)}px`;
}

export function createNoteEditor({
  onSave,
  onDelete,
  onExport,
  onArchive,
  onBack,
  onPopOut,
  onOpenInApp,
  onCheckUpdates,
  onTitleChange,
  getTagSuggestions,
  showBack = false,
  sticky = false,
}) {
  let note = null;
  let editor = null;
  let toolbar = null;
  let saveTimer = null;
  // Set in sticky mode to a closer for the Tags popover (see color-row section).
  let closeTagPopoverRef = null;
  // Tracks the open note's read-only state so applyHideState() can keep the Due
  // control hidden in read-only views regardless of the per-note hide flag.
  let currentReadOnly = false;

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

  // Pop out (main app only). Flush pending edits first so the popped-out window
  // reads the latest content.
  if (onPopOut) {
    const popOutItem = document.createElement('button');
    popOutItem.type = 'button';
    popOutItem.className = 'sc-editor-more-item';
    popOutItem.setAttribute('role', 'menuitem');
    popOutItem.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 4l-8 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Pop out into its own window</span>';
    popOutItem.addEventListener('click', async () => {
      closeMore();
      if (!note) return;
      await flush();
      onPopOut(note);
    });
    moreMenu.appendChild(popOutItem);
  }

  // Open in the Wren app (pop-out window only): focus/raise the main window on
  // this note. The host wires the actual navigation.
  if (onOpenInApp) {
    const openInAppItem = document.createElement('button');
    openInAppItem.type = 'button';
    openInAppItem.className = 'sc-editor-more-item';
    openInAppItem.setAttribute('role', 'menuitem');
    openInAppItem.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg><span>Open in Wren app</span>';
    openInAppItem.addEventListener('click', async () => {
      closeMore();
      if (!note) return;
      await flush();
      onOpenInApp(note);
    });
    moreMenu.appendChild(openInAppItem);
  }

  // Per-note display toggles (Hide due date / Hide tags). Checkbox menu items —
  // available on every editable surface (main + pop-out) so a note can be
  // decluttered and, crucially, un-hidden from wherever it's open.
  function buildHideToggle(labelText, getState, setState) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'sc-editor-more-item sc-editor-more-item--check';
    item.setAttribute('role', 'menuitemcheckbox');
    item.setAttribute('aria-checked', 'false');
    const check = document.createElement('span');
    check.className = 'sc-editor-more-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-11"/></svg>';
    const label = document.createElement('span');
    label.textContent = labelText;
    item.append(check, label);
    item.addEventListener('click', () => {
      if (!note) return;
      const next = !getState();
      setState(next);
      item.setAttribute('aria-checked', next ? 'true' : 'false');
      applyHideState();
      scheduleSave();
    });
    item.syncState = () => item.setAttribute('aria-checked', getState() ? 'true' : 'false');
    return item;
  }
  const hideDueItem = buildHideToggle(
    'Hide due date',
    () => !!note?.hideDue,
    (v) => {
      note.hideDue = v;
    }
  );
  const hideTagsItem = buildHideToggle(
    'Hide tags',
    () => !!note?.hideTags,
    (v) => {
      note.hideTags = v;
    }
  );
  moreMenu.append(hideDueItem, hideTagsItem);

  // Check for updates (desktop app only — the host passes this handler solely in
  // Tauri; a PWA/extension auto-updates). Opens the Build with Baker download
  // page in the external browser. Separated from the toggles above with a rule.
  if (onCheckUpdates) {
    const updateItem = document.createElement('button');
    updateItem.type = 'button';
    updateItem.className = 'sc-editor-more-item sc-editor-more-item--sep';
    updateItem.setAttribute('role', 'menuitem');
    updateItem.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg><span>Check for updates</span>';
    updateItem.addEventListener('click', () => {
      closeMore();
      onCheckUpdates();
    });
    moreMenu.appendChild(updateItem);
  }

  function syncMoreItems() {
    hideDueItem.syncState();
    hideTagsItem.syncState();
  }

  moreWrap.append(moreBtn, moreMenu);
  // Shown on every editable surface (the hide toggles always apply). Hidden only
  // in read-only views — handled in openNote via updateMoreVisibility().
  moreWrap.hidden = false;

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
    syncMoreItems();
    moreMenu.hidden = false;
    positionDropdown(moreMenu, moreBtn);
    moreBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClickForMore, true);
    document.addEventListener('keydown', onKeyForMore, true);
    // A fixed menu doesn't track its trigger on scroll/resize — close it so it
    // never drifts away from the ⋯ button.
    window.addEventListener('scroll', closeMore, true);
    window.addEventListener('resize', closeMore);
  }
  function closeMore() {
    moreMenu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClickForMore, true);
    document.removeEventListener('keydown', onKeyForMore, true);
    window.removeEventListener('scroll', closeMore, true);
    window.removeEventListener('resize', closeMore);
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
      message: `"${note.title || 'Untitled'}" will be moved to Trash — a .trash folder in your notes folder (or Drive's trash) — so you can restore it later.`,
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

  // Formatting-bar toggle: collapses ONLY the Tiptap formatting bar (bold,
  // etc.) so a note can be read/written without that chrome. The color swatches
  // and the Due control are deliberately NOT collapsed; they stay visible.
  // State is remembered across sessions.
  const FORMAT_COLLAPSED_KEY = 'wren.formatCollapsed';
  let formatCollapsed = false;
  try {
    formatCollapsed = localStorage.getItem(FORMAT_COLLAPSED_KEY) === 'true';
  } catch {
    /* ignore */
  }
  const formatToggle = document.createElement('button');
  formatToggle.type = 'button';
  formatToggle.className = 'sc-format-toggle';
  formatToggle.title = 'Show or hide the formatting bar';
  formatToggle.setAttribute('aria-label', 'Show or hide the formatting bar');
  formatToggle.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  function applyFormatCollapsed() {
    surface.classList.toggle('is-format-collapsed', formatCollapsed);
    formatToggle.setAttribute('aria-expanded', formatCollapsed ? 'false' : 'true');
  }
  formatToggle.addEventListener('click', () => {
    formatCollapsed = !formatCollapsed;
    try {
      localStorage.setItem(FORMAT_COLLAPSED_KEY, formatCollapsed ? 'true' : 'false');
    } catch {
      /* ignore */
    }
    applyFormatCollapsed();
  });

  const savedHint = document.createElement('span');
  savedHint.className = 'sc-saved-hint';
  savedHint.setAttribute('aria-live', 'polite');

  // Pop-out (sticky) tags control: the slim window has no inline tag row, so a
  // small "Tags" button above the Due control opens a popover holding the tag
  // editor. Built here; the editor element is moved into the popover once it
  // exists (below). No-op in the main app, which keeps its inline tag row.
  let tagsBtn = null;
  let tagPopover = null;
  if (sticky) {
    tagsBtn = document.createElement('button');
    tagsBtn.type = 'button';
    tagsBtn.className = 'sc-tags-btn';
    tagsBtn.title = 'Tags';
    tagsBtn.setAttribute('aria-haspopup', 'true');
    tagsBtn.setAttribute('aria-expanded', 'false');
    tagsBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 12 22l-9-9V3h10z"/><circle cx="7.5" cy="7.5" r="1.3"/></svg><span>Tags</span>';
    tagPopover = document.createElement('div');
    tagPopover.className = 'sc-tags-popover';
    tagPopover.hidden = true;

    const onDocClickForTags = (e) => {
      if (!tagPopover.contains(e.target) && e.target !== tagsBtn && !tagsBtn.contains(e.target)) {
        closeTagPopover();
      }
    };
    const onKeyForTags = (e) => {
      if (e.key === 'Escape') {
        closeTagPopover();
        tagsBtn.focus();
      }
    };
    function closeTagPopover() {
      tagPopover.hidden = true;
      tagsBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClickForTags, true);
      document.removeEventListener('keydown', onKeyForTags, true);
      window.removeEventListener('scroll', closeTagPopover, true);
      window.removeEventListener('resize', closeTagPopover);
    }
    tagsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tagPopover.hidden) {
        if (note?.hideTags) return; // nothing to manage while tags are hidden
        tagPopover.hidden = false;
        positionDropdown(tagPopover, tagsBtn);
        tagsBtn.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', onDocClickForTags, true);
        document.addEventListener('keydown', onKeyForTags, true);
        window.addEventListener('scroll', closeTagPopover, true);
        window.addEventListener('resize', closeTagPopover);
      } else {
        closeTagPopover();
      }
    });
    closeTagPopoverRef = closeTagPopover;
  }

  // Color swatches + Due/Tags live in the color row and stay visible; the
  // formatting-bar toggle now lives at the head of the toolbar row (below), so
  // collapsing the bar no longer hides the colors. Right side differs by
  // surface: the main app pins the Due control; a sticky stacks the Tags button
  // above the Due control (CSS right-aligns the stack).
  if (sticky) {
    const stickyMeta = document.createElement('div');
    stickyMeta.className = 'sc-sticky-meta';
    const tagsRow = document.createElement('div');
    tagsRow.className = 'sc-sticky-meta-tags';
    tagsRow.append(tagsBtn, tagPopover);
    stickyMeta.append(tagsRow, dueWrap);
    colorRow.append(cardColor.element, stickyMeta);
  } else {
    colorRow.append(cardColor.element, dueWrap);
  }

  function updateDueControl() {
    const status = dueStatus(note?.due || '');
    dueWrap.dataset.status = status; // '', 'overdue', 'today', 'upcoming'
    dueClear.hidden = !(note && note.due);
  }

  // Apply the per-note hide toggles to the live controls. Due stays hidden in
  // read-only views regardless. In the main app "hide tags" hides the inline tag
  // editor; in a sticky it hides the "Tags" button (and closes its popover).
  function applyHideState() {
    dueWrap.hidden = currentReadOnly || !!note?.hideDue;
    if (sticky) {
      if (tagsBtn) tagsBtn.hidden = !!note?.hideTags;
      if (note?.hideTags) closeTagPopoverRef?.();
    } else {
      tagEditor.element.hidden = !!note?.hideTags;
    }
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

  // Tag editor placement differs by surface. Main app: inline in the tag row.
  // Sticky: relocated into the Tags popover (built in the color-row section),
  // reached via the small "Tags" button above the Due control.
  const tagRow = document.createElement('div');
  tagRow.className = 'sc-editor-tagrow';
  if (sticky && tagPopover) {
    tagPopover.appendChild(tagEditor.element);
    tagRow.append(savedHint);
  } else {
    tagRow.append(tagEditor.element, savedHint);
  }

  // The formatting-bar toggle sits at the head of the toolbar row, next to the
  // first formatting button, as its own outlined button. Collapsing hides only
  // the formatting bar (.sc-toolbar); the colors and Due control stay put.
  const toolbarRow = document.createElement('div');
  toolbarRow.className = 'sc-toolbar-row';
  toolbarRow.append(formatToggle, toolbarMount);
  // Provenance ("Updated ... by you") sits at the very bottom of the surface,
  // below the editor body, out of the way of the title/tag/save controls.
  surface.append(head, colorRow, tagRow, toolbarRow, bodyMount, provenanceEl);
  root.append(placeholder, surface);

  // --- save scheduling ------------------------------------------------------
  // Saves are SERIALIZED through a queue: each runSave() runs only after the
  // previous one settles, so a debounced save and a flush()-triggered save can
  // never overlap (overlapping writes could interleave and lose the newer body).
  const saveQueue = createSaveQueue(runSave);

  function scheduleSave() {
    setHint('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveQueue.enqueue();
    }, SAVE_DELAY);
  }
  function cancelSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  async function runSave() {
    if (!note) return;
    const target = note;
    try {
      // onSave returns true on a confirmed write, false on failure. (Legacy
      // callers that return undefined are treated as success for back-compat.)
      const result = await onSave?.(target);
      if (result === false) {
        // The write did NOT reach disk. Never paint the "Updated … by you"
        // provenance for a failed save — that is the silent-data-loss bug. Show
        // a persistent "Not saved" state and leave the note dirty so the next
        // edit re-arms the debounce and retries.
        if (note === target) setHint('Not saved — will retry on next edit');
        return;
      }
      // onSave (app-controller handleSave) stamped modified + human provenance on
      // the same note object; reflect it in the provenance panel. The transient
      // "Saving…" hint is cleared once saved — the "Updated … by you" provenance
      // line below is the single resting record, so we don't show a duplicate
      // "Saved <time>" next to an identical "Updated <time>".
      if (note === target) {
        updateProvenance(target);
        setHint('');
      }
    } catch (err) {
      // Never let a save rejection break the chain (it would strand later saves).
      console.warn('Autosave failed', err);
      if (note === target) setHint('Not saved — will retry on next edit');
    }
  }
  // Flush any pending save immediately (e.g. when leaving the note) AND await the
  // whole chain, so callers know both the queued and any in-flight write finished.
  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveQueue.enqueue();
    }
    return saveQueue.settle();
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
    closeTagPopoverRef?.();
    note = next;
    currentReadOnly = readOnly;

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
    // Per-note hide toggles + roll-up state, and the ⋮ menu (hidden read-only).
    applyHideState();
    applyFormatCollapsed();
    syncMoreItems();
    moreWrap.hidden = readOnly;
    // Archive is a normal-note action; hide it on read-only/sticky surfaces.
    archiveBtn.hidden = !onArchive || sticky || readOnly;
    updateProvenance(note);
    // No persistent "Saved <time>" — the provenance "Updated … by you" line is
    // the resting record. Only the read-only label lingers here.
    setHint(readOnly ? readOnlyLabel : '');

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
    closeTagPopoverRef?.();
    tagEditor.clear();
    note = null;
    surface.hidden = true;
    placeholder.hidden = false;
  }

  function destroy() {
    cancelSave();
    teardownEditor();
    closeMore();
    closeTagPopoverRef?.();
  }

  return {
    element: root,
    openNote,
    flush,
    clear,
    focusTitle: () => titleInput.focus(),
    getNote: () => note,
    // True while a debounced save is queued OR a write is in flight — lets
    // callers (cross-window sync) avoid clobbering in-progress local edits with
    // a remote re-read while a save is still settling.
    hasPendingSave: () => saveTimer !== null || saveQueue.isRunning(),
    destroy,
  };
}
