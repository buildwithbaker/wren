// @vitest-environment jsdom
//
// X2.4 - list and existence failures must be loud.
//
//   - loadNotes(): a listNotes() failure used to be console.error + notes = [],
//     which rendered "No notes yet" over a broken folder. It now shows the real
//     error with a Retry in the list (and Compact), plus a toast.
//   - TauriFsAdapter._listMd: a readDir failure rejects (it returned []); one bad
//     file is still skipped, now with a warning naming it.
//   - TauriFsAdapter._existsAbs: an exists() error rejects (it returned false,
//     i.e. "name is free", which feeds uniqueNoteName and can overwrite a note).
//   - A broken _inbox/ or _archive/ must not stop the main list rendering.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountApp, createFakeAdapter, cleanupApp } from './helpers/mount-app.js';
import { TauriFsAdapter } from '../src/storage/TauriFsAdapter.js';

const fsMock = vi.hoisted(() => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  stat: vi.fn(),
  exists: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => fsMock);
vi.mock('@tauri-apps/api/path', () => ({ documentDir: async () => '/docs' }));

const NOTE = {
  id: 'n.md',
  wrenId: 'wren-nnnnnnnnnnnn',
  title: 'Existing note',
  body: 'hi',
  tags: [],
};

function ioError(msg = 'The system cannot find the path specified. (os error 3)') {
  const e = new Error(msg);
  e.name = 'IoError';
  return e;
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  for (const fn of Object.values(fsMock)) fn.mockReset();
});
afterEach(() => cleanupApp());

describe('loadNotes() failure is a visible error state, not "No notes yet"', () => {
  function failingAdapter() {
    const a = createFakeAdapter([NOTE]);
    const realList = a.listNotes;
    a._failList = true;
    a.listNotes = vi.fn(async () => {
      if (a._failList) throw ioError();
      return realList();
    });
    return a;
  }

  it('shows the real error text, a Retry button and a toast; no empty state', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await mountApp({ adapter: failingAdapter() });
    const err = await app.waitFor(() => document.querySelector('.sc-list-error [data-load-error]'));
    expect(err).not.toBeNull();
    expect(err.textContent).toBe('IoError: The system cannot find the path specified. (os error 3)');
    expect(document.querySelector('.sc-list-error .sc-load-retry').textContent).toBe('Retry');
    expect(document.body.textContent).not.toContain('No notes yet');
    expect(document.querySelector('.sc-toast-error')?.textContent).toContain('IoError');
    expect(consoleError).toHaveBeenCalledWith('Failed to list notes', expect.any(Error));
  });

  it('shows the same error state in Compact', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await mountApp({ adapter: failingAdapter() });
    await app.waitFor(() => document.querySelector('.sc-compact-empty.sc-list-error'));
    const compact = document.querySelector('.sc-compact-empty.sc-list-error');
    expect(compact.querySelector('[data-load-error]').textContent).toContain('IoError');
    expect(compact.querySelector('.sc-load-retry')).not.toBeNull();
  });

  it('Retry after the adapter recovers renders the list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = failingAdapter();
    const app = await mountApp({ adapter });
    const retry = await app.waitFor(() => document.querySelector('.sc-list-error .sc-load-retry'));
    adapter._failList = false;
    retry.click();
    const card = await app.waitFor(() => document.querySelector('.sc-card'));
    expect(card).not.toBeNull();
    expect(document.body.textContent).toContain('Existing note');
    expect(document.querySelector('.sc-list-error')).toBeNull();
  });

  it('a broken inbox does not block the main list (and warns)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createFakeAdapter([NOTE]);
    adapter.listInboxNotes = async () => {
      throw ioError('inbox unreadable');
    };
    const app = await mountApp({ adapter });
    await app.waitFor(() => document.querySelector('.sc-card'));
    expect(document.body.textContent).toContain('Existing note');
    expect(document.querySelector('.sc-list-error')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not load inbox notes'),
      expect.any(Error)
    );
  });

  it('a broken archive does not block the main list (and warns)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createFakeAdapter([NOTE]);
    adapter.listArchiveNotes = async () => {
      throw ioError('archive unreadable');
    };
    const app = await mountApp({ adapter });
    await app.waitFor(() => document.querySelector('.sc-card'));
    expect(document.body.textContent).toContain('Existing note');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not load archived notes'),
      expect.any(Error)
    );
  });
});

describe('TauriFsAdapter silent catches', () => {
  function readyAdapter() {
    const a = new TauriFsAdapter();
    a._ready = true;
    a._base = '/docs/Wren Notes';
    return a;
  }

  it('_listMd: a readDir rejection propagates (not [])', async () => {
    fsMock.readDir.mockRejectedValue(ioError());
    await expect(readyAdapter().listNotes()).rejects.toMatchObject({ name: 'IoError' });
  });

  it('_listMd: one bad file is skipped with a warning naming it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fsMock.readDir.mockResolvedValue([
      { name: 'good.md', isFile: true },
      { name: 'bad.md', isFile: true },
    ]);
    fsMock.readTextFile.mockImplementation(async (p) => {
      if (p.endsWith('bad.md')) throw ioError('locked');
      return '---\ntitle: "Good"\n---\n\nbody';
    });
    fsMock.stat.mockResolvedValue({ mtime: new Date('2026-07-01T00:00:00Z') });
    const notes = await readyAdapter().listNotes();
    expect(notes.map((n) => n.id)).toEqual(['good.md']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('bad.md');
    expect(warn.mock.calls[0][1]).toMatchObject({ message: 'locked' });
  });

  it('_existsAbs: returns the answer, and an error rejects instead of "free"', async () => {
    const a = readyAdapter();
    fsMock.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(a._existsAbs('/x')).resolves.toBe(true);
    await expect(a._existsAbs('/x')).resolves.toBe(false);
    fsMock.exists.mockRejectedValue(ioError('access denied'));
    await expect(a._existsAbs('/x')).rejects.toMatchObject({ message: 'access denied' });
  });

  it('createNote rejects (and writes nothing) when the existence check errors', async () => {
    fsMock.exists.mockRejectedValue(ioError('access denied'));
    await expect(readyAdapter().createNote('---\ntitle: "T"\n---\n', { title: 'T' })).rejects.toMatchObject({
      message: 'access denied',
    });
    expect(fsMock.writeTextFile).not.toHaveBeenCalled();
  });

  it('listInboxNotes: a readDir failure inside an existing _inbox/ rejects (caller catches)', async () => {
    fsMock.exists.mockResolvedValue(true);
    fsMock.readDir.mockRejectedValue(ioError('inbox unreadable'));
    await expect(readyAdapter().listInboxNotes()).rejects.toMatchObject({
      message: 'inbox unreadable',
    });
  });
});
