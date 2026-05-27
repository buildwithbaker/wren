// notes-store.js
// File System Access API read/write layer for Wren notes.
// Notes are plain .md files (YAML frontmatter + markdown body) inside a folder
// the user picks. The chosen FileSystemDirectoryHandle is persisted in
// IndexedDB (it is NOT serializable into localStorage / chrome.storage).
// Shared verbatim by the PWA (main.js) and the Chrome extension (popup.js).

const DB_NAME = 'scrybe';
// v2 (2026-05-27): adds 'sync_state' object store used by src/sync/syncStateStore.js
//   The existing 'handles' store is preserved untouched; the migration is purely
//   additive so existing Wren installs with notes-store data do not lose anything.
const DB_VERSION = 2;
const STORE = 'handles';
const HANDLE_KEY = 'notesDir';
export const SYNC_STATE_STORE = 'sync_state';

// Exposed so src/sync/syncStateStore.js can share the same DB connection schema
// without re-declaring the migration logic.
export const SCRYBE_DB_NAME = DB_NAME;
export const SCRYBE_DB_VERSION = DB_VERSION;

/**
 * Apply schema migrations to the shared 'scrybe' IndexedDB database.
 *
 * Called from onupgradeneeded by any module that opens the database. Each
 * store-creation is wrapped in a `contains` guard so the function is safe
 * regardless of which version the user is upgrading from.
 *
 * Order of stores:
 *   v1: 'handles' (FileSystemDirectoryHandle persistence — pre-existing)
 *   v2: 'sync_state' (per-note sync metadata, keyed by noteId)
 */
export function applyScrybeMigrations(db) {
  if (!db.objectStoreNames.contains(STORE)) {
    db.createObjectStore(STORE);
  }
  if (!db.objectStoreNames.contains(SYNC_STATE_STORE)) {
    db.createObjectStore(SYNC_STATE_STORE, { keyPath: 'noteId' });
  }
}

export const CARD_COLORS = [
  { id: 'default', label: 'Default', bg: '#EFF2F7' },
  { id: 'slate', label: 'Slate', bg: '#E8EEF8' },
  { id: 'amber', label: 'Amber', bg: '#FFF4DC' },
  { id: 'red', label: 'Red', bg: '#FDECEA' },
  { id: 'green', label: 'Green', bg: '#EAF7E6' },
  { id: 'rose', label: 'Rose', bg: '#FDEEF5' },
  { id: 'purple', label: 'Purple', bg: '#F0EBFA' },
];

const VALID_COLORS = new Set(CARD_COLORS.map((c) => c.id));

// --- Feature detection ------------------------------------------------------

export function isSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// --- IndexedDB handle persistence ------------------------------------------

// Shared DB opener. Exported so src/sync/syncStateStore.js can reuse the same
// connection (sharing the upgrade path avoids two competing onupgradeneeded
// handlers seeing different schema states).
export function openScrybeDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => applyScrybeMigrations(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      // Another tab is holding an older version open. The promise will not
      // resolve until that tab closes; surface a hint in the console so the
      // developer can debug stuck migrations.
      console.warn('Wren IndexedDB upgrade blocked: another tab is holding the old version open.');
    };
  });
}

function openDb() {
  return openScrybeDb();
}

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function getStoredDirHandle() {
  try {
    return (await idbGet(HANDLE_KEY)) || null;
  } catch {
    return null;
  }
}

export async function clearStoredDirHandle() {
  await idbDelete(HANDLE_KEY);
}

// --- Permissions ------------------------------------------------------------

export async function queryPermission(handle, readWrite = true) {
  if (!handle?.queryPermission) return 'granted';
  return handle.queryPermission({ mode: readWrite ? 'readwrite' : 'read' });
}

// Must be called from within a user gesture (click). Browsers auto-grant for a
// handle the user already picked, so this is usually a no-op prompt.
export async function requestPermission(handle, readWrite = true) {
  if (!handle?.requestPermission) return 'granted';
  return handle.requestPermission({ mode: readWrite ? 'readwrite' : 'read' });
}

