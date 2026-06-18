// Tests for resolveBackend() — the local-default + Drive-experimental policy
// (2026-06-17). Two branches matter most and are asserted explicitly:
//   - a fresh / unconfigured install resolves to local ("fs");
//   - an existing install with a stored "drive" preference is NEVER downgraded.
// The fs-migration heuristic (unset + a leftover directory handle adopts "fs")
// is also covered, since the 2026-06-03 switch-snap-back fix depends on it.
//
// resolveBackend pulls its two collaborators from backendPreference.js and
// notes-store.js; both are mocked. The adapter modules are stubbed so importing
// activeAdapter.js doesn't drag in the FS/Drive/OAuth load chain (resolveBackend
// never instantiates an adapter).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getStoredBackend = vi.fn();
const setStoredBackend = vi.fn();
const getStoredDirHandle = vi.fn();

vi.mock('../src/storage/backendPreference.js', () => ({
  getStoredBackend: (...a) => getStoredBackend(...a),
  setStoredBackend: (...a) => setStoredBackend(...a),
  clearStoredBackend: vi.fn(),
}));

vi.mock('../src/notes-store.js', () => ({
  getStoredDirHandle: (...a) => getStoredDirHandle(...a),
}));

// Stub the adapters so the import chain stays light.
vi.mock('../src/storage/FileSystemAdapter.js', () => ({ FileSystemAdapter: class {} }));
vi.mock('../src/storage/DriveAdapter.js', () => ({ DriveAdapter: class {} }));

const { resolveBackend } = await import('../src/storage/activeAdapter.js');
const { ADAPTER_TYPES } = await import('../src/storage/StorageAdapter.js');

describe('resolveBackend — local default + no-downgrade policy', () => {
  beforeEach(() => {
    getStoredBackend.mockReset();
    setStoredBackend.mockReset();
    getStoredDirHandle.mockReset();
  });

  it('fresh/unconfigured install (no backend, no handle) resolves to local "fs"', async () => {
    getStoredBackend.mockResolvedValue(null);
    getStoredDirHandle.mockResolvedValue(null);

    const backend = await resolveBackend();

    expect(backend).toBe(ADAPTER_TYPES.FS);
    // Brand-new: the default is NOT persisted — the user's first real choice is.
    expect(setStoredBackend).not.toHaveBeenCalled();
  });

  it('existing Drive user (stored "drive") stays on Drive — never downgraded', async () => {
    getStoredBackend.mockResolvedValue(ADAPTER_TYPES.DRIVE);

    const backend = await resolveBackend();

    expect(backend).toBe(ADAPTER_TYPES.DRIVE);
    // Hard rule: an explicit "drive" is honored without touching the dir handle
    // or rewriting the preference.
    expect(setStoredBackend).not.toHaveBeenCalled();
    expect(getStoredDirHandle).not.toHaveBeenCalled();
  });

  it('explicit stored "fs" is honored verbatim', async () => {
    getStoredBackend.mockResolvedValue(ADAPTER_TYPES.FS);

    const backend = await resolveBackend();

    expect(backend).toBe(ADAPTER_TYPES.FS);
    expect(setStoredBackend).not.toHaveBeenCalled();
    expect(getStoredDirHandle).not.toHaveBeenCalled();
  });

  it('fs-migration heuristic preserved: unset + a leftover handle adopts and persists "fs"', async () => {
    getStoredBackend.mockResolvedValue(null);
    getStoredDirHandle.mockResolvedValue({ kind: 'directory' });

    const backend = await resolveBackend();

    expect(backend).toBe(ADAPTER_TYPES.FS);
    expect(setStoredBackend).toHaveBeenCalledWith(ADAPTER_TYPES.FS);
  });

  it('defensive: unset + getStoredDirHandle throwing still falls back to local "fs"', async () => {
    getStoredBackend.mockResolvedValue(null);
    getStoredDirHandle.mockRejectedValue(new Error('IndexedDB unavailable'));

    const backend = await resolveBackend();

    expect(backend).toBe(ADAPTER_TYPES.FS);
    expect(setStoredBackend).not.toHaveBeenCalled();
  });
});
