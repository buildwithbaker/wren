// Audit blocker 3 (U4/S11): a main-app delete must SOFT-delete a top-level note
// into the notes folder's .trash/ subfolder (recoverable) instead of hard-
// removing it. Backed by the in-memory File System Access API mock.
import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystemAdapter } from '../src/storage/FileSystemAdapter.js';
import { serializeNote } from '../src/notes-store.js';

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
    title: 'Keep me',
    body: 'precious body',
    color: 'default',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('FileSystemAdapter soft-delete to .trash/', () => {
  let adapter;
  let root;

  beforeEach(() => {
    root = makeDirHandle({ 'keep.md': { content: noteText(), mtime: 3 } }, {});
    adapter = new FileSystemAdapter();
    adapter._dirHandle = root;
  });

  it('moves a top-level note into .trash/ with content preserved, removing it from root', async () => {
    await adapter.deleteNote('keep.md');

    // Gone from the main corpus…
    expect('keep.md' in root._files).toBe(false);
    expect((await adapter.listNotes()).map((n) => n.id)).toEqual([]);

    // …recoverable in .trash/ with its original content.
    const trash = root._subdirs['.trash'];
    expect(trash).toBeTruthy();
    expect('keep.md' in trash._files).toBe(true);
    expect(trash._files['keep.md'].content).toContain('precious body');
  });

  it('resolves a name collision in .trash/ with a " (N)" suffix', async () => {
    root._subdirs['.trash'] = makeDirHandle({ 'keep.md': { content: 'older trashed', mtime: 1 } }, {});
    await adapter.deleteNote('keep.md');

    const trash = root._subdirs['.trash'];
    // Original trashed file untouched; the new one got a suffix.
    expect(trash._files['keep.md'].content).toBe('older trashed');
    const suffixed = Object.keys(trash._files).find((n) => /^keep \(\d+\)\.md$/.test(n));
    expect(suffixed).toBeTruthy();
    expect(trash._files[suffixed].content).toContain('precious body');
  });
});
