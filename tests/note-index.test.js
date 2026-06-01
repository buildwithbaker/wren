// Unit tests for the pure index builders in src/ai/note-index.js.
// No DOM / no I/O — these run in plain Node.
import { describe, it, expect } from 'vitest';
import {
  buildIndexJson,
  buildIndexMarkdown,
  INDEX_JSON_NAME,
  INDEX_MD_NAME,
  INDEX_SCHEMA_VERSION,
} from '../src/ai/note-index.js';

const noteA = {
  id: '2026-01-02 - Alpha.md',
  wrenId: 'wren-aaaaaaaaaaaa',
  filename: '2026-01-02 - Alpha.md',
  title: 'Alpha',
  summary: 'First note',
  due: '2026-02-01',
  tags: ['status:todo', 'project:wren'],
  color: 'amber',
  created: '2026-01-02T00:00:00.000Z',
  modified: '2026-01-02T08:00:00.000Z',
  body: 'Alpha body text',
};
const noteB = {
  id: 'drive-file-id-xyz',
  wrenId: 'wren-bbbbbbbbbbbb',
  name: '2026-01-05 - Beta.md', // adapter-style `name` (Drive)
  title: 'Beta',
  summary: '',
  due: '',
  tags: [],
  color: 'default',
  created: '2026-01-05T00:00:00.000Z',
  modified: '2026-01-05T08:00:00.000Z',
  body: 'Beta body text',
  revision: 'headRev-123', // Drive headRevisionId, surfaced as contentHash
};

describe('constants', () => {
  it('exposes the managed file names', () => {
    expect(INDEX_JSON_NAME).toBe('.wren-index.json');
    expect(INDEX_MD_NAME).toBe('_index.md');
  });
});

