// Inbox (_inbox/) round-trip tests for FileSystemAdapter (AI phase 4).
// Backed by a tiny in-memory mock of the File System Access API so the
// list -> read -> promote/delete id round-trip can run in plain Node.
import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystemAdapter } from '../src/storage/FileSystemAdapter.js';
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
  // files: { name: { content, mtime } }; subdirs: { name: dirHandle }
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
    // queryPermission so adapter.isReady()-style checks (if any) pass.
    async queryPermission() {
      return 'granted';
    },
  };
  return dir;
}

function noteText(overrides = {}) {
  return serializeNote({
    wrenId: 'wren-stable12345',
    title: 'Captured',
    body: 'staged body',
    color: 'default',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

// ---- Tests ----------------------------------------------------------------

describe('FileSystemAdapter inbox round-trip', () => {
  let adapter;
  let root;
  let inboxFiles;

  beforeEach(() => {
    inboxFiles = { 'staged.md': { content: noteText(), mtime: 5 } };
    const inboxDir = makeDirHandle(inboxFiles, {});
    root = makeDirHandle({ 'existing.md': { content: noteText({ wrenId: 'wren-other00000' }), mtime: 1 } }, { _inbox: inboxDir });
    adapter = new FileSystemAdapter();
    adapter._dirHandle = root; // inject handle directly (skip the picker)
  });

  it('listInboxNotes returns staged files with _inbox/ ids and inbox:true', async () => {
    const staged = await adapter.listInboxNotes();
    expect(staged).toHaveLength(1);
    expect(staged[0].id).toBe('_inbox/staged.md');
    expect(staged[0].inbox).toBe(true);
    expect(staged[0].wrenId).toBe('wren-stable12345');
  });

  it('listNotes does NOT include inbox files', async () => {
    const main = await adapter.listNotes();
    expect(main.map((n) => n.id)).toEqual(['existing.md']);
  });

  it('listInboxNotes returns [] when _inbox/ is absent (no folder created)', async () => {
    const bare = new FileSystemAdapter();
    bare._dirHandle = makeDirHandle({}, {});
    expect(await bare.listInboxNotes()).toEqual([]);
    // No _inbox subdir was created by listing.
    expect('_inbox' in bare._dirHandle._subdirs).toBe(false);
  });

  it('readNote round-trips an _inbox/ id to the staged file', async () => {
    const { content } = await adapter.readNote('_inbox/staged.md');
    expect(content).toContain('id: wren-stable12345');
    expect(content).toContain('staged body');
  });

  it('promoteInboxNote moves the file to root, preserving wrenId, and removes it from inbox', async () => {
    const { id } = await adapter.promoteInboxNote('_inbox/staged.md');
    expect(id).toBe('staged.md'); // now top-level
    // Gone from inbox:
    expect(await adapter.listInboxNotes()).toHaveLength(0);
    // Present at root with the same wrenId:
    const main = await adapter.listNotes();
    const promoted = main.find((n) => n.id === 'staged.md');
    expect(promoted).toBeTruthy();
    expect(promoted.wrenId).toBe('wren-stable12345');
  });

  it('promoteInboxNote avoids collisions with an existing root file', async () => {
    // Add a root file already named staged.md.
    root._files['staged.md'] = { content: noteText({ wrenId: 'wren-rootexists0' }), mtime: 2 };
    const { id } = await adapter.promoteInboxNote('_inbox/staged.md');
    expect(id).not.toBe('staged.md'); // got a " (2)" suffix
    expect(id).toMatch(/staged \(\d+\)\.md/);
  });

  it('deleteNote on an _inbox/ id removes the staged file only', async () => {
    await adapter.deleteNote('_inbox/staged.md');
    expect(await adapter.listInboxNotes()).toHaveLength(0);
    // Root file untouched.
    expect((await adapter.listNotes()).map((n) => n.id)).toEqual(['existing.md']);
  });

  it('discardInboxNote soft-deletes the staged file into .trash/ (content preserved)', async () => {
    const res = await adapter.discardInboxNote('_inbox/staged.md');
    expect(res.id).toBe('.trash/staged.md');
    // Gone from the inbox:
    expect(await adapter.listInboxNotes()).toHaveLength(0);
    // Landed in .trash/ with its original content (recoverable by a file move):
    const trash = root._subdirs['.trash'];
    expect(trash).toBeTruthy();
    expect('staged.md' in trash._files).toBe(true);
    expect(trash._files['staged.md'].content).toContain('staged body');
    // Main corpus untouched.
    expect((await adapter.listNotes()).map((n) => n.id)).toEqual(['existing.md']);
  });

  it('discardInboxNote resolves a name collision in .trash/ with a " (N)" suffix', async () => {
    // Pre-seed a colliding file in .trash/.
    root._subdirs['.trash'] = makeDirHandle({ 'staged.md': { content: 'old', mtime: 1 } }, {});
    const res = await adapter.discardInboxNote('_inbox/staged.md');
    expect(res.id).toMatch(/^\.trash\/staged \(\d+\)\.md$/);
    // Original trashed file is untouched.
    expect(root._subdirs['.trash']._files['staged.md'].content).toBe('old');
  });

  it('discardInboxNote rejects a non-inbox id', async () => {
    await expect(adapter.discardInboxNote('existing.md')).rejects.toThrow(/_inbox\//);
  });
});
