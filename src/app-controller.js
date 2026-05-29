// app-controller.js
// Shared orchestration for both the PWA (two-panel on desktop) and the Chrome
// extension popup (single-panel; the <=640px layout in style.css kicks in
// automatically at the popup's 400px width). Entry points pass a mount root.
//
// Phase 2b.1: CRUD goes through a StorageAdapter (FileSystem or Drive) rather
// than directly to notes-store.js. The adapter API speaks raw .md text;
// app-controller bridges that to the parsed-note shape the UI consumes.
// Multi-device sync (pull-on-resume, conflict detection) is Phase 2b.2.

import {
  isSupported,
  parseNote,
  serializeNote,
  firstLineOf,
  exportNoteDownload,
  CARD_COLORS,
} from './notes-store.js';
import {
  ADAPTER_TYPES,
  NoBackendConfiguredError,
  AdapterAuthError,
  FileSystemAdapter,
  DriveAdapter,
  getActiveAdapter,
  resolveBackend,
  setStoredBackend,
  clearStoredBackend,
} from './storage/index.js';
import {
  initTokenClient,
  requestAccessToken,
  revokeToken,
  isSignedIn,
  isIosStandalonePwa,
} from './oauth/index.js';
import { createNotesList } from './ui/notes-list.js';
import { createNoteEditor } from './ui/note-editor.js';
import { createKanbanView } from './ui/kanban-view.js';
import { confirmDialog } from './ui/dialog.js';
import { addTagToNote, parseTag, getAllTags, getAllNamespaces } from './tags/tag-parser.js';
import { getStoredTheme, cycleTheme, initTheme } from './theme.js';

const KOFI = 'https://ko-fi.com/abaker421';
const VIEW_MODE_KEY = 'wren.viewMode';

