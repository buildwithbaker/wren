// DriveAdapter.js
//
// Drive REST v3 implementation of the StorageAdapter interface. Pairs with
// src/oauth/gisClient.js for token acquisition.
//
// Drive-side anatomy:
//   - One folder named "Wren Notes" per user, marked with appProperties so
//     find-or-create survives renames and same-name collisions.
//   - Notes are stored as text/markdown files inside that folder.
//   - Revisions use headRevisionId (P2b.4); md5Checksum is a secondary check.
//   - Soft delete via PATCH trashed=true (recoverable from Drive trash ~30d).
//
// Decision provenance: KB Module 05 P1.3, P1.4, P1.8, P2b.3, P2b.4.

import { ADAPTER_TYPES, ConflictError, AdapterAuthError } from './StorageAdapter.js';
import {
  buildNoteFilename,
  uniqueNoteName,
  isReservedNoteName,
  INBOX_DIR,
  ARCHIVE_DIR,
} from '../notes-store.js';
import {
  getAccessToken,
  requestAccessToken,
  initTokenClient,
} from '../oauth/gisClient.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = 'Wren Notes';
const FOLDER_MARKER_KEY = 'wrenAppFolder';
const FOLDER_MARKER_VALUE = '1';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const NOTE_MIME = 'text/markdown';

// Retry policy per Decision P1.8 (truncated exponential backoff with jitter).
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;

// Whether If-Match: <headRevisionId> on multipart PATCH is honored by Drive
// for blob files. Set empirically once during runtime by the writeNote probe.
// null = untested, true = supported (preferred), false = not supported (fall
// back to read-before-write only).
let IF_MATCH_SUPPORTED = null;

/**
 * Drive-backed adapter.
 *
 * noteId === Drive file ID for this backend. Revision is the file's
 * headRevisionId.
 *
 * @implements {import('./StorageAdapter.js').StorageAdapter}
 */
export class DriveAdapter {
  constructor() {
    /** @type {string|null} */
    this._folderId = null;
    /**
     * Resolved Drive file IDs for Wren-managed files, keyed by name
     * (e.g. '.wren-index.json'). Lets repeated index regens media-update the
     * same file instead of re-querying by name each time. Invalidated on write
     * failure so a stale/deleted id can't wedge future writes.
     * @type {Record<string, string>}
     */
    this._managedFileIds = {};
    /**
     * Resolved Drive file ID of the `_inbox/` subfolder (AI phase 4), once
     * looked up or created. null = not yet resolved this session.
     * @type {string|null}
     */
    this._inboxFolderId = null;
    /**
     * Resolved Drive file ID of the `_archive/` subfolder (Note Lifecycle B),
     * once looked up or created. null = not yet resolved this session.
     * @type {string|null}
     */
    this._archiveFolderId = null;
  }

  // ---- Lifecycle ---------------------------------------------------------

  /**
   * Sign in (if not already) and resolve / create the "Wren Notes" folder.
   * Caller is responsible for invoking from a user-gesture context the first
   * time so the consent popup is allowed.
   */
  async initialize() {
    // Make sure the GIS TokenClient is ready, but do NOT trigger a popup yet.
    await initTokenClient();

    if (!getAccessToken()) {
      // Silent first - works if the user has previously consented.
      try {
        await requestAccessToken({ silent: true });
      } catch {
        // Silent failed - fall through to interactive request. The browser
        // popup blocker requires a user gesture, so the caller's button
        // handler must be on the stack at this point.
        await requestAccessToken({ silent: false });
      }
    }

    this._folderId = await this._resolveOrCreateFolder();
  }

  async isReady() {
    return this._folderId !== null && getAccessToken() !== null;
  }

  backendId() {
    return ADAPTER_TYPES.DRIVE;
  }

  // ---- Folder bootstrap (Decision P1.4) ---------------------------------

