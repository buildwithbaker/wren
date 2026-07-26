// TauriFsAdapter.js
//
// Native desktop storage backend. Implements the same StorageAdapter contract
// as FileSystemAdapter, but talks to the real filesystem through the Tauri
// `plugin-fs` + `@tauri-apps/api/path` APIs instead of the browser File System
// Access API. This is what lets a fresh desktop install open STRAIGHT into a
// notes folder with no directory picker:
//
//   <Documents>/Wren Notes
//
// resolved from the OS Documents directory and auto-created (recursive mkdir)
// on first launch. `backendId()` is still 'fs' — the fs|drive preference model
// is unchanged; this is purely a different fs-family implementation chosen by
// getActiveAdapter()/chooseFsAdapter() for Tauri fresh installs.
//
// Semantics mirror FileSystemAdapter exactly so the AI-readable index + MCP
// keep working: top-level-only note scans, reserved managed files
// (.wren-index.json, README-for-AI.md, _index.md, tasks.md) excluded from
// listings, mtime-as-revision with ConflictError on conditional-write
// mismatch, and the _inbox/ (staging) / _archive/ (archive) / .trash/
// (soft-delete) subfolder conventions.
//
// The Tauri plugin modules are imported LAZILY (dynamic import inside async
// methods) so this file loads cleanly in the PWA/extension bundle and under
// vitest, where those native modules can't run. The real fs calls only ever
// execute inside Tauri (the adapter is only instantiated when isTauri()).
//
// Decision provenance: storage-local-default-drive-experimental SOW P5
// (native folder adapter + zero-prompt folder).

import {
  parseNote,
  buildNoteFilename,
  uniqueNoteName,
  isReservedNoteName,
  INBOX_DIR,
  TRASH_DIR,
  ARCHIVE_DIR,
} from '../notes-store.js';
import { ADAPTER_TYPES, ConflictError, AdapterAuthError } from './StorageAdapter.js';

/** Folder name created under the OS Documents directory. */
export const WREN_NOTES_FOLDER = 'Wren Notes';

const EPOCH_ISO = new Date(0).toISOString();

// ---- Lazy Tauri module loaders --------------------------------------------
// Cached after first load. Kept out of the static import graph so the PWA /
// extension / vitest never resolve the native plugin at module-eval time.

let _fsMod = null;
let _pathMod = null;
async function fsApi() {
  if (!_fsMod) _fsMod = await import('@tauri-apps/plugin-fs');
  return _fsMod;
}
async function pathApi() {
  if (!_pathMod) _pathMod = await import('@tauri-apps/api/path');
  return _pathMod;
}

// ---- Pure path helpers (no fs access — unit-testable in plain Node) --------

/**
 * Join path segments with a forward slash, trimming stray separators. The base
 * (first) segment keeps any drive prefix; only its trailing separator is
 * stripped. Tauri's fs plugin normalizes forward slashes on every platform
 * (including Windows), so mixed `C:\…/Wren Notes/foo.md` paths resolve fine.
 *
 * @param {...string} parts
 * @returns {string}
 */
export function joinPath(...parts) {
  const segs = [];
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i];
    if (p == null || p === '') continue;
    p = String(p);
    p = i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '');
    if (p !== '') segs.push(p);
  }
  return segs.join('/');
}

// Inbox-/archive-scoped note ids carry a subfolder prefix so read/delete can
// resolve to the right directory — exactly as FileSystemAdapter does. (Drive
// ids are location-independent; the FS family is not.)
const INBOX_ID_PREFIX = `${INBOX_DIR}/`;
const ARCHIVE_ID_PREFIX = `${ARCHIVE_DIR}/`;
function isInboxId(id) {
  return typeof id === 'string' && id.startsWith(INBOX_ID_PREFIX);
}
function isArchiveId(id) {
  return typeof id === 'string' && id.startsWith(ARCHIVE_ID_PREFIX);
}
function inboxBaseName(id) {
  return id.slice(INBOX_ID_PREFIX.length);
}
function archiveBaseName(id) {
  return id.slice(ARCHIVE_ID_PREFIX.length);
}

/**
 * Guard against path traversal. Adapter note ids / managed names must behave
 * like bare File System Access child filenames — the browser FileSystemAdapter
 * relies on the platform API rejecting separators, so a value like
 * `../README-for-AI.md` or `_inbox/../foo.md` can never escape the intended
 * folder there. joinPath() does no such enforcement, so we reject separators
 * and `.`/`..` here before any path is built.
 *
 * @param {string} name - a BARE filename (no directory component)
 * @param {string} [label]
 */
