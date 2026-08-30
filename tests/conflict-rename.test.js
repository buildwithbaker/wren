// Audit blocker 2 (data integrity) regressions:
//   1. External-edit-then-save must produce a conflict COPY, never an overwrite
//      of the winning version (writeNote is conditional; writeConflictCopy
//      preserves the losing edit as a `.sync-conflict-…` file).
//   2. A rename that changes the FS storage id must NOT let a stale-id write
//      resurrect the old filename (writeNote no longer creates on a plain/
//      conditional update whose target has vanished).
//
// Backed by a tiny in-memory mock of the File System Access API so the whole
// read -> conditional-write -> conflict-copy round-trip runs in plain Node.
import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystemAdapter } from '../src/storage/FileSystemAdapter.js';
import { ConflictError, ADAPTER_TYPES } from '../src/storage/StorageAdapter.js';
import { writeConflictCopy } from '../src/sync/conflictDetection.js';
import { serializeNote } from '../src/notes-store.js';

// ---- Minimal File System Access API mock ----------------------------------

function makeFileHandle(name, store) {
  return {
    kind: 'file',
    name,
    async getFile() {
      return {
        name,
        lastModified: store[name]?.mtime ?? 0,
        async text() {
          return store[name]?.content ?? '';
        },
      };
    },
    async createWritable() {
      return {
        async write(content) {
          store[name] = { content, mtime: (store[name]?.mtime ?? 0) + 1 };
        },
        async close() {},
      };
    },
  };
}

function makeDirHandle(files = {}, subdirs = {}) {
  const dir = {
    kind: 'directory',
    _files: files,
    _subdirs: subdirs,
    async *values() {
      for (const name of Object.keys(files)) yield makeFileHandle(name, files);
      for (const name of Object.keys(subdirs)) yield { kind: 'directory', name };
    },
    async getFileHandle(name, opts = {}) {
      if (!(name in files)) {
        if (opts.create) files[name] = { content: '', mtime: 1 };
        else {
          const err = new Error('NotFound');
          err.name = 'NotFoundError';
          throw err;
        }
      }
      return makeFileHandle(name, files);
    },
    async getDirectoryHandle(name, opts = {}) {
      if (!(name in subdirs)) {
        if (opts.create) subdirs[name] = makeDirHandle({}, {});
        else {
          const err = new Error('NotFound');
          err.name = 'NotFoundError';
          throw err;
        }
      }
      return subdirs[name];
    },
    async removeEntry(name) {
      delete files[name];
    },
    async queryPermission() {
      return 'granted';
    },
  };
  return dir;
}