  async _resolveOrCreateFolder() {
    // 1. By appProperties marker - the canonical lookup.
    const markerQuery =
      `appProperties has { key='${FOLDER_MARKER_KEY}' and value='${FOLDER_MARKER_VALUE}' } ` +
      `and mimeType='${FOLDER_MIME}' and trashed=false`;
    const markerHits = await this._listFiles(markerQuery, 'files(id,createdTime)');
    if (markerHits.length > 0) {
      const sorted = [...markerHits].sort((a, b) =>
        (a.createdTime || '') < (b.createdTime || '') ? -1 : 1
      );
      const winner = sorted[0];
      // Best-effort trash of duplicates - failure here is non-fatal.
      for (const dup of sorted.slice(1)) {
        try {
          await this._driveFetch(
            `${DRIVE_API}/files/${encodeURIComponent(dup.id)}?fields=id`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ trashed: true }),
            }
          );
        } catch (e) {
          console.warn('Could not trash duplicate Wren Notes folder', dup.id, e);
        }
      }
      return winner.id;
    }

    // 2. By name only - adopt an existing user-created folder and tag it.
    const nameQuery =
      `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const nameHits = await this._listFiles(nameQuery, 'files(id,createdTime)');
    if (nameHits.length > 0) {
      const sorted = [...nameHits].sort((a, b) =>
        (a.createdTime || '') < (b.createdTime || '') ? -1 : 1
      );
      const winner = sorted[0];
      await this._driveFetch(
        `${DRIVE_API}/files/${encodeURIComponent(winner.id)}?fields=id`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appProperties: { [FOLDER_MARKER_KEY]: FOLDER_MARKER_VALUE },
          }),
        }
      );
      return winner.id;
    }

    // 3. Create from scratch.
    const created = await this._driveFetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: FOLDER_NAME,
        mimeType: FOLDER_MIME,
        appProperties: { [FOLDER_MARKER_KEY]: FOLDER_MARKER_VALUE },
      }),
    });
    const body = await created.json();
    return body.id;
  }

  async _listFiles(qExpr, fields = 'files(id,name,modifiedTime,createdTime,headRevisionId,md5Checksum)') {
    const url =
      `${DRIVE_API}/files?q=${encodeURIComponent(qExpr)}` +
      `&fields=${encodeURIComponent(fields)}&pageSize=1000`;
    const resp = await this._driveFetch(url, { method: 'GET' });
    const body = await resp.json();
    return body.files || [];
  }

  // ---- Inbox (_inbox/) subfolder bootstrap (AI phase 4) ----------------

  /**
   * Resolve the `_inbox/` subfolder's Drive id. With `{ create: false }` (the
   * default) returns null when absent WITHOUT creating it — listing must not
   * litter an empty folder. With `{ create: true }` it creates the subfolder
   * lazily (only on a write/promote that needs it). Caches the id on success.
   *
   * @param {{create?: boolean}} [opts]
   * @returns {Promise<string|null>}
   */
  async _resolveOrCreateInboxFolder({ create = false } = {}) {
    if (this._inboxFolderId) return this._inboxFolderId;
    const escaped = INBOX_DIR.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const hits = await this._listFiles(
      `name='${escaped}' and '${this._folderId}' in parents and ` +
        `mimeType='${FOLDER_MIME}' and trashed=false`,
      'files(id,createdTime)'
    );
    if (hits.length > 0) {
      const sorted = [...hits].sort((a, b) =>
        (a.createdTime || '') < (b.createdTime || '') ? -1 : 1
      );
      this._inboxFolderId = sorted[0].id;
      return this._inboxFolderId;
    }
    if (!create) return null;
    const resp = await this._driveFetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: INBOX_DIR,
        mimeType: FOLDER_MIME,
        parents: [this._folderId],
      }),
    });
    const body = await resp.json();
    this._inboxFolderId = body.id;
    return this._inboxFolderId;
  }

  // ---- Archive (_archive/) subfolder — Note Lifecycle B -----------------

  /**
   * Resolve the `_archive/` subfolder's Drive id. Mirrors
   * _resolveOrCreateInboxFolder: returns null when absent unless `create:true`.
   * @param {{create?: boolean}} [opts]
   * @returns {Promise<string|null>}
   */
  async _resolveOrCreateArchiveFolder({ create = false } = {}) {
    if (this._archiveFolderId) return this._archiveFolderId;
    const escaped = ARCHIVE_DIR.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const hits = await this._listFiles(
      `name='${escaped}' and '${this._folderId}' in parents and ` +
        `mimeType='${FOLDER_MIME}' and trashed=false`,
      'files(id,createdTime)'
    );
    if (hits.length > 0) {
      const sorted = [...hits].sort((a, b) =>
        (a.createdTime || '') < (b.createdTime || '') ? -1 : 1
      );
      this._archiveFolderId = sorted[0].id;
      return this._archiveFolderId;
    }
    if (!create) return null;
    const resp = await this._driveFetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ARCHIVE_DIR,
        mimeType: FOLDER_MIME,
        parents: [this._folderId],
      }),
    });
    const body = await resp.json();
    this._archiveFolderId = body.id;
    return this._archiveFolderId;
  }

  /**
   * Metadata for notes in `_archive/`. Returns [] when the subfolder is absent.
   * Drive ids are location-independent, so each entry's id is the raw file id
   * (round-trips for readNote without a prefix); the `archived: true` flag marks
   * it. Mirrors listInboxNotes.
   */
  async listArchiveNotes() {
    this._assertReady();
    const archiveFolderId = await this._resolveOrCreateArchiveFolder({ create: false });
    if (!archiveFolderId) return [];
    const qExpr = `'${archiveFolderId}' in parents and trashed=false and mimeType='${NOTE_MIME}'`;
    const files = await this._listFiles(qExpr);

    const out = [];
    for (const f of files) {
      if (isReservedNoteName(f.name)) continue;
      let wrenId = '';
      let title = '';
      let color = 'default';
      let summary = '';
      let due = '';
      let createdBy = '';
      let lastEditedBy = '';
      let lastEdited = '';
      let created = f.createdTime || f.modifiedTime || new Date().toISOString();
      try {
        const text = await this._readFileContent(f.id);
        const fm = parseFrontmatterLite(text);
        wrenId = fm.id || '';
        title = fm.title || '';
        color = fm.color || 'default';
        summary = fm.summary || '';
        due = fm.due || '';
        createdBy = fm.createdBy || '';
        lastEditedBy = fm.lastEditedBy || '';
        lastEdited = fm.lastEdited || '';
        if (fm.created) created = fm.created;
      } catch {
        // Unreadable archived file - still surface its metadata.
      }
      out.push({
        id: f.id,
        archived: true,
        wrenId,
        name: f.name || '',
        title,
        created,
        modified: f.modifiedTime || created,
        color,
        summary,
        due,
        createdBy,
        lastEditedBy,
        lastEdited,
        revision: f.headRevisionId || '',
        contentHash: f.md5Checksum || undefined,
      });
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return out;
  }

  /**
   * Archive a note: a Drive parent move into `_archive/` (addParents=archive,
   * removeParents=root). The file id is unchanged (no content copy), so the
   * frontmatter is trivially preserved. Returns the same id + current revision.
   *
   * @param {string} noteId - the Drive file id of a top-level note
   * @returns {Promise<{id: string, revision: string}>}
   */
  async archiveNote(noteId) {
    this._assertReady();
    const archiveFolderId = await this._resolveOrCreateArchiveFolder({ create: true });
    const resp = await this._driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(noteId)}` +
        `?addParents=${encodeURIComponent(archiveFolderId)}` +
        `&removeParents=${encodeURIComponent(this._folderId)}` +
        `&fields=id,headRevisionId`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    const meta = await resp.json();
    return { id: meta.id || noteId, revision: meta.headRevisionId || '' };
  }

  /**
   * Unarchive: the mirror parent move (addParents=root, removeParents=archive).
   * @param {string} noteId - the Drive file id of an archived note
   * @returns {Promise<{id: string, revision: string}>}
   */
  async unarchiveNote(noteId) {
    this._assertReady();
    const archiveFolderId = await this._resolveOrCreateArchiveFolder({ create: false });
    if (!archiveFolderId) throw new Error('_archive/ subfolder not found');
    const resp = await this._driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(noteId)}` +
        `?addParents=${encodeURIComponent(this._folderId)}` +
        `&removeParents=${encodeURIComponent(archiveFolderId)}` +
        `&fields=id,headRevisionId`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    const meta = await resp.json();
    return { id: meta.id || noteId, revision: meta.headRevisionId || '' };
  }

  // ---- StorageAdapter interface ----------------------------------------

  async listNotes() {
    this._assertReady();
    const qExpr = `'${this._folderId}' in parents and trashed=false and mimeType='${NOTE_MIME}'`;
    const files = await this._listFiles(qExpr);

    // Read enough of each file to extract title + color from frontmatter.
    // Drive's metadata fields don't include note content, so per-file reads
    // are unavoidable. listNotes is rare (post-init); the cost is acceptable.
    const out = [];
    for (const f of files) {
      // Skip Wren-managed files (AI phase 2): _index.md / tasks.md. daily/ and
      // _inbox/ live in subfolders (a different parent) so aren't returned here.
      if (isReservedNoteName(f.name)) continue;
      let wrenId = '';
      let title = '';
      let color = 'default';
      let summary = '';
      let createdBy = '';
      let lastEditedBy = '';
      let lastEdited = '';
      let created = f.createdTime || f.modifiedTime || new Date().toISOString();
      try {
        const text = await this._readFileContent(f.id);
        const fm = parseFrontmatterLite(text);
        wrenId = fm.id || '';
        title = fm.title || '';
        color = fm.color || 'default';
        summary = fm.summary || '';
        createdBy = fm.createdBy || '';
        lastEditedBy = fm.lastEditedBy || '';
        lastEdited = fm.lastEdited || '';
        if (fm.created) created = fm.created;
      } catch {
        // Unreadable file - still surface its metadata.
      }
      out.push({
        id: f.id,
        // Logical wren-id from frontmatter (additive — the storage id stays
        // `id`, the Drive fileId). Exposed so the AI/index layer can consume it.
        wrenId,
        name: f.name || '',
        title,
        created,
        modified: f.modifiedTime || created,
        color,
        summary,
        createdBy,
        lastEditedBy,
        lastEdited,
        revision: f.headRevisionId || '',
        contentHash: f.md5Checksum || undefined,
      });
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return out;
  }

  /**
   * Metadata for `.md` files staged in the `_inbox/` subfolder. Returns [] when
   * the subfolder is absent (and never creates it). Drive file ids are
   * location-independent, so the id round-trips for readNote/deleteNote without
   * any prefix — the `inbox: true` flag is what marks the entry as staged.
   */
  async listInboxNotes() {
    this._assertReady();
    const inboxFolderId = await this._resolveOrCreateInboxFolder({ create: false });
    if (!inboxFolderId) return [];
    const qExpr = `'${inboxFolderId}' in parents and trashed=false and mimeType='${NOTE_MIME}'`;
    const files = await this._listFiles(qExpr);

    const out = [];
    for (const f of files) {
      if (isReservedNoteName(f.name)) continue;
      let wrenId = '';
      let title = '';
      let color = 'default';
      let summary = '';
      let createdBy = '';
      let lastEditedBy = '';
      let lastEdited = '';
      let created = f.createdTime || f.modifiedTime || new Date().toISOString();
      try {
        const text = await this._readFileContent(f.id);
        const fm = parseFrontmatterLite(text);
        wrenId = fm.id || '';
        title = fm.title || '';
        color = fm.color || 'default';
        summary = fm.summary || '';
        createdBy = fm.createdBy || '';
        lastEditedBy = fm.lastEditedBy || '';
        lastEdited = fm.lastEdited || '';
        if (fm.created) created = fm.created;
      } catch {
        // Unreadable staged file - still surface its metadata.
      }
      out.push({
        id: f.id,
        inbox: true,
        wrenId,
        name: f.name || '',
        title,
        created,
        modified: f.modifiedTime || created,
        color,
        summary,
        createdBy,
        lastEditedBy,
        lastEdited,
        revision: f.headRevisionId || '',
        contentHash: f.md5Checksum || undefined,
      });
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return out;
  }

  /**
   * Promote a staged note into the main corpus via a Drive parent move:
   * addParents=<rootFolderId>, removeParents=<inboxFolderId>. The file id is
   * unchanged (no content copy), so the frontmatter `wrenId` is trivially
   * preserved. Returns the same id plus the current revision.
   *
   * @param {string} noteId - the Drive file id of a staged note
   * @returns {Promise<{id: string, revision: string}>}
   */
  async promoteInboxNote(noteId) {
    this._assertReady();
    const inboxFolderId = await this._resolveOrCreateInboxFolder({ create: false });
    if (!inboxFolderId) throw new Error('_inbox/ subfolder not found');
    const resp = await this._driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(noteId)}` +
        `?addParents=${encodeURIComponent(this._folderId)}` +
        `&removeParents=${encodeURIComponent(inboxFolderId)}` +
        `&fields=id,headRevisionId`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    const meta = await resp.json();
    return { id: meta.id || noteId, revision: meta.headRevisionId || '' };
  }

  async readNote(noteId) {
    this._assertReady();
    const [content, meta] = await Promise.all([
      this._readFileContent(noteId),
      this._getFileMeta(noteId, 'name,headRevisionId,md5Checksum'),
    ]);
    return {
      content,
      revision: meta.headRevisionId || '',
      contentHash: meta.md5Checksum,
      name: meta.name || '',
    };
  }

  async _readFileContent(noteId) {
    const resp = await this._driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(noteId)}?alt=media`,
      { method: 'GET' }
    );
    return resp.text();
  }

  async _getFileMeta(noteId, fields) {
    const resp = await this._driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(noteId)}?fields=${encodeURIComponent(fields)}`,
      { method: 'GET' }
    );
    return resp.json();
  }

  /**
   * Update an existing note's content.
   *
   * Conflict detection strategy (Decision P2b.3):
   *   1. Try If-Match: <expectedRevision> first. If Drive honors it,
   *      response is 412 on stale; we surface ConflictError. Subsequent
   *      writes skip the explicit pre-fetch.
   *   2. If Drive ignores If-Match (returns 200 on stale), fall back to
   *      read-before-write: fetch headRevisionId, compare, then write.
   *
   * The first call self-tests: tries If-Match. If the server returns 412 OR
   * the write succeeds with If-Match honored, set IF_MATCH_SUPPORTED = true.
   * If the server appears to ignore If-Match (write goes through despite a
   * stale value), we cannot tell without a second probe; we conservatively
   * stick with read-before-write for subsequent calls.
   */
  async writeNote(noteId, content, expectedRevision) {
    this._assertReady();

    // Pre-write read-before-write when If-Match is not known to be honored,
    // OR when caller provided no expected revision (we still want to short
    // circuit if the file moved underneath us, but with no expectation we
    // simply do an unconditional PATCH).
    if (expectedRevision !== undefined && IF_MATCH_SUPPORTED !== true) {
      const meta = await this._getFileMeta(noteId, 'headRevisionId');
      if (meta.headRevisionId && meta.headRevisionId !== expectedRevision) {
        throw new ConflictError('Revision mismatch (read-before-write)', {
          localRevision: expectedRevision,
          remoteRevision: meta.headRevisionId,
        });
      }
    }

    const boundary = '----wren-' + Math.random().toString(36).slice(2, 12);
    const body = buildMultipart(boundary, { mimeType: NOTE_MIME }, content);
    const headers = {
      'Content-Type': `multipart/related; boundary=${boundary}`,
    };
    if (expectedRevision !== undefined && IF_MATCH_SUPPORTED !== false) {
      // Probe / use If-Match. expectedRevision is the etag-like value.
      headers['If-Match'] = expectedRevision;
    }

    let resp;
    try {
      resp = await this._driveFetch(
        `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(noteId)}?uploadType=multipart&fields=headRevisionId,md5Checksum`,
        { method: 'PATCH', headers, body }
      );
    } catch (e) {
      if (e && e.status === 412) {
        // If-Match honored AND stale - mark feature supported.
        IF_MATCH_SUPPORTED = true;
        // Need the current remote revision so the conflict error is informative.
        let remoteRev = 'unknown';
        try {
          const meta = await this._getFileMeta(noteId, 'headRevisionId');
          remoteRev = meta.headRevisionId || 'unknown';
        } catch {
          /* ignore */
        }
        throw new ConflictError('Revision mismatch (If-Match 412)', {
          localRevision: expectedRevision,
          remoteRevision: remoteRev,
        });
      }
      throw e;
    }

    // First successful write with If-Match attached - we can't be certain
    // Drive enforced it (could have been a coincidental same-revision write),
    // so leave IF_MATCH_SUPPORTED as-is unless we've already proven 412 works.
    const meta = await resp.json();
    return { revision: meta.headRevisionId || '' };
  }

  /**
   * Create a new note in the Wren Notes folder. Signature matches
   * FileSystemAdapter.createNote — adapter is responsible for picking the
   * Drive-side filename (Drive will return an opaque file ID that the UI
   * uses as the noteId regardless).
   *
   * @param {string} content - full file body (frontmatter + markdown)
   * @param {{title?: string, created?: string}} [hint] - used to derive the
   *   "YYYY-MM-DD - <title>.md" Drive filename. Drive still returns its own
   *   opaque file ID, which becomes the noteId regardless of the name.
   * @returns {Promise<{id: string, revision: string, name: string}>}
   */
  async createNote(content, { title = '', created = '' } = {}) {
    this._assertReady();
    const filename = buildNoteFilename(created, title);
    const boundary = '----wren-' + Math.random().toString(36).slice(2, 12);
    const body = buildMultipart(
      boundary,
      { name: filename, mimeType: NOTE_MIME, parents: [this._folderId] },
      content
    );
    const resp = await this._driveFetch(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,headRevisionId`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      }
    );
    const meta = await resp.json();
    return { id: meta.id, revision: meta.headRevisionId || '', name: filename };
  }

  /**
   * Rename a note's Drive file (the `name` metadata only — the opaque file ID,
   * and therefore the noteId, is unchanged). Resolves collisions within the
   * Wren Notes folder with a " (2)", " (3)", … suffix so two same-day,
   * same-title notes don't end up with identical names.
   *
   * drive.file scope covers files this app created, so the PATCH is permitted.
   *
   * @param {string} noteId
   * @param {string} desiredName - e.g. "2026-05-28 - My Note.md"
   * @returns {Promise<{id: string, revision: string, name: string}>}
   */
  async renameNote(noteId, desiredName) {
    this._assertReady();
    const finalName = await uniqueNoteName(desiredName, (name) =>
      this._nameExistsInFolder(name, noteId)
    );
    const resp = await this._driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(noteId)}?fields=id,name,headRevisionId`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: finalName }),
      }
    );
    const meta = await resp.json();
    return {
      id: noteId,
      revision: meta.headRevisionId || '',
      name: meta.name || finalName,
    };
  }

  /**
   * Whether a non-trashed note with this exact name already exists in the
   * folder, excluding the file identified by `excludeId` (so a note doesn't
   * collide with itself during a rename).
   */
  async _nameExistsInFolder(name, excludeId) {
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const qExpr =
      `'${this._folderId}' in parents and trashed=false and ` +
      `mimeType='${NOTE_MIME}' and name='${escaped}'`;
    const files = await this._listFiles(qExpr, 'files(id,name)');
    return files.some((f) => f.id !== excludeId);
  }

  /** Soft delete (PATCH trashed=true). Recoverable from Drive trash for ~30d. */
  async deleteNote(noteId) {
    this._assertReady();
    await this._driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(noteId)}?fields=id`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      }
    );
  }

  /**
   * Discard a staged inbox note: soft-delete it. On Drive that is exactly
   * deleteNote (PATCH trashed=true) — the file lands in Drive's native trash,
   * recoverable for ~30d. Exposed under the same name as the FS adapter's
   * `.trash/` move so app-controller can call one method regardless of backend.
   *
   * @param {string} noteId - the Drive file id of a staged note
   */
  async discardInboxNote(noteId) {
    await this.deleteNote(noteId);
  }

  /**
   * Write/overwrite a Wren-managed file by exact name in the Wren Notes folder
   * (e.g. '.wren-index.json', '_index.md'). Media-updates the existing file when
   * one is found, else creates it. Separate from writeNote so managed artifacts
   * never flow through note routing and never bump a note's revision.
   *
   * The resolved file ID is cached on the instance so repeated index regens skip
   * the name lookup. On any failure the cache entry is invalidated and the error
   * re-thrown so the caller (app-controller's regenerateIndex) can swallow it.
   *
   * NOTE_MIME is text/markdown for both files. The JSON file uses it too: Drive
   * doesn't strongly care, and keeping one mime avoids a second multipart path.
   *
   * @param {string} name
   * @param {string} content
   * @returns {Promise<void>}
   */
  async writeManagedFile(name, content) {
    this._assertReady();
    try {
      let fileId = this._managedFileIds[name];

      // Resolve by name if we don't have a cached id.
      if (!fileId) {
        const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const hits = await this._listFiles(
          `name='${escaped}' and '${this._folderId}' in parents and trashed=false`,
          'files(id)'
        );
        if (hits.length > 0) fileId = hits[0].id;
      }

      const boundary = '----wren-' + Math.random().toString(36).slice(2, 12);

      if (fileId) {
        // Media-update the existing file.
        const body = buildMultipart(boundary, { mimeType: NOTE_MIME }, content);
        await this._driveFetch(
          `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body,
          }
        );
        this._managedFileIds[name] = fileId;
        return;
      }

      // Create it.
      const body = buildMultipart(
        boundary,
        { name, mimeType: NOTE_MIME, parents: [this._folderId] },
        content
      );
      const resp = await this._driveFetch(
        `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        }
      );
      const meta = await resp.json();
      this._managedFileIds[name] = meta.id;
    } catch (e) {
      // Drop the (possibly stale) cached id so the next attempt re-resolves.
      delete this._managedFileIds[name];
      throw e;
    }
  }

  /**
   * Read a Wren-managed file by exact name from the Wren Notes folder. Returns
   * its text, or null if it does not exist. Symmetric with writeManagedFile;
   * used by the Phase 3 contract-doc missing/stale check. Resolves the file id
   * (reusing/refreshing the writeManagedFile cache) then media-GETs the body.
   *
   * @param {string} name
   * @returns {Promise<string|null>}
   */
  async readManagedFile(name) {
    this._assertReady();
    let fileId = this._managedFileIds[name];
    if (!fileId) {
      const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const hits = await this._listFiles(
        `name='${escaped}' and '${this._folderId}' in parents and trashed=false`,
        'files(id)'
      );
      if (hits.length === 0) return null;
      fileId = hits[0].id;
      this._managedFileIds[name] = fileId;
    }
    try {
      return await this._readFileContent(fileId);
    } catch (e) {
      // A cached id that 404s means the file was deleted/replaced — drop it so
      // the caller's next attempt re-resolves by name.
      if (e && e.status === 404) {
        delete this._managedFileIds[name];
        return null;
      }
      throw e;
    }
  }

  // ---- Shared fetch helper (auth + retries + error normalization) ------

  /**
   * Authenticated fetch with auto-retry on 401/429/5xx per Decision P1.8.
   *
   * On non-OK responses, throws an Error with status, body, and (for 403)
   * the parsed reason so callers can branch on quota vs. permission.
   */
  async _driveFetch(url, opts = {}, attempt = 0) {
    let token = getAccessToken();
    if (!token) {
      // Silent refresh - if this fails, surface to the caller as auth error.
      try {
        const result = await requestAccessToken({ silent: true });
        token = result.token;
      } catch (e) {
        throw new AdapterAuthError('Drive token missing and silent refresh failed', {
          backendId: this.backendId(),
          recoverable: true,
        });
      }
    }

    const headers = new Headers(opts.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    const resp = await fetch(url, { ...opts, headers });

    if (resp.ok) return resp;

    // 401 - one silent re-acquire, then retry.
    if (resp.status === 401 && attempt === 0) {
      try {
        await requestAccessToken({ silent: true });
      } catch {
        throw new AdapterAuthError('Drive 401 and silent re-acquire failed', {
          backendId: this.backendId(),
          recoverable: true,
        });
      }
      return this._driveFetch(url, opts, attempt + 1);
    }

    // Read body once for error inspection (we cannot peek-then-replay).
    const bodyText = await resp.text();

    if (shouldRetry(resp, bodyText) && attempt < MAX_ATTEMPTS - 1) {
      const delay = backoffDelay(resp, attempt);
      await sleep(delay);
      return this._driveFetch(url, opts, attempt + 1);
    }

    const err = new Error(
      `Drive ${resp.status} ${resp.statusText}: ${bodyText.slice(0, 300)}`
    );
    err.status = resp.status;
    err.body = bodyText;
    throw err;
  }

  // ---- Internal --------------------------------------------------------

  _assertReady() {
    if (this._folderId === null) {
      throw new AdapterAuthError('DriveAdapter not initialized (no folder ID).', {
        backendId: this.backendId(),
        recoverable: true,
      });
    }
    if (getAccessToken() === null) {
      throw new AdapterAuthError('DriveAdapter has no valid access token.', {
        backendId: this.backendId(),
        recoverable: true,
      });
    }
  }
}

// ---- Module-level helpers ---------------------------------------------

function shouldRetry(resp, bodyText) {
  if (resp.status === 429) return true;
  if (resp.status >= 500 && resp.status < 600) return true;
  if (resp.status === 403) {
    // Retry only on quota-related 403 reasons.
    try {
      const parsed = JSON.parse(bodyText);
      const reason = parsed?.error?.errors?.[0]?.reason || '';
      return (
        reason === 'userRateLimitExceeded' ||
        reason === 'rateLimitExceeded' ||
        reason === 'dailyLimitExceeded'
      );
    } catch {
      return false;
    }
  }
  return false;
}

function backoffDelay(resp, attempt) {
  const retryAfter = resp.headers.get('Retry-After');
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(n * 1000, MAX_BACKOFF_MS);
    }
  }
  const base = Math.pow(2, attempt) * 1000;
  const jitter = Math.random() * 1000;
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a Drive v3 multipart upload body (Content-Type metadata + content).
 *
 * The format is "multipart/related" with two parts, separated by --boundary.
 * Drive expects exactly this layout for uploadType=multipart.
 */
function buildMultipart(boundary, metadata, content) {
  const parts = [];
  parts.push(`--${boundary}`);
  parts.push('Content-Type: application/json; charset=UTF-8');
  parts.push('');
  parts.push(JSON.stringify(metadata));
  parts.push('');
  parts.push(`--${boundary}`);
  parts.push(`Content-Type: ${metadata.mimeType || NOTE_MIME}`);
  parts.push('');
  parts.push(content);
  parts.push('');
  parts.push(`--${boundary}--`);
  return parts.join('\r\n');
}

/**
 * Tiny frontmatter parser. Matches notes-store.js's parseNote frontmatter
 * shape but extracts only the subset listNotes / the AI-index layer need
 * (id, title, color, created, summary). Stays a lite/subset parser — do NOT
 * import the full parseNote here: keeping this local avoids a circular dep if
 * the FS adapter ever needs to call into the Drive adapter or vice versa.
 * `out.id` is the logical wren-id from the frontmatter `id` key (distinct from
 * the Drive fileId, which listNotes carries as the storage `id`).
 */
function parseFrontmatterLite(text) {
  const out = {
    id: '',
    title: '',
    color: 'default',
    created: '',
    summary: '',
    due: '',
    createdBy: '',
    lastEditedBy: '',
    lastEdited: '',
  };
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text || '');
  if (!fm) return out;
  for (const line of fm[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"')) {
      try {
        val = JSON.parse(val);
      } catch {
        /* ignore */
      }
    }
    if (key === 'id') out.id = val;
    else if (key === 'title') out.title = val;
    else if (key === 'color') out.color = val;
    else if (key === 'created') out.created = val;
    else if (key === 'summary') out.summary = val;
    else if (key === 'due') out.due = val;
    // Provenance (MCP v2.1). Only 'ai' | 'human' are meaningful for the *_by
    // fields; anything else is treated as unknown (no badge).
    else if (key === 'created_by') out.createdBy = val === 'ai' || val === 'human' ? val : '';
    else if (key === 'last_edited_by') out.lastEditedBy = val === 'ai' || val === 'human' ? val : '';
    else if (key === 'last_edited') out.lastEdited = val;
  }
  return out;
}

// Test-only accessor for the If-Match probe state. Phase 1 STORAGE.md uses
// this to document the outcome of empirical Q1.
export function _ifMatchSupportedState() {
  return IF_MATCH_SUPPORTED;
}
