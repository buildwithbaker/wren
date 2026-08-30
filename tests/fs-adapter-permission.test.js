// Regression: a File System Access permission revocation (NotAllowedError /
// SecurityError) must be mapped to AdapterAuthError so the app routes to the
// folder-reconnect screen instead of swallowing it as a generic "save failed"
// and displaying the failed save as a success (the P0 silent-data-loss bug).
import { describe, it, expect } from 'vitest';
import { FileSystemAdapter } from '../src/storage/FileSystemAdapter.js';
import { AdapterAuthError } from '../src/storage/StorageAdapter.js';

function dirThatThrows(name) {
  return {
    kind: 'directory',
    async getFileHandle() {
      const err = new Error('permission');
      err.name = name;
      throw err;
    },
    async getDirectoryHandle() {
      const err = new Error('permission');
      err.name = name;
      throw err;
    },
    async queryPermission() {
      return 'denied';
    },
  };
}

describe('FileSystemAdapter permission-revocation mapping', () => {
  it('writeNote maps NotAllowedError to AdapterAuthError', async () => {
    const a = new FileSystemAdapter();
    a._dirHandle = dirThatThrows('NotAllowedError');
    await expect(a.writeNote('n.md', 'content')).rejects.toBeInstanceOf(AdapterAuthError);
  });

  it('writeNote maps SecurityError to AdapterAuthError', async () => {
    const a = new FileSystemAdapter();
    a._dirHandle = dirThatThrows('SecurityError');
    await expect(a.writeNote('n.md', 'content')).rejects.toBeInstanceOf(AdapterAuthError);
  });

  it('readNote maps NotAllowedError to AdapterAuthError', async () => {
    const a = new FileSystemAdapter();
    a._dirHandle = dirThatThrows('NotAllowedError');
    await expect(a.readNote('n.md')).rejects.toBeInstanceOf(AdapterAuthError);
  });

  it('does NOT convert an unrelated error (passes it through unchanged)', async () => {
    const a = new FileSystemAdapter();
    a._dirHandle = dirThatThrows('TypeError');
    let caught;
    try {
      await a.writeNote('n.md', 'content');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(AdapterAuthError);
    expect(caught.name).toBe('TypeError');
  });

  // Audit R2-2 (S8): the mutation methods used to let a raw DOMException escape,
  // producing dead-end alert()s instead of routing to the reconnect flow.
  it('maps NotAllowedError to AdapterAuthError across every mutation', async () => {
    const each = async (fn) => {
      const a = new FileSystemAdapter();
      a._dirHandle = dirThatThrows('NotAllowedError');
      await expect(fn(a)).rejects.toBeInstanceOf(AdapterAuthError);
    };
    await each((a) => a.deleteNote('n.md'));
    await each((a) => a.createNote('body', { title: 'x', created: '2026-01-01T00:00:00.000Z' }));
    await each((a) => a.renameNote('a.md', 'b.md'));
    await each((a) => a.archiveNote('a.md'));
    await each((a) => a.unarchiveNote('_archive/a.md'));
  });

  it('a non-permission error still passes through a mutation unchanged', async () => {
    const a = new FileSystemAdapter();
    a._dirHandle = dirThatThrows('TypeError');
    let caught;
    try {
      await a.renameNote('a.md', 'b.md');
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeInstanceOf(AdapterAuthError);
    expect(caught.name).toBe('TypeError');
  });
});