// Pick a folder (user gesture) and persist the handle for next launch.
export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

// --- Frontmatter <-> note ---------------------------------------------------

function normalizeColor(value) {
  return VALID_COLORS.has(value) ? value : 'default';
}

export function serializeNote(note) {
  const lines = [
    '---',
    `title: ${JSON.stringify(note.title || '')}`,
    `created: ${note.created}`,
    `modified: ${note.modified}`,
    `color: ${normalizeColor(note.color)}`,
    '---',
    '',
    note.body || '',
  ];
  return lines.join('\n');
}

export function parseNote(text, filename) {
  let title = '';
  let created = '';
  let modified = '';
  let color = 'default';
  let body = text;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (val.startsWith('"')) {
        try {
          val = JSON.parse(val);
        } catch {
          /* leave raw */
        }
      }
      if (key === 'title') title = val;
      else if (key === 'created') created = val;
      else if (key === 'modified') modified = val;
      else if (key === 'color') color = val;
    }
  }

  const now = new Date().toISOString();
  return {
    filename,
    title,
    body,
    color: normalizeColor(color),
    created: created || now,
    modified: modified || created || now,
    firstLine: firstLineOf(body),
  };
}

// Plain-text preview of the first meaningful line of markdown.
export function firstLineOf(markdown) {
  if (!markdown) return '';
  const lines = markdown.split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    line = line
      .replace(/^#{1,6}\s+/, '') // headings
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, '') // task list
      .replace(/^[-*+]\s+/, '') // bullets
      .replace(/^\d+\.\s+/, '') // ordered
      .replace(/^>\s?/, '') // blockquote
      .replace(/[*_~`]/g, '') // inline emphasis marks
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images -> text
      .trim();
    if (line) return line;
  }
  return '';
}

// --- Note CRUD --------------------------------------------------------------

export function slugify(title) {
  const base = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'untitled';
}

export async function listNotes(dirHandle) {
  const notes = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file') continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    try {
      const file = await entry.getFile();
      const text = await file.text();
      const note = parseNote(text, entry.name);
      // Fall back to the file's own mtime if frontmatter lacks one.
      if (!note.modified && file.lastModified) {
        note.modified = new Date(file.lastModified).toISOString();
      }
      notes.push(note);
    } catch {
      /* skip unreadable files */
    }
  }
  notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return notes;
}

export async function readNote(dirHandle, filename) {
  const fileHandle = await dirHandle.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return parseNote(await file.text(), filename);
}

// Writes the note to disk, bumping `modified`. Returns the persisted note.
export async function writeNote(dirHandle, note) {
  note.modified = new Date().toISOString();
  const fileHandle = await dirHandle.getFileHandle(note.filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(serializeNote(note));
  await writable.close();
  note.firstLine = firstLineOf(note.body);
  return note;
}

export async function createNote(dirHandle, { title = '', color = 'default' } = {}) {
  const now = new Date().toISOString();
  const filename = await uniqueFilename(dirHandle, slugify(title));
  const note = { filename, title, body: '', color: normalizeColor(color), created: now, modified: now, firstLine: '' };
  await writeNote(dirHandle, note);
  return note;
}

export async function deleteNote(dirHandle, filename) {
  await dirHandle.removeEntry(filename);
}

async function uniqueFilename(dirHandle, slug) {
  const stamp = Date.now().toString(36);
  let candidate = `${slug}-${stamp}.md`;
  let n = 1;
  // Extremely unlikely to collide, but guard anyway.
  while (await fileExists(dirHandle, candidate)) {
    candidate = `${slug}-${stamp}-${n++}.md`;
  }
  return candidate;
}

async function fileExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

// Trigger a browser download of the raw .md file.
export function exportNoteDownload(note) {
  const blob = new Blob([serializeNote(note)], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = note.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