function assertBareName(name, label = 'note name') {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    /[\\/]/.test(name)
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(name)}`);
  }
}

/** FileInfo.mtime (Date|null) → ms-since-epoch string, mirroring FS revisions. */
function revOf(info) {
  const ms = info && info.mtime ? new Date(info.mtime).getTime() : 0;
  return String(Number.isFinite(ms) ? ms : 0);
}

/**
 * Native-filesystem-backed adapter (Tauri desktop only).
 *
 * noteId === filename (top-level) or `_inbox/<filename>` / `_archive/<filename>`
 * for subfolder-scoped ids. Revision is the file's mtime in milliseconds,
 * serialized to a string for cross-backend symmetry with Drive's
 * headRevisionId.
 *
 * @implements {import('./StorageAdapter.js').StorageAdapter}
 */
export class TauriFsAdapter {
  constructor() {
    /** Absolute path to the notes folder, set in initialize(). */
    this._base = null;
    this._ready = false;
  }

  // ---- Lifecycle ---------------------------------------------------------

  /**
   * Resolve <Documents>/Wren Notes and ensure it exists (recursive mkdir is a
   * no-op when present). No picker, no prompt — this is the zero-friction
   * desktop default. Idempotent.
   */
  async initialize() {
    const { documentDir } = await pathApi();
    const { mkdir, exists } = await fsApi();
    const docs = await documentDir();
    this._base = joinPath(docs, WREN_NOTES_FOLDER);
    if (!(await exists(this._base))) {
      await mkdir(this._base, { recursive: true });
    }
    this._ready = true;
  }

  async isReady() {
    return this._ready && !!this._base;
  }

  backendId() {
    return ADAPTER_TYPES.FS;
  }

  /** Absolute path of the active notes folder (for display / diagnostics). */
  folderPath() {
    return this._base;
  }

  // ---- StorageAdapter interface methods ---------------------------------

  async listNotes() {
    this._assertReady();
    return this._listMd(this._base, (name, _parsed, base) => ({ id: name, ...base }));
  }

  async readNote(noteId) {
    this._assertReady();
    const abs = this._pathForId(noteId);
    const { readTextFile, stat } = await fsApi();
    // Stat BEFORE reading: if an external editor rewrites the file between the
    // two calls, the caller ends up holding new content tagged with the OLD
    // revision. A later conditional write then mismatches the now-newer mtime
    // and raises ConflictError — the safe direction. (Read-then-stat would do
    // the opposite: new revision on old content → silent overwrite.)
    const info = await stat(abs);
    const content = await readTextFile(abs);
    return { content, revision: revOf(info) };
  }

  /**
   * @param {string} noteId
   * @param {string} content - raw .md text including frontmatter
   * @param {string} [expectedRevision] - if provided, current mtime must match
   * @returns {Promise<{revision: string}>}
   */
  async writeNote(noteId, content, expectedRevision) {
    this._assertReady();
    assertBareName(noteId, 'note id');
    const { writeTextFile, stat, exists } = await fsApi();
    // writeNote targets the root only (mirrors FileSystemAdapter — staged inbox
    // notes are promoted/discarded, never written back in place).
    const abs = joinPath(this._base, noteId);

    // Create-intent is signalled by an empty/zero expectedRevision (createNote
    // path + the conflict-copy writer). Any other write must target an existing
    // file: writeTextFile always creates, so a plain update whose target
    // vanished (renamed/deleted underneath us) would otherwise resurrect the
    // stale filename. Guard it and surface a ConflictError instead.
    const allowCreate = expectedRevision === '' || expectedRevision === '0';
    const present = await exists(abs);
    if (expectedRevision !== undefined) {
      let currentRev = null;
      if (present) {
        currentRev = revOf(await stat(abs));
      } else if (!allowCreate) {
        // File vanished underneath a conditional (non-create) write.
        throw new ConflictError('File missing during conditional write', {
          localRevision: expectedRevision,
          remoteRevision: 'deleted',
        });
      }
      if (currentRev !== null && currentRev !== expectedRevision) {
        throw new ConflictError('Revision mismatch during conditional write', {
          localRevision: expectedRevision,
          remoteRevision: currentRev,
        });
      }
    } else if (!present) {
      // Plain update whose target vanished — do not resurrect it.
      throw new ConflictError('Note file missing on write (renamed or deleted underneath us)', {
        localRevision: '',
        remoteRevision: 'deleted',
      });
    }

    await writeTextFile(abs, content);
    return { revision: revOf(await stat(abs)) };
  }

  async deleteNote(noteId) {
    this._assertReady();
    const abs = this._pathForId(noteId);
    const { remove, exists } = await fsApi();
    // For subfolder-scoped ids, a missing subfolder/file is a no-op (the file is
    // already gone) — matching FileSystemAdapter.
    if ((isInboxId(noteId) || isArchiveId(noteId)) && !(await exists(abs))) return;
    await remove(abs);
  }

  /**
   * Write/overwrite a Wren-managed file by exact name in the notes-folder root
   * (e.g. '.wren-index.json', '_index.md'). Carries no revision and never
   * appears in listNotes (reserved-name + .md filters exclude it).
   */
  async writeManagedFile(name, content) {
    this._assertReady();
    assertBareName(name, 'managed file name');
    const { writeTextFile } = await fsApi();
    await writeTextFile(joinPath(this._base, name), content);
  }

  /**
   * Read a Wren-managed file by exact name from the notes-folder root. Returns
   * its text, or null if absent. Symmetric with writeManagedFile.
   */
  async readManagedFile(name) {
    this._assertReady();
    assertBareName(name, 'managed file name');
    const { readTextFile, exists } = await fsApi();
    const abs = joinPath(this._base, name);
    try {
      if (!(await exists(abs))) return null;
      return await readTextFile(abs);
    } catch (err) {
      // Mirror FileSystemAdapter: a read failure resolves to "absent" so the
      // once-per-session managed-file check never hard-crashes boot. But the
      // file passed the exists() check above, so a failure here is a real I/O /
      // permission / fs-scope problem — log it so a misconfigured scope is
      // diagnosable rather than silently masked as a missing file.
      console.warn(`readManagedFile("${name}") failed after exists() passed`, err);
      return null;
    }
  }

  /**
   * Create a brand-new note, generating a "YYYY-MM-DD - <title>.md" filename
   * with a " (N)" uniqueness suffix on collision.
   *
   * @param {string} content
   * @param {{title?: string, created?: string}} [hint]
   * @returns {Promise<{id: string, revision: string}>}
   */
  async createNote(content, { title = '', created = '' } = {}) {
    this._assertReady();
    const { writeTextFile, stat } = await fsApi();
    const desired = buildNoteFilename(created, title);
    const candidate = await uniqueNoteName(desired, (name) => this._rootExists(name));
    const abs = joinPath(this._base, candidate);
    await writeTextFile(abs, content);
    return { id: candidate, revision: revOf(await stat(abs)) };
  }

  /**
   * Rename a note's file to `desiredName`, resolving collisions with a " (N)"
   * suffix. For FS the noteId IS the filename, so this changes the note's
   * identity and the caller must propagate the returned id. Done as
   * write-new-then-delete-old (see {@link _moveFile}) so a mid-failure never
   * loses data — mirroring FileSystemAdapter.
   *
   * @param {string} noteId
   * @param {string} desiredName
   * @returns {Promise<{id: string, revision: string}>}
   */
  async renameNote(noteId, desiredName) {
    this._assertReady();
    assertBareName(noteId, 'note id');
    assertBareName(desiredName, 'desired name');
    const { stat } = await fsApi();
    if (desiredName === noteId) {
      return { id: noteId, revision: revOf(await stat(joinPath(this._base, noteId))) };
    }
    const newName = await uniqueNoteName(desiredName, (name) => this._rootExists(name));
    const destAbs = joinPath(this._base, newName);
    await this._moveFile(joinPath(this._base, noteId), destAbs);
    return { id: newName, revision: revOf(await stat(destAbs)) };
  }

  // ---- Inbox (_inbox/) — AI write-back staging --------------------------

  /**
   * Metadata for `.md` files staged in `_inbox/`. Returns [] when the subfolder
   * is absent (and never creates it). Each entry's id is `_inbox/<filename>`
   * and carries `inbox: true`.
   */
  async listInboxNotes() {
    this._assertReady();
    const { exists } = await fsApi();
    const inboxAbs = joinPath(this._base, INBOX_DIR);
    if (!(await exists(inboxAbs))) return [];
    return this._listMd(inboxAbs, (name, _parsed, base) => ({
      id: `${INBOX_DIR}/${name}`,
      inbox: true,
      name,
      ...base,
    }));
  }

  /**
   * Promote a staged note into the main corpus: move it from `_inbox/` to the
   * root under a collision-free name. Content (and therefore frontmatter
   * `wrenId`) is preserved by the move. Returns the new top-level id.
   *
   * @param {string} noteId - an `_inbox/<filename>` id
   * @returns {Promise<{id: string, revision: string}>}
   */
  async promoteInboxNote(noteId) {
    this._assertReady();
    if (!isInboxId(noteId)) {
      throw new Error(`promoteInboxNote requires an _inbox/ id, got "${noteId}"`);
    }
    const { stat, exists } = await fsApi();
    const inboxAbs = joinPath(this._base, INBOX_DIR);
    if (!(await exists(inboxAbs))) throw new Error('_inbox/ subfolder not found');
    const baseName = inboxBaseName(noteId);
    assertBareName(baseName, 'inbox note id');
    const destName = await uniqueNoteName(baseName, (name) => this._rootExists(name));
    const destAbs = joinPath(this._base, destName);
    await this._moveFile(joinPath(inboxAbs, baseName), destAbs);
    return { id: destName, revision: revOf(await stat(destAbs)) };
  }

  /**
   * Discard a staged note: SOFT-delete it by moving the file from `_inbox/`
   * into `.trash/` (created on demand) rather than hard-deleting, matching the
   * MCP convention. Collisions in `.trash/` get a " (N)" suffix.
   *
   * @param {string} noteId - an `_inbox/<filename>` id
   * @returns {Promise<{id: string}>} the new `.trash/<filename>` id
   */
  async discardInboxNote(noteId) {
    this._assertReady();
    if (!isInboxId(noteId)) {
      throw new Error(`discardInboxNote requires an _inbox/ id, got "${noteId}"`);
    }
    const { mkdir, exists } = await fsApi();
    const inboxAbs = joinPath(this._base, INBOX_DIR);
    if (!(await exists(inboxAbs))) throw new Error('_inbox/ subfolder not found');
    const baseName = inboxBaseName(noteId);
    assertBareName(baseName, 'inbox note id');
    const trashAbs = joinPath(this._base, TRASH_DIR);
    if (!(await exists(trashAbs))) await mkdir(trashAbs, { recursive: true });
    const destName = await uniqueNoteName(baseName, (name) =>
      this._existsAbs(joinPath(trashAbs, name))
    );
    await this._moveFile(joinPath(inboxAbs, baseName), joinPath(trashAbs, destName));
    return { id: `${TRASH_DIR}/${destName}` };
  }

  // ---- Archive (_archive/) — Note Lifecycle B ---------------------------

  /**
   * Metadata for `.md` files in `_archive/`. Returns [] when the subfolder is
   * absent (and never creates it). Each entry's id is `_archive/<filename>` and
   * carries `archived: true`.
   */
  async listArchiveNotes() {
    this._assertReady();
    const { exists } = await fsApi();
    const archiveAbs = joinPath(this._base, ARCHIVE_DIR);
    if (!(await exists(archiveAbs))) return [];
    return this._listMd(archiveAbs, (name, parsed, base) => ({
      id: `${ARCHIVE_DIR}/${name}`,
      archived: true,
      name,
      due: parsed.due || '',
      ...base,
    }));
  }

  /**
   * Archive a top-level note: move its file into `_archive/` (created on
   * demand), preserving the filename (with a " (N)" suffix only on collision)
   * and content. Returns the new `_archive/` id.
   *
   * @param {string} noteId - a top-level note id (filename)
   * @returns {Promise<{id: string}>}
   */
  async archiveNote(noteId) {
    this._assertReady();
    if (isInboxId(noteId) || isArchiveId(noteId)) {
      throw new Error(`archiveNote requires a top-level id, got "${noteId}"`);
    }
    assertBareName(noteId, 'note id');
    const { mkdir, exists } = await fsApi();
    const archiveAbs = joinPath(this._base, ARCHIVE_DIR);
    if (!(await exists(archiveAbs))) await mkdir(archiveAbs, { recursive: true });
    const destName = await uniqueNoteName(noteId, (name) =>
      this._existsAbs(joinPath(archiveAbs, name))
    );
    await this._moveFile(joinPath(this._base, noteId), joinPath(archiveAbs, destName));
    return { id: `${ARCHIVE_DIR}/${destName}` };
  }

  /**
   * Unarchive: move an `_archive/<filename>` note back to the top level (the
   * mirror of archiveNote), preserving the filename/`wrenId`.
   *
   * @param {string} noteId - an `_archive/<filename>` id
   * @returns {Promise<{id: string, revision: string}>}
   */
  async unarchiveNote(noteId) {
    this._assertReady();
    if (!isArchiveId(noteId)) {
      throw new Error(`unarchiveNote requires an _archive/ id, got "${noteId}"`);
    }
    const { stat, exists } = await fsApi();
    const archiveAbs = joinPath(this._base, ARCHIVE_DIR);
    if (!(await exists(archiveAbs))) throw new Error('_archive/ subfolder not found');
    const baseName = archiveBaseName(noteId);
    assertBareName(baseName, 'archive note id');
    const destName = await uniqueNoteName(baseName, (name) => this._rootExists(name));
    const destAbs = joinPath(this._base, destName);
    await this._moveFile(joinPath(archiveAbs, baseName), destAbs);
    return { id: destName, revision: revOf(await stat(destAbs)) };
  }

  // ---- Internal ----------------------------------------------------------

  /**
   * Scan a directory for note `.md` files (top-level only — readDir is not
   * recursive), parse each, and return metadata newest-first. `decorate` maps
   * (name, parsed, baseMeta) → the final entry so callers can add id/inbox/etc.
   */
  async _listMd(absDir, decorate) {
    const { readDir, readTextFile, stat } = await fsApi();
    let entries;
    try {
      entries = await readDir(absDir);
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (isReservedNoteName(entry.name)) continue;
      try {
        const abs = joinPath(absDir, entry.name);
        const text = await readTextFile(abs);
        const info = await stat(abs);
        const parsed = parseNote(text, entry.name);
        const modified =
          parsed.modified || (info.mtime ? new Date(info.mtime).toISOString() : EPOCH_ISO);
        const base = {
          wrenId: parsed.wrenId || '',
          title: parsed.title || '',
          created: parsed.created || modified,
          modified,
          color: parsed.color,
          summary: parsed.summary || '',
          createdBy: parsed.createdBy || '',
          lastEditedBy: parsed.lastEditedBy || '',
          lastEdited: parsed.lastEdited || '',
          revision: revOf(info),
        };
        out.push(decorate(entry.name, parsed, base));
      } catch {
        // Skip unreadable files (matches FileSystemAdapter).
      }
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return out;
  }

  /**
   * Move a file by write-new-then-delete-old (the File System Access API has no
   * atomic rename and we keep the fs permission set to read/write/remove). On a
   * mid-failure the source survives at worst, never losing data.
   */
  async _moveFile(srcAbs, destAbs) {
    const { readTextFile, writeTextFile, remove } = await fsApi();
    const content = await readTextFile(srcAbs);
    await writeTextFile(destAbs, content);
    await remove(srcAbs);
  }

  /** Absolute path for a (possibly subfolder-scoped) note id. */
  _pathForId(noteId) {
    if (isInboxId(noteId)) {
      const base = inboxBaseName(noteId);
      assertBareName(base, 'inbox note id');
      return joinPath(this._base, INBOX_DIR, base);
    }
    if (isArchiveId(noteId)) {
      const base = archiveBaseName(noteId);
      assertBareName(base, 'archive note id');
      return joinPath(this._base, ARCHIVE_DIR, base);
    }
    assertBareName(noteId, 'note id');
    return joinPath(this._base, noteId);
  }

  async _existsAbs(abs) {
    const { exists } = await fsApi();
    try {
      return await exists(abs);
    } catch {
      return false;
    }
  }

  /** Existence check for a bare filename in the notes-folder root. */
  _rootExists(name) {
    return this._existsAbs(joinPath(this._base, name));
  }

  _assertReady() {
    if (!this._ready || !this._base) {
      throw new AdapterAuthError('TauriFsAdapter is not initialized.', {
        backendId: this.backendId(),
        recoverable: false,
      });
    }
  }
}
