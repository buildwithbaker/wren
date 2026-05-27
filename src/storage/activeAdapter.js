// activeAdapter.js
//
// Returns the currently-configured storage adapter (FileSystem or Drive)
// based on the persisted backend preference. The caller (app-controller)
// invokes this once per boot after deciding the backend and once again on
// any backend switch.
//
// Migration: if no backend has been explicitly set BUT a directory handle
// already exists in IndexedDB, treat the user as an existing FS user and
// auto-set the preference to "fs" so the next boot is a clean fast path.

import { ADAPTER_TYPES, NoBackendConfiguredError } from './StorageAdapter.js';
import { FileSystemAdapter } from './FileSystemAdapter.js';
import { DriveAdapter } from './DriveAdapter.js';
import { getStoredBackend, setStoredBackend } from './backendPreference.js';
import { getStoredDirHandle } from '../notes-store.js';

/**
 * Read the stored backend preference, applying the migration heuristic for
 * existing FS-only users. Does NOT prompt the user or instantiate anything.
 *
 * @returns {Promise<'fs'|'drive'|null>}
 *   null means "no backend chosen yet — route to storage-choice onboarding."
 */
export async function resolveBackend() {
  const stored = await getStoredBackend();
  if (stored) return stored;

  // Migration: existing user with a saved directory handle but no explicit
  // backend choice. Silently set to "fs" and proceed.
  try {
    const handle = await getStoredDirHandle();
    if (handle) {
      await setStoredBackend(ADAPTER_TYPES.FS);
      return ADAPTER_TYPES.FS;
    }
  } catch {
    /* ignore — if IndexedDB is busted, treat as no choice */
  }
  return null;
}

/**
 * Return an initialized adapter matching the stored backend.
 *
 * Throws {@link NoBackendConfiguredError} if no backend is set. The caller
 * (app-controller boot) catches this and shows the storage-choice screen.
 *
 * For "drive" backend, this triggers DriveAdapter.initialize() which in turn
 * may invoke a silent token re-acquire. If silent fails, the adapter will
 * throw an AdapterAuthError that the caller routes to the Drive sign-in
 * screen.
 *
 * @returns {Promise<import('./StorageAdapter.js').StorageAdapter>}
 */
export async function getActiveAdapter() {
  const backend = await resolveBackend();
  if (backend === null) {
    throw new NoBackendConfiguredError();
  }
  if (backend === ADAPTER_TYPES.DRIVE) {
    const a = new DriveAdapter();
    await a.initialize();
    return a;
  }
  // Default: fs
  const a = new FileSystemAdapter();
  await a.initialize();
  return a;
}
