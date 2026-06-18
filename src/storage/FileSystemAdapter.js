// FileSystemAdapter.js
//
// Wraps Wren's existing File System Access API logic (src/notes-store.js)
// to expose the StorageAdapter interface defined in StorageAdapter.js.
//
// The existing module's exports (listNotes, readNote, writeNote, etc.) are
// preserved untouched so src/app-controller.js and src/ui/note-editor.js
// continue to work. Phase 2b will swap those call sites over to the adapter.
//
// Decision provenance: KB Module 05, P1.3 (adapter pattern), and the standing
// "local-first must keep working without Drive" guarantee.

import {
  isSupported,
  getStoredDirHandle,
  clearStoredDirHandle,
  queryPermission,
  requestPermission,
  pickDirectory,
  parseNote,
  buildNoteFilename,
  uniqueNoteName,
  isReservedNoteName,
  INBOX_DIR,
  TRASH_DIR,
  ARCHIVE_DIR,
} from '../notes-store.js';
import { ADAPTER_TYPES, ConflictError, AdapterAuthError } from './StorageAdapter.js';

// Inbox-scoped note ids are the bare filename prefixed with `_inbox/`, so
// readNote/deleteNote can tell a staged file from a top-level one and operate on
// the right directory handle. (FS only — Drive ids are location-independent.)
const INBOX_ID_PREFIX = `${INBOX_DIR}/`;
function isInboxId(id) {
  return typeof id === 'string' && id.startsWith(INBOX_ID_PREFIX);
}
function inboxBaseName(id) {
  return id.slice(INBOX_ID_PREFIX.length);
}

// Archive-scoped ids work the same way: `_archive/<filename>` so readNote /
// deleteNote can resolve to the archive subfolder. (Note Lifecycle B.)
const ARCHIVE_ID_PREFIX = `${ARCHIVE_DIR}/`;
function isArchiveId(id) {
  return typeof id === 'string' && id.startsWith(ARCHIVE_ID_PREFIX);
}
function archiveBaseName(id) {
  return id.slice(ARCHIVE_ID_PREFIX.length);
}

/**
 * Filesystem-backed adapter.
 *
 * noteId === filename for this backend. Revision is the file's mtime in
 * milliseconds (serialized to a string for cross-backend symmetry with
 * Drive's headRevisionId).
 *
 * @implements {import('./StorageAdapter.js').StorageAdapter}
 */
export class FileSystemAdapter {
  constructor() {
    /** @type {FileSystemDirectoryHandle|null} */
    this._dirHandle = null;
  }

  // ---- Lifecycle ---------------------------------------------------------

  /**
   * Load any previously persisted directory handle and check that we still
   * have permission to use it. Never prompts the user — callers must invoke
   * chooseFolder() from inside a click handler to surface the picker.
   */
  async initialize() {
    if (!isSupported()) return; // adapter remains not-ready; caller checks isReady()
    const stored = await getStoredDirHandle();
    if (!stored) return;
    const perm = await queryPermission(stored);
    if (perm === 'granted') {
      this._dirHandle = stored;
    }
    // If perm !== 'granted', we hold the handle in memory but only after the
    // caller re-requests permission via reconnect(). This mirrors the existing
    // boot() flow in app-controller.js.
  }

  async isReady() {
    if (!this._dirHandle) return false;
    const perm = await queryPermission(this._dirHandle);
    return perm === 'granted';
  }

  backendId() {
    return ADAPTER_TYPES.FS;
  }

  // ---- Folder-selection helpers (not part of the adapter interface but the
  //      UI needs them; the parallel methods on DriveAdapter are no-ops). -----

  /** Prompt the user to pick a folder. Must be called from a user gesture. */
  async chooseFolder() {
    const handle = await pickDirectory();
    this._dirHandle = handle;
    return handle;
  }

  /** Re-request permission on a previously stored handle. User-gesture path. */
  async reconnect() {
    const stored = this._dirHandle || (await getStoredDirHandle());
    if (!stored) {
      throw new AdapterAuthError('No stored folder handle to reconnect.', {
        backendId: this.backendId(),
        recoverable: true,
      });
    }
    const perm = await requestPermission(stored);
    if (perm === 'granted') {
      this._dirHandle = stored;
      return true;
    }
    throw new AdapterAuthError('User did not grant folder permission.', {
      backendId: this.backendId(),
      recoverable: true,
    });
  }

  /** Forget the stored handle (used by a "Disconnect folder" affordance). */
  async forget() {
    this._dirHandle = null;
    await clearStoredDirHandle();
  }

  // ---- StorageAdapter interface methods ---------------------------------

