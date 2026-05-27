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
      let title = '';
      let color = 'default';
      let created = f.createdTime || f.modifiedTime || new Date().toISOString();
      try {
        const text = await this._readFileContent(f.id);
        const fm = parseFrontmatterLite(text);
        title = fm.title || '';
        color = fm.color || 'default';
        if (fm.created) created = fm.created;
      } catch {
        // Unreadable file - still surface its metadata.
      }
      out.push({
        id: f.id,
        title,
        created,
        modified: f.modifiedTime || created,
        color,
        revision: f.headRevisionId || '',
        contentHash: f.md5Checksum || undefined,
      });
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return out;
  }

  async readNote(noteId) {
    this._assertReady();
    const [content, meta] = await Promise.all([
      this._readFileContent(noteId),
      this._getFileMeta(noteId, 'headRevisionId,md5Checksum'),
    ]);
    return {
      content,
      revision: meta.headRevisionId || '',
      contentHash: meta.md5Checksum,
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
   * Create a new note in the Wren Notes folder. Not part of the formal
   * StorageAdapter interface but Phase 2b's sync runner needs it; left here
   * so the adapter is a complete I/O surface.
   *
   * @param {string} filename - desired Drive file name (.md)
   * @param {string} content - full file body (frontmatter + markdown)
   * @returns {Promise<{id: string, revision: string}>}
   */
  async createNote(filename, content) {
    this._assertReady();
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
    return { id: meta.id, revision: meta.headRevisionId || '' };
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
 * shape but extracts only the fields listNotes needs (title, color, created).
 * Keeping this here rather than importing parseNote avoids a circular dep
 * if the FS adapter ever needs to call into the Drive adapter or vice versa.
 */
function parseFrontmatterLite(text) {
  const out = { title: '', color: 'default', created: '' };
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
    if (key === 'title') out.title = val;
    else if (key === 'color') out.color = val;
    else if (key === 'created') out.created = val;
  }
  return out;
}

// Test-only accessor for the If-Match probe state. Phase 1 STORAGE.md uses
// this to document the outcome of empirical Q1.
export function _ifMatchSupportedState() {
  return IF_MATCH_SUPPORTED;
}
