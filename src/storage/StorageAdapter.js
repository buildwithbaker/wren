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
 * @property {string} [name]        - backend file name (FS: same as id; Drive: the file's `name`)
 * @property {string} title         - extracted from YAML frontmatter
 * @property {string} created       - ISO 8601
 * @property {string} modified      - ISO 8601
 * @property {string} color         - one of CARD_COLORS ids
 * @property {string} revision      - backend-specific revision identifier (FS: mtime ms as string; Drive: headRevisionId)
 * @property {string} [contentHash] - md5 / sha for secondary conflict detection (Drive only at present)
 * @property {boolean} [inbox]      - true for notes staged in the `_inbox/` subfolder (AI phase 4). On FS the `id` is `_inbox/<filename>` so read/delete round-trip; on Drive the opaque id already round-trips regardless of parent.
 */

/**
 * Result of reading a note: raw .md text plus the revision at read time.
 *
 * @typedef {Object} NoteContent
 * @property {string} content       - full .md text (frontmatter + body)
 * @property {string} revision      - revision id at the moment of read
 * @property {string} [contentHash]
 * @property {string} [name]        - backend file name at read time (Drive sets this; FS omits it)
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
 * @property {(noteId: string, desiredName: string) => Promise<{id: string, revision: string, name: string}>} [renameNote]
 *   Rename the backend file to `desiredName`, resolving collisions with a
 *   " (N)" suffix. Drive-only: the noteId (opaque file ID) is unchanged. FS
 *   omits this — its identity *is* the filename, so renaming is a separate
 *   concern handled elsewhere.
 * @property {(name: string, content: string) => Promise<void>} writeManagedFile
 *   Write/overwrite a Wren-managed file by EXACT name in the notes-folder root
 *   (e.g. '.wren-index.json', '_index.md'). Separate from writeNote so managed
 *   artifacts never flow through note routing: it must NOT bump any note's
 *   revision and the file must NOT appear in listNotes (callers also guard via
 *   isReservedNoteName). Used by the AI-readable index layer (Phase 2).
 * @property {(name: string) => Promise<string|null>} readManagedFile
 *   Read a Wren-managed file by EXACT name from the notes-folder root, returning
 *   its text, or null if it does not exist. Symmetric with writeManagedFile.
 *   Used by the Phase 3 contract-doc writer to do a once-per-session missing/
 *   stale-version check before rewriting.
 * @property {() => Promise<NoteMetadata[]>} listInboxNotes
 *   Metadata for the `.md` files staged in the `_inbox/` subfolder (AI phase 4),
 *   each with `inbox: true` and an `id` that round-trips back to the staged file
 *   via readNote/deleteNote. Returns [] when `_inbox/` is absent — and must NOT
 *   create the subfolder just from listing (avoids littering empty folders).
 * @property {(noteId: string) => Promise<{id: string, revision: string}>} promoteInboxNote
 *   Move a staged note out of `_inbox/` into the notes root (main corpus),
 *   preserving file content (and therefore the frontmatter `wrenId`). Returns
 *   the new top-level id. FS: write-new-at-root + delete-inbox-original. Drive:
 *   parent PATCH (addParents root / removeParents inbox), same file id.
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

/**
 * Thrown by getActiveAdapter() when no storage backend has been selected yet
 * (first-launch user). Caller is expected to route to the storage-choice
 * onboarding screen rather than treating this as a fatal error.
 */
export class NoBackendConfiguredError extends Error {
  constructor(message = 'No storage backend has been chosen yet.') {
    super(message);
    this.name = 'NoBackendConfiguredError';
  }
}