  async listNotes() {
    this._assertReady();
    const out = [];
    for await (const entry of this._dirHandle.values()) {
      if (entry.kind !== 'file') continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      // Skip Wren-managed files (AI phase 2): _index.md / tasks.md. The scan is
      // top-level only, so daily/ and _inbox/ subdirs are already excluded.
      if (isReservedNoteName(entry.name)) continue;
      try {
        const file = await entry.getFile();
        const text = await file.text();
        const parsed = parseNote(text, entry.name);
        const modified = parsed.modified || new Date(file.lastModified).toISOString();
        out.push({
          id: entry.name,
          // Logical wren-id from frontmatter (additive — the storage id stays
          // `id`). Exposed so the AI/index layer can consume it.
          wrenId: parsed.wrenId || '',
          title: parsed.title || '',
          created: parsed.created || modified,
          modified,
          color: parsed.color,
          summary: parsed.summary || '',
          // Provenance (MCP v2.1) — surfaced so cards can show the AI badge
          // without re-reading the body. Absent on legacy notes.
          createdBy: parsed.createdBy || '',
          lastEditedBy: parsed.lastEditedBy || '',
          lastEdited: parsed.lastEdited || '',
          // Revision for FS = mtime in ms (string for cross-backend symmetry).
          // Drive uses headRevisionId. Both are opaque to the sync layer.
          revision: String(file.lastModified),
        });
      } catch {
        // Skip unreadable files - this matches the existing notes-store.listNotes behavior.
      }
    }
    // Newest first, like the existing module.
    out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return out;
  }

  async readNote(noteId) {
    this._assertReady();
    const { dirHandle, name } = await this._resolveNoteLocation(noteId);
    const fileHandle = await dirHandle.getFileHandle(name);
    const file = await fileHandle.getFile();
    const content = await file.text();
    return {
      content,
      revision: String(file.lastModified),
    };
  }

