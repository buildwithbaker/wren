// Regression (audit S13, 2026-07-25): initialize()'s comment claimed the
// stored directory handle is held in memory when permission is only 'prompt',
// but the code dropped it unless permission was already 'granted'.
//
// Why it matters: with no handle in memory, _assertReady() throws "no folder
// handle", which the app routes to storage-choice — where re-picking a folder
// overwrites the real stored handle. With the handle held, the same operation
// fails with NotAllowedError, which _mapPermissionError types as an
// AdapterAuthError and the app answers with "reconnect this folder". Same
// user-visible symptom, two very different recoveries.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsState = vi.hoisted(() => ({ perm: 'prompt', stored: null, throwOnRead: false }));

vi.mock('../src/notes-store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isSupported: () => true,
    getStoredDirHandle: async () => {
      if (fsState.throwOnRead) throw new Error('IndexedDB unavailable');
      return fsState.stored;
    },
    queryPermission: async () => fsState.perm,
    requestPermission: async () => fsState.perm,
  };
});

const { FileSystemAdapter } = await import('../src/storage/FileSystemAdapter.js');

const handle = { kind: 'directory', name: 'Notes' };

beforeEach(() => {
  fsState.perm = 'prompt';
  fsState.stored = handle;
  fsState.throwOnRead = false;
});

describe('FileSystemAdapter.initialize handle retention (S13)', () => {
  it("holds the stored handle when permission is 'prompt'", async () => {
    const a = new FileSystemAdapter();
    await a.initialize();
    expect(a._dirHandle).toBe(handle);
  });

  it("still reports not-ready while permission is 'prompt'", async () => {
    const a = new FileSystemAdapter();
    await a.initialize();
    await expect(a.isReady()).resolves.toBe(false);
  });

  it("holds the stored handle when permission is 'granted' and reports ready", async () => {
    fsState.perm = 'granted';
    const a = new FileSystemAdapter();
    await a.initialize();
    expect(a._dirHandle).toBe(handle);
    await expect(a.isReady()).resolves.toBe(true);
  });

  it("does not hold the handle when permission is 'denied'", async () => {
    fsState.perm = 'denied';
    const a = new FileSystemAdapter();
    await a.initialize();
    expect(a._dirHandle).toBeNull();
  });

  it('leaves the adapter handle-less when there is no stored handle', async () => {
    fsState.stored = null;
    const a = new FileSystemAdapter();
    await a.initialize();
    expect(a._dirHandle).toBeNull();
  });

  it('leaves the adapter handle-less when the handle store cannot be read', async () => {
    fsState.throwOnRead = true;
    const a = new FileSystemAdapter();
    await expect(a.initialize()).resolves.toBeUndefined();
    expect(a._dirHandle).toBeNull();
  });
});
