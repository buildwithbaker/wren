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
  buildNoteFilename,
  getStoredDirHandle,
  isStoragePersisted,
} from './notes-store.js';
import {
  ADAPTER_TYPES,
  AdapterAuthError,
  ConflictError,
  FileSystemAdapter,
  TauriFsAdapter,
  DriveAdapter,
  resolveBackend,
  chooseFsAdapter,
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
import { createCompactView } from './ui/compact-view.js';
import { createPinButton } from './ui/pin-button.js';
import { isTauri, openExternal } from './platform.js';
import { applyWindowSize, watchResize, applyPinnedAtBoot } from './tauri-window.js';
import { setupDesktopIntegration, maybeNotifyDueNotes } from './desktop.js';
import { openShortcutsDialog } from './ui/desktop-panel.js';
import { openArchiveDialog } from './ui/archive-panel.js';
import { confirmDialog } from './ui/dialog.js';
import { isModalOpen } from './ui/focus-trap.js';
import { addTagToNote, parseTag, getAllTags, getAllNamespaces } from './tags/tag-parser.js';
import { getStoredTheme, cycleTheme, initTheme } from './theme.js';
import { getSyncState, setSyncState, clearSyncState } from './sync/syncStateStore.js';
import { createBroadcast } from './sync/broadcast.js';
import { writeConflictCopy } from './sync/conflictDetection.js';
import { openSticky } from './sticky/opener.js';
import { readRegistry, clearRegistry } from './sticky/registry.js';
import {
  buildIndexJson,
  buildIndexMarkdown,
  INDEX_JSON_NAME,
  INDEX_MD_NAME,
} from './ai/note-index.js';
import {
  buildAiContractDoc,
  AI_CONTRACT_DOC_NAME,
  AI_CONTRACT_VERSION,
} from './ai/ai-contract-doc.js';

const KOFI = 'https://ko-fi.com/abaker421';
const VIEW_MODE_KEY = 'wren.viewMode';

// Drive is demoted to an opt-in, experimental backend (local is the default).
// One label + one warning string, reused on every surface that can switch to
// Drive (onboarding, sign-in screen, backend popover) so the messaging cannot
// drift between them.
const DRIVE_EXPERIMENTAL_LABEL = 'Cloud sync (experimental)';
const DRIVE_EXPERIMENTAL_WARNING =
  'Experimental — may not sync reliably across devices; expect occasional issues. ' +
  'Your notes stay local unless you turn this on.';

export function createApp({ root, enableServiceWorker = false }) {
  /** @type {import('./storage/StorageAdapter.js').StorageAdapter|null} */
  let adapter = null;
  let notes = [];
  let inboxNotes = []; // staged _inbox/ notes (AI phase 4), kept separate
  let archiveNotes = []; // _archive/ notes (Note Lifecycle B), loaded on demand
  let list = null;
  let noteEditor = null;
  let appEl = null;
  let installPrompt = null;
  let flushOnHideBound = false;
  let currentScreen = null;
  let backendChipEl = null;
  let skipLinkEl = null;
  // Set synchronously the first time setupDesktop() runs; desktopIntegration
  // itself only lands when the async setup resolves.
  let desktopSetupStarted = false;
  let driveBannerEl = null;
  let kanbanView = null;
  let compactView = null;
  let viewToggleEl = null;
  let compactBtnEl = null; // Standalone Compact (window-mode) button, beside the pin
  let sidebarPin = null; // Expanded-view always-on-top toggle (Tauri only)
  let desktopIntegration = null; // tray/hotkey/autostart bridge (Tauri only; stub in browser)
  // Session view: 'list' | 'kanban' | 'compact'. Only 'list'|'kanban' are ever
  // persisted (wren.viewMode = the "full mode" memory); 'compact' is a session-
  // only landing layer set on every launch and never written to localStorage.
  let viewMode = loadViewMode(); // boot value is the stored full mode
  let lastEffectiveMode = null;
  // Live cross-window note sync (Sticky Float Phase 2). Created once on first
  // renderApp; peers' saves refresh the list/editor here.
  let broadcast = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
  });

  initTheme();
  mountThemeToggle();
  mountInstallButton();
  mountOpenFullApp();

  // View-mode keyboard shortcuts (only act once the app shell is mounted).
  //
  // Ctrl+1/2/3 switch browser tabs. Wren used to bind them unconditionally and
  // call that a documented caveat, which meant that in an ordinary tab the app
  // silently ate a shortcut the browser owns and the user did not agree to give
  // up (audit S15). The binding is now installed only where there are no tabs to
  // steal from: an installed PWA window, or the Tauri desktop shell. In a normal
  // browser tab Ctrl+1/2/3 goes back to doing what the browser says it does.
  window.addEventListener('keydown', (e) => {
    if (!kanbanView) return;
    if (!isTablessWindow()) return;
    // Stand down while a modal is open — the view switch must not fire
    // "underneath" a dialog/panel (audit U10).
    if (isModalOpen()) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key === '1') {
      e.preventDefault();
      setViewMode('list');
    } else if (e.key === '2') {
      e.preventDefault();
      setViewMode('kanban');
    } else if (e.key === '3') {
      e.preventDefault();
      setViewMode('compact');
    }
  });

  // Re-apply view mode only when crossing the 640px breakpoint (force list
  // below it), so resize-drag doesn't thrash the board re-render.
  window.addEventListener('resize', () => {
    if (!kanbanView) return;
    if (effectiveViewMode() !== lastEffectiveMode) applyViewMode();
  });

  boot();

  // First-paint reveal (Tauri desktop only). WebView2 on Windows sometimes
  // withholds the very first frame until an input event, so a freshly launched
  // window shows blank until the user clicks or moves the mouse (observed
  // 2026-07). The native window is created hidden (tauri.conf visible:false)
  // and shown by revealWindow() once a render path has painted; this timer is
  // the safety net so the window still appears even if a render path is slow
  // or stalls, so the user never faces a permanently hidden window.
  let _windowRevealed = false;
  function revealWindow() {
    if (_windowRevealed) return;
    _windowRevealed = true;
    if (!isTauri()) return;
    // Double rAF: wait for the browser to actually paint the mounted DOM before
    // asking the native window to show, so the first visible frame has content.
    requestAnimationFrame(() =>
      requestAnimationFrame(async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        } catch (err) {
          console.warn('revealWindow failed', err);
        }
      })
    );
  }
  setTimeout(revealWindow, 3000);

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
    a.href = 'https://wren.buildwithbaker.io/';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'Open Wren in a full browser tab';
    a.setAttribute('aria-label', 'Open Wren in a full browser tab');
    a.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg><span>Open Full App</span>`;
    document.body.appendChild(a);
    // Marker so the brand header can reserve room for this fixed pill instead of
    // letting it overlap the backend chip at popup width (audit U18).
    document.body.classList.add('has-open-full-app');
  }

  // Inline "Open Full App" affordance for screens that would otherwise offer
  // Google Drive sign-in. Drive's GIS flow injects a remote script that MV3's
  // CSP blocks, so in the extension popup we send users to the full PWA (where
  // Drive works) instead. Opens in a new browser tab.
  function buildOpenFullAppButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-btn sc-btn--primary';
    btn.textContent = 'Open Full App';
    btn.addEventListener('click', () => {
      window.open('https://wren.buildwithbaker.io', '_blank', 'noopener');
    });
    return btn;
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
    // Resolve the configured backend. Unset installs default to local ("fs");
    // an explicit stored "drive" is honored (existing Drive users keep Drive).
    const backend = await resolveBackend();
    if (backend === null) return renderStorageChoice();

    if (backend === ADAPTER_TYPES.FS) {
      // Pick the fs-family adapter: native Tauri folder for a fresh desktop
      // install (zero prompts, auto Documents/Wren Notes), otherwise the browser
      // File System Access adapter (existing desktop users keep their folder;
      // PWA gets the one-time picker).
      let fs;
      try {
        fs = await chooseFsAdapter();
        const isNativeFs = fs instanceof TauriFsAdapter;
        // Only the browser FS-Access path needs the File System Access API + a
        // picker; the native folder adapter needs neither.
        if (!isNativeFs && !isSupported()) return renderUnsupported();
        await fs.initialize();
      } catch (err) {
        // Adapter selection or initialize() failed (e.g. the native folder
        // couldn't be created / read). Route to the storage-choice screen so the
        // user can recover, rather than leaving boot on a blank screen.
        console.error('FS boot failed', err);
        return renderStorageChoice();
      }
      if (await fs.isReady()) {
        adapter = fs;
        await renderApp();
        return;
      }
      // Not ready (FileSystemAdapter only — the native adapter is always ready
      // after initialize, having auto-created its folder). Distinguish THREE
      // cases:
      //   - handle present → existing FS user whose permission lapsed → reconnect
      //   - handle genuinely absent → brand-new install → storage-choice onboarding
      //   - handle store UNREADABLE (read failure) → we do NOT know, so route to
      //     reconnect/retry. NEVER fall through to storage-choice on a read
      //     failure: re-picking there overwrites the real handle (audit S3).
      let stored;
      try {
        stored = await getStoredDirHandle();
      } catch (err) {
        console.error('Reading the saved folder handle failed at boot', err);
        return renderFsReconnect(fs, { readFailed: true });
      }
      if (stored) return renderFsReconnect(fs);
      return renderStorageChoice();
    }

    if (backend === ADAPTER_TYPES.DRIVE) {
      // Try silent token re-acquire first.
      try {
        await initTokenClient({ onTokenChange: handleTokenChange });
        if (!isSignedIn()) {
          try {
            await requestAccessToken({ silent: true });
          } catch (err) {
            // Silent re-acquire failed (common on mobile after the webview
            // sleeps). Log the reason for diagnosis and offer a dedicated
            // one-tap resume rather than the generic sign-in screen (audit S5).
            console.warn('Drive silent token re-acquire failed at boot', err);
            return renderDriveResume({ hint: getStoredLoginHint() });
          }
        }
        const drive = new DriveAdapter();
        await drive.initialize();
        adapter = drive;
        await renderApp();
      } catch (err) {
        if (err instanceof AdapterAuthError) {
          console.warn('Drive session expired at boot', err);
          return renderDriveResume({ hint: getStoredLoginHint() });
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

    // Skip link as the first focusable element, targeting the <main> below
    // (WCAG SC 2.4.1). renderApp() has its own; this covers the onboarding,
    // storage-choice, drive-sign-in, and unsupported screens.
    const skipLink = document.createElement('a');
    skipLink.className = 'sc-skip-link';
    skipLink.href = '#main-content';
    skipLink.textContent = 'Skip to content';
    wrap.appendChild(skipLink);

    // <main> landmark so these screens expose primary content, not just
    // footer chrome (WCAG SC 1.3.1).
    const screen = document.createElement('main');
    screen.className = 'sc-screen';
    screen.id = 'main-content';
    // Skip-link targets need to be able to hold focus, or the anchor scrolls
    // without moving the caret and the next Tab starts from the top again
    // (audit U19 — same reason the main shell's containers carry it).
    screen.tabIndex = -1;
    screen.style.gridColumn = '1 / -1';
    screen.appendChild(innerNode);
    wrap.appendChild(screen);
    root.append(wrap, buildFooter());
    revealWindow();
  }

  function renderUnsupported() {
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Browser not supported</h1>
      <p>Wren’s default local storage needs the <strong>File System Access API</strong>,
      which this browser doesn’t provide. You can still use the experimental Cloud
      sync from any browser.</p>`;
    if (isExtensionPopup()) {
      // Drive sign-in needs the remote GIS script, which MV3's CSP blocks in
      // the popup — offer the full app instead, where Drive works.
      card.appendChild(buildOpenFullAppButton());
    } else {
      const driveBtn = document.createElement('button');
      driveBtn.type = 'button';
      driveBtn.className = 'sc-btn sc-btn--primary';
      driveBtn.textContent = 'Try Cloud sync (experimental)';
      driveBtn.addEventListener('click', () => renderDriveSignIn({ reason: 'fresh' }));
      card.appendChild(driveBtn);
    }
    screenShell(card);
  }

  function renderStorageChoice() {
    currentScreen = renderStorageChoice;
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Where should your notes live?</h1>
      <p>Wren is local-first — your notes are plain <code>.md</code> files on this
      computer. You can change this later from the app shell.</p>`;

    // Local files — the default, primary path.
    const local = document.createElement('div');
    local.className = 'sc-choice-card sc-choice-card--primary';
    const localTitle = document.createElement('div');
    localTitle.className = 'sc-choice-card-title';
    localTitle.textContent = 'Save to my computer';
    const localSub = document.createElement('p');
    localSub.className = 'sc-choice-card-sub';
    localSub.textContent =
      'Notes live as .md files on this PC. No account needed. Browser must support the File System Access API.';
    const localBtn = document.createElement('button');
    localBtn.type = 'button';
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
          showErrorToast('Could not open that folder. Please try again.');
        }
      }
    });
    local.append(localTitle, localSub, localBtn);
    card.appendChild(local);

    // Drive — demoted to a deliberate, collapsed "experimental" disclosure so a
    // new user can't land on it by accident. Opening it is the intentional act.
    const exp = document.createElement('details');
    exp.className = 'sc-experimental';
    const expSummary = document.createElement('summary');
    expSummary.textContent = DRIVE_EXPERIMENTAL_LABEL;
    exp.appendChild(expSummary);

    const warn = document.createElement('p');
    warn.className = 'sc-warn';
    warn.textContent = DRIVE_EXPERIMENTAL_WARNING;
    exp.appendChild(warn);

    if (isExtensionPopup()) {
      // Drive sign-in uses the remote GIS script, which MV3's CSP blocks in the
      // popup. Point users to the full app, where Drive sync works.
      const note = document.createElement('p');
      note.className = 'sc-choice-card-sub';
      note.textContent =
        'Cloud sync isn’t available in the extension popup. Open the full app to turn it on.';
      exp.append(note, buildOpenFullAppButton());
    } else {
      const driveSub = document.createElement('p');
      driveSub.className = 'sc-choice-card-sub';
      driveSub.textContent =
        'Notes sync through your own Google Drive (a "Wren Notes" folder, narrow drive.file scope) so they reach your phone and other computers.';
      const driveBtn = document.createElement('button');
      driveBtn.type = 'button';
      driveBtn.className = 'sc-btn sc-btn--ghost';
      driveBtn.textContent = 'Turn on Cloud sync';
      driveBtn.addEventListener('click', () => renderDriveSignIn({ reason: 'fresh' }));
      exp.append(driveSub, driveBtn);
    }
    card.appendChild(exp);

    // Why-choose expandable.
    const details = document.createElement('details');
    details.className = 'sc-choice-why';
    const summary = document.createElement('summary');
    summary.textContent = 'Why choose?';
    details.appendChild(summary);
    const ul = document.createElement('ul');
    ul.innerHTML = `
      <li><strong>Local files</strong> never leave your computer. No account needed. This is the recommended default.</li>
      <li><strong>Cloud sync (experimental)</strong> syncs your notes across devices, including phone — but it’s not fully reliable yet.</li>
      <li>Cloud sync uses a narrow <code>drive.file</code> scope — Wren only sees its own "Wren Notes" folder, never the rest of your Drive.</li>
      <li>You can switch later from the chip in the sidebar header.</li>`;
    details.appendChild(ul);
    card.appendChild(details);

    const install = buildInstallSection();
    if (install) card.appendChild(install);

    screenShell(card);
  }

  // A promoted "Install Wren" button for the reconnect screen. Installing the
  // PWA is the DURABLE fix for repeated folder re-prompts (permission then
  // persists), so when it's offerable we surface it as a primary CTA. Returns
  // null when install can't be offered (already installed, or no prompt event).
  function buildReconnectInstallCta() {
    if (!canInstall()) return null;
    const btn = document.createElement('button');
    btn.className = 'sc-btn sc-btn--primary';
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
    return btn;
  }

  function renderFsReconnect(fs, { readFailed = false } = {}) {
    currentScreen = () => renderFsReconnect(fs, { readFailed });
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    const heading = readFailed ? 'Couldn’t read your notes folder' : 'Reconnect your notes folder';
    const copy = readFailed
      ? 'Wren couldn’t read your saved folder just now — a temporary storage hiccup, not lost notes. Try again, or reconnect below. Don’t pick a new folder unless you actually want to switch.'
      : 'Your browser needs you to confirm access to your notes folder again.';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>${heading}</h1>
      <p>${copy}</p>`;

    const installed = isInstalled();
    const installCta = installed ? null : buildReconnectInstallCta();

    // Guidance — this screen previously gave none (audit S6). Installed users get
    // told how to stop the prompt for good; browser-tab users are nudged to
    // install (which makes folder permission persist).
    const tip = document.createElement('p');
    tip.className = 'sc-hint';
    if (installed) {
      tip.textContent =
        'When your browser asks, choose “Allow on every visit” so Wren stops prompting each session.';
    } else if (installCta) {
      tip.textContent =
        'Tip: install Wren as an app and your folder permission persists — no more re-granting every session.';
    } else {
      tip.textContent =
        'Tip: install Wren from your browser menu and your folder permission persists across sessions.';
    }
    card.appendChild(tip);

    // On a read failure the recovery is a retry (re-read IndexedDB), not a
    // permission re-grant; reuse the primary button for it.
    const grant = document.createElement('button');
    grant.className = installCta ? 'sc-btn sc-btn--ghost' : 'sc-btn sc-btn--primary';
    grant.textContent = readFailed ? 'Try again' : 'Grant access';
    grant.addEventListener('click', async () => {
      if (readFailed) {
        await boot();
        return;
      }
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
        if (err?.name !== 'AbortError') showErrorToast('Could not open that folder.');
      }
    });

    if (installCta) card.append(installCta, grant, choose);
    else card.append(grant, choose);
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
          : 'Turn on Cloud sync (experimental)';
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

    // Fresh opt-in only: spell out that Cloud sync is experimental. (The
    // expired/error paths are existing Drive users reconnecting — no need to
    // re-warn them on every reconnect.)
    if (reason === 'fresh') {
      const warn = document.createElement('p');
      warn.className = 'sc-warn';
      warn.textContent = DRIVE_EXPERIMENTAL_WARNING;
      card.appendChild(warn);
    }

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

  // The last Google account Wren signed in with, if we ever recorded one, used
  // as a login_hint so a returning user resumes without an account picker. With
  // the drive.file scope Wren can't read the account email, so this stays empty
  // this round (populating it would need an openid/email scope we deliberately
  // avoid); the plumbing is here for when a hint becomes available.
  function getStoredLoginHint() {
    try {
      return localStorage.getItem('wren.driveLoginHint') || '';
    } catch {
      return '';
    }
  }

  /**
   * Dedicated one-tap "Resume with Google" screen for the common mobile case: a
   * dropped/expired Drive session on boot. Simpler than the full sign-in screen
   * (one primary action) and passes a login_hint when known so the returning
   * account is pre-selected. No FedCM this round (audit S5).
   */
  function renderDriveResume({ hint = '' } = {}) {
    currentScreen = () => renderDriveResume({ hint });
    const card = document.createElement('div');
    card.className = 'sc-screen-card';
    card.innerHTML = `
      <img src="./icon.svg" alt="Wren" />
      <h1>Resume your Drive notes</h1>
      <p>Your Google sign-in paused — common on mobile after the app sleeps. Tap to pick up where you left off.</p>`;
    const resume = document.createElement('button');
    resume.className = 'sc-btn sc-btn--primary';
    resume.textContent = 'Resume with Google';
    resume.addEventListener('click', () => startDriveSignIn(resume, { loginHint: hint }));
    const switchBtn = document.createElement('button');
    switchBtn.className = 'sc-btn sc-btn--ghost';
    switchBtn.style.marginLeft = '8px';
    switchBtn.textContent = 'Use local files instead';
    switchBtn.addEventListener('click', async () => {
      await clearStoredBackend();
      renderStorageChoice();
    });
    card.append(resume, switchBtn);
    screenShell(card);
  }

  /**
   * Click-handler-context Drive sign-in. On iOS standalone PWAs, an extra
   * confirmation modal is required so the user-activation chain survives into
   * the requestAccessToken call (Decision P2c.1).
   */
  async function startDriveSignIn(triggerBtn, { loginHint = '' } = {}) {
    if (isIosStandalonePwa()) {
      const proceed = await confirmDialog({
        title: 'Connect to Google Drive?',
        message:
          'Tap Continue to open Google’s sign-in window. Wren needs this extra tap on iOS.',
        confirmLabel: 'Continue',
      });
      if (!proceed) return;
      // We are now in the modal-confirm click handler.
      await completeDriveSignIn(triggerBtn, { loginHint });
    } else {
      await completeDriveSignIn(triggerBtn, { loginHint });
    }
  }

  async function completeDriveSignIn(triggerBtn, { loginHint = '' } = {}) {
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = 'Opening sign-in window…';
    }
    try {
      await initTokenClient({ onTokenChange: handleTokenChange });
      await requestAccessToken({ silent: false, loginHint });
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
        showErrorToast(
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

    const skipLink = document.createElement('a');
    skipLink.className = 'sc-skip-link';
    skipLink.href = '#main-content';
    skipLink.textContent = 'Skip to content';
    appEl.appendChild(skipLink);
    // Retargeted by applyViewMode() — see syncSkipLinkTarget (audit U19).
    skipLinkEl = skipLink;

    driveBannerEl = buildDriveBanner();
    if (driveBannerEl) appEl.appendChild(driveBannerEl);

    const restoreBar = buildRestoreBar();
    if (restoreBar) appEl.appendChild(restoreBar);

    const sidebar = document.createElement('aside');
    sidebar.className = 'sc-sidebar';
    sidebar.appendChild(buildBrand());
    // Header row: the List|Kanban view toggle, with the always-on-top pin
    // clustered right beside it (Tauri only — createPinButton() is null in the
    // PWA, so the pin simply isn't appended there). The Compact (window-mode)
    // button now lives in the footer's bottom-left corner, not here.
    const headRow = document.createElement('div');
    headRow.className = 'sc-sidebar-head';
    headRow.appendChild(buildViewToggle());
    sidebarPin = createPinButton();
    if (sidebarPin) headRow.appendChild(sidebarPin.element);
    sidebar.appendChild(headRow);

    list = createNotesList({
      // In Kanban the editor panel is hidden behind the board, so opening a note
      // from the sidebar there looked like "nothing happened". Switch to List
      // first (mirrors the Kanban card click at onNoteOpen), then open it.
      onSelect: (noteId) => {
        if (effectiveViewMode() === 'kanban') setViewMode('list');
        openNote(noteId);
      },
      // In Kanban the editor is hidden, so opening a new note there looked like
      // "nothing happened". Route Kanban's New note through the pop-out path
      // (desktop) / list fallback (browser); List mode keeps the normal open.
      onNew: () =>
        effectiveViewMode() === 'kanban' ? handleNewPopOut({ from: 'kanban' }) : handleNew(),
      // No pop-out from the extension popup: it can only open another popup.html
      // in a tiny 320×360 window (chrome-extension://…?note=), which just kills
      // the popup rather than floating a sticky (audit E1). Omitting the handler
      // hides the affordance (notes-list guards on `if (onPopOut)`).
      onPopOut: isExtensionPopup() ? undefined : (noteId) => handlePopOut(noteId),
      onArchive: (noteId) => handleArchive(noteId),
      onArchiveOpen: () => openArchiveView(),
      onInboxSelect: (id) => openInboxNote(id),
      onInboxPromote: (id) => handlePromoteInbox(id),
      onInboxDiscard: (id) => handleDiscardInbox(id),
    });
    sidebar.appendChild(list.element);

    const main = document.createElement('main');
    main.className = 'sc-main';
    main.id = 'main-content';
    noteEditor = createNoteEditor({
      onSave: handleSave,
      onDelete: handleDelete,
      onExport: (note) => exportNoteDownload(note),
      onArchive: (note) => handleArchive(note.id),
      onBack: () => {
        appEl.dataset.view = 'list';
        list.setActive(null);
      },
      // Hidden in the extension popup for the same reason as the sidebar
      // affordance above (audit E1); note-editor guards on `if (onPopOut)`.
      onPopOut: isExtensionPopup() ? undefined : (note) => handlePopOut(note),
      // Desktop only: "Check for updates" compares the running version against
      // the latest GitHub Release and prompts to download when behind. In the
      // browser PWA/extension the app auto-updates, so no handler is passed and
      // the menu item doesn't render.
      onCheckUpdates: isTauri() ? () => checkForUpdates() : undefined,
      getTagSuggestions: tagSuggestions,
      showBack: true,
    });
    kanbanView = createKanbanView({
      getNotes: () => notes,
      onNoteOpen: (id) => {
        setViewMode('list');
        openNote(id);
      },
      onMoveNote: handleKanbanMove,
    });
    // Compact view is a full-width sibling of the two-panel layout, shown when
    // data-view='compact'. Card click / + / Expand all route back to the stored
    // full mode (loadViewMode → list|kanban) and then take the normal path.
    // Compact's container needs an id + a focus target so the skip link can
    // point at it on the default landing view (audit U19).
    compactView = createCompactView({
      onSelect: (id) => {
        // Leaving Compact to open a note: restore the full mode, but never land
        // in Kanban — its editor is hidden, so the note would open invisibly
        // (audit U1/U2). Fall back to List, mirroring the sidebar/new-note guards.
        setViewMode(loadViewMode() === 'kanban' ? 'list' : loadViewMode());
        openNote(id);
      },
      // Desktop: pop a fresh sticky out right here (stay in Compact). Browser:
      // fall back to expanding into the full editor. Handled in handleNewPopOut.
      onNew: () => handleNewPopOut({ from: 'compact' }),
      onExpand: () => setViewMode(loadViewMode()),
    });
    main.append(noteEditor.element, kanbanView.element);

    // Flush a pending debounced save when the window/tab is closing or hidden.
    // Without this, typing and closing within the 500ms debounce silently drops
    // the last edit. visibilitychange(hidden) fires while the page can still do
    // work (more reliable than pagehide); pagehide is the last-chance backup.
    // Registered once — the render function can run multiple times.
    if (!flushOnHideBound) {
      flushOnHideBound = true;
      const flushOpen = () => {
        if (noteEditor?.hasPendingSave?.()) noteEditor.flush();
      };
      window.addEventListener('pagehide', flushOpen);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOpen();
      });
    }

    compactView.element.id = 'compact-content';
    compactView.element.tabIndex = -1;
    main.tabIndex = -1;
    appEl.append(sidebar, main, compactView.element);
    root.append(appEl, buildFooter({ compact: true }));
    revealWindow();

    // Default landing view: every launch opens in Compact regardless of the
    // stored full mode. Session-only — assign viewMode directly (not via
    // setViewMode, which is equivalent here, but the intent is "land, don't
    // persist"). The stored list|kanban preference is untouched.
    viewMode = 'compact';
    applyViewMode();
    // Tauri desktop shell: land small (Compact) and persist manual resizes per
    // view. Both calls no-op in the browser PWA / extension (isTauri() false).
    applyWindowSize('compact');
    watchResize(() => effectiveViewMode());
    // Restore the persisted always-on-top ("pin") state on launch (Tauri only).
    applyPinnedAtBoot();
    setupBroadcast();
    setupDesktop();
    await loadNotes();
    if (effectiveViewMode() === 'kanban') kanbanView.refresh();
  }

  // Wire desktop quick-capture (tray "New note" event + global hotkeys +
  // autostart) once. No-op stub in the browser PWA / extension. renderApp may
  // run again (Drive reconnect), so guard against double-registering.
  // Quick-capture (the global new-note hotkey and the tray "New note") always
  // pops out a fresh sticky and never adds a note to the in-app list, so a
  // capture never depends on which view happens to be open.
  function setupDesktop() {
    // Guard on a SYNCHRONOUS flag, not on desktopIntegration: that is only
    // assigned when the setup promise resolves, so a second renderApp() during
    // the Drive-reconnect race (which can fire while the first setup is still
    // in flight) sailed past the check and registered the tray/hotkey handlers
    // — and a second anonymous focus listener that could never be removed —
    // twice over (audit U21).
    if (desktopSetupStarted) return;
    desktopSetupStarted = true;
    setupDesktopIntegration({
      onNewNote: () => handleNewPopOut({ from: 'hotkey' }),
      // Quit-time flush: land any pending debounced save before the app exits.
      onFlush: () => {
        if (noteEditor?.hasPendingSave?.()) noteEditor.flush();
      },
    })
      .then((api) => {
        desktopIntegration = api;
      })
      .catch((err) => console.warn('Desktop integration setup failed', err));
    // Re-check due/overdue notes when the window regains focus (EXE only;
    // no-op in the browser). The once-per-day guard prevents nagging.
    window.addEventListener('focus', () => maybeNotifyDueNotes(notes));
  }

  /* ---- Cross-window sync (Sticky Float Phase 2) ----------------------- */

  // Create the shared channel once (renderApp may run again on Drive reconnect).
  function setupBroadcast() {
    if (broadcast) return;
    broadcast = createBroadcast();
    broadcast.onNoteSaved((msg) => handleRemoteNoteSaved(msg));
  }

  // A peer window (a sticky, or another tab) saved a note. Re-read it via the
  // adapter, refresh the in-memory model + sidebar + board, and — if it's the
  // note open in the editor with no pending local edits — re-open it silently.
  // Last-write-wins; no conflict UI (consistent with Drive Phase 2b.1).
  async function handleRemoteNoteSaved(msg) {
    if (!adapter || isDriveDisconnected()) return;
    let idx = notes.findIndex((n) => n.id === msg.id);
    if (idx === -1 && msg.wrenId) idx = notes.findIndex((n) => n.wrenId === msg.wrenId);
    if (idx === -1) return; // unknown note (e.g. created elsewhere) — caught on next load
    const oldId = notes[idx].id;
    // A rename broadcast carries the note's NEW storage id under the same wrenId
    // (FS renames change the id). Adopt it before reading so we never read — or
    // later write — the stale id (which would 404 or resurrect the old file).
    const currentId = msg.id && msg.id !== oldId ? msg.id : oldId;
    try {
      const { content, revision, name } = await adapter.readNote(currentId);
      const parsed = parseNote(content, currentId);
      const updated = {
        ...notes[idx],
        id: currentId,
        wrenId: parsed.wrenId || notes[idx].wrenId,
        filename: name || (currentId !== oldId ? currentId : notes[idx].filename),
        title: parsed.title,
        body: parsed.body,
        color: parsed.color,
        created: parsed.created || notes[idx].created,
        modified: parsed.modified || notes[idx].modified,
        tags: parsed.tags || [],
        summary: parsed.summary || '',
        due: parsed.due || '',
        hideDue: !!parsed.hideDue,
        hideTags: !!parsed.hideTags,
        firstLine: firstLineOf(parsed.body),
        revision: revision || notes[idx].revision,
      };
      notes[idx] = updated;
      notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
      list.setNotes(notes);
      compactView?.setNotes(notes);
      if (effectiveViewMode() === 'kanban') kanbanView.refresh();
      const open = noteEditor.getNote();
      // Re-open when the editor holds this note under EITHER its old or new id,
      // so a rename adopts the new id in the open editor too.
      if (open && (open.id === updated.id || open.id === oldId) && !noteEditor.hasPendingSave()) {
        await noteEditor.openNote(updated);
      }
      list.setActive(noteEditor.getNote()?.id || null);
      regenerateIndex();
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      console.warn('Remote note-saved refresh failed', err);
    }
  }

  /* ---- Pop-out (Sticky Float Phase 2) --------------------------------- */

  // Open a note in its own floating sticky window. Accepts a note object (from
  // the editor header button) or a note id (from a sidebar card). Flushes the
  // editor first when popping out the currently-open note, then returns the
  // main editor to the empty/list state — the note now "lives" in the sticky.
  async function handlePopOut(noteOrId) {
    const id = typeof noteOrId === 'string' ? noteOrId : noteOrId?.id;
    const note = notes.find((n) => n.id === id) || (typeof noteOrId === 'object' ? noteOrId : null);
    if (!note) return;
    const open = noteEditor.getNote();
    const isOpenNote = open && open.id === note.id;
    if (isOpenNote) await noteEditor.flush();
    const win = openSticky(note);
    if (!win) {
      showToast('Allow pop-ups for Wren to use stickies.');
      return;
    }
    if (isOpenNote) {
      noteEditor.clear();
      list.setActive(null);
      appEl.dataset.view = 'list';
    }
  }

  // Restore bar (Sticky Float Phase 2). Shown above the sidebar when the open-
  // sticky registry is non-empty (best-effort: after a full browser restart the
  // registry persists, so this is the "you had stickies open" signal). The
  // restore click opens ALL of them inside one user gesture so popup blockers
  // permit the batch; "Dismiss" clears the registry.
  function buildRestoreBar() {
    const open = readRegistry();
    if (!open || open.length === 0) return null;
    const bar = document.createElement('div');
    bar.className = 'sc-restore-bar';
    const text = document.createElement('span');
    text.className = 'sc-restore-bar-text';
    text.textContent = `Restore ${open.length} sticky${open.length === 1 ? '' : ' notes'}`;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'sc-btn sc-btn--primary';
    restore.textContent = 'Restore';
    restore.addEventListener('click', () => {
      let blocked = false;
      open.forEach((entry, i) => {
        const win = openSticky({ id: entry.id, wrenId: entry.wrenId }, { cascadeIndex: i });
        if (!win) blocked = true;
      });
      if (blocked) showToast('Allow pop-ups for Wren to restore all stickies.');
      bar.remove();
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'sc-btn sc-btn--ghost';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      clearRegistry();
      bar.remove();
    });
    bar.append(text, restore, dismiss);
    return bar;
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
  // Compact is exempt from that downgrade: it is already the narrow layout.
  function effectiveViewMode() {
    if (viewMode === 'compact') return 'compact';
    if (window.matchMedia('(max-width: 640px)').matches) return 'list';
    return viewMode;
  }

  function setViewMode(mode) {
    if (mode === 'compact') {
      // Session-only landing layer — never written to wren.viewMode.
      viewMode = 'compact';
    } else {
      viewMode = mode === 'kanban' ? 'kanban' : 'list';
      try {
        localStorage.setItem(VIEW_MODE_KEY, viewMode);
      } catch {
        /* ignore */
      }
    }
    applyViewMode();
    // Resize the native window to match the new view (Tauri only; no-op in the
    // browser). Hooked here — at explicit transitions — rather than in
    // applyViewMode so the 640px breakpoint resize handler can't fight a manual
    // drag.
    applyWindowSize(viewMode === 'compact' ? 'compact' : 'expanded');
  }

  function applyViewMode() {
    if (!noteEditor || !kanbanView || !compactView) return;
    const mode = effectiveViewMode();
    const compact = mode === 'compact';
    const kanban = mode === 'kanban';
    // Use style.display (not [hidden]) — both panels set display:flex, which
    // would otherwise win over the hidden attribute.
    noteEditor.element.style.display = compact || kanban ? 'none' : '';
    kanbanView.element.style.display = kanban ? '' : 'none';
    compactView.element.style.display = compact ? '' : 'none';
    if (appEl) {
      appEl.dataset.viewmode = mode;
      // data-view drives the <=640px single-panel toggle (list|editor) and now
      // the compact full-width layout. Only flip it for the compact transition
      // so an open editor's data-view='editor' is preserved otherwise.
      if (compact) appEl.dataset.view = 'compact';
      else if (appEl.dataset.view === 'compact') appEl.dataset.view = 'list';
    }
    if (kanban) kanbanView.refresh();
    if (compact) compactView.setNotes(notes);
    syncSkipLinkTarget(compact);
    // Keep the Expanded-view pin in sync with the persisted state (it may have
    // been toggled from the Compact bar while the sidebar was hidden).
    sidebarPin?.sync();
    updateViewToggle(mode);
    lastEffectiveMode = mode;
  }

  // "Skip to content" pointed at #main-content unconditionally, but Compact —
  // which is the DEFAULT landing view — hides .sc-main outright
  // (.sc-app[data-view='compact'] .sc-main { display: none }). Jumping to a
  // display:none element does nothing: focus stays put and the link is a
  // no-op exactly where a keyboard user meets it first. Retarget it to
  // whichever container is actually on screen. Both targets carry
  // tabindex="-1" so the anchor moves focus, not just the scroll position.
  function syncSkipLinkTarget(compact) {
    if (!skipLinkEl) return;
    skipLinkEl.href = compact ? '#compact-content' : '#main-content';
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

  // Standalone Compact control — NOT a peer of List/Kanban. Compact is the
  // narrow "desk-side panel" window mode, so it lives outside the segmented
  // toggle, beside the pin, with a distinct window-dock icon + label.
  function buildCompactButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-compact-btn';
    btn.dataset.mode = 'compact';
    btn.title = 'Shrink to the compact panel';
    btn.setAttribute('aria-label', 'Switch to the compact panel');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg><span>Compact</span>';
    btn.addEventListener('click', () => setViewMode('compact'));
    compactBtnEl = btn;
    return btn;
  }

  function updateViewToggle(mode) {
    const m = mode || effectiveViewMode();
    if (viewToggleEl) {
      for (const btn of viewToggleEl.querySelectorAll('button')) {
        btn.classList.toggle('is-active', btn.dataset.mode === m);
      }
    }
    if (compactBtnEl) compactBtnEl.classList.toggle('is-active', m === 'compact');
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
            const { content, revision, name } = await adapter.readNote(m.id);
            const parsed = parseNote(content, m.id);
            return {
              id: m.id,
              // Logical wren-id from frontmatter (additive; note.id stays the
              // storage identity). Threaded through so it round-trips on save.
              wrenId: parsed.wrenId || m.wrenId || '',
              // The backend file name. Drive returns it (opaque id != name); FS
              // omits it, so we fall back to the id (which IS the FS filename).
              // Used by exportNoteDownload and the Drive rename-on-title flow.
              filename: name || m.name || m.id,
              title: parsed.title || m.title || '',
              body: parsed.body,
              color: parsed.color || m.color || 'default',
              created: parsed.created || m.created,
              modified: m.modified || parsed.modified,
              tags: parsed.tags || [],
              // AI-readable fields (Phase 1) — threaded through for the Phase 2
              // index so it has summaries/due without extra reads.
              summary: parsed.summary || m.summary || '',
              due: parsed.due || '',
              // Provenance (AI-write visibility) — drives the card AI badge and
              // the open-note last-updated panel.
              createdBy: parsed.createdBy || m.createdBy || '',
              lastEditedBy: parsed.lastEditedBy || m.lastEditedBy || '',
              lastEdited: parsed.lastEdited || m.lastEdited || '',
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
    compactView?.setNotes(notes);
    // Load staged inbox notes alongside the main list (best-effort — a failure
    // here must never break the main notes list).
    await loadInboxNotes();
    // Load the _archive/ count for the sidebar entry (read from disk — archived
    // notes are outside the indexed roots, so the catalog never lists them).
    await loadArchiveNotes();
    // Refresh the AI-readable index after the initial (and any) full load so an
    // external agent sees a current manifest even if no edit has happened yet.
    regenerateIndex();
    // Write the AI contract doc once per session (missing/stale-version check).
    ensureAiContractDoc();
    // Desktop reminder (EXE only): nudge for notes due today/overdue. No-op in
    // the browser — cards already carry the visual due treatment.
    maybeNotifyDueNotes(notes);
  }

  /* ---- Archive (_archive/) — Note Lifecycle B ------------------------- */

  // Load the `_archive/` notes from disk into the archiveNotes collection and
  // update the sidebar entry's count. Crash-safe like loadInboxNotes.
  async function loadArchiveNotes() {
    try {
      if (!adapter || typeof adapter.listArchiveNotes !== 'function') {
        archiveNotes = [];
      } else {
        const archived = await adapter.listArchiveNotes();
        archiveNotes = (archived || []).map((m) => ({
          ...m,
          filename: m.name || m.id,
          firstLine: '',
          tags: m.tags || [],
        }));
      }
    } catch (err) {
      console.warn('Could not load archived notes (main list unaffected)', err);
      archiveNotes = [];
    }
    if (list) list.setArchiveCount(archiveNotes.length);
  }

  // Archive a note: move its file to _archive/, then refresh. If it was open in
  // the editor, drop back to the list (it's no longer in the main corpus).
  async function handleArchive(noteId) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to archive notes.');
      return;
    }
    if (!adapter || typeof adapter.archiveNote !== 'function') return;
    try {
      await adapter.archiveNote(noteId);
    } catch (err) {
      if (routeAuthError(err)) return;
      console.error('Archive failed', err);
      showErrorToast('Could not archive that note.');
      return;
    }
    if (noteEditor.getNote && noteEditor.getNote()?.id === noteId) {
      noteEditor.clear();
      list.setActive(null);
      appEl.dataset.view = 'list';
    }
    // Reload: the note leaves the main list + index, and the archive count bumps.
    await loadNotes();
  }

  // Unarchive: move the file back to the top level. Returns true on success so
  // the Archive dialog can drop the row. Refreshes the main list + index.
  async function handleUnarchive(archiveId) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to unarchive notes.');
      return false;
    }
    if (!adapter || typeof adapter.unarchiveNote !== 'function') return false;
    try {
      await adapter.unarchiveNote(archiveId);
    } catch (err) {
      if (routeAuthError(err)) return false;
      console.error('Unarchive failed', err);
      showErrorToast('Could not unarchive that note.');
      return false;
    }
    await loadNotes();
    return true;
  }

  // Open the Archive view (B3): a dialog listing _archive/ notes with open +
  // unarchive. Notes are the already-loaded archiveNotes (read from disk).
  function openArchiveView() {
    openArchiveDialog({
      notes: archiveNotes,
      onOpen: (id) => openArchivedNote(id),
      onUnarchive: (id) => handleUnarchive(id),
    });
  }

  // Open an archived note read-only (mirrors openInboxNote). Editing happens
  // after unarchiving; the file lives in _archive/ and isn't in the main list.
  async function openArchivedNote(archiveId) {
    try {
      const { content } = await adapter.readNote(archiveId);
      const parsed = parseNote(content, archiveId);
      const fresh = {
        id: archiveId,
        archived: true,
        wrenId: parsed.wrenId || '',
        filename: archiveId,
        title: parsed.title,
        body: parsed.body,
        color: parsed.color,
        created: parsed.created,
        modified: parsed.modified,
        tags: parsed.tags || [],
        summary: parsed.summary || '',
        due: parsed.due || '',
        createdBy: parsed.createdBy || '',
        lastEditedBy: parsed.lastEditedBy || '',
        lastEdited: parsed.lastEdited || '',
        firstLine: firstLineOf(parsed.body),
        revision: '',
        readOnly: true,
      };
      // In Kanban the editor is hidden behind the board, so open would look like
      // "nothing happened" — switch to List first (mirrors the sidebar guard).
      if (effectiveViewMode() === 'kanban') setViewMode('list');
      await noteEditor.openNote(fresh, { readOnly: true, readOnlyLabel: 'Archived · read-only' });
      list.setActive(archiveId);
      appEl.dataset.view = 'editor';
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      console.warn('Could not open archived note', err);
    }
  }

  /* ---- Inbox (_inbox/) — AI write-back staging (phase 4) -------------- */

  // Load the staged `_inbox/` notes into the separate inboxNotes collection and
  // push them to the sidebar. Crash-safe: any failure logs and leaves the inbox
  // empty rather than breaking the main list. Returns nothing.
  async function loadInboxNotes() {
    try {
      if (!adapter || typeof adapter.listInboxNotes !== 'function') {
        inboxNotes = [];
      } else {
        const staged = await adapter.listInboxNotes();
        inboxNotes = (staged || []).map((m) => ({
          ...m,
          // Mirror the main-list shape just enough for rendering + the index.
          filename: m.name || m.id,
          firstLine: '',
          tags: m.tags || [],
        }));
      }
    } catch (err) {
      console.warn('Could not load inbox notes (main list unaffected)', err);
      inboxNotes = [];
    }
    if (list) list.setInboxNotes(inboxNotes);
  }

  // Open a staged note read-only (v1: viewing only; editing is out of scope).
  async function openInboxNote(inboxId) {
    try {
      const { content } = await adapter.readNote(inboxId);
      const parsed = parseNote(content, inboxId);
      const fresh = {
        id: inboxId,
        inbox: true,
        wrenId: parsed.wrenId || '',
        filename: inboxId,
        title: parsed.title,
        body: parsed.body,
        color: parsed.color,
        created: parsed.created,
        modified: parsed.modified,
        tags: parsed.tags || [],
        summary: parsed.summary || '',
        due: parsed.due || '',
        createdBy: parsed.createdBy || '',
        lastEditedBy: parsed.lastEditedBy || '',
        lastEdited: parsed.lastEdited || '',
        firstLine: firstLineOf(parsed.body),
        revision: '',
        readOnly: true,
      };
      // In Kanban the editor is hidden behind the board, so open would look like
      // "nothing happened" — switch to List first (mirrors the sidebar guard).
      if (effectiveViewMode() === 'kanban') setViewMode('list');
      await noteEditor.openNote(fresh, { readOnly: true, readOnlyLabel: 'Staged · read-only' });
      list.setActive(inboxId);
      appEl.dataset.view = 'editor';
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      console.warn('Could not open staged note', err);
    }
  }

  // Promote a staged note into the main corpus, then refresh both lists + index.
  async function handlePromoteInbox(inboxId) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to move notes.');
      return;
    }
    try {
      await adapter.promoteInboxNote(inboxId);
    } catch (err) {
      if (routeAuthError(err)) return;
      console.error('Promote failed', err);
      showErrorToast('Could not move that note into your notes.');
      return;
    }
    // If the promoted note was open in the editor, drop back to the list.
    noteEditor.clear();
    list.setActive(null);
    appEl.dataset.view = 'list';
    // Reload both collections so the note appears in the main list and leaves
    // the inbox; loadNotes also triggers regenerateIndex.
    await loadNotes();
  }

  // Discard (reject) a staged note after a confirm, then refresh.
  async function handleDiscardInbox(inboxId) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to discard notes.');
      return;
    }
    const staged = inboxNotes.find((n) => n.id === inboxId);
    const onDrive = adapter?.backendId() === ADAPTER_TYPES.DRIVE;
    const ok = await confirmDialog({
      title: 'Discard staged note?',
      message: `"${(staged && staged.title) || 'Untitled'}" will be removed from the inbox and moved to ${
        onDrive ? "your Drive's trash" : 'the .trash folder'
      }. Recover it from there if you change your mind.`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      // Soft-delete to match the MCP convention. discardInboxNote moves the file
      // to .trash/ (FS) or Drive's trash (Drive); fall back to deleteNote if an
      // adapter somehow predates it.
      if (typeof adapter.discardInboxNote === 'function') {
        await adapter.discardInboxNote(inboxId);
      } else {
        await adapter.deleteNote(inboxId);
      }
    } catch (err) {
      if (routeAuthError(err)) return;
      console.error('Discard failed', err);
      showErrorToast('Could not discard that staged note.');
      return;
    }
    // If the discarded note was open, clear the editor.
    noteEditor.clear();
    list.setActive(null);
    appEl.dataset.view = 'list';
    await loadInboxNotes();
    regenerateIndex();
  }

  /* ---- AI contract doc (Phase 3) -------------------------------------- */

  // README-for-AI.md is static content keyed to AI_CONTRACT_VERSION — NOT
  // regenerated on every save. We check once per session: write it only when
  // missing or when its first-line version marker is stale. Guarded so repeated
  // loadNotes() calls (e.g. Drive reconnect) don't re-check needlessly.
  let aiContractChecked = false;

  async function ensureAiContractDoc() {
    if (aiContractChecked) return;
    aiContractChecked = true;
    // Hard rule (same as index regen): a contract-doc failure must NEVER break
    // a note operation. Log and continue.
    try {
      if (
        !adapter ||
        typeof adapter.writeManagedFile !== 'function' ||
        typeof adapter.readManagedFile !== 'function'
      ) {
        return;
      }
      if (isDriveDisconnected()) {
        aiContractChecked = false; // retry on a later load once Drive is back
        return;
      }
      const marker = `<!-- wren-ai-contract v${AI_CONTRACT_VERSION} -->`;
      const existing = await adapter.readManagedFile(AI_CONTRACT_DOC_NAME);
      const firstLine = existing ? existing.split('\n', 1)[0] : '';
      if (existing && firstLine.includes(marker)) return; // present & current
      await adapter.writeManagedFile(AI_CONTRACT_DOC_NAME, buildAiContractDoc());
    } catch (err) {
      console.warn('AI contract-doc write failed (note operations unaffected)', err);
    }
  }

  /* ---- AI-readable index (Phase 2) ------------------------------------- */

  // Trailing-debounced regeneration of the Wren-managed catalog files
  // (.wren-index.json + _index.md). Built purely from the in-memory `notes`
  // collection — no extra reads. Coalesces bursts of edits into one write.
  let indexRegenTimer = null;
  const INDEX_REGEN_DELAY = 1500;

  function regenerateIndex() {
    clearTimeout(indexRegenTimer);
    indexRegenTimer = setTimeout(doRegenerateIndex, INDEX_REGEN_DELAY);
  }

  async function doRegenerateIndex() {
    indexRegenTimer = null;
    // Hard rule: index regeneration must NEVER throw into a note operation.
    // A failed managed-file write logs and is dropped — it never blocks or
    // rolls back a note save. Managed files can't re-enter the notes list
    // (isReservedNoteName excludes _index.md / .wren-index.json) so this can
    // never trigger a reload/regen loop.
    try {
      if (!adapter || typeof adapter.writeManagedFile !== 'function') return;
      if (isDriveDisconnected()) return; // no point writing to a dead Drive token
      const backend = adapter.backendId();
      // Combine main + staged notes; inbox entries carry `inbox: true` so the
      // builders flag them (JSON) and partition them under the Inbox heading
      // (markdown). buildIndexJson is async (per-note contentHash hashing);
      // buildIndexMarkdown stays sync (no hashing).
      const combined = [...notes, ...inboxNotes];
      const json = JSON.stringify(await buildIndexJson(combined, backend), null, 2);
      const md = buildIndexMarkdown(combined, backend);
      await adapter.writeManagedFile(INDEX_JSON_NAME, json);
      await adapter.writeManagedFile(INDEX_MD_NAME, md);
    } catch (err) {
      console.warn('Index regeneration failed (note operations unaffected)', err);
    }
  }

  async function openNote(noteId, { focusTitle = false } = {}) {
    let fresh;
    try {
      const { content, revision, name } = await adapter.readNote(noteId);
      const parsed = parseNote(content, noteId);
      fresh = {
        id: noteId,
        // Logical wren-id from frontmatter (additive; note.id stays storage id).
        wrenId: parsed.wrenId || '',
        filename: name || noteId,
        title: parsed.title,
        body: parsed.body,
        color: parsed.color,
        created: parsed.created,
        modified: parsed.modified,
        tags: parsed.tags || [],
        // AI-readable fields (Phase 1) — kept on the in-memory note for the
        // Phase 2 index.
        summary: parsed.summary || '',
        due: parsed.due || '',
        // Per-note display toggles (hide the due/tag display, not the data).
        hideDue: !!parsed.hideDue,
        hideTags: !!parsed.hideTags,
        // Provenance — for the AI badge + last-updated panel.
        createdBy: parsed.createdBy || '',
        lastEditedBy: parsed.lastEditedBy || '',
        lastEdited: parsed.lastEdited || '',
        firstLine: firstLineOf(parsed.body),
        revision,
      };
    } catch (err) {
      if (routeAuthError(err)) return;
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

  // Create a blank note, insert it at the top of the model, and refresh the
  // sidebar/index. Returns the new note, or null on failure. Does NOT change the
  // view or open the editor — callers decide what to do next (open in-place, or
  // pop out into a sticky).
  async function createBlankNote() {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to create new notes.');
      return null;
    }
    try {
      const now = new Date().toISOString();
      const seed = {
        title: '',
        body: '',
        color: 'default',
        created: now,
        modified: now,
        tags: [],
        summary: '',
        due: '',
        hideDue: false,
        hideTags: false,
        createdBy: 'human',
        lastEditedBy: 'human',
        lastEdited: now,
        filename: '',
      };
      const content = serializeNote(seed);
      const { id, revision, name } = await adapter.createNote(content, {
        title: seed.title,
        created: seed.created,
      });
      const note = {
        id,
        wrenId: seed.wrenId,
        filename: name || id,
        title: seed.title,
        body: seed.body,
        color: seed.color,
        created: seed.created,
        modified: seed.modified,
        tags: seed.tags,
        summary: seed.summary,
        due: seed.due,
        hideDue: seed.hideDue,
        hideTags: seed.hideTags,
        createdBy: seed.createdBy,
        lastEditedBy: seed.lastEditedBy,
        lastEdited: seed.lastEdited,
        firstLine: '',
        revision,
      };
      notes.unshift(note);
      list.setNotes(notes);
      compactView?.setNotes(notes);
      regenerateIndex();
      return note;
    } catch (err) {
      if (routeAuthError(err)) return null;
      console.error('Could not create note', err);
      showErrorToast('Could not create a new note.');
      return null;
    }
  }

  // Sidebar / List "New note": create and open the note in the editor.
  async function handleNew() {
    const note = await createBlankNote();
    if (note) await openNote(note.id, { focusTitle: true });
  }

  // Compact / Kanban "New note". On the DESKTOP app the expected behaviour is a
  // fresh sticky card popping out right there — so create the note and pop it
  // out, leaving the current view in place. In the browser PWA/extension we do
  // NOT auto-open a popup (popups there are blocker-prone and unwanted): fall
  // back to opening the note in the full editor so it's visible.
  //
  // @param {{ from: 'compact' | 'kanban' | 'hotkey' }} opts
  async function handleNewPopOut({ from }) {
    const note = await createBlankNote();
    if (!note) return;
    if (isTauri()) {
      const win = openSticky(note);
      if (!win) showToast('Allow pop-ups for Wren to use stickies.');
      // Keep the current board/compact view; just reflect the new note in it.
      if (from === 'kanban' && effectiveViewMode() === 'kanban') kanbanView.refresh();
      return;
    }
    // Browser fallback: surface the note in the full editor. Never land in
    // Kanban (its editor is hidden → the new note would open invisibly); fall
    // back to List.
    const restore = from === 'compact' ? loadViewMode() : 'list';
    setViewMode(restore === 'kanban' ? 'list' : restore);
    await openNote(note.id, { focusTitle: true });
  }

  // Returns true when the write reached disk, false on any failure. The editor
  // (note-editor.doSave) relies on this boolean: a false result stops it from
  // painting the "Updated … by you" provenance on a note that never saved.
  async function handleSave(note) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to save changes.');
      return false;
    }
    // Bump modified at write time (mirrors legacy notes-store.writeNote).
    note.modified = new Date().toISOString();
    // This is a human edit in the app: stamp human provenance so the
    // last-updated panel reads "by you" and an AI-edited note flips back to
    // human on the next manual edit. created_by is preserved (an AI-CREATED
    // note keeps its AI badge via created_by even after a human edits it).
    note.lastEditedBy = 'human';
    note.lastEdited = note.modified;
    const content = serializeNote(note);
    try {
      // Pass the note's known revision so the adapter can detect a concurrent
      // write (another window / editor / device) and throw ConflictError rather
      // than blindly overwriting the winner's changes.
      const { revision } = await adapter.writeNote(note.id, content, note.revision);
      note.revision = revision;
      note.firstLine = firstLineOf(note.body);
      await syncBackendFilename(note);
    } catch (err) {
      // A revoked backend permission must route to the matching reconnect
      // screen — Drive session expiry OR File System Access permission loss
      // (the FS adapter now maps NotAllowedError/SecurityError to
      // AdapterAuthError, which previously fell through to the silent branch).
      if (err instanceof AdapterAuthError) {
        if (adapter?.backendId() === ADAPTER_TYPES.DRIVE) showDriveDisconnected();
        else renderFsReconnect(adapter);
        return false;
      }
      // Concurrent-write conflict: preserve this window's unsaved text as a
      // conflict copy (never silently overwrite), then reload the winner.
      if (err instanceof ConflictError) {
        await handleSaveConflict(note, content);
        return false;
      }
      console.error('Save failed', err);
      return false;
    }
    notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    list.setNotes(notes);
    list.setActive(note.id);
    // Covers both content saves and any rename that syncBackendFilename applied
    // (filename/id changes are already reflected on the in-memory note above).
    regenerateIndex();
    // Notify any open sticky/peer window holding this note (Sticky Phase 2).
    broadcast?.postNoteSaved(note);
    return true;
  }

  /**
   * Keep the backend file name in lockstep with the note title.
   *
   * Both adapters expose renameNote, but the identity model differs:
   *   - Drive: noteId is an opaque file ID that never changes — only the file's
   *     display name (tracked on note.filename) updates. No cascade needed.
   *   - FS: noteId *is* the filename, so a rename changes the note's identity.
   *     The new id must propagate to the in-memory notes array, the open editor
   *     note (same object ref as `note` here), list-active state, and the
   *     sync_state store (keyed by noteId).
   *
   * Rename only when the title-derived name actually changed, comparing against
   * the de-dup-stripped current name so a note that already owns a " (N)"
   * suffix isn't re-renamed on every save. Called from handleSave's debounced
   * flow (never per keystroke) after the content write has succeeded.
   * Best-effort: a rename failure must not fail the content save, but an auth
   * failure still routes to the Drive-disconnected UI.
   */
  async function syncBackendFilename(note) {
    if (typeof adapter.renameNote !== 'function') return;
    const desired = buildNoteFilename(note.created, note.title);
    const currentBase = (note.filename || '').replace(/ \(\d+\)(\.md)$/, '$1');
    if (desired === note.filename || desired === currentBase) return;

    let res;
    try {
      res = await adapter.renameNote(note.id, desired);
    } catch (err) {
      if (err instanceof AdapterAuthError) throw err;
      console.warn('Rename failed (content saved OK)', err);
      return;
    }

    const oldId = note.id;
    const newId = res.id || oldId;
    note.filename = res.name || newId;
    if (res.revision) note.revision = res.revision;
    if (newId === oldId) return; // Drive: id is stable, nothing to cascade.

    // FS: the filename *is* the identity, so the id changed. Propagate it.
    note.id = newId;
    const entryInArray = notes.find((n) => n.id === oldId);
    if (entryInArray && entryInArray !== note) entryInArray.id = newId;
    if (list) list.setActive(newId);
    try {
      const prev = await getSyncState(oldId);
      if (prev) {
        await setSyncState(newId, { ...prev });
        await clearSyncState(oldId);
      }
    } catch (err) {
      console.warn('Could not migrate sync state after rename', oldId, '->', newId, err);
    }
  }

  /**
   * A conditional write hit a concurrent change (another window / editor /
   * device wrote this note since we last read it). Syncthing-style resolution:
   * keep whatever is now on disk as the canonical note, preserve THIS window's
   * losing edit as a `.sync-conflict-…` copy so nothing is lost, tell the user
   * where it went, and reload the editor to the winning version.
   *
   * @param {object} note - the in-memory note whose save conflicted
   * @param {string} localContent - the serialized text that failed to save
   */
  async function handleSaveConflict(note, localContent) {
    // Read the winner now on disk. Adopt its revision (so a later save overwrites
    // rather than spawning an endless chain of copies) AND compare content: if
    // our losing edit is byte-identical in the parts that matter, there's nothing
    // to preserve — skip the copy so fresh typing never silently spawns a side
    // file the user thinks ate their edit.
    let diskContent = null;
    try {
      const read = await adapter.readNote(note.id);
      diskContent = read.content;
      note.revision = read.revision;
    } catch {
      /* the note may itself have been renamed/deleted — still preserve below */
    }
    if (diskContent !== null && !noteContentDiffers(localContent, diskContent)) {
      await refreshAfterConflict(note);
      return;
    }
    let copy;
    try {
      copy = await writeConflictCopy(adapter, note, localContent);
    } catch (err) {
      console.error('Could not write conflict copy', err);
      showToast('Edited elsewhere — copy your text; a conflict copy could not be written.');
      return;
    }
    showConflictToast(copy);
    await refreshAfterConflict(note);
  }

  async function refreshAfterConflict(note) {
    try {
      await handleRemoteNoteSaved({ id: note.id, wrenId: note.wrenId });
    } catch (err) {
      console.warn('Post-conflict refresh failed', err);
    }
  }

  // True when two serialized notes differ in the parts a user cares about
  // (title/body/tags/color/due) — volatile provenance (modified/last_edited) is
  // ignored so a mere timestamp bump never triggers a conflict copy.
  function noteContentDiffers(aRaw, bRaw) {
    const a = parseNote(aRaw, '');
    const b = parseNote(bRaw, '');
    if ((a.body || '') !== (b.body || '')) return true;
    if ((a.title || '') !== (b.title || '')) return true;
    if ((a.color || '') !== (b.color || '')) return true;
    if ((a.due || '') !== (b.due || '')) return true;
    const at = JSON.stringify((a.tags || []).slice().sort());
    const bt = JSON.stringify((b.tags || []).slice().sort());
    return at !== bt;
  }

  // Conflict toast that NAMES the copy and offers a one-click "Open" so the user
  // can see exactly where their edit went (audit R2 conflict refinement).
  function showConflictToast({ id, name }) {
    const toast = document.createElement('div');
    toast.className = 'sc-toast';
    const label = document.createElement('span');
    label.textContent = `Edited elsewhere — your changes were kept as “${name}”. `;
    toast.appendChild(label);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'sc-toast-action';
    open.textContent = 'Open';
    open.addEventListener('click', async () => {
      toast.remove();
      await loadNotes();
      await openNote(id);
    });
    toast.appendChild(open);
    // Longer than a plain toast — it carries an action the user may want to take.
    mountToast(toast, 9000);
  }

  async function handleDelete(note) {
    if (isDriveDisconnected()) {
      showDriveDisconnectedToast('Reconnect Drive to delete notes.');
      return;
    }
    try {
      await adapter.deleteNote(note.id);
    } catch (err) {
      if (routeAuthError(err)) return;
      console.error('Delete failed', err);
      showErrorToast('Could not delete the note.');
      return;
    }
    notes = notes.filter((n) => n.id !== note.id);
    list.setNotes(notes);
    noteEditor.clear();
    list.setActive(null);
    appEl.dataset.view = 'list';
    regenerateIndex();
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
      const { content, revision } = await adapter.readNote(noteId);
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
      // A drag between columns is a human edit exactly like a save from the
      // editor, so stamp the same provenance handleSave does (:1802–1803).
      // Without this an AI-edited note keeps reading "edited by AI" in the
      // last-updated panel after a person has moved its card.
      updated.lastEditedBy = 'human';
      updated.lastEdited = updated.modified;
      // Conditional on the revision we just read so a concurrent write is caught
      // instead of silently clobbered.
      const res = await adapter.writeNote(noteId, serializeNote(updated), revision);

      // Keep the in-memory model in sync so both the board and the sidebar
      // list reflect the move without a full reload.
      const n = notes.find((x) => x.id === noteId);
      if (n) {
        n.tags = updated.tags;
        n.modified = updated.modified;
        n.revision = res.revision;
        n.lastEditedBy = updated.lastEditedBy;
        n.lastEdited = updated.lastEdited;
      }
      notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
      list.setNotes(notes);
      kanbanView.refresh();
      regenerateIndex();
      if (n) broadcast?.postNoteSaved(n);
    } catch (err) {
      if (err instanceof AdapterAuthError && adapter?.backendId() === ADAPTER_TYPES.DRIVE) {
        showDriveDisconnected();
        return;
      }
      if (err instanceof ConflictError) {
        // The card was edited elsewhere between our read and write. Re-read and
        // refresh the board rather than clobbering the concurrent change; the
        // drop can simply be retried.
        showToast('Card changed elsewhere — refreshed. Try the move again.');
        await handleRemoteNoteSaved({ id: noteId });
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

  // Route a lapsed-permission error to the matching reconnect screen — Drive's
  // disconnected banner or the FS folder-reconnect card. Returns true when it
  // handled an AdapterAuthError (the caller should then bail), false otherwise so
  // non-auth errors fall through to their own handling. Replaces the Drive-only
  // guards that let a revoked FS permission dead-end in an alert() (audit S8).
  function routeAuthError(err) {
    if (!(err instanceof AdapterAuthError)) return false;
    if (adapter?.backendId() === ADAPTER_TYPES.DRIVE) showDriveDisconnected();
    else renderFsReconnect(adapter);
    return true;
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

  // Lightweight toast: temporary div, auto-removes. No persistent state.
  // Toasts used to be individually position:fixed at the same coordinates, so
  // two in flight rendered exactly on top of each other and the first was
  // unreadable. They now live in a shared stack container (audit U21).
  function toastStack() {
    let stack = document.querySelector('.sc-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'sc-toast-stack';
      // Announce toasts without stealing focus; the stack is a pass-through
      // layer so it can't intercept clicks meant for the app beneath it.
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    return stack;
  }

  function mountToast(toast, ttlMs) {
    toastStack().appendChild(toast);
    setTimeout(() => {
      toast.remove();
      const stack = document.querySelector('.sc-toast-stack');
      if (stack && !stack.childElementCount) stack.remove();
    }, ttlMs);
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'sc-toast';
    toast.textContent = msg;
    mountToast(toast, 3200);
  }

  // Errors that used to be alert() (audit S15). alert() blocks the whole page,
  // cannot be styled, reads badly on mobile, and in the desktop shell can land
  // behind the window. A toast replaces it — but a failure must not look like
  // ordinary chatter, so error toasts are visually distinct, live roughly twice
  // as long, and carry role="alert" so assistive tech announces them at once
  // rather than waiting for a pause, which is what the stack's polite
  // aria-live would otherwise do.
  function showErrorToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'sc-toast sc-toast-error';
    toast.setAttribute('role', 'alert');
    toast.textContent = msg;
    mountToast(toast, 6000);
  }

  // True where the window has no browser tab strip to steal shortcuts from:
  // an installed/standalone PWA, or the Tauri desktop shell. Both checks are
  // wrapped because matchMedia is absent in some embedded webviews and reading
  // an undefined global throws.
  function isTablessWindow() {
    try {
      if (window.__TAURI_INTERNALS__ || window.__TAURI__) return true;
    } catch {
      /* not a Tauri webview */
    }
    try {
      if (window.matchMedia?.('(display-mode: standalone)')?.matches) return true;
      if (window.matchMedia?.('(display-mode: window-controls-overlay)')?.matches) return true;
    } catch {
      /* matchMedia unavailable */
    }
    // iOS Safari's pre-standard installed-app flag.
    return window.navigator?.standalone === true;
  }

  function showDriveDisconnectedToast(msg) {
    showToast(msg);
  }

  /* ---- Check for updates (desktop) ------------------------------------- */

  // Compare dotted numeric versions ("1.2.0"). Returns 1 if a>b, -1 if a<b,
  // 0 if equal. Missing trailing parts count as 0, so "1.2" == "1.2.0".
  function compareVersions(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  // Desktop update check: read the latest published GitHub Release tag, compare
  // it to the running version (__APP_VERSION__, injected from tauri.conf.json by
  // Vite), and prompt to download when behind. Any network/API failure falls
  // back to offering the download page so the action still does something. The
  // GitHub API is CORS-enabled and needs no auth for a public repo; a private
  // repo returns 404 and lands in the graceful fallback below.
  async function checkForUpdates() {
    const RELEASES_API = 'https://api.github.com/repos/buildwithbaker/wren/releases/latest';
    const DOWNLOAD_URL = 'https://wren.buildwithbaker.io/download';
    const current = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

    showToast('Checking for updates…');
    let latest = '';
    try {
      const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      latest = String(data.tag_name || '').replace(/^v/i, '').trim();
      if (!latest) throw new Error('no tag_name');
    } catch (err) {
      console.warn('Update check failed', err);
      const go = await confirmDialog({
        title: 'Couldn’t check for updates',
        message:
          'Wren couldn’t reach the update server. Open the download page to check for the latest version manually?',
        confirmLabel: 'Open download page',
      });
      if (go) openExternal(DOWNLOAD_URL);
      return;
    }

    if (current && compareVersions(latest, current) > 0) {
      const go = await confirmDialog({
        title: 'Update available',
        message: `You’re on v${current}. v${latest} is available. Download the latest Wren?`,
        confirmLabel: 'Download',
      });
      if (go) openExternal(DOWNLOAD_URL);
    } else {
      showToast(`You’re on the latest version (v${current || latest}).`);
    }
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

    // Deterministic switch: persist the TARGET backend explicitly, never
    // clearStoredBackend(). Clearing let resolveBackend()'s fs-migration
    // heuristic re-infer "fs" from the leftover directory handle, so a
    // local->Drive switch silently snapped back to local and Drive never
    // appeared (the 2026-06-03 fix). Setting the target lands on it (a Drive
    // target then routes to the experimental sign-in screen if needed).
    const performSwitch = async (targetBackend, { title, message, confirmLabel }) => {
      pop.remove();
      const ok = await confirmDialog({ title, message, confirmLabel });
      if (!ok) return;
      await setStoredBackend(targetBackend);
      window.location.reload();
    };

    if (isDrive) {
      // On Cloud sync → the prominent, recommended action is returning to local.
      const toLocal = document.createElement('button');
      toLocal.type = 'button';
      toLocal.className = 'sc-popover-item';
      toLocal.textContent = 'Switch to local files';
      toLocal.addEventListener('click', () =>
        performSwitch(ADAPTER_TYPES.FS, {
          title: 'Switch to local files?',
          message:
            'Wren will reload and start with no notes on this device until you pick a folder. Your existing notes stay where they are — in your "Wren Notes" Drive folder — and you can switch back any time.',
          confirmLabel: 'Switch',
        })
      );
      pop.appendChild(toLocal);

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
    } else {
      // On local → switching to Drive is a deliberate, experimental act. Group
      // it under a labeled "Experimental" section with the warning so it can't
      // be flipped on by a stray click.
      const label = document.createElement('div');
      label.className = 'sc-popover-label';
      label.textContent = 'Experimental';
      pop.appendChild(label);

      const warn = document.createElement('p');
      warn.className = 'sc-popover-warn';
      warn.textContent = DRIVE_EXPERIMENTAL_WARNING;
      pop.appendChild(warn);

      const toDrive = document.createElement('button');
      toDrive.type = 'button';
      toDrive.className = 'sc-popover-item';
      toDrive.textContent = 'Turn on Cloud sync…';
      toDrive.addEventListener('click', () =>
        performSwitch(ADAPTER_TYPES.DRIVE, {
          title: 'Turn on Cloud sync (experimental)?',
          message:
            'Cloud sync is experimental — it may not sync reliably across devices. Wren will reload and ask you to sign in to Google Drive. Your local notes stay in their folder; you can switch back to local any time.',
          confirmLabel: 'Continue',
        })
      );
      pop.appendChild(toDrive);
    }

    // Diagnostics: surface whether the browser granted persistent storage. On a
    // local backend this is the difference between folder permission surviving
    // eviction and getting re-prompted every session (audit S6). Filled async.
    if (!isDrive) {
      const persistLine = document.createElement('p');
      persistLine.className = 'sc-popover-hint';
      persistLine.textContent = 'Persistent storage: checking…';
      pop.appendChild(persistLine);
      isStoragePersisted().then((state) => {
        persistLine.textContent =
          state === true
            ? 'Persistent storage: on (folder access should stick).'
            : state === false
              ? 'Persistent storage: off — install Wren so folder access persists.'
              : 'Persistent storage: unavailable in this browser.';
      });
    }

    document.body.appendChild(pop);

    // Clamp to the viewport now that the popover has a measurable size — anchored
    // at rect.left it was cut off ~74px on the right at a 400px popup width
    // (audit U16). Nudge left so the right edge stays on-screen, and flip above
    // the chip if it would overflow the bottom.
    {
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
      pop.style.left = `${left}px`;
      if (rect.bottom + 6 + h > window.innerHeight - 8) {
        pop.style.top = `${Math.max(8, rect.top - h - 6)}px`;
      }
    }

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

  function buildFooter({ compact = false } = {}) {
    const footer = document.createElement('footer');
    footer.className = 'sc-footer';
    // Compact (window-mode) button anchored in the footer's bottom-left corner —
    // main app only (onboarding/sign-in footers pass no flag). Separated from
    // the List|Kanban view toggle so it reads as a window control, not a view.
    if (compact) footer.appendChild(buildCompactButton());
    // All links live in a centered group to the right of the corner button.
    const linksWrap = document.createElement('div');
    linksWrap.className = 'sc-footer-links';
    const SITE = 'https://wren.buildwithbaker.io';
    const desktop = isTauri();
    // Running build number, injected from tauri.conf.json by Vite (__APP_VERSION__).
    // Guarded typeof read so a bundle without the define doesn't throw.
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
    const links = [
      // In the desktop app the "Download" link is pointless (you already have
      // it). Show a static, non-clickable "Desktop version" indicator instead,
      // with an info tooltip on hover. PWA/extension keep the real Download link.
      desktop
        ? {
            label: appVersion ? `Desktop v${appVersion}` : 'Desktop version',
            static: true,
            title:
              'You’re running the Wren desktop app for Windows. The web, extension, and desktop versions all share the same notes.',
          }
        : { href: `${SITE}/download`, label: 'Download' },
      { href: `${SITE}/guide`, label: 'Guide' },
      { href: `${SITE}/privacy`, label: 'Privacy' },
      // Shortcuts, Support on Ko-fi, and Build with Baker are appended after the
      // loop (in that order) so the footer reads: Desktop version / Guide /
      // Privacy / Shortcuts / Support on Ko-fi / Build with Baker.
    ];
    links.forEach((l, i) => {
      if (i) {
        const dot = document.createElement('span');
        dot.className = 'sc-footer-dot';
        dot.textContent = '·';
        linksWrap.appendChild(dot);
      }
      // Static (non-link) footer entry: a plain span the Tauri link interceptor
      // ignores, with an info tooltip via the native title attribute.
      if (l.static) {
        const span = document.createElement('span');
        span.className = 'sc-footer-static';
        span.textContent = l.label;
        if (l.title) span.title = l.title;
        linksWrap.appendChild(span);
        return;
      }
      const a = document.createElement('a');
      a.href = l.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = l.cls || 'sc-footer-bwb';
      a.textContent = l.label;
      linksWrap.appendChild(a);
    });
    // Trailing entries, in order: Shortcuts (button), Support on Ko-fi, Build
    // with Baker. Each is preceded by a separator dot.
    const makeDot = () => {
      const d = document.createElement('span');
      d.className = 'sc-footer-dot';
      d.textContent = '·';
      return d;
    };
    const makeFooterLink = (href, label, cls) => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = cls || 'sc-footer-bwb';
      a.textContent = label;
      return a;
    };
    // In-app help: the full keyboard-shortcut reference (and, in the desktop
    // app, the startup toggle + rebindable global hotkeys). A button, not a
    // link, so the Tauri external-link interceptor below ignores it.
    const shortcutsBtn = document.createElement('button');
    shortcutsBtn.type = 'button';
    shortcutsBtn.className = 'sc-footer-bwb sc-footer-btn';
    shortcutsBtn.textContent = 'Shortcuts';
    shortcutsBtn.addEventListener('click', () =>
      openShortcutsDialog({ desktop: desktopIntegration })
    );
    linksWrap.append(makeDot(), shortcutsBtn);
    linksWrap.append(makeDot(), makeFooterLink(KOFI, '☕ Support on Ko-fi', 'sc-footer-kofi'));
    linksWrap.append(makeDot(), makeFooterLink(KOFI, 'Build with Baker'));
    footer.appendChild(linksWrap);
    // In the Tauri desktop app a plain target=_blank link would open/navigate a
    // webview; intercept and hand the URL to the system browser instead so the
    // app window stays put. PWA/extension keep the normal new-tab behavior.
    if (isTauri()) {
      footer.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a || !footer.contains(a)) return;
        e.preventDefault();
        openExternal(a.href);
      });
    }
    return footer;
  }

  /* ---- Service worker -------------------------------------------------- */
  // Desktop (Tauri) must NOT run a service worker. The cached app shell can go
  // stale and serve a blank/broken document that only a hard-refresh clears
  // (observed 2026-07). The desktop app is already local, so the SW buys it
  // nothing. Register only in the real browser PWA build. On desktop, actively
  // unregister any SW a prior build registered and purge its caches, so already
  // installed desktop clients self-heal on their next launch.
  if ('serviceWorker' in navigator) {
    if (enableServiceWorker && !isTauri()) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('sw.js')
          .catch((err) => console.warn('SW registration failed', err));
      });
    } else if (isTauri()) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if (self.caches && caches.keys) {
        caches
          .keys()
          .then((keys) => keys.forEach((k) => caches.delete(k)))
          .catch(() => {});
      }
    }
  }
}