  /**
   * @param {string} noteId
   * @param {string} content - raw .md text including frontmatter
   * @param {string} [expectedRevision] - if provided, current mtime must match
   * @returns {Promise<{revision: string}>}
   */
  async writeNote(noteId, content, expectedRevision) {
    this._assertReady();

    if (expectedRevision !== undefined) {
      let currentRev = null;
      try {
        const existing = await this._dirHandle.getFileHandle(noteId);
        const f = await existing.getFile();
        currentRev = String(f.lastModified);
      } catch {
        // File doesn't exist yet — that's fine if caller passed an empty/zero
        // expectedRevision (treat as "create"). Otherwise it's a conflict
        // (someone deleted the file underneath us).
        if (expectedRevision !== '' && expectedRevision !== '0') {
          throw new ConflictError('File missing during conditional write', {
            localRevision: expectedRevision,
            remoteRevision: 'deleted',
          });
        }
      }
      if (currentRev !== null && currentRev !== expectedRevision) {
        throw new ConflictError('Revision mismatch during conditional write', {
          localRevision: expectedRevision,
          remoteRevision: currentRev,
        });
      }
    }

    const fileHandle = await this._dirHandle.getFileHandle(noteId, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();

    // Re-stat to capture the mtime the OS just assigned. This is the new
    // revision the caller should track.
    const after = await fileHandle.getFile();
    return { revision: String(after.lastModified) };
  }

  async deleteNote(noteId) {
    this._assertReady();
    if (isInboxId(noteId)) {
      // Delete inside the _inbox/ subfolder. If the subfolder is gone the file
      // is already absent — treat as a no-op.
      const inboxDir = await this._getInboxDirHandle({ create: false });
      if (!inboxDir) return;
      await inboxDir.removeEntry(inboxBaseName(noteId));
      return;
    }
    if (isArchiveId(noteId)) {
      const archiveDir = await this._getArchiveDirHandle({ create: false });
      if (!archiveDir) return;
      await archiveDir.removeEntry(archiveBaseName(noteId));
      return;
    }
    await this._dirHandle.removeEntry(noteId);
  }

  // ---- Inbox (_inbox/) — AI write-back staging (phase 4) ----------------

  /**
   * Get the `_inbox/` subfolder handle, or null when absent. With
   * `{ create: false }` (the default) a missing subfolder returns null rather
   * than creating it — listing must never litter an empty `_inbox/`.
   */
  async _getInboxDirHandle({ create = false } = {}) {
    try {
      return await this._dirHandle.getDirectoryHandle(INBOX_DIR, { create });
    } catch {
      return null;
    }
  }

  /**
   * Resolve a (possibly inbox-scoped) note id to the directory handle + bare
   * filename to operate on. Top-level ids resolve to the root dir handle; ids
   * prefixed `_inbox/` resolve to the inbox subfolder handle.
   */
  async _resolveNoteLocation(noteId) {
    if (isInboxId(noteId)) {
      const inboxDir = await this._getInboxDirHandle({ create: false });
      if (!inboxDir) {
        // Surface a clear error rather than silently reading the wrong file.
        throw new Error(`_inbox/ subfolder not found for id "${noteId}"`);
      }
      return { dirHandle: inboxDir, name: inboxBaseName(noteId) };
    }
    if (isArchiveId(noteId)) {
      const archiveDir = await this._getArchiveDirHandle({ create: false });
      if (!archiveDir) {
        throw new Error(`_archive/ subfolder not found for id "${noteId}"`);
      }
      return { dirHandle: archiveDir, name: archiveBaseName(noteId) };
    }
    return { dirHandle: this._dirHandle, name: noteId };
  }

  /**
   * Metadata for `.md` files staged in `_inbox/`. Returns [] when the subfolder
   * is absent (and never creates it). Mirrors listNotes' parse/shape, but each
   * entry's id is `_inbox/<filename>` and carries `inbox: true`.
   */
  async listInboxNotes() {
    this._assertReady();
    const inboxDir = await this._getInboxDirHandle({ create: false });
    if (!inboxDir) return [];
    const out = [];
    for await (const entry of inboxDir.values()) {
      if (entry.kind !== 'file') continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (isReservedNoteName(entry.name)) continue;
      try {
        const file = await entry.getFile();
        const text = await file.text();
        const parsed = parseNote(text, entry.name);
        const modified = parsed.modified || new Date(file.lastModified).toISOString();
        out.push({
          id: `${INBOX_DIR}/${entry.name}`,
          inbox: true,
          name: entry.name,
          wrenId: parsed.wrenId || '',
          title: parsed.title || '',
          created: parsed.created || modified,
          modified,
          color: parsed.color,
          summary: parsed.summary || '',
          createdBy: parsed.createdBy || '',
          lastEditedBy: parsed.lastEditedBy || '',
          lastEdited: parsed.lastEdited || '',
          revision: String(file.lastModified),
        });
      } catch {
        // Skip unreadable staged files.
      }
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return out;
  }

  /**
   * Promote a staged note into the main corpus: read the inbox file, write it at
   * the root under a collision-free name, then delete the inbox original. Mirrors
   * renameNote's write-new-then-delete-old move so a mid-failure never loses data
   * (at worst the original stays staged). Content is byte-preserved, so the
   * frontmatter `wrenId` survives. Returns the new top-level id.
   *
   * @param {string} noteId - an `_inbox/<filename>` id
   * @returns {Promise<{id: string, revision: string}>}
   */
  async promoteInboxNote(noteId) {
    this._assertReady();
    if (!isInboxId(noteId)) {
      throw new Error(`promoteInboxNote requires an _inbox/ id, got "${noteId}"`);
    }
    const inboxDir = await this._getInboxDirHandle({ create: false });
    if (!inboxDir) throw new Error('_inbox/ subfolder not found');
    const baseName = inboxBaseName(noteId);
    const srcHandle = await inboxDir.getFileHandle(baseName);
    const content = await (await srcHandle.getFile()).text();

    const destName = await uniqueNoteName(baseName, (name) => this._fileExists(name));
    const destHandle = await this._dirHandle.getFileHandle(destName, { create: true });
    const writable = await destHandle.createWritable();
    await writable.write(content);
    await writable.close();
    await inboxDir.removeEntry(baseName);

    const after = await destHandle.getFile();
    return { id: destName, revision: String(after.lastModified) };
  }

  /**
   * Discard a staged note: SOFT-delete it by moving the file from `_inbox/` into
   * the `.trash/` subfolder (created on demand) rather than hard-deleting, so the
   * note is recoverable by a manual file move — matching the MCP convention
   * (Drive's discard soft-deletes to its native trash). Uses the same
   * write-new-then-delete-old move as promote, so a mid-failure never loses the
   * file (at worst it stays staged). Collisions in `.trash/` get a " (N)" suffix.
   *
   * @param {string} noteId - an `_inbox/<filename>` id
   * @returns {Promise<{id: string}>} the new `.trash/<filename>` id
   */
  async discardInboxNote(noteId) {
    this._assertReady();
    if (!isInboxId(noteId)) {
      throw new Error(`discardInboxNote requires an _inbox/ id, got "${noteId}"`);
    }
    const inboxDir = await this._getInboxDirHandle({ create: false });
    if (!inboxDir) throw new Error('_inbox/ subfolder not found');
    const baseName = inboxBaseName(noteId);
    const srcHandle = await inboxDir.getFileHandle(baseName);
    const content = await (await srcHandle.getFile()).text();

    const trashDir = await this._dirHandle.getDirectoryHandle(TRASH_DIR, { create: true });
    const destName = await uniqueNoteName(baseName, async (name) => {
      try {
        await trashDir.getFileHandle(name);
        return true;
      } catch {
        return false;
      }
    });
    const destHandle = await trashDir.getFileHandle(destName, { create: true });
    const writable = await destHandle.createWritable();
    await writable.write(content);
    await writable.close();
    await inboxDir.removeEntry(baseName);

    return { id: `${TRASH_DIR}/${destName}` };
  }

  // ---- Archive (_archive/) — Note Lifecycle B -------------------------------

  /**
   * Get the `_archive/` subfolder handle, or null when absent. With
   * `{ create: false }` (the default) a missing subfolder returns null rather
   * than creating it — listing must never create an empty `_archive/`.
   */
  async _getArchiveDirHandle({ create = false } = {}) {
    try {
      return await this._dirHandle.getDirectoryHandle(ARCHIVE_DIR, { create });
    } catch {
      return null;
    }
  }

  /**
   * Metadata for the `.md` files in `_archive/`. Returns [] when the subfolder
   * is absent (and never creates it). Mirrors listNotes' shape, but each entry's
   * id is `_archive/<filename>` and carries `archived: true`. Read from disk —
   * archived notes are outside the indexed roots, so the catalog never has them.
   */
  async listArchiveNotes() {
    this._assertReady();
    const archiveDir = await this._getArchiveDirHandle({ create: false });
    if (!archiveDir) return [];
    const out = [];
    for await (const entry of archiveDir.values()) {
      if (entry.kind !== 'file') continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (isReservedNoteName(entry.name)) continue;
      try {
        const file = await entry.getFile();
        const text = await file.text();
        const parsed = parseNote(text, entry.name);
        const modified = parsed.modified || new Date(file.lastModified).toISOString();
        out.push({
          id: `${ARCHIVE_DIR}/${entry.name}`,
          archived: true,
          name: entry.name,
          wrenId: parsed.wrenId || '',
          title: parsed.title || '',
          created: parsed.created || modified,
          modified,
          color: parsed.color,
          summary: parsed.summary || '',
          due: parsed.due || '',
          createdBy: parsed.createdBy || '',
          lastEditedBy: parsed.lastEditedBy || '',
          lastEdited: parsed.lastEdited || '',
          revision: String(file.lastModified),
        });
      } catch {
        // Skip unreadable archived files.
      }
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return out;
  }

  /**
   * Archive a top-level note: move its file into `_archive/` (created on demand)
   * via the same write-new-then-delete-old move as promote, so a mid-failure
   * never loses the file. Content is byte-preserved (frontmatter intact). The
   * filename — including the `YYYY-MM-DD - Title.md` convention — is preserved,
   * with a " (N)" suffix only on a collision. Returns the new `_archive/` id.
   *
   * @param {string} noteId - a top-level note id (filename)
   * @returns {Promise<{id: string}>}
   */
  async archiveNote(noteId) {
    this._assertReady();
    if (isInboxId(noteId) || isArchiveId(noteId)) {
      throw new Error(`archiveNote requires a top-level id, got "${noteId}"`);
    }
    const srcHandle = await this._dirHandle.getFileHandle(noteId);
    const content = await (await srcHandle.getFile()).text();

    const archiveDir = await this._dirHandle.getDirectoryHandle(ARCHIVE_DIR, { create: true });
    const destName = await uniqueNoteName(noteId, async (name) => {
      try {
        await archiveDir.getFileHandle(name);
        return true;
      } catch {
        return false;
      }
    });
    const destHandle = await archiveDir.getFileHandle(destName, { create: true });
    const writable = await destHandle.createWritable();
    await writable.write(content);
    await writable.close();
    await this._dirHandle.removeEntry(noteId);

    return { id: `${ARCHIVE_DIR}/${destName}` };
  }

  /**
   * Unarchive: move an `_archive/<filename>` note back to the top level (the
   * mirror of archiveNote), preserving the filename/`wrenId`. Returns the new
   * top-level id + revision, so the caller can re-index and re-list it.
   *
   * @param {string} noteId - an `_archive/<filename>` id
   * @returns {Promise<{id: string, revision: string}>}
   */
  async unarchiveNote(noteId) {
    this._assertReady();
    if (!isArchiveId(noteId)) {
      throw new Error(`unarchiveNote requires an _archive/ id, got "${noteId}"`);
    }
    const archiveDir = await this._getArchiveDirHandle({ create: false });
    if (!archiveDir) throw new Error('_archive/ subfolder not found');
    const baseName = archiveBaseName(noteId);
    const srcHandle = await archiveDir.getFileHandle(baseName);
    const content = await (await srcHandle.getFile()).text();

    const destName = await uniqueNoteName(baseName, (name) => this._fileExists(name));
    const destHandle = await this._dirHandle.getFileHandle(destName, { create: true });
    const writable = await destHandle.createWritable();
    await writable.write(content);
    await writable.close();
    await archiveDir.removeEntry(baseName);

    const after = await destHandle.getFile();
    return { id: destName, revision: String(after.lastModified) };
  }

  /**
   * Write/overwrite a Wren-managed file by exact name in the notes-folder root
   * (e.g. '.wren-index.json', '_index.md'). Mirrors the writeNote write path
   * minus revision bookkeeping — managed files are not notes, carry no revision,
   * and are excluded from listNotes (isReservedNoteName + the .md filter).
   *
   * @param {string} name
   * @param {string} content
   * @returns {Promise<void>}
   */
  async writeManagedFile(name, content) {
    this._assertReady();
    const fileHandle = await this._dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  /**
   * Read a Wren-managed file by exact name from the notes-folder root. Returns
   * its text, or null if the file does not exist. Symmetric with
   * writeManagedFile; used by the Phase 3 contract-doc missing/stale check.
   *
   * @param {string} name
   * @returns {Promise<string|null>}
   */
  async readManagedFile(name) {
    this._assertReady();
    try {
      const fileHandle = await this._dirHandle.getFileHandle(name);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch {
      // NotFoundError (or any read failure) -> treat as absent.
      return null;
    }
  }

  /**
   * Create a brand-new note. The adapter is responsible for generating an
   * id (filename) — for FS, this is the "YYYY-MM-DD - <title>.md" name from
   * buildNoteFilename with a " (N)" uniqueness suffix on collision.
   *
   * Called by app-controller's handleNew after it has serialized the empty
   * note (frontmatter + empty body) into raw markdown text.
   *
   * @param {string} content - raw .md text including frontmatter
   * @param {{title?: string, created?: string}} [hint] - used to derive the
   *   "YYYY-MM-DD - <title>.md" filename. DriveAdapter accepts the same shape.
   * @returns {Promise<{id: string, revision: string}>}
   */
  async createNote(content, { title = '', created = '' } = {}) {
    this._assertReady();
    const desired = buildNoteFilename(created, title);
    const candidate = await uniqueNoteName(desired, (name) => this._fileExists(name));
    const fileHandle = await this._dirHandle.getFileHandle(candidate, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    const after = await fileHandle.getFile();
    return { id: candidate, revision: String(after.lastModified) };
  }

  /**
   * Rename a note's file to `desiredName`, resolving collisions with a
   * " (2)", " (3)", … suffix.
   *
   * For FS the noteId *is* the filename, so this CHANGES the note's identity —
   * the caller (app-controller) must propagate the returned id everywhere the
   * old id was held. The File System Access API has no atomic rename, so this
   * is write-new-then-delete-old: content is copied to the new file before the
   * old entry is removed, so a failure mid-way never loses data (at worst it
   * leaves the original in place).
   *
   * @param {string} noteId        - current filename
   * @param {string} desiredName   - e.g. "2026-05-28 - My Note.md"
   * @returns {Promise<{id: string, revision: string}>} new filename + mtime
   */
  async renameNote(noteId, desiredName) {
    this._assertReady();
    if (desiredName === noteId) {
      const existing = await this._dirHandle.getFileHandle(noteId);
      const f = await existing.getFile();
      return { id: noteId, revision: String(f.lastModified) };
    }
    const newName = await uniqueNoteName(desiredName, (name) => this._fileExists(name));
    const srcHandle = await this._dirHandle.getFileHandle(noteId);
    const content = await (await srcHandle.getFile()).text();
    const destHandle = await this._dirHandle.getFileHandle(newName, { create: true });
    const writable = await destHandle.createWritable();
    await writable.write(content);
    await writable.close();
    await this._dirHandle.removeEntry(noteId);
    const after = await destHandle.getFile();
    return { id: newName, revision: String(after.lastModified) };
  }

  async _fileExists(name) {
    try {
      await this._dirHandle.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  // ---- Internal ----------------------------------------------------------

  _assertReady() {
    if (!this._dirHandle) {
      throw new AdapterAuthError('FileSystemAdapter has no folder handle.', {
        backendId: this.backendId(),
        recoverable: true,
      });
    }
  }
}
