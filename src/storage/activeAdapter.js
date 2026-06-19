// activeAdapter.js
//
// Returns the currently-configured storage adapter (FileSystem or Drive)
// based on the persisted backend preference. The caller (app-controller)
// invokes this once per boot after deciding the backend and once again on
// any backend switch.
//
// Default is LOCAL. An install with no explicit stored backend resolves to
// "fs" — Drive is never a default a new user lands on (it's opt-in and
// labeled experimental in the UI). Two unset sub-cases:
//   1. A directory handle already exists in IndexedDB → treat the user as an
//      existing FS user and persist "fs" so the next boot is a clean fast path
//      (the fs-migration heuristic; the 2026-06-03 switch-snap-back fix relies
//      on this staying intact).
//   2. No handle either (brand-new install) → still default to "fs", but do
//      NOT persist it, so the user's first real action (pick a folder, or
//      deliberately opt into experimental Drive) is what gets written.
// HARD RULE: an explicit stored "drive" is always honored verbatim — existing
// Drive users are never downgraded to local.

import { ADAPTER_TYPES, NoBackendConfiguredError } from './StorageAdapter.js';
import { FileSystemAdapter } from './FileSystemAdapter.js';
import { TauriFsAdapter } from './TauriFsAdapter.js';
import { DriveAdapter } from './DriveAdapter.js';
import { getStoredBackend, setStoredBackend } from './backendPreference.js';
import { getStoredDirHandle } from '../notes-store.js';
import { isTauri } from '../platform.js';

/**
 * Read the stored backend preference, applying the local default and the
 * fs-migration heuristic. Does NOT prompt the user or instantiate anything.
 *
 * @returns {Promise<'fs'|'drive'>}
 *   - an explicit stored "drive"/"fs" is returned verbatim (Drive never downgraded)
 *   - unset → "fs" (local default). If a directory handle already exists the
 *     "fs" choice is persisted (migration); for a brand-new install it is not.
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
    /* ignore — if IndexedDB is busted, fall through to the local default */
  }

  // Brand-new install: default to local without persisting. The storage-choice
  // onboarding presents local as the primary path; opting into Drive is a
  // deliberate, separately-persisted action.
  return ADAPTER_TYPES.FS;
}

/**
 * Pick the right fs-family adapter INSTANCE (uninitialized) per the desktop
 * selection rule. Does not initialize it — the caller awaits initialize().
 *
 *   - Tauri AND we can CONFIRM no existing File System Access handle
 *     (getStoredDirHandle() === null) → {@link TauriFsAdapter}. Fresh desktop
 *     installs land in <Documents>/Wren Notes with zero prompts.
 *   - An FS-Access directory handle already exists → {@link FileSystemAdapter}.
 *     ⚠ NEVER relocate an existing desktop user's notes: if they already picked
 *     a folder (handle in IndexedDB), keep using it via the browser API.
 *   - Not Tauri (PWA / extension) → {@link FileSystemAdapter} (one-time picker).
 *
 * If the handle store can't be read, we deliberately do NOT assume "fresh" —
 * routing an existing desktop user to a brand-new Documents/Wren Notes folder
 * would split their notes across two locations. We fall back to
 * FileSystemAdapter (which re-checks / recovers the handle) so the
 * never-relocate rule holds even when IndexedDB is transiently unavailable.
 *
 * @returns {Promise<FileSystemAdapter|TauriFsAdapter>}
 */
export async function chooseFsAdapter() {
  if (isTauri()) {
    let handle = null;
    try {
      handle = await getStoredDirHandle();
    } catch {
      // Handle store unreadable — cannot prove this is a fresh install, so do
      // not adopt the native folder (would relocate an existing user). Use the
      // browser FS-Access adapter, which handles its own not-ready recovery.
      return new FileSystemAdapter();
    }
    if (handle === null) return new TauriFsAdapter();
  }
  return new FileSystemAdapter();
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
  // Default: fs. The concrete fs-family adapter (native Tauri folder vs. browser
  // File System Access) is chosen by chooseFsAdapter().
  const a = await chooseFsAdapter();
  await a.initialize();
  return a;
}
