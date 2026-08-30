// sticky-app.js
// The pop-out sticky window shell (Sticky Float Phase 2). A minimal single-note
// editor that boots when the URL carries a `?note=<storageId>&wid=<wrenId>`
// query (see src/main.js). It is the PWA approximation of a Windows Sticky
// Note: a small floating, editable, autosaving window that remembers its own
// screen position/size and syncs live with the main app.
//
// Always-on-top is explicitly impossible in a PWA and out of scope (that is
// Phase 3 / Tauri).
//
// Adapter boot intentionally duplicates a compact slice of app-controller's
// boot() rather than restructuring it — light duplication is acceptable for v1
// and keeps the main app's boot path untouched.
//
// Decision provenance: project-blueprints/wren/future-enhancements/sticky-float-sow.md (Phase 2)

import {
  ADAPTER_TYPES,
  TauriFsAdapter,
  DriveAdapter,
  AdapterAuthError,
  ConflictError,
  resolveBackend,
  chooseFsAdapter,
} from './storage/index.js';
import {
  initTokenClient,
  requestAccessToken,
  isSignedIn,
} from './oauth/index.js';
import {
  isSupported,
  parseNote,
  serializeNote,
  firstLineOf,
  getStoredDirHandle,
  CARD_COLORS,
} from './notes-store.js';
import { createNoteEditor } from './ui/note-editor.js';
import { createBroadcast } from './sync/broadcast.js';
import { writeConflictCopy } from './sync/conflictDetection.js';
import { loadGeometry, saveGeometry, geometryEquals } from './sticky/geometry.js';
import { addToRegistry, removeFromRegistry } from './sticky/registry.js';
import { parseStickyParams } from './sticky/opener.js';
import { buildStickyTitleBar } from './sticky/titlebar.js';
import { isTauri } from './platform.js';
import { initTheme, applyTheme, getStoredTheme } from './theme.js';

const VALID_COLOR = new Set(CARD_COLORS.map((c) => c.id));
const GEOM_POLL_MS = 1500;
const MAIN_APP_URL = (() => {
  if (typeof location === 'undefined') return '/';
  const url = new URL(location.href);
  url.search = '';
  return url.toString();
})();

