// Audit blocker 4 (S3): getStoredDirHandle must distinguish a genuine ABSENT
// key (brand-new install → null) from a READ FAILURE (IndexedDB error → throw).
// It used to swallow every failure to null, which sent existing users to the
// storage-choice screen where re-picking overwrote their real folder handle.
import { describe, it, expect, afterEach } from 'vitest';
import {
  getStoredDirHandle,
  isStoragePersisted,
  requestStoragePersistence,
} from '../src/notes-store.js';

// ---- Minimal IndexedDB fakes ----------------------------------------------

function fireAsync(req, apply) {
  Promise.resolve().then(() => {
    apply(req);
  });
  return req;
}

function fakeDbWithValue(value) {
  return {
    transaction() {
      return {
        objectStore() {
          return {
            get() {
              return fireAsync({}, (r) => {
                r.result = value;
                r.onsuccess && r.onsuccess();
              });
            },
          };
        },
      };
    },
    close() {},
  };
}

function installIdb(openImpl) {
  globalThis.indexedDB = { open: openImpl };
}

describe('getStoredDirHandle read-failure vs absent (audit S3)', () => {
  const orig = globalThis.indexedDB;
  afterEach(() => {
    globalThis.indexedDB = orig;
  });

  it('propagates a read failure instead of swallowing it to null', async () => {
    installIdb(() =>
      fireAsync({}, (req) => {
        req.error = new Error('idb open boom');
        req.onerror && req.onerror();
      })
    );
    await expect(getStoredDirHandle()).rejects.toBeTruthy();
  });

  it('returns null when the key is genuinely absent (get resolves undefined)', async () => {
    installIdb(() =>
      fireAsync({}, (req) => {
        req.result = fakeDbWithValue(undefined);
        req.onsuccess && req.onsuccess();
      })
    );
    await expect(getStoredDirHandle()).resolves.toBeNull();
  });

  it('returns the stored handle when present', async () => {
    const handle = { kind: 'directory', name: 'notes' };
    installIdb(() =>
      fireAsync({}, (req) => {
        req.result = fakeDbWithValue(handle);
        req.onsuccess && req.onsuccess();
      })
    );
    await expect(getStoredDirHandle()).resolves.toBe(handle);
  });
});

describe('storage-persistence helpers degrade gracefully', () => {
  it('return null when the Storage API is unavailable', async () => {
    // No navigator.storage in this environment → both helpers must no-op to null
    // rather than throw.
    await expect(isStoragePersisted()).resolves.toBeNull();
    await expect(requestStoragePersistence()).resolves.toBeNull();
  });
});
