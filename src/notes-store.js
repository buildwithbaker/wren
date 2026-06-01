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

// Parse a frontmatter `tags:` value (inline JSON array form). Defensive:
// returns [] for anything that isn't a JSON array of non-empty strings.
function parseTagsValue(val) {
  if (typeof val !== 'string' || !val.startsWith('[')) return [];
  try {
    const arr = JSON.parse(val);
    if (!Array.isArray(arr)) return [];
    return arr.filter((t) => typeof t === 'string' && t.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Generate a stable logical note id: `wren-` + 12 random base36 chars
 * (e.g. "wren-k3p9x2m7q1za").
 *
 * This is the note's ADDITIVE logical identity for AI consumption / backlinks.
 * It is independent of the storage identity (the FS filename or the Drive
 * fileId), which the app tracks separately as `note.id`. Generated once and
 * never changed. Prefers crypto.getRandomValues; falls back to Math.random
 * where crypto is unavailable (e.g. some test/Node contexts).
 */
export function generateNoteId() {
  const LEN = 12;
  let out = '';
  const cryptoObj =
    typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : null;
  if (cryptoObj) {
    const bytes = new Uint8Array(LEN);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < LEN; i++) out += (bytes[i] % 36).toString(36);
  } else {
    for (let i = 0; i < LEN; i++) out += Math.floor(Math.random() * 36).toString(36);
  }
  return `wren-${out}`;
}

export function serializeNote(note) {
  // Stable-id chokepoint — the ONE intentional mutation of the passed note:
  // if the note has no logical id yet, stamp one before building the lines.
  // Routing every write through here means new notes get an id on first save and
  // legacy id-less notes get one lazily the next time they're saved — no mass
  // file rewrite on load, no modified/Drive-revision churn. The frontmatter key
  // is `id`; the in-memory property is `note.wrenId`. NOTE: `note.id` is the
  // STORAGE identity (FS filename / Drive fileId) and must NOT be touched here.
  if (!note.wrenId) note.wrenId = generateNoteId();

  const lines = [
    '---',
    `id: ${note.wrenId}`,
    `title: ${JSON.stringify(note.title || '')}`,
    `created: ${note.created}`,
    `modified: ${note.modified}`,
    `color: ${normalizeColor(note.color)}`,
  ];
  // due: only written when set (ISO date / timestamp); kept clean otherwise.
  if (note.due) {
    lines.push(`due: ${JSON.stringify(note.due)}`);
  }
  // summary: only written when non-empty. JSON.stringify so a summary containing
  // a colon survives the line-based parser (which splits on the first colon).
  if (note.summary) {
    lines.push(`summary: ${JSON.stringify(note.summary)}`);
  }
  // tags: only written when non-empty — keeps tag-less notes' frontmatter clean.
  const tags = Array.isArray(note.tags)
    ? note.tags.filter((t) => typeof t === 'string' && t.trim().length > 0)
    : [];
  if (tags.length > 0) {
    lines.push(`tags: ${JSON.stringify(tags)}`);
  }
  lines.push('---', '', note.body || '');
  return lines.join('\n');
}

export function parseNote(text, filename) {
  // wrenId is the logical id read from the frontmatter `id` key. parse stays
  // pure / read-only — it never GENERATES an id (that is serializeNote's job).
  let wrenId = '';
  let title = '';
  let created = '';
  let modified = '';
  let color = 'default';
  let due = '';
  let summary = '';
  let tags = [];
  let body = text;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (key === 'tags') {
        // Inline JSON array; first colon already split key/val so the array
        // literal (which contains internal colons) stays intact in val.
        tags = parseTagsValue(val);
        continue;
      }
      if (val.startsWith('"')) {
        try {
          val = JSON.parse(val);
        } catch {
          /* leave raw */
        }
      }
      if (key === 'id') wrenId = val;
      else if (key === 'title') title = val;
      else if (key === 'created') created = val;
      else if (key === 'modified') modified = val;
      else if (key === 'color') color = val;
      else if (key === 'due') due = val;
      else if (key === 'summary') summary = val;
    }
  }

  const now = new Date().toISOString();
  return {
    filename,
    wrenId,
    title,
    body,
    color: normalizeColor(color),
    created: created || now,
    modified: modified || created || now,
    due,
    summary,
    tags,
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

// --- Reserved Wren-managed files --------------------------------------------

// Files that live in the notes folder but are NOT user notes — they are created
// by the AI layer in later phases (_index.md, tasks.md, and anything under
// daily/ or _inbox/). They must be excluded from note listings. Directory scans
// here are top-level only, so daily/ and _inbox/ subdirs are already skipped;
// only the reserved top-level files need a name guard. Exported so both storage
// adapters can share one definition. TODO(ai-phase2): extend if more reserved
// names are added.
const RESERVED_NOTE_NAMES = new Set(['_index.md', 'tasks.md']);

export function isReservedNoteName(name) {
  return RESERVED_NOTE_NAMES.has(name);
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

/**
 * Build a human-friendly note filename: "YYYY-MM-DD - <title>.md".
 *
 * The date is the first 10 chars of the ISO `created` timestamp (falling back
 * to today when missing or unparseable). The title is stripped of characters
 * that are illegal in Windows / macOS / Drive file names plus control chars,
 * has its whitespace collapsed, is capped to ~80 chars, and defaults to
 * "Untitled" when empty.
 */
export function buildNoteFilename(createdIso, title) {
  let date = '';
  if (typeof createdIso === 'string') {
    const head = createdIso.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) date = head;
  }
  if (!date) date = new Date().toISOString().slice(0, 10);

  let safe = (typeof title === 'string' ? title : '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  if (!safe) safe = 'Untitled';

  return `${date} - ${safe}.md`;
}

/**
 * Resolve a unique filename by appending " (2)", " (3)", … before the .md
 * extension until `nameExists` reports the candidate is free. `nameExists`
 * may return a boolean or a Promise<boolean>.
 */
export async function uniqueNoteName(desiredName, nameExists) {
  if (!(await nameExists(desiredName))) return desiredName;
  const m = /^(.*)(\.md)$/i.exec(desiredName);
  const base = m ? m[1] : desiredName;
  const ext = m ? m[2] : '';
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await nameExists(candidate))) return candidate;
  }
}

export async function listNotes(dirHandle) {
  const notes = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file') continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    if (isReservedNoteName(entry.name)) continue; // skip Wren-managed files (AI phase 2)
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
