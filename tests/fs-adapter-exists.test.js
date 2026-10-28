// X2.5 - FileSystemAdapter existence checks and silent catches.
//
//   - Every uniqueNoteName() check (root create/rename/restore via _fileExists,
//     the .trash/ lambda in _moveToTrash, the _archive/ lambda in archiveNote)
//     shares one helper: NotFoundError -> name is free, TypeMismatchError -> name
//     is taken (by a directory), anything else rethrows so the operation rejects
//     and writes nothing. It used to return false on ANY error, i.e. "free".
//   - A per-file read/parse skip in listNotes / listInboxNotes / listArchiveNotes
//     still skips, now with a console.warn naming the file.
//   - readManagedFile: NotFoundError -> null silently; any other error -> null
//     plus a warn.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileSystemAdapter } from '../src/storage/FileSystemAdapter.js';
import { serializeNote, buildNoteFilename } from '../src/notes-store.js';

function domErr(name, msg = name) {
  const e = new Error(msg);
  e.name = name;
  return e;
}

/**
 * Tiny in-memory directory handle. `faults` maps "<dirLabel>:<name>" to an error
 * name that getFileHandle(name) throws (even when the file does not exist), so a
 * test can make exactly one existence probe fail.
 */
function makeDir(label, files, subdirs, faults) {
  const fileHandle = (name) => ({
    kind: 'file',
    name,
    async getFile() {
      return {
        name,
        lastModified: files[name]?.mtime ?? 0,
        async text() {
          if (files[name]?.unreadable) throw domErr('NotReadableError', 'locked');
          return files[name]?.content ?? '';
        },
      };
    },
    async createWritable() {
      return {
        async write(content) {
          files[name] = { content, mtime: (files[name]?.mtime ?? 0) + 1 };
        },
        async close() {},
      };
    },
  });
  const dir = {
    kind: 'directory',
    _files: files,
    _subdirs: subdirs,
    async *values() {
      for (const name of Object.keys(files)) yield fileHandle(name);
    },
    async getFileHandle(name, opts = {}) {
      const fault = faults[`${label}:${name}`];
      if (fault && !opts.create) throw domErr(fault);
      if (!(name in files)) {
        if (!opts.create) throw domErr('NotFoundError');
        files[name] = { content: '', mtime: 1 };
      }
      return fileHandle(name);
    },
    async getDirectoryHandle(name, opts = {}) {
      if (!(name in subdirs)) {
        if (!opts.create) throw domErr('NotFoundError');
        subdirs[name] = makeDir(name, {}, {}, faults);
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

const NOTE = serializeNote({
  wrenId: 'wren-existstest01',
  title: 'T',
  body: 'body',
  color: 'default',
  created: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z',
});

let faults;
let root;
let adapter;

beforeEach(() => {
  vi.restoreAllMocks();
  faults = {};
  root = makeDir('root', { 'note.md': { content: NOTE, mtime: 5 } }, {}, faults);
  adapter = new FileSystemAdapter();
  adapter._dirHandle = root;
});

/** The three operations that run a uniqueNoteName() check, each with its probe key. */
const created = '2026-01-01T00:00:00.000Z';
const createdName = buildNoteFilename(created, 'T');
const CASES = [
  {
    op: 'createNote',
    key: `root:${createdName}`,
    base: createdName,
    run: () => adapter.createNote(NOTE, { title: 'T', created }),
    result: (r) => r.id,
    writtenIn: () => root._files,
    untouchedAfterReject: () => !Object.keys(root._files).some((n) => n !== 'note.md'),
  },
  {
    op: 'trash (deleteNote)',
    key: '.trash:note.md',
    base: 'note.md',
    run: () => adapter.deleteNote('note.md'),
    result: (r) => r.trashId.replace('.trash/', ''),
    writtenIn: () => root._subdirs['.trash']._files,
    untouchedAfterReject: () => 'note.md' in root._files && !('.trash' in root._subdirs && Object.keys(root._subdirs['.trash']._files).length),
  },
  {
    op: 'archiveNote',
    key: '_archive:note.md',
    base: 'note.md',
    run: () => adapter.archiveNote('note.md'),
    result: (r) => r.id.replace('_archive/', ''),
    writtenIn: () => root._subdirs['_archive']._files,
    untouchedAfterReject: () =>
      'note.md' in root._files && !('_archive' in root._subdirs && Object.keys(root._subdirs['_archive']._files).length),
  },
];

describe.each(CASES)('$op existence check', (c) => {
  it('NotFoundError -> the name is free and is used as-is', async () => {
    const r = await c.run();
    expect(c.result(r)).toBe(c.base);
    expect(c.base in c.writtenIn()).toBe(true);
  });

  it('TypeMismatchError -> the name is taken (by a directory); the next suffix is used', async () => {
    faults[c.key] = 'TypeMismatchError';
    const r = await c.run();
    const used = c.result(r);
    expect(used).not.toBe(c.base);
    expect(used).toMatch(/\(\d+\)\.md$/);
    expect(used in c.writtenIn()).toBe(true);
    // Nothing was written under the colliding name.
    expect(c.base in c.writtenIn() && c.base !== 'note.md').toBe(false);
  });

  it('any other error rejects and writes nothing', async () => {
    faults[c.key] = 'NotReadableError';
    await expect(c.run()).rejects.toMatchObject({ name: 'NotReadableError' });
    expect(c.untouchedAfterReject()).toBe(true);
  });
});

describe('per-file skips warn with the filename', () => {
  function withBadFile(files) {
    return { ...files, 'bad.md': { content: 'x', mtime: 1, unreadable: true } };
  }

  it('listNotes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter._dirHandle = makeDir('root', withBadFile({ 'note.md': { content: NOTE, mtime: 5 } }), {}, faults);
    const notes = await adapter.listNotes();
    expect(notes.map((n) => n.id)).toEqual(['note.md']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('bad.md');
    expect(warn.mock.calls[0][1]).toMatchObject({ name: 'NotReadableError' });
  });

  it('listInboxNotes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inbox = makeDir('_inbox', withBadFile({ 'ok.md': { content: NOTE, mtime: 2 } }), {}, faults);
    adapter._dirHandle = makeDir('root', {}, { _inbox: inbox }, faults);
    const notes = await adapter.listInboxNotes();
    expect(notes.map((n) => n.id)).toEqual(['_inbox/ok.md']);
    expect(warn.mock.calls[0][0]).toContain('bad.md');
  });

  it('listArchiveNotes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const arch = makeDir('_archive', withBadFile({ 'ok.md': { content: NOTE, mtime: 2 } }), {}, faults);
    adapter._dirHandle = makeDir('root', {}, { _archive: arch }, faults);
    const notes = await adapter.listArchiveNotes();
    expect(notes.map((n) => n.id)).toEqual(['_archive/ok.md']);
    expect(warn.mock.calls[0][0]).toContain('bad.md');
  });
});

describe('readManagedFile', () => {
  it('NotFoundError -> null with no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(adapter.readManagedFile('README-for-AI.md')).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('another error -> null plus a warning naming the file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    faults['root:README-for-AI.md'] = 'NotReadableError';
    await expect(adapter.readManagedFile('README-for-AI.md')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('README-for-AI.md');
    expect(warn.mock.calls[0][1]).toMatchObject({ name: 'NotReadableError' });
  });

  it('returns the text when the file exists', async () => {
    root._files['README-for-AI.md'] = { content: 'hello', mtime: 1 };
    await expect(adapter.readManagedFile('README-for-AI.md')).resolves.toBe('hello');
  });
});
