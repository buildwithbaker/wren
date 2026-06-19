// Pure-logic tests for TauriFsAdapter. The native Tauri fs calls (plugin-fs /
// api/path) are dynamically imported INSIDE the adapter's methods and can't run
// headlessly, so they are not exercised here (per the SOW: keep real fs calls
// behind isTauri() and don't assert them in vitest). What IS testable in plain
// Node is the pure path-building helper, which underpins every fs call.
import { describe, it, expect } from 'vitest';
import { joinPath, WREN_NOTES_FOLDER, TauriFsAdapter } from '../src/storage/TauriFsAdapter.js';

describe('TauriFsAdapter.joinPath', () => {
  it('joins a Windows base with a folder name using a forward slash', () => {
    expect(joinPath('C:\\Users\\Adam\\Documents', WREN_NOTES_FOLDER)).toBe(
      'C:\\Users\\Adam\\Documents/Wren Notes'
    );
  });

  it('strips a trailing separator on the base segment', () => {
    expect(joinPath('/home/adam/Documents/', 'Wren Notes')).toBe('/home/adam/Documents/Wren Notes');
  });

  it('builds nested subfolder paths (e.g. _inbox/foo.md)', () => {
    const base = joinPath('/docs', WREN_NOTES_FOLDER);
    expect(joinPath(base, '_inbox', 'foo.md')).toBe('/docs/Wren Notes/_inbox/foo.md');
  });

  it('strips leading/trailing separators on non-base parts', () => {
    expect(joinPath('/base', '/sub/', 'file.md')).toBe('/base/sub/file.md');
  });

  it('skips empty / null parts', () => {
    expect(joinPath('/base', '', null, undefined, 'file.md')).toBe('/base/file.md');
  });

  it('coalesces redundant separators between segments', () => {
    expect(joinPath('/base//', '//sub', 'a.md')).toBe('/base/sub/a.md');
  });
});

describe('TauriFsAdapter bare-name validation (path-traversal guard)', () => {
  // A ready adapter with no real folder. The bare-name guard runs before any
  // native fs import, so these reject without touching the Tauri plugin.
  function readyAdapter() {
    const a = new TauriFsAdapter();
    a._ready = true;
    a._base = '/notes';
    return a;
  }

  it('rejects a note id that escapes the root', async () => {
    await expect(readyAdapter().writeNote('../escape.md', 'x')).rejects.toThrow(/Invalid/);
  });

  it('rejects a managed file name with a directory component', async () => {
    await expect(readyAdapter().writeManagedFile('sub/index.json', 'x')).rejects.toThrow(/Invalid/);
    await expect(readyAdapter().readManagedFile('../README-for-AI.md')).rejects.toThrow(/Invalid/);
  });

  it('rejects a rename target that traverses out of the folder', async () => {
    await expect(readyAdapter().renameNote('note.md', '../../evil.md')).rejects.toThrow(/Invalid/);
  });

  it('rejects an _inbox/ id whose basename escapes the inbox', async () => {
    await expect(readyAdapter().readNote('_inbox/../live.md')).rejects.toThrow(/Invalid/);
  });
});