export function createStickyApp({ root }) {
  const params = parseStickyParams(location.search);
  if (!params) {
    // Defensive: createStickyApp should only be reached with a ?note= param.
    renderMessage(root, 'No note specified.', { openWren: true });
    return;
  }

  document.body.classList.add('is-sticky');

  // Mirror the main hub's theme (Light / Dark / Auto) rather than falling back
  // to the OS setting — a popup note follows whatever the Wren app is set to.
  // The choice lives in localStorage under 'wren.theme', shared across the PWA
  // and every Tauri webview (same origin), so reading it here is enough. Re-apply
  // live when the main app changes the theme while this popup is open.
  initTheme();
  window.addEventListener('storage', (e) => {
    if (e.key === 'wren.theme' || e.key === null) applyTheme(getStoredTheme());
  });

  let adapter = null;
  let noteEditor = null;
  let storageId = params.storageId;
  const wrenId = params.wrenId;
  let broadcast = null;
  let geomTimer = null;
  let lastGeom = null;
  let registered = false;

  boot();

  /* ---- Boot ------------------------------------------------------------- */

  async function boot() {
    let backend;
    try {
      backend = await resolveBackend();
    } catch (err) {
      console.error('Sticky boot: resolveBackend failed', err);
      renderMessage(root, 'Could not open your notes.', { openWren: true });
      return;
    }

    if (backend === null) {
      renderMessage(root, 'Open Wren and choose where your notes live first.', { openWren: true });
      return;
    }

    if (backend === ADAPTER_TYPES.FS) {
      let fs;
      try {
        fs = await chooseFsAdapter();
        const isNativeFs = fs instanceof TauriFsAdapter;
        if (!isNativeFs && !isSupported()) {
          renderMessage(root, 'This browser can’t open local notes.', { openWren: true });
          return;
        }
        await fs.initialize();
      } catch (err) {
        console.error('Sticky boot: fs initialization failed', err);
        renderMessage(root, 'Could not open your notes.', { openWren: true });
        return;
      }
      if (await fs.isReady()) {
        adapter = fs;
        return openNoteFlow();
      }
      // Brand-new install (no folder chosen yet): "fs" is now the unset default,
      // so a sticky can boot before the user has set up storage. Send them to
      // the main app to choose first, rather than prompting to re-grant a folder
      // that doesn't exist.
      let hasHandle = false;
      try {
        hasHandle = !!(await getStoredDirHandle());
      } catch {
        /* ignore — treat as brand-new */
      }
      if (!hasHandle) {
        renderMessage(root, 'Open Wren and choose where your notes live first.', { openWren: true });
        return;
      }
      // Fresh popup may hold the IndexedDB handle without granted permission —
      // a user gesture is required to re-grant. Mirror renderFsReconnect, slim.
      renderGrantAccess(fs);
      return;
    }

    if (backend === ADAPTER_TYPES.DRIVE) {
      try {
        await initTokenClient();
        if (!isSignedIn()) {
          await requestAccessToken({ silent: true });
        }
        const drive = new DriveAdapter();
        await drive.initialize();
        adapter = drive;
        return openNoteFlow();
      } catch (err) {
        // Do NOT run the full OAuth popup flow inside a sticky — point the user
        // back to the main app to reconnect.
        if (!(err instanceof AdapterAuthError)) {
          console.warn('Sticky Drive boot failed', err);
        }
        renderDriveReconnect();
        return;
      }
    }
  }

  /* ---- Note resolution -------------------------------------------------- */

  async function openNoteFlow() {
    let resolved;
    try {
      resolved = await resolveNote();
    } catch (err) {
      if (err instanceof AdapterAuthError) {
        if (adapter?.backendId() === ADAPTER_TYPES.DRIVE) return renderDriveReconnect();
        // FS lost permission between isReady and read — re-prompt.
        return renderGrantAccess(adapter);
      }
      console.error('Sticky note read failed', err);
      renderMessage(root, 'Could not open this note.', { close: true });
      return;
    }
    if (!resolved) {
      renderMessage(root, 'This note no longer exists.', { close: true });
      return;
    }
    storageId = resolved.id;
    mountEditor(resolved.note, resolved.revision);
  }

  // Read the note by storage id; on failure (e.g. an FS rename changed the id)
  // fall back to scanning listNotes for the frontmatter id == wid. Returns
  // { id, note, revision } or null when the note can't be found.
  async function resolveNote() {
    try {
      const { content, revision } = await adapter.readNote(storageId);
      return { id: storageId, note: toNote(content, storageId), revision };
    } catch (err) {
      if (err instanceof AdapterAuthError) throw err;
      // Not found by id — fall through to the wrenId scan below.
    }
    if (!wrenId) return null;

    const metas = await adapter.listNotes();
    // Fast path: adapters that surface frontmatter wrenId in list metadata.
    const metaMatch = metas.find((m) => m.wrenId && m.wrenId === wrenId);
    const ordered = metaMatch ? [metaMatch, ...metas.filter((m) => m !== metaMatch)] : metas;
    for (const m of ordered) {
      try {
        const { content, revision } = await adapter.readNote(m.id);
        const parsed = parseNote(content, m.id);
        if (parsed.wrenId === wrenId) {
          return { id: m.id, note: shapeNote(parsed, m.id), revision };
        }
      } catch {
        // Skip unreadable candidates.
      }
    }
    return null;
  }

  function toNote(content, id) {
    return shapeNote(parseNote(content, id), id);
  }

  function shapeNote(parsed, id) {
    return {
      id,
      wrenId: parsed.wrenId || wrenId || '',
      filename: parsed.filename || id,
      title: parsed.title || '',
      body: parsed.body || '',
      color: parsed.color || 'default',
      created: parsed.created,
      modified: parsed.modified,
      tags: parsed.tags || [],
      summary: parsed.summary || '',
      due: parsed.due || '',
      hideDue: !!parsed.hideDue,
      hideTags: !!parsed.hideTags,
      // Provenance — carried through so a sticky save never strips an AI note's
      // created_by / last_edited_by / last_edited frontmatter.
      createdBy: parsed.createdBy || '',
      lastEditedBy: parsed.lastEditedBy || '',
      lastEdited: parsed.lastEdited || '',
      firstLine: firstLineOf(parsed.body),
      revision: '',
    };
  }

  /* ---- Editor ----------------------------------------------------------- */

  function mountEditor(note, revision) {
    note.revision = revision;
    root.replaceChildren();

    // Tauri-only slim title bar (Wren logo + drag region + close). The native
    // OS bar was removed in opener.js (decorations:false); null in the browser
    // PWA/extension, which keeps its native window chrome.
    const titlebar = buildStickyTitleBar({ onClose: closeWindow });
    if (titlebar) {
      document.body.classList.add('has-sticky-titlebar');
      root.appendChild(titlebar);
    }

    noteEditor = createNoteEditor({
      sticky: true,
      showBack: false,
      onSave: (n) => handleSave(n),
      onOpenInApp: () => openInWrenApp(),
      onTitleChange: (title) => setDocTitle(title),
    });
    root.appendChild(noteEditor.element);
    noteEditor.openNote(note);

    applyWindowColor(note.color);
    setDocTitle(note.title);

    // Live cross-window sync: refresh when a PEER saves THIS note and we have no
    // pending local edits (so we never clobber what the user is typing).
    broadcast = createBroadcast();
    broadcast.onNoteSaved((msg) => {
      if (!isSameNote(msg)) return;
      if (noteEditor.hasPendingSave()) return;
      refreshFromDisk(msg);
    });

    // Position/size memory + open-sticky registry.
    addToRegistry(note.wrenId, storageId);
    registered = true;
    lastGeom = loadGeometry(note.wrenId, storageId);
    startGeomPoll();
    window.addEventListener('pagehide', onPageHide);
    listenForQuitFlush();
  }

  // Desktop only: the tray Quit emits a flush event before exiting, so land any
  // pending debounced save in THIS sticky webview (audit T2). Must match
  // EVENT_FLUSH_SAVES in src-tauri/src/lib.rs.
  async function listenForQuitFlush() {
    if (!isTauri()) return;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('wren://flush-saves', () => {
        if (noteEditor?.hasPendingSave?.()) noteEditor.flush();
      });
    } catch (err) {
      console.warn('sticky flush listener failed', err);
    }
  }

  // Returns true when the write reached disk, false on any failure — the editor
  // (note-editor.doSave) uses this to avoid painting a false "saved" state.
  async function handleSave(note) {
    note.modified = new Date().toISOString();
    // A sticky edit is a human edit — stamp human provenance (mirrors the main
    // app's handleSave) so last_edited stays truthful and AI-edited notes flip
    // back to human. created_by is preserved.
    note.lastEditedBy = 'human';
    note.lastEdited = note.modified;
    try {
      // NOTE: a sticky deliberately does NOT rename-on-title (no
      // syncBackendFilename). Renaming changes the FS storage id, which would
      // churn ids while the main app is open; the main app reconciles the file
      // name on its next save of this note. Stickies only ever write content.
      // Conditional on our known revision so a concurrent write (the main app
      // or another sticky) is detected instead of silently overwritten.
      const content = serializeNote(note);
      const { revision } = await adapter.writeNote(note.id, content, note.revision);
      note.revision = revision;
      note.firstLine = firstLineOf(note.body);
    } catch (err) {
      if (err instanceof AdapterAuthError) {
        // Do NOT tear down the editor: it holds the text that just failed to
        // save, and replaceChildren() would make it unrecoverable (the user
        // can't even select-copy it). Show a non-destructive banner instead and
        // leave the editor mounted. Full-screen reconnect cards are still used
        // at boot (openNoteFlow), where there is no unsaved content at risk.
        showSaveReconnectBanner(note);
        return false;
      }
      if (err instanceof ConflictError) {
        await handleSaveConflict(note);
        return false;
      }
      console.error('Sticky save failed', err);
      return false;
    }
    applyWindowColor(note.color);
    setDocTitle(note.title);
    broadcast?.postNoteSaved(note);
    return true;
  }

  // Non-destructive auth-failure banner for the SAVE path. Overlays the top of
  // the sticky without removing the editor, so unsaved text is preserved and
  // copyable while the user reconnects. (P0#3 fix.)
  function showSaveReconnectBanner(note) {
    if (root.querySelector('.sc-save-banner')) return;
    const isDrive = adapter?.backendId() === ADAPTER_TYPES.DRIVE;
    const banner = document.createElement('div');
    banner.className = 'sc-save-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText =
      'background:#B82F2F;color:#fff;padding:8px 12px;font-size:13px;line-height:1.4;' +
      'display:flex;gap:8px;align-items:center;justify-content:space-between;';
    const msg = document.createElement('span');
    msg.textContent = isDrive
      ? 'Not saved — Drive session expired. Copy your text, then reopen Wren to reconnect.'
      : 'Not saved — folder permission lost. Copy your text, then grant access.';
    banner.appendChild(msg);
    if (isDrive) {
      banner.appendChild(buildOpenWrenLink());
    } else {
      const grant = document.createElement('button');
      grant.className = 'sc-btn sc-btn--primary';
      grant.textContent = 'Grant access';
      grant.addEventListener('click', async () => {
        try {
          await adapter.reconnect();
          banner.remove();
          await handleSave(note); // retry now that permission is restored
        } catch (e) {
          if (e?.name !== 'AbortError' && !(e instanceof AdapterAuthError)) {
            console.warn('Sticky grant failed', e);
          }
        }
      });
      banner.appendChild(grant);
    }
    root.prepend(banner);
  }

  // Re-read the note from the active adapter and re-open it in the editor. Used
  // when a peer window saved this note. Guarded by hasPendingSave() at the call
  // site so local edits win.
  async function refreshFromDisk(msg) {
    // A rename broadcast carries this note's NEW storage id under the same
    // wrenId (an FS rename changes the id). Adopt it before reading so we never
    // read — or on the next save WRITE — the stale id (a stale write would 404
    // or, worse, resurrect the old filename via create-on-write).
    if (msg && msg.id && msg.id !== storageId && msg.wrenId && wrenId && msg.wrenId === wrenId) {
      storageId = msg.id;
    }
    try {
      const { content, revision } = await adapter.readNote(storageId);
      const fresh = toNote(content, storageId); // fresh.id === storageId → editor adopts the new id
      fresh.revision = revision;
      await noteEditor.openNote(fresh);
      applyWindowColor(fresh.color);
      setDocTitle(fresh.title);
    } catch (err) {
      if (err instanceof AdapterAuthError) return; // a save attempt will surface it
      console.warn('Sticky refresh failed', err);
    }
  }

  // A conditional write hit a concurrent change (the main app or another sticky
  // wrote this note since we last read it). Preserve this sticky's losing edit
  // as a `.sync-conflict-…` copy so nothing typed is lost, tell the user, then
  // reload the winning version from disk.
  async function handleSaveConflict(note) {
    const localContent = serializeNote(note);
    // If our losing edit matches the winner already on disk, there's nothing to
    // preserve — skip the copy so fresh typing never silently spawns a side file.
    try {
      const { content } = await adapter.readNote(storageId);
      if (!noteContentDiffers(localContent, content)) {
        await refreshFromDisk({ id: storageId, wrenId });
        return;
      }
    } catch {
      /* couldn't read the winner — fall through and preserve the edit anyway */
    }
    let copy;
    try {
      copy = await writeConflictCopy(adapter, note, localContent);
    } catch (err) {
      console.error('Sticky conflict copy failed', err);
      showStickyNotice('Edited elsewhere — copy your text; a conflict copy could not be written.');
      return;
    }
    showStickyNotice(`Edited elsewhere — your changes were kept as “${copy.name}”. Find it in Wren.`);
    await refreshFromDisk({ id: storageId, wrenId });
  }

  // True when two serialized notes differ in title/body/tags/color/due (volatile
  // provenance ignored) — mirrors the main app's conflict-diff check.
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

  // Transient, non-destructive status strip at the top of the sticky. Leaves the
  // editor mounted (unlike the reconnect banner) and auto-dismisses.
  function showStickyNotice(text) {
    root.querySelector('.sc-sticky-notice')?.remove();
    const notice = document.createElement('div');
    notice.className = 'sc-sticky-notice';
    notice.setAttribute('role', 'status');
    notice.style.cssText =
      'background:#8A5A00;color:#fff;padding:8px 12px;font-size:13px;line-height:1.4;';
    notice.textContent = text;
    root.prepend(notice);
    setTimeout(() => notice.remove(), 5000);
  }

  function isSameNote(msg) {
    if (msg.id && msg.id === storageId) return true;
    if (wrenId && msg.wrenId && msg.wrenId === wrenId) return true;
    return false;
  }

  /* ---- Geometry + registry --------------------------------------------- */

  function currentGeometry() {
    return { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
  }

  function persistGeometry() {
    const geom = currentGeometry();
    if (lastGeom && geometryEquals(lastGeom, geom)) return;
    saveGeometry(wrenId, storageId, geom);
    lastGeom = geom;
  }

  function startGeomPoll() {
    geomTimer = setInterval(persistGeometry, GEOM_POLL_MS);
  }

  function onPageHide() {
    // Best-effort flush of a pending debounced save before teardown, so closing
    // the sticky within the 500ms debounce doesn't silently drop the last edit.
    if (noteEditor?.hasPendingSave?.()) noteEditor.flush();
    if (geomTimer) clearInterval(geomTimer);
    geomTimer = null;
    persistGeometry();
    if (registered) removeFromRegistry(storageId);
    broadcast?.close();
  }

  /* ---- Window chrome ---------------------------------------------------- */

  function applyWindowColor(color) {
    const safe = VALID_COLOR.has(color) ? color : 'default';
    document.body.style.setProperty('--wr-note-bg', `var(--wr-note-${safe})`);
  }

  function setDocTitle(title) {
    const t = (title || '').trim();
    const full = t ? `${t} — Wren` : 'Wren note';
    document.title = full;
    // The visible custom bar shows the Wren logo only, but the OS/taskbar still
    // needs the right title — keep the native window title in sync on rename.
    setNativeTitle(full);
  }

  // Mirror the document title onto the native Tauri window so the taskbar /
  // window switcher stay correct (the custom bar intentionally shows no text).
  // No-op outside Tauri; errors are logged, never thrown.
  async function setNativeTitle(title) {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setTitle(title);
    } catch (err) {
      console.warn('Sticky setTitle failed', err);
    }
  }

  // "Open in Wren app" (sticky ⋮ menu): bring the main Wren window forward. In
  // Tauri, focus the existing main window (label 'main') rather than spawning a
  // browser tab; fall back to opening the app URL when it can't be focused or in
  // the browser PWA. The sticky stays open.
  async function openInWrenApp() {
    if (isTauri()) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const main = await WebviewWindow.getByLabel('main');
        if (main) {
          await main.unminimize().catch(() => {});
          await main.setFocus();
          return;
        }
      } catch (err) {
        console.warn('Open in Wren app failed', err);
      }
    }
    window.open(MAIN_APP_URL, '_blank', 'noopener');
  }

  // Close the sticky window. Under Tauri the native close button is gone with
  // decorations:false, so close via the window API; falls back to window.close.
  async function closeWindow() {
    if (isTauri()) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
        return;
      } catch (err) {
        console.warn('Sticky close failed', err);
      }
    }
    window.close();
  }

  /* ---- Fallback screens ------------------------------------------------- */

  function renderGrantAccess(fs) {
    const card = buildCard('Grant access to your notes', 'This window needs permission to read your notes folder.');
    const grant = document.createElement('button');
    grant.className = 'sc-btn sc-btn--primary';
    grant.textContent = 'Grant access to your notes';
    grant.addEventListener('click', async () => {
      try {
        await fs.reconnect();
        adapter = fs;
        await openNoteFlow();
      } catch (err) {
        if (err?.name !== 'AbortError' && !(err instanceof AdapterAuthError)) {
          console.warn('Sticky grant failed', err);
        }
      }
    });
    card.appendChild(grant);
    mountCard(card);
  }

  function renderDriveReconnect() {
    const card = buildCard('Reconnect Drive in the main app', 'Your Google Drive session expired. Open Wren to sign back in, then reopen this note.');
    card.appendChild(buildOpenWrenLink());
    mountCard(card);
  }

  function renderMessage(target, message, { close = false, openWren = false } = {}) {
    const card = buildCard('Wren', message);
    if (openWren) card.appendChild(buildOpenWrenLink());
    if (close) card.appendChild(buildCloseButton());
    target.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'sc-sticky-screen';
    wrap.appendChild(card);
    target.appendChild(wrap);
  }

  function mountCard(card) {
    root.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'sc-sticky-screen';
    wrap.appendChild(card);
    root.appendChild(wrap);
  }

  function buildCard(heading, body) {
    const card = document.createElement('div');
    card.className = 'sc-screen-card sc-sticky-card';
    const h = document.createElement('h1');
    h.textContent = heading;
    const p = document.createElement('p');
    p.textContent = body;
    card.append(h, p);
    return card;
  }

  function buildOpenWrenLink() {
    const a = document.createElement('a');
    a.className = 'sc-btn sc-btn--primary';
    a.href = MAIN_APP_URL;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open Wren';
    return a;
  }

  function buildCloseButton() {
    const btn = document.createElement('button');
    btn.className = 'sc-btn sc-btn--ghost';
    btn.textContent = 'Close window';
    btn.addEventListener('click', () => window.close());
    return btn;
  }
}
