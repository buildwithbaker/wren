// StorageAdapter.js
//
// Interface contract for Wren's storage backends. JavaScript has no formal
// interface keyword, so this file documents the shape that FileSystemAdapter
// and DriveAdapter must both implement, plus the shared error type for
// optimistic-concurrency conflicts.
//
// Decision provenance: KB Module 05, P1.3 (storage abstraction layer).

/**
 * Lightweight metadata sufficient for the notes-list UI.
 *
 * @typedef {Object} NoteMetadata
 * @property {string} id            - stable note identifier (FS: filename; Drive: file ID)
 * @property {string} title         - extracted from YAML frontmatter
 * @property {string} created       - ISO 8601
 * @property {string} modified      - ISO 8601
 * @property {string} color         - one of CARD_COLORS ids
 * @property {string} revision      - backend-specific revision identifier (FS: mtime ms as string; Drive: headRevisionId)
 * @property {string} [contentHash] - md5 / sha for secondary conflict detection (Drive only at present)
 */

/**
 * Result of reading a note: raw .md text plus the revision at read time.
 *
 * @typedef {Object} NoteContent
 * @property {string} content       - full .md text (frontmatter + body)
 * @property {string} revision      - revision id at the moment of read
 * @property {string} [contentHash]
 */

/**
 * Storage adapter interface.
 *
 * Both FileSystemAdapter and DriveAdapter (and any future test/memory adapter)
 * implement this shape.
 *
 * @typedef {Object} StorageAdapter
 * @property {() => Promise<void>} initialize
 *   One-time setup (load stored handle, ensure folder, etc.). Idempotent.
 * @property {() => Promise<boolean>} isReady
 *   Whether the adapter is currently usable for I/O calls.
 * @property {() => Promise<NoteMetadata[]>} listNotes
 *   Metadata for every note in the user's notes folder.
 * @property {(noteId: string) => Promise<NoteContent>} readNote
 * @property {(noteId: string, content: string, expectedRevision?: string) => Promise<{revision: string}>} writeNote
 *   If expectedRevision is provided and does not match the backend's current
 *   revision, the adapter must throw ConflictError without writing.
 * @property {(noteId: string) => Promise<void>} deleteNote
 * @property {() => string} backendId
 *   Stable identifier for the backend. Used in sync metadata + telemetry.
 */

/**
 * Stable identifiers for the two Phase 1 adapters.
 *
 * Frozen so callers cannot mutate; exported so consumers can compare against
 * adapter.backendId() without re-declaring the strings.
 */
export const ADAPTER_TYPES = Object.freeze({
  FS: 'fs',
  DRIVE: 'drive',
});

/**
 * Thrown by writeNote when the caller's expectedRevision does not match the
 * backend's current revision (the file was written by another device / tab /
 * editor between the last read and this write).
 *
 * The caller (sync runner, eventually) catches this and creates a
 * sync-conflict copy per src/sync/conflictDetection.js.
 */
export class ConflictError extends Error {
  /**
   * @param {string} message
   * @param {{localRevision: string, remoteRevision: string}} revisions
   */
  constructor(message, { localRevision, remoteRevision }) {
    super(message);
    this.name = 'ConflictError';
    this.localRevision = localRevision;
    this.remoteRevision = remoteRevision;
  }
}

/**
 * Thrown when the adapter cannot perform an operation because of an
 * unrecoverable auth / permission state (token revoked, folder picker not
 * granted, etc.). Distinct from generic Error so the UI can route it to a
 * "Reconnect Drive" / "Re-grant folder permission" affordance.
 */
export class AdapterAuthError extends Error {
  constructor(message, { backendId, recoverable = true } = {}) {
    super(message);
    this.name = 'AdapterAuthError';
    this.backendId = backendId || null;
    this.recoverable = recoverable;
  }
}
