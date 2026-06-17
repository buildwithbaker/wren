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
  FileSystemAdapter,
  DriveAdapter,
  AdapterAuthError,
  resolveBackend,
} from './storage/index.js';
import {
  initTokenClient,
  requestAccessToken,
  isSignedIn,
} from './oauth/index.js';
import { isSupported, parseNote, serializeNote, firstLineOf, CARD_COLORS } from './notes-store.js';
import { createNoteEditor } from './ui/note-editor.js';
import { createBroadcast } from './sync/broadcast.js';
import { loadGeometry, saveGeometry, geometryEquals } from './sticky/geometry.js';
import { addToRegistry, removeFromRegistry } from './sticky/registry.js';
import { parseStickyParams } from './sticky/opener.js';
import { buildStickyTitleBar } from './sticky/titlebar.js';
import { isTauri } from './platform.js';

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
      if (!isSupported()) {
        renderMessage(root, 'This browser can’t open local notes.', { openWren: true });
        return;
      }
      const fs = new FileSystemAdapter();
      await fs.initialize();
      if (await fs.isReady()) {
        adapter = fs;
        return openNoteFlow();
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
      refreshFromDisk();
    });

    // Position/size memory + open-sticky registry.
    addToRegistry(note.wrenId, storageId);
    registered = true;
    lastGeom = loadGeometry(note.wrenId, storageId);
    startGeomPoll();
    window.addEventListener('pagehide', onPageHide);
  }

  async function handleSave(note) {
    note.modified = new Date().toISOString();
    try {
      // NOTE: a sticky deliberately does NOT rename-on-title (no
      // syncBackendFilename). Renaming changes the FS storage id, which would
      // churn ids while the main app is open; the main app reconciles the file
      // name on its next save of this note. Stickies only ever write content.
      const { revision } = await adapter.writeNote(note.id, serializeNote(note));
      note.revision = revision;
      note.firstLine = firstLineOf(note.body);
    } catch (err) {
      if (err instanceof AdapterAuthError) {
        if (adapter?.backendId() === ADAPTER_TYPES.DRIVE) renderDriveReconnect();
        else renderGrantAccess(adapter);
        return;
      }
      console.error('Sticky save failed', err);
      return;
    }
    applyWindowColor(note.color);
    setDocTitle(note.title);
    broadcast?.postNoteSaved(note);
  }

  // Re-read the note from the active adapter and re-open it in the editor. Used
  // when a peer window saved this note. Guarded by hasPendingSave() at the call
  // site so local edits win.
  async function refreshFromDisk() {
    try {
      const { content, revision } = await adapter.readNote(storageId);
      const fresh = toNote(content, storageId);
      fresh.revision = revision;
      await noteEditor.openNote(fresh);
      applyWindowColor(fresh.color);
      setDocTitle(fresh.title);
    } catch (err) {
      if (err instanceof AdapterAuthError) return; // a save attempt will surface it
      console.warn('Sticky refresh failed', err);
    }
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
