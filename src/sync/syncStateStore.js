// syncStateStore.js
//
// Per-note sync metadata, persisted in IndexedDB. Keyed by noteId (filename
// for FS, file ID for Drive). Lives in the same 'scrybe' database as the
// existing FileSystemDirectoryHandle store; the v1 -> v2 migration that adds
// this object store is defined in src/notes-store.js (see applyScrybeMigrations).
//
// Decision provenance: KB Module 05, P2b.5 (separate IndexedDB store).

import { openScrybeDb, SYNC_STATE_STORE } from '../notes-store.js';

/**
 * @typedef {'synced'|'dirty'|'stale'|'conflict'|'local-only'|'cloud-only'} SyncStateLabel
 */

/**
 * @typedef {Object} SyncStateEntry
 * @property {string} noteId
 * @property {string} localRevision  - last revision Wren wrote locally
 * @property {string} remoteRevision - last revision Wren saw from the backend
 * @property {string} lastSyncAt     - ISO 8601 of last successful sync
 * @property {boolean} dirty         - local content changed since last sync
 * @property {SyncStateLabel} state
 */

const STATES = Object.freeze({
  SYNCED: 'synced',
  DIRTY: 'dirty',
  STALE: 'stale',
  CONFLICT: 'conflict',
  LOCAL_ONLY: 'local-only',
  CLOUD_ONLY: 'cloud-only',
});

export { STATES as SYNC_STATES };

// ---- DB helpers --------------------------------------------------------

async function withStore(mode, fn) {
  const db = await openScrybeDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SYNC_STATE_STORE, mode);
      const store = tx.objectStore(SYNC_STATE_STORE);
      let result;
      Promise.resolve(fn(store))
        .then((r) => {
          result = r;
        })
        .catch((e) => reject(e));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Public API --------------------------------------------------------

/**
 * Fetch the sync-state entry for a note, or null if none recorded.
 *
 * @param {string} noteId
 * @returns {Promise<SyncStateEntry|null>}
 */
export async function getSyncState(noteId) {
  return withStore('readonly', async (store) => {
    const value = await reqToPromise(store.get(noteId));
    return value || null;
  });
}

/**
 * Merge partial into the existing entry (or create one). Always re-writes the
 * full entry; do not call this on a hot loop.
 *
 * @param {string} noteId
 * @param {Partial<SyncStateEntry>} partial
 * @returns {Promise<SyncStateEntry>} resolved entry as persisted
 */
export async function setSyncState(noteId, partial) {
  return withStore('readwrite', async (store) => {
    const existing = (await reqToPromise(store.get(noteId))) || {
      noteId,
      localRevision: '',
      remoteRevision: '',
      lastSyncAt: '',
      dirty: false,
      state: STATES.LOCAL_ONLY,
    };
    const merged = { ...existing, ...partial, noteId };
    await reqToPromise(store.put(merged));
    return merged;
  });
}

/**
 * Delete the sync-state entry for a note (e.g. after the note is deleted on
 * both sides).
 *
 * @param {string} noteId
 */
export async function clearSyncState(noteId) {
  return withStore('readwrite', async (store) => {
    await reqToPromise(store.delete(noteId));
  });
}
