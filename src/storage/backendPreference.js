// backendPreference.js
//
// Persists the user's chosen storage backend ("fs" | "drive") in the existing
// `scrybe` IndexedDB database under the same `handles` object store as the
// directory handle. Phase 2b.1 reads this on boot to route between
// FileSystemAdapter and DriveAdapter without prompting on every launch.
//
// Decision provenance: KB Module 05, P2b.* (adapter selection at startup).

import { ADAPTER_TYPES } from './StorageAdapter.js';
import { openScrybeDb } from '../notes-store.js';

// Keyed under the existing 'handles' store. The store already holds the
// directory handle under 'notesDir'; this is just a sibling key.
const STORE = 'handles';
const KEY = 'storageBackend';

const VALID = new Set([ADAPTER_TYPES.FS, ADAPTER_TYPES.DRIVE]);

/**
 * Read the currently stored backend preference.
 *
 * @returns {Promise<'fs'|'drive'|null>}
 *   - "fs" or "drive" if the user has explicitly picked
 *   - null if never set (caller should route to storage-choice onboarding,
 *     OR — for migration — infer "fs" if a directory handle already exists)
 */
export async function getStoredBackend() {
  let db;
  try {
    db = await openScrybeDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (value === undefined || value === null) return null;
    return VALID.has(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

/**
 * Persist the user's backend choice.
 *
 * @param {'fs'|'drive'} backend
 */
export async function setStoredBackend(backend) {
  if (!VALID.has(backend)) {
    throw new Error(`Invalid backend: ${backend}`);
  }
  const db = await openScrybeDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(backend, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Remove the stored backend (used by "Disconnect Drive" / "Switch backend").
 * After this, the next boot will route to the storage-choice screen unless
 * a directory handle still implies "fs" by migration heuristic.
 */
export async function clearStoredBackend() {
  const db = await openScrybeDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
