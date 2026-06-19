// Tests for chooseFsAdapter() — the fs-family adapter selection rule that gives
// fresh desktop installs a zero-prompt native folder while never relocating an
// existing user's notes (SOW P5). Three branches matter and are asserted:
//   - Tauri + no stored FS-Access handle → TauriFsAdapter (auto Documents/Wren Notes)
//   - Tauri + an existing handle         → FileSystemAdapter (keep their folder)
//   - not Tauri (PWA / extension)        → FileSystemAdapter (one-time picker)
//
// The adapter classes are stubbed (distinct named classes so `instanceof`
// discriminates) and the two collaborators — isTauri() and getStoredDirHandle()
// — are mocked. chooseFsAdapter never touches the real Tauri fs APIs.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/storage/FileSystemAdapter.js', () => ({
  FileSystemAdapter: class FileSystemAdapter {},
}));
vi.mock('../src/storage/TauriFsAdapter.js', () => ({
  TauriFsAdapter: class TauriFsAdapter {},
  WREN_NOTES_FOLDER: 'Wren Notes',
}));
vi.mock('../src/storage/DriveAdapter.js', () => ({ DriveAdapter: class {} }));
vi.mock('../src/storage/backendPreference.js', () => ({
  getStoredBackend: vi.fn(),
  setStoredBackend: vi.fn(),
  clearStoredBackend: vi.fn(),
}));

const isTauri = vi.fn();
vi.mock('../src/platform.js', () => ({ isTauri: (...a) => isTauri(...a) }));

const getStoredDirHandle = vi.fn();
vi.mock('../src/notes-store.js', () => ({ getStoredDirHandle: (...a) => getStoredDirHandle(...a) }));

const { chooseFsAdapter } = await import('../src/storage/activeAdapter.js');
const { FileSystemAdapter } = await import('../src/storage/FileSystemAdapter.js');
const { TauriFsAdapter } = await import('../src/storage/TauriFsAdapter.js');

describe('chooseFsAdapter — fs-family selection', () => {
  beforeEach(() => {
    isTauri.mockReset();
    getStoredDirHandle.mockReset();
  });

  it('fresh desktop install (Tauri, no stored handle) → TauriFsAdapter', async () => {
    isTauri.mockReturnValue(true);
    getStoredDirHandle.mockResolvedValue(null);

    const a = await chooseFsAdapter();

    expect(a).toBeInstanceOf(TauriFsAdapter);
  });

  it('existing desktop user (Tauri, handle present) → FileSystemAdapter (never relocate)', async () => {
    isTauri.mockReturnValue(true);
    getStoredDirHandle.mockResolvedValue({ kind: 'directory' });

    const a = await chooseFsAdapter();

    expect(a).toBeInstanceOf(FileSystemAdapter);
    expect(a).not.toBeInstanceOf(TauriFsAdapter);
  });

  it('PWA / extension (not Tauri) → FileSystemAdapter (one-time picker)', async () => {
    isTauri.mockReturnValue(false);

    const a = await chooseFsAdapter();

    expect(a).toBeInstanceOf(FileSystemAdapter);
    // Browser path must not even consult the FS-Access handle store.
    expect(getStoredDirHandle).not.toHaveBeenCalled();
  });

  it('defensive: Tauri + getStoredDirHandle throwing falls back to FileSystemAdapter (never relocate)', async () => {
    isTauri.mockReturnValue(true);
    getStoredDirHandle.mockRejectedValue(new Error('IndexedDB unavailable'));

    const a = await chooseFsAdapter();

    // A read failure must NOT be assumed to mean "fresh install" — that would
    // route an existing desktop user to a brand-new Documents/Wren Notes folder.
    expect(a).toBeInstanceOf(FileSystemAdapter);
    expect(a).not.toBeInstanceOf(TauriFsAdapter);
  });
});