function noteText(overrides = {}) {
  return serializeNote({
    wrenId: 'wren-stable12345',
    title: 'Todo',
    body: 'original body',
    color: 'default',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

const DEV_ID = 'dev1234';
const CONFLICT_RE = /\.sync-conflict-\d{8}-\d{6}-dev1234\.md$/;

// ---- Tests ----------------------------------------------------------------

describe('conditional writes + conflict copies (FS)', () => {
  let adapter;
  let files;

  beforeEach(() => {
    files = { 'todo.md': { content: noteText(), mtime: 5 } };
    adapter = new FileSystemAdapter();
    adapter._dirHandle = makeDirHandle(files, {});
  });

  it('external edit between read and save throws ConflictError and does NOT overwrite the winner', async () => {
    const { revision } = await adapter.readNote('todo.md');
    expect(revision).toBe('5');

    // A different editor writes the file underneath us (new content + mtime).
    files['todo.md'] = { content: noteText({ body: 'EXTERNAL WINNER' }), mtime: 9 };

    // Our stale-revision save must be rejected, not silently applied.
    await expect(
      adapter.writeNote('todo.md', noteText({ body: 'MY LOSING EDIT' }), revision)
    ).rejects.toBeInstanceOf(ConflictError);

    // The winner on disk is untouched — no overwrite happened.
    expect(files['todo.md'].content).toContain('EXTERNAL WINNER');
    expect(files['todo.md'].content).not.toContain('MY LOSING EDIT');
  });

  it('writeConflictCopy preserves the losing edit as a new .sync-conflict file, leaving the original intact', async () => {
    const winnerBefore = files['todo.md'].content;
    const losing = noteText({ body: 'MY LOSING EDIT' });

    const { id, name } = await writeConflictCopy(
      adapter,
      { id: 'todo.md', filename: 'todo.md', title: 'Todo', created: '2026-01-01T00:00:00.000Z' },
      losing,
      DEV_ID
    );

    // Named per the Syncthing convention, keyed by our device id; on FS the id
    // IS the file name (so the toast can open it).
    expect(name).toMatch(CONFLICT_RE);
    expect(name.startsWith('todo.')).toBe(true);
    expect(id).toBe(name);

    // The conflict copy holds the losing edit …
    expect(files[name]).toBeTruthy();
    expect(files[name].content).toContain('MY LOSING EDIT');
    // … and the original file is completely untouched (no overwrite).
    expect(files['todo.md'].content).toBe(winnerBefore);
  });
});

describe('writeConflictCopy on a Drive-style adapter', () => {
  it('mints a new file via createNote then renames it to the conflict convention', async () => {
    const calls = { create: null, rename: null };
    const driveMock = {
      backendId: () => ADAPTER_TYPES.DRIVE,
      async createNote(content, hint) {
        calls.create = { content, hint };
        return { id: 'drive-new-id', revision: 'r1' };
      },
      async renameNote(id, name) {
        calls.rename = { id, name };
        return { id, name, revision: 'r2' };
      },
    };

    const { id, name } = await writeConflictCopy(
      driveMock,
      { id: 'drive-old-id', filename: 'Todo.md', title: 'Todo', created: '2026-01-01T00:00:00.000Z' },
      'LOSER',
      DEV_ID
    );

    expect(name).toMatch(CONFLICT_RE);
    // Drive: the storage id is the opaque fileId (unchanged by rename), so the
    // toast can open the copy by id.
    expect(id).toBe('drive-new-id');
    expect(calls.create.content).toBe('LOSER');
    expect(calls.rename.id).toBe('drive-new-id');
    expect(calls.rename.name).toBe(name);
  });
});

describe('rename does not resurrect the old filename (FS)', () => {
  let adapter;
  let files;

  beforeEach(() => {
    files = { 'old.md': { content: noteText(), mtime: 5 } };
    adapter = new FileSystemAdapter();
    adapter._dirHandle = makeDirHandle(files, {});
  });

  it('a stale-id conditional write after a rename throws ConflictError and never recreates the old file', async () => {
    const { revision } = await adapter.readNote('old.md');

    // The main app renames the note; the FS storage id changes.
    const { id: newId } = await adapter.renameNote('old.md', 'new.md');
    expect(newId).toBe('new.md');
    expect('old.md' in files).toBe(false);
    expect('new.md' in files).toBe(true);

    // A second window still holding the stale id tries to save.
    await expect(
      adapter.writeNote('old.md', noteText({ body: 'stale window edit' }), revision)
    ).rejects.toBeInstanceOf(ConflictError);

    // The old filename was NOT resurrected.
    expect('old.md' in files).toBe(false);
  });

  it('a plain (unconditional) write to a vanished id throws ConflictError instead of creating it', async () => {
    await adapter.renameNote('old.md', 'new.md');

    await expect(
      adapter.writeNote('old.md', noteText({ body: 'stale window edit' }))
    ).rejects.toBeInstanceOf(ConflictError);

    expect('old.md' in files).toBe(false);
  });

  it('still creates a genuinely new file when create-intent is signalled (empty expectedRevision)', async () => {
    // This is the path writeConflictCopy relies on — a fresh name + '' must create.
    await adapter.writeNote('brand-new.md', noteText({ body: 'created on purpose' }), '');
    expect('brand-new.md' in files).toBe(true);
    expect(files['brand-new.md'].content).toContain('created on purpose');
  });
});
