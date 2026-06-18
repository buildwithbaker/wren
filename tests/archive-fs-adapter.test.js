// Archive (_archive/) round-trip tests for FileSystemAdapter (Note Lifecycle B).
// Backed by the same tiny in-memory File System Access mock the inbox tests use,
// so archive → list → unarchive file moves run in plain Node.
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
    wrenId: 'wren-archive00001',
    title: 'Keepsake',
    body: 'archived body',
    color: 'default',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('FileSystemAdapter archive round-trip', () => {
  let adapter;
  let root;

  beforeEach(() => {
    root = makeDirHandle({
      'note.md': { content: noteText(), mtime: 5 },
      'other.md': { content: noteText({ wrenId: 'wren-other000000' }), mtime: 3 },
    });
    adapter = new FileSystemAdapter();
    adapter._dirHandle = root;
  });

  it('archiveNote moves a top-level note into _archive/ (content preserved)', async () => {
    const res = await adapter.archiveNote('note.md');
    expect(res.id).toBe('_archive/note.md');
    // Gone from the main list:
    expect((await adapter.listNotes()).map((n) => n.id)).toEqual(['other.md']);
    // Present in _archive/ with its original content:
    const archive = root._subdirs['_archive'];
    expect(archive._files['note.md'].content).toContain('archived body');
  });

  it('listArchiveNotes returns _archive/ ids with archived:true', async () => {
    await adapter.archiveNote('note.md');
    const archived = await adapter.listArchiveNotes();
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('_archive/note.md');
    expect(archived[0].archived).toBe(true);
    expect(archived[0].wrenId).toBe('wren-archive00001');
  });

  it('listArchiveNotes returns [] when _archive/ is absent (never creates it)', async () => {
    expect(await adapter.listArchiveNotes()).toEqual([]);
    expect('_archive' in root._subdirs).toBe(false);
  });

  it('readNote round-trips an _archive/ id', async () => {
    await adapter.archiveNote('note.md');
    const { content } = await adapter.readNote('_archive/note.md');
    expect(content).toContain('archived body');
  });

  it('unarchiveNote moves the file back to the top level, preserving the filename', async () => {
    await adapter.archiveNote('note.md');
    const res = await adapter.unarchiveNote('_archive/note.md');
    expect(res.id).toBe('note.md');
    // Back in the main list, gone from the archive:
    expect((await adapter.listNotes()).map((n) => n.id).sort()).toEqual(['note.md', 'other.md']);
    expect(await adapter.listArchiveNotes()).toHaveLength(0);
  });

  it('archiveNote resolves a name collision in _archive/ with a " (N)" suffix', async () => {
    root._subdirs['_archive'] = makeDirHandle({ 'note.md': { content: 'old', mtime: 1 } }, {});
    const res = await adapter.archiveNote('note.md');
    expect(res.id).toMatch(/^_archive\/note \(\d+\)\.md$/);
    // The pre-existing archived file is untouched.
    expect(root._subdirs['_archive']._files['note.md'].content).toBe('old');
  });

  it('unarchiveNote resolves a collision at the top level with a " (N)" suffix', async () => {
    await adapter.archiveNote('note.md');
    // Recreate a top-level note.md so unarchive must rename.
    root._files['note.md'] = { content: noteText({ wrenId: 'wren-readded00000' }), mtime: 9 };
    const res = await adapter.unarchiveNote('_archive/note.md');
    expect(res.id).toMatch(/^note \(\d+\)\.md$/);
  });

  it('rejects mismatched ids', async () => {
    await expect(adapter.archiveNote('_inbox/x.md')).rejects.toThrow(/top-level/);
    await expect(adapter.unarchiveNote('note.md')).rejects.toThrow(/_archive\//);
  });
});