export function createApp({ root, enableServiceWorker = false }) {
  /** @type {import('./storage/StorageAdapter.js').StorageAdapter|null} */
  let adapter = null;
  let notes = [];
  let list = null;
  let noteEditor = null;
  let appEl = null;
  let installPrompt = null;
  let currentScreen = null;
  let backendChipEl = null;
  let driveBannerEl = null;
  let kanbanView = null;
  let viewToggleEl = null;
  let viewMode = loadViewMode(); // 'list' | 'kanban'
  let lastEffectiveMode = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
  });

  initTheme();
  mountThemeToggle();
  mountInstallButton();
  mountOpenFullApp();

  // View-mode keyboard shortcuts (only act once the app shell is mounted).
  // NOTE: Ctrl+1/Ctrl+2 are browser tab-switch shortcuts in a normal tab; in
  // the standalone PWA window (the primary full-app context) there are no tabs
  // so the override is harmless. Documented as a known caveat.
  window.addEventListener('keydown', (e) => {
    if (!kanbanView) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key === '1') {
      e.preventDefault();
      setViewMode('list');
    } else if (e.key === '2') {
      e.preventDefault();
      setViewMode('kanban');
    }
  });

  // Re-apply view mode only when crossing the 640px breakpoint (force list
  // below it), so resize-drag doesn't thrash the board re-render.
  window.addEventListener('resize', () => {
    if (!kanbanView) return;
    if (effectiveViewMode() !== lastEffectiveMode) applyViewMode();
  });

  boot();

  function themeLabel(t) {
    return t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark';
  }

  function themeIcon(t) {
    if (t === 'light') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
    }
    if (t === 'dark') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/></svg>';
  }

  function mountThemeToggle() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-theme-toggle';
    btn.setAttribute('aria-label', 'Change theme');
    const render = () => {
      const t = getStoredTheme();
      btn.innerHTML = `${themeIcon(t)}<span>${themeLabel(t)}</span>`;
      btn.title = `Theme: ${themeLabel(t)} (click to cycle)`;
    };
    btn.addEventListener('click', () => {
      cycleTheme();
      render();
    });
    render();
    document.body.appendChild(btn);
  }

  function mountInstallButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-install-button';
    btn.setAttribute('aria-label', 'Install Wren as an app');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Install</span>`;
    btn.title = 'Install Wren — folder permission then persists across sessions.';

    const render = () => {
      btn.hidden = !canInstall();
    };

    btn.addEventListener('click', async () => {
      if (!installPrompt) return;
      try {
        await installPrompt.prompt();
        await installPrompt.userChoice;
      } catch (err) {
        console.warn('Install prompt failed', err);
      }
      installPrompt = null;
      render();
      if (currentScreen) currentScreen();
    });

    // Re-render when beforeinstallprompt fires (event may fire AFTER mount).
    window.addEventListener('beforeinstallprompt', () => render());
    // Also re-render when the app becomes installed (event fires once on first install).
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      render();
    });

    render();
    document.body.appendChild(btn);
  }

  function mountOpenFullApp() {
    if (!isExtensionPopup()) return;
    const a = document.createElement('a');
    a.className = 'sc-open-full-app';
    a.href = 'https://wren-ckn.pages.dev/';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'Open Wren in a full browser tab';
    a.setAttribute('aria-label', 'Open Wren in a full browser tab');
    a.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg><span>Open Full App</span>`;
    document.body.appendChild(a);
  }

  function isInstalled() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches ||
      window.navigator.standalone === true
    );
  }

  function canInstall() {
    return !isInstalled() && installPrompt !== null;
  }

  /**
   * True when Wren is running inside the MV3 extension popup (chrome.runtime
   * is only populated in extension contexts; in the PWA / Vite dev server it
   * is undefined). Used to render the "Open Full App" affordance only where
   * it makes sense.
   */
  function isExtensionPopup() {
    return (
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      !!chrome.runtime.id
    );
  }

  function buildInstallSection() {
    if (!canInstall()) return null;
    const frag = document.createDocumentFragment();
    const hint = document.createElement('p');
    hint.className = 'sc-hint';
    hint.textContent =
      'Tip: install Wren as an app and your folder permission persists — no more re-granting every session.';
    const btn = document.createElement('button');
    btn.className = 'sc-btn sc-btn--ghost';
    btn.textContent = 'Install Wren';
    btn.addEventListener('click', async () => {
      if (!installPrompt) return;
      try {
        await installPrompt.prompt();
        await installPrompt.userChoice;
      } catch (err) {
        console.warn('Install prompt failed', err);
      }
      installPrompt = null;
      if (currentScreen) currentScreen();
    });
    frag.append(hint, btn);
    return frag;
  }

  /* ---- Boot ------------------------------------------------------------- */

  async function boot() {
    // Resolve the configured backend (applies fs-migration heuristic).
    const backend = await resolveBackend();
    if (backend === null) return renderStorageChoice();

    if (backend === ADAPTER_TYPES.FS) {
      if (!isSupported()) return renderUnsupported();
      const fs = new FileSystemAdapter();
      await fs.initialize();
      if (await fs.isReady()) {
        adapter = fs;
        await renderApp();
        return;
      }
      // Has a handle but permission isn't granted; show reconnect.
      // Or has no handle at all (rare — implies someone cleared the dir handle
      // but kept the backend pref). Either way, ask the user to pick again.
      return renderFsReconnect(fs);
    }

    if (backend === ADAPTER_TYPES.DRIVE) {
      // Try silent token re-acquire first.
      try {
        await initTokenClient({ onTokenChange: handleTokenChange });
        if (!isSignedIn()) {
          try {
            await requestAccessToken({ silent: true });
          } catch {
            // Silent failed — user needs to re-tap to sign in.
            return renderDriveSignIn({ reason: 'expired' });
          }
        }
        const drive = new DriveAdapter();
        await drive.initialize();
        adapter = drive;
        await renderApp();
      } catch (err) {
        if (err instanceof AdapterAuthError) {
          return renderDriveSignIn({ reason: 'expired' });
        }
        console.error('Drive boot failed', err);
        return renderDriveSignIn({ reason: 'error', error: err });
      }
    }
  }

  /* ---- Screens --------------------------------------------------------- */

  function screenShell(innerNode) {
    root.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'sc-app';
    const screen = document.createElement('div');
    screen.className = 'sc-screen';
    screen.style.gridColumn = '1 / -1';
    screen.appendChild(innerNode);
    wrap.appendChild(screen);
    root.append(wrap, buildFooter());
  }

  function renderUnsupported() {
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Browser not supported</h1>
      <p>Wren needs the <strong>File System Access API</strong> for local-file
      storage, or you can use Drive sync from any browser.</p>`;
    const driveBtn = document.createElement('button');
    driveBtn.className = 'sc-btn sc-btn--primary';
    driveBtn.textContent = 'Use Google Drive';
    driveBtn.addEventListener('click', () => renderDriveSignIn({ reason: 'fresh' }));
    card.appendChild(driveBtn);
    screenShell(card);
  }

  function renderStorageChoice() {
    currentScreen = renderStorageChoice;
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Where should your notes live?</h1>
      <p>You can change this later from the app shell.</p>`;

    const grid = document.createElement('div');
    grid.className = 'sc-choice-grid';

    // Local files card.
    const local = document.createElement('div');
    local.className = 'sc-choice-card';
    const localTitle = document.createElement('div');
    localTitle.className = 'sc-choice-card-title';
    localTitle.textContent = 'Save to my computer';
    const localSub = document.createElement('p');
    localSub.className = 'sc-choice-card-sub';
    localSub.textContent =
      'Notes live as .md files on this PC. Browser must support the File System Access API. Won’t sync to other devices.';
    const localBtn = document.createElement('button');
    localBtn.className = 'sc-btn sc-btn--primary';
    localBtn.textContent = 'Choose folder';
    if (!isSupported()) {
      localBtn.disabled = true;
      localBtn.title = 'This browser doesn’t support the File System Access API.';
    }
    localBtn.addEventListener('click', async () => {
      try {
        const fs = new FileSystemAdapter();
        await fs.chooseFolder();
        await setStoredBackend(ADAPTER_TYPES.FS);
        adapter = fs;
        await renderApp();
      } catch (err) {
        if (err?.name !== 'AbortError') {
          console.error('Folder pick failed', err);
          alert('Could not open that folder. Please try again.');
        }
      }
    });
    local.append(localTitle, localSub, localBtn);

    // Drive card.
    const drive = document.createElement('div');
    drive.className = 'sc-choice-card';
    const driveTitle = document.createElement('div');
    driveTitle.className = 'sc-choice-card-title';
    driveTitle.textContent = 'Save to Google Drive';
    const driveSub = document.createElement('p');
    driveSub.className = 'sc-choice-card-sub';
    driveSub.textContent =
      'Notes live in your Drive under a "Wren Notes" folder. Sync across phone and computer. Works in any browser.';
    const driveBtn = document.createElement('button');
    driveBtn.className = 'sc-btn sc-btn--primary';
    driveBtn.textContent = 'Sign in to Google Drive';
    driveBtn.addEventListener('click', () => renderDriveSignIn({ reason: 'fresh' }));
    drive.append(driveTitle, driveSub, driveBtn);

    grid.append(local, drive);
    card.appendChild(grid);

    // Why-choose expandable.
    const details = document.createElement('details');
    details.className = 'sc-choice-why';
    const summary = document.createElement('summary');
    summary.textContent = 'Why choose?';
    details.appendChild(summary);
    const ul = document.createElement('ul');
    ul.innerHTML = `
      <li><strong>Local files</strong> never leave your computer. No account needed.</li>
      <li><strong>Drive</strong> syncs your notes across devices, including phone.</li>
      <li>Drive uses a narrow <code>drive.file</code> scope — Wren only sees its own "Wren Notes" folder, never the rest of your Drive.</li>
      <li>You can switch later from the chip in the sidebar header.</li>`;
    details.appendChild(ul);
    card.appendChild(details);

    const install = buildInstallSection();
    if (install) card.appendChild(install);

    screenShell(card);
  }

  function renderFsReconnect(fs) {
    currentScreen = () => renderFsReconnect(fs);
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Reconnect your notes folder</h1>
      <p>Your browser needs you to confirm access to your notes folder again.</p>`;
    const grant = document.createElement('button');
    grant.className = 'sc-btn sc-btn--primary';
    grant.textContent = 'Grant access';
    grant.addEventListener('click', async () => {
      try {
        await fs.reconnect();
        adapter = fs;
        await renderApp();
      } catch (err) {
        if (err?.name !== 'AbortError' && !(err instanceof AdapterAuthError)) {
          console.error('Reconnect failed', err);
        }
      }
    });
    const choose = document.createElement('button');
    choose.className = 'sc-btn sc-btn--ghost';
    choose.style.marginLeft = '8px';
    choose.textContent = 'Choose a different folder';
    choose.addEventListener('click', async () => {
      try {
        await fs.chooseFolder();
        adapter = fs;
        await renderApp();
      } catch (err) {
        if (err?.name !== 'AbortError') alert('Could not open that folder.');
      }
    });
    card.append(grant, choose);
    const install = buildInstallSection();
    if (install) card.appendChild(install);
    screenShell(card);
  }

  function renderDriveSignIn({ reason = 'fresh', error } = {}) {
    currentScreen = () => renderDriveSignIn({ reason, error });
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    const headline =
      reason === 'expired'
        ? 'Sign back in to Google Drive'
        : reason === 'error'
          ? 'Could not connect to Google Drive'
          : 'Connect Google Drive';
    const sub =
      reason === 'expired'
        ? 'Your previous session expired. Sign in again to load your notes.'
        : reason === 'error'
          ? 'Something went wrong while contacting Google. Try again, or switch to local files.'
          : 'You’ll be redirected to Google to grant access to a "Wren Notes" folder in your Drive. Wren only ever sees files inside that folder.';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>${headline}</h1>
      <p>${sub}</p>`;

    const signIn = document.createElement('button');
    signIn.className = 'sc-btn sc-btn--primary';
    signIn.textContent = 'Sign in to Google Drive';
    signIn.addEventListener('click', () => startDriveSignIn(signIn));

    const switchBtn = document.createElement('button');
    switchBtn.className = 'sc-btn sc-btn--ghost';
    switchBtn.style.marginLeft = '8px';
    switchBtn.textContent = 'Use local files instead';
    switchBtn.addEventListener('click', async () => {
      await clearStoredBackend();
      renderStorageChoice();
    });

    card.append(signIn, switchBtn);

    if (reason === 'error' && error) {
      const detail = document.createElement('p');
      detail.className = 'sc-hint';
      detail.style.color = 'var(--wr-panel-muted)';
      detail.textContent = `Error: ${error.message || String(error)}`;
      card.appendChild(detail);
    }

    screenShell(card);
  }

  /**
   * Click-handler-context Drive sign-in. On iOS standalone PWAs, an extra
   * confirmation modal is required so the user-activation chain survives into
   * the requestAccessToken call (Decision P2c.1).
   */
  async function startDriveSignIn(triggerBtn) {
    if (isIosStandalonePwa()) {
      const proceed = await confirmDialog({
        title: 'Connect to Google Drive?',
        message:
          'Tap Continue to open Google’s sign-in window. Wren needs this extra tap on iOS.',
        confirmLabel: 'Continue',
      });
      if (!proceed) return;
      // We are now in the modal-confirm click handler.
      await completeDriveSignIn(triggerBtn);
    } else {
      await completeDriveSignIn(triggerBtn);
    }
  }

  async function completeDriveSignIn(triggerBtn) {
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = 'Opening sign-in window…';
    }
    try {
      await initTokenClient({ onTokenChange: handleTokenChange });
      await requestAccessToken({ silent: false });
      const drive = new DriveAdapter();
      await drive.initialize();
      adapter = drive;
      await setStoredBackend(ADAPTER_TYPES.DRIVE);
      await renderApp();
    } catch (err) {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = 'Sign in to Google Drive';
      }
      if (err?.code === 'popup_blocked') {
        alert(
          'Sign-in window didn’t open. Allow pop-ups for this site (or tap the Sign in button again).'
        );
      } else if (err?.code === 'no_token') {
        // User dismissed the consent dialog. Silently return — the screen
        // is already showing the sign-in button.
      } else {
        console.error('Drive sign-in failed', err);
        renderDriveSignIn({ reason: 'error', error: err });
      }
    }
  }

  /* ---- Main app -------------------------------------------------------- */

  async function renderApp() {
    currentScreen = renderApp;
    root.replaceChildren();

    appEl = document.createElement('div');
    appEl.className = 'sc-app';
    appEl.dataset.view = 'list';

    driveBannerEl = buildDriveBanner();
    if (driveBannerEl) appEl.appendChild(driveBannerEl);

    const sidebar = document.createElement('aside');
    sidebar.className = 'sc-sidebar';
    sidebar.appendChild(buildBrand());
    sidebar.appendChild(buildViewToggle());

    list = createNotesList({
      onSelect: (noteId) => openNote(noteId),
      onNew: () => handleNew(),
    });
    sidebar.appendChild(list.element);

    const main = document.createElement('main');
    main.className = 'sc-main';
    noteEditor = createNoteEditor({
      onSave: handleSave,
      onDelete: handleDelete,
      onExport: (note) => exportNoteDownload(note),
      onBack: () => {
        appEl.dataset.view = 'list';
        list.setActive(null);
      },
      getTagSuggestions: tagSuggestions,
      showBack: true,
    });
    kanbanView = createKanbanView({
      getNotes: () => notes,
      onNoteOpen: (id) => {
        setViewMode('list');
        openNote(id);
      },
      onNewNote: () => {
        setViewMode('list');
        handleNew();
      },
      onMoveNote: handleKanbanMove,
    });
    main.append(noteEditor.element, kanbanView.element);

    appEl.append(sidebar, main);
    root.append(appEl, buildFooter());

    applyViewMode();
    await loadNotes();
    if (effectiveViewMode() === 'kanban') kanbanView.refresh();
  }

  /* ---- View mode (list | kanban) -------------------------------------- */

  function loadViewMode() {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === 'kanban' ? 'kanban' : 'list';
    } catch {
      return 'list';
    }
  }

  // Below 640px (e.g. extension popup) Kanban is out of scope — force list.
  function effectiveViewMode() {
    if (window.matchMedia('(max-width: 640px)').matches) return 'list';
    return viewMode;
  }

  function setViewMode(mode) {
    viewMode = mode === 'kanban' ? 'kanban' : 'list';
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      /* ignore */
    }
    applyViewMode();
  }

  function applyViewMode() {
    if (!noteEditor || !kanbanView) return;
    const mode = effectiveViewMode();
    const kanban = mode === 'kanban';
    // Use style.display (not [hidden]) — both panels set display:flex, which
    // would otherwise win over the hidden attribute.
    noteEditor.element.style.display = kanban ? 'none' : '';
    kanbanView.element.style.display = kanban ? '' : 'none';
    if (appEl) appEl.dataset.viewmode = mode;
    if (kanban) kanbanView.refresh();
    updateViewToggle(mode);
    lastEffectiveMode = mode;
  }

  function buildViewToggle() {
    const wrap = document.createElement('div');
    wrap.className = 'sc-viewtoggle';
    const listBtn = document.createElement('button');
    listBtn.type = 'button';
    listBtn.dataset.mode = 'list';
    listBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span>List</span>';
    listBtn.addEventListener('click', () => setViewMode('list'));
    const kanbanBtn = document.createElement('button');
    kanbanBtn.type = 'button';
    kanbanBtn.dataset.mode = 'kanban';
    kanbanBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/></svg><span>Kanban</span>';
    kanbanBtn.addEventListener('click', () => setViewMode('kanban'));
    wrap.append(listBtn, kanbanBtn);
    viewToggleEl = wrap;
    return wrap;
  }

  function updateViewToggle(mode) {
    if (!viewToggleEl) return;
    const m = mode || effectiveViewMode();
    for (const btn of viewToggleEl.querySelectorAll('button')) {
      btn.classList.toggle('is-active', btn.dataset.mode === m);
    }
  }

  /**
   * Autocomplete source for the editor's tag input. Returns full raw tags
   * ("status:todo") plus namespace prefixes ("status:") so the user can either
   * pick a complete tag or start a namespace and get its values next. Drawn
   * from every loaded note; recomputed each time the editor opens.
   */
  function tagSuggestions() {
    const prefixes = getAllNamespaces(notes)
      .filter((ns) => ns !== '_uncategorized')
      .map((ns) => `${ns}:`);
    return Array.from(new Set([...prefixes, ...getAllTags(notes)]));
  }

  /**
   * Eager-load every note via the active adapter and bridge to the UI shape
   * the sidebar list / editor expect:
   *
   *   { id, filename, title, body, color, created, modified, firstLine, revision }
   *
   * For FS the cost is essentially zero (already a directory scan). For Drive
   * this is N+1 HTTP calls (listNotes + one readNote per note); acceptable for
   * Phase 2b.1's single-device scope, will be optimized in 2b.2.
   */
  async function loadNotes() {
    try {
      const metas = await adapter.listNotes();
      const hydrated = await Promise.all(
        metas.map(async (m) => {
          try {
            const { content, revision } = await adapter.readNote(m.id);
            const parsed = parseNote(content, m.id);
            return {
              id: m.id,
              // 'filename' kept as an alias for backwards compatibility inside
              // legacy helpers (exportNoteDownload). UI now reads .id.
              filename: m.id,
              title: parsed.title || m.title || '',
              body: parsed.body,
              color: parsed.color || m.color || 'default',
              created: parsed.created || m.created,
              modified: m.modified || parsed.modified,
              tags: parsed.tags || [],
              firstLine: firstLineOf(parsed.body),
              revision: revision || m.revision,
            };
          } catch (err) {
            // Skip unreadable notes but keep the row in the list so the user
            // sees something. listNotes already filtered out kind!=file/.md.
            console.warn('Could not read note for sidebar hydration', m.id, err);
            return null;
          }
        })
      );
      notes = hydrated.filter(Boolean);
      notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        notes = [];
        showDriveDisconnected();
        return;
      }
      console.error('Failed to list notes', err);
      notes = [];
    }
    list.setNotes(notes);
  }

  async function openNote(noteId, { focusTitle = false } = {}) {
    let fresh;
    try {
      const { content, revision } = await adapter.readNote(noteId);
      const parsed = parseNote(content, noteId);
      fresh = {
        id: noteId,
        filename: noteId,
        title: parsed.title,
        body: parsed.body,
        color: parsed.color,
        created: parsed.created,
        modified: parsed.modified,
        tags: parsed.tags || [],
        firstLine: firstLineOf(parsed.body),
        revision,
      };
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      console.warn('Could not read note', err);
      await loadNotes();
      return;
    }
    const idx = notes.findIndex((n) => n.id === noteId);
    if (idx !== -1) notes[idx] = fresh;
    await noteEditor.openNote(fresh, { focusTitle });
    list.setActive(noteId);
    appEl.dataset.view = 'editor';
  }

  async function handleNew() {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to create new notes.');
      return;
    }
    try {
      const now = new Date().toISOString();
      const seed = { title: '', body: '', color: 'default', created: now, modified: now, tags: [] };
      const content = serializeNote({ ...seed, filename: '' });
      const { id, revision } = await adapter.createNote(content, { title: seed.title });
      const note = {
        id,
        filename: id,
        title: seed.title,
        body: seed.body,
        color: seed.color,
        created: seed.created,
        modified: seed.modified,
        tags: seed.tags,
        firstLine: '',
        revision,
      };
      notes.unshift(note);
      list.setNotes(notes);
      await openNote(id, { focusTitle: true });
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      console.error('Could not create note', err);
      alert('Could not create a new note.');
    }
  }

  async function handleSave(note) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to save changes.');
      return;
    }
    // Bump modified at write time (mirrors legacy notes-store.writeNote).
    note.modified = new Date().toISOString();
    const content = serializeNote(note);
    try {
      const { revision } = await adapter.writeNote(note.id, content);
      note.revision = revision;
      note.firstLine = firstLineOf(note.body);
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      // ConflictError is technically possible but Phase 2b.1 doesn't surface
      // conflicts — last-write-wins per spec. Log and move on.
      console.error('Save failed', err);
      return;
    }
    notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    list.setNotes(notes);
    list.setActive(note.id);
  }

  async function handleDelete(note) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to delete notes.');
      return;
    }
    try {
      await adapter.deleteNote(note.id);
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      console.error('Delete failed', err);
      alert('Could not delete the note.');
      return;
    }
    notes = notes.filter((n) => n.id !== note.id);
    list.setNotes(notes);
    noteEditor.clear();
    list.setActive(null);
    appEl.dataset.view = 'list';
  }

  /**
   * Kanban drag-drop handler. Re-tags a note when its card is dropped into a
   * column. Dropping into a value column adds/replaces `namespace:value`
   * (addTagToNote drops any prior tag in that namespace); dropping into the
   * "_untagged" column removes the namespace tag entirely.
   *
   * Idempotent: a drop back into the origin column is a no-op (no write).
   */
  async function handleKanbanMove(noteId, namespace, value) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to move notes.');
      return;
    }
    try {
      const { content } = await adapter.readNote(noteId);
      const parsed = parseNote(content, noteId);
      let updated;
      if (value === '_untagged') {
        updated = {
          ...parsed,
          tags: (parsed.tags || []).filter((t) => {
            const tp = parseTag(t);
            return !tp || tp.namespace !== namespace;
          }),
        };
      } else {
        updated = addTagToNote(parsed, `${namespace}:${value}`);
      }

      // Skip the write when nothing changed (dropped into the same column).
      const before = JSON.stringify((parsed.tags || []).slice().sort());
      const after = JSON.stringify((updated.tags || []).slice().sort());
      if (before === after) return;

      updated.modified = new Date().toISOString();
      const res = await adapter.writeNote(noteId, serializeNote(updated));

      // Keep the in-memory model in sync so both the board and the sidebar
      // list reflect the move without a full reload.
      const n = notes.find((x) => x.id === noteId);
      if (n) {
        n.tags = updated.tags;
        n.modified = updated.modified;
        n.revision = res.revision;
      }
      notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
      list.setNotes(notes);
      kanbanView.refresh();
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      console.error('Kanban move failed', err);
    }
  }

  /* ---- Drive-disconnected fallback (Decision P2c.5) ------------------- */

  let driveDisconnected = false;

  function isDriveDisconnected() {
    return driveDisconnected;
  }

  function handleTokenChange(token) {
    if (adapter?.backendId() !== ADAPTER_TYPES.DRIVE) return;
    if (token === null && !driveDisconnected) {
      showDriveDisconnected();
    } else if (token !== null && driveDisconnected) {
      driveDisconnected = false;
      if (driveBannerEl) driveBannerEl.hidden = true;
      // Re-load notes from Drive now that we have a token again.
      loadNotes();
    }
  }

  function showDriveDisconnected() {
    driveDisconnected = true;
    if (driveBannerEl) {
      driveBannerEl.hidden = false;
    }
    if (list) {
      // Visual cue: disable the New Note button by toggling the data attribute
      // the CSS targets via [data-disconnected].
      list.element.dataset.disconnected = 'true';
    }
  }

  function showDriveDisconnectedToast(msg) {
    // Lightweight toast: temporary div, auto-removes. No persistent state.
    const toast = document.createElement('div');
    toast.className = 'sc-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function buildDriveBanner() {
    if (adapter?.backendId() !== ADAPTER_TYPES.DRIVE) return null;
    const banner = document.createElement('div');
    banner.className = 'sc-drive-banner';
    banner.hidden = true; // shown only when token is invalid
    const text = document.createElement('span');
    text.textContent = 'Drive connection lost.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reconnect';
    btn.addEventListener('click', () => completeDriveSignIn(null));
    banner.append(text, btn);
    return banner;
  }

  /* ---- Chrome ---------------------------------------------------------- */

  function buildBrand() {
    const brand = document.createElement('div');
    brand.className = 'sc-brand';
    brand.innerHTML = `<img src="./icon.svg" alt="" /><div class="sc-brand-text"><span class="sc-brand-name">Wren</span><span class="sc-brand-tagline">Local-first sticky notes</span></div>`;
    backendChipEl = buildBackendChip();
    if (backendChipEl) brand.appendChild(backendChipEl);
    // Open Full App link is now persistent (mountOpenFullApp), not in-brand.
    return brand;
  }

  function buildBackendChip() {
    if (!adapter) return null;
    const isDrive = adapter.backendId() === ADAPTER_TYPES.DRIVE;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sc-backend-chip';
    chip.setAttribute('aria-label', isDrive ? 'Storage: Google Drive' : 'Storage: Local files');
    const icon = isDrive
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6.5 6.5 0 0 0 4 13.5 4.5 4.5 0 0 0 8.5 19z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    chip.innerHTML = `${icon}<span>${isDrive ? 'Google Drive' : 'Local files'}</span>`;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openBackendPopover(chip);
    });
    return chip;
  }

  function openBackendPopover(anchor) {
    const isDrive = adapter?.backendId() === ADAPTER_TYPES.DRIVE;

    // Close any existing popover first.
    document.querySelectorAll('.sc-popover').forEach((el) => el.remove());

    const pop = document.createElement('div');
    pop.className = 'sc-popover';
    pop.setAttribute('role', 'menu');

    const rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.left = `${rect.left}px`;

    const switchItem = document.createElement('button');
    switchItem.type = 'button';
    switchItem.className = 'sc-popover-item';
    switchItem.textContent = 'Switch backend…';
    switchItem.addEventListener('click', async () => {
      pop.remove();
      const target = isDrive ? 'local files' : 'Google Drive';
      const ok = await confirmDialog({
        title: 'Switch storage backend?',
        message: `Wren will reload and start with no notes (this device only). Your existing notes stay where they are — you can switch back any time. Continue switching to ${target}?`,
        confirmLabel: 'Switch',
      });
      if (!ok) return;
      await clearStoredBackend();
      window.location.reload();
    });
    pop.appendChild(switchItem);

    if (isDrive) {
      const disconnect = document.createElement('button');
      disconnect.type = 'button';
      disconnect.className = 'sc-popover-item sc-popover-item--danger';
      disconnect.textContent = 'Disconnect Drive';
      disconnect.addEventListener('click', async () => {
        pop.remove();
        const ok = await confirmDialog({
          title: 'Disconnect Google Drive?',
          message:
            'Wren will sign out and revoke its access to your Drive. Your notes remain in the "Wren Notes" folder on Drive — they’re just not connected here anymore. You’ll be returned to the storage-choice screen.',
          confirmLabel: 'Disconnect',
          danger: true,
        });
        if (!ok) return;
        await revokeToken();
        await clearStoredBackend();
        window.location.reload();
      });
      pop.appendChild(disconnect);
    }

    document.body.appendChild(pop);

    // Dismiss on outside click / Escape.
    const dismiss = (ev) => {
      if (ev.type === 'keydown' && ev.key !== 'Escape') return;
      if (ev.type === 'click' && pop.contains(ev.target)) return;
      pop.remove();
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
    };
    // Defer so the originating click doesn't immediately re-trigger dismiss.
    setTimeout(() => {
      document.addEventListener('click', dismiss, true);
      document.addEventListener('keydown', dismiss, true);
    }, 0);
  }

  function buildFooter() {
    const footer = document.createElement('footer');
    footer.className = 'sc-footer';
    footer.innerHTML = `
      <a href="${KOFI}" target="_blank" rel="noopener" class="sc-footer-bwb">Build with Baker</a>
      <span class="sc-footer-dot">·</span>
      <a href="${KOFI}" target="_blank" rel="noopener" class="sc-footer-kofi">☕ Support on Ko-fi</a>`;
    return footer;
  }

  /* ---- Service worker -------------------------------------------------- */
  if (enableServiceWorker && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
    });
  }
}