describe('buildIndexJson', () => {
  it('produces the documented FROZEN schema shape', async () => {
    const idx = await buildIndexJson([noteA], 'fs');
    expect(idx.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(idx.backend).toBe('fs');
    expect(idx.count).toBe(1);
    expect(typeof idx.generatedAt).toBe('string');
    expect(() => new Date(idx.generatedAt).toISOString()).not.toThrow();
    const entry = idx.notes[0];
    // Exact frozen key set (order-independent).
    expect(Object.keys(entry).sort()).toEqual(
      [
        'wrenId', 'storageId', 'path', 'file', 'title', 'summary',
        'due', 'tags', 'color', 'created', 'updated', 'contentHash',
      ].sort()
    );
    expect(entry.wrenId).toBe('wren-aaaaaaaaaaaa');
    expect(entry.storageId).toBe('2026-01-02 - Alpha.md');
    expect(entry.path).toBe('2026-01-02 - Alpha.md'); // flat note: path === file
    expect(entry.file).toBe('2026-01-02 - Alpha.md');
    expect(entry.title).toBe('Alpha');
    expect(entry.summary).toBe('First note');
    expect(entry.due).toBe('2026-02-01');
    expect(entry.tags).toEqual(['status:todo', 'project:wren']);
    expect(entry.color).toBe('amber');
    expect(entry.created).toBe('2026-01-02T00:00:00.000Z');
    expect(entry.updated).toBe('2026-01-02T08:00:00.000Z'); // mapped from modified
  });

  it('sorts notes by updated (modified) descending', async () => {
    const idx = await buildIndexJson([noteA, noteB], 'fs');
    expect(idx.notes.map((n) => n.wrenId)).toEqual([
      'wren-bbbbbbbbbbbb', // 01-05 newest
      'wren-aaaaaaaaaaaa', // 01-02
    ]);
  });

  it('keeps all keys present with empty defaults (stable schema)', async () => {
    const idx = await buildIndexJson([noteB], 'drive');
    const entry = idx.notes[0];
    expect(entry.summary).toBe('');
    expect(entry.due).toBe('');
    expect(entry.tags).toEqual([]);
    expect(entry.color).toBe('default');
    // Drive entry: storageId = opaque id, file = the human `name`.
    expect(entry.storageId).toBe('drive-file-id-xyz');
    expect(entry.file).toBe('2026-01-05 - Beta.md');
    expect(entry.path).toBe('2026-01-05 - Beta.md');
  });

  it('FS contentHash is sha256 of the body and changes when the body changes', async () => {
    const a = (await buildIndexJson([noteA], 'fs')).notes[0];
    expect(a.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    const edited = { ...noteA, body: 'Alpha body text — EDITED' };
    const b = (await buildIndexJson([edited], 'fs')).notes[0];
    expect(b.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(b.contentHash).not.toBe(a.contentHash);
    // Same body => same hash (deterministic).
    const again = (await buildIndexJson([noteA], 'fs')).notes[0];
    expect(again.contentHash).toBe(a.contentHash);
  });

  it('Drive contentHash reuses the metadata token (headRevisionId)', async () => {
    const entry = (await buildIndexJson([noteB], 'drive')).notes[0];
    expect(entry.contentHash).toBe('headRev-123');
  });

  it('Drive prefers md5 contentHash over revision when present', async () => {
    const withHash = { ...noteB, contentHash: 'md5-abc', revision: 'headRev-123' };
    const entry = (await buildIndexJson([withHash], 'drive')).notes[0];
    expect(entry.contentHash).toBe('md5-abc');
  });

  it('contentHash is never empty', async () => {
    const bare = { id: 'x.md', wrenId: 'wren-cccccccccccc', modified: '2026-01-01T00:00:00.000Z' };
    const fs = (await buildIndexJson([bare], 'fs')).notes[0];
    const drive = (await buildIndexJson([bare], 'drive')).notes[0];
    expect(fs.contentHash).toMatch(/^sha256-/);
    expect(drive.contentHash).toMatch(/^sha256-/); // no Drive token => body-hash fallback
  });

  it('handles an empty folder (count 0, empty notes array)', async () => {
    const idx = await buildIndexJson([], 'fs');
    expect(idx.count).toBe(0);
    expect(idx.notes).toEqual([]);
  });

  it('does not mutate the input array', async () => {
    const input = [noteA, noteB];
    const snapshot = [...input];
    await buildIndexJson(input, 'fs');
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(noteA);
  });
});

describe('buildIndexMarkdown', () => {
  it('emits a banner, metadata block, and a table row per note', () => {
    const md = buildIndexMarkdown([noteA, noteB], 'fs');
    expect(md).toContain('AUTO-GENERATED by Wren');
    expect(md).toContain('do not edit by hand');
    expect(md).toContain('- Notes: 2');
    expect(md).toContain('- Backend: fs');
    expect(md).toContain('| Updated | Title | Tags | Due | Summary | File | wrenId |');
    // Newest first.
    const betaIdx = md.indexOf('Beta');
    const alphaIdx = md.indexOf('Alpha');
    expect(betaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeLessThan(alphaIdx);
    // 2 data rows + 1 header + 1 divider = 4 table lines.
    expect(md.split('\n').filter((l) => l.startsWith('|')).length).toBe(4);
  });

  it('escapes pipes and collapses newlines so the table never breaks', () => {
    const tricky = {
      ...noteA,
      title: 'A | B',
      summary: 'line one\nline two: with colon | and pipe',
    };
    const md = buildIndexMarkdown([tricky], 'fs');
    const row = md.split('\n').find((l) => l.includes('wren-aaaa'));
    expect(row).toContain('A \\| B');
    expect(row).toContain('line one line two: with colon \\| and pipe');
    // Escaped pipes don't add real columns: 7 cols => 8 unescaped pipes.
    const unescaped = (row.match(/(?<!\\)\|/g) || []).length;
    expect(unescaped).toBe(8);
  });

  it('renders an empty folder as a valid header + "No notes yet."', () => {
    const md = buildIndexMarkdown([], 'drive');
    expect(md).toContain('# Wren Note Index');
    expect(md).toContain('- Notes: 0');
    expect(md).toContain('No notes yet.');
    expect(md).not.toContain('| Modified |');
  });
});
