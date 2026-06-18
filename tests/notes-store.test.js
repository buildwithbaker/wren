// Smoke + unit tests for the pure note logic in src/notes-store.js.
// These are the load-bearing transforms (parse/serialize/filename/preview);
// they run in plain Node with no DOM.
import { describe, it, expect } from 'vitest';
import {
  serializeNote,
  parseNote,
  firstLineOf,
  slugify,
  buildNoteFilename,
  uniqueNoteName,
  generateNoteId,
  isReservedNoteName,
} from '../src/notes-store.js';

describe('serializeNote / parseNote round-trip', () => {
  it('preserves title (incl. colon), body, and tags', () => {
    const note = {
      title: 'Hello: World',
      body: '# Heading\n\nbody text',
      color: 'default',
      created: '2026-01-02T03:04:05.000Z',
      modified: '2026-01-02T03:04:05.000Z',
      tags: ['status:todo', 'important'],
    };
    const text = serializeNote(note);
    const parsed = parseNote(text, 'note.md');

    expect(parsed.title).toBe('Hello: World');
    expect(parsed.tags).toEqual(['status:todo', 'important']);
    expect(parsed.created).toBe('2026-01-02T03:04:05.000Z');
    expect(parsed.body).toContain('# Heading');
    expect(parsed.body.trim().endsWith('body text')).toBe(true);
    expect(typeof parsed.color).toBe('string');
  });

  it('omits the tags line entirely when there are no tags', () => {
    const text = serializeNote({ title: 'x', body: 'b', created: '', modified: '' });
    expect(text).not.toMatch(/\ntags:/);
    expect(parseNote(text, 'x.md').tags).toEqual([]);
  });

  it('fills missing timestamps with a valid ISO string', () => {
    const parsed = parseNote('no frontmatter here', 'plain.md');
    expect(parsed.title).toBe('');
    expect(parsed.body).toBe('no frontmatter here');
    expect(() => new Date(parsed.created).toISOString()).not.toThrow();
  });
});

describe('provenance (created_by / last_edited_by / last_edited)', () => {
  const fm = (extra) =>
    `---\nid: wren-abc\ntitle: "T"\ncreated: 2026-01-01T00:00:00.000Z\nmodified: 2026-01-02T00:00:00.000Z\n${extra}---\n\nbody`;

  it('parses present provenance fields', () => {
    const parsed = parseNote(
      fm('created_by: ai\nlast_edited_by: human\nlast_edited: 2026-01-03T00:00:00.000Z\n'),
      'n.md'
    );
    expect(parsed.createdBy).toBe('ai');
    expect(parsed.lastEditedBy).toBe('human');
    expect(parsed.lastEdited).toBe('2026-01-03T00:00:00.000Z');
  });

  it('absent provenance parses to empty strings (legacy notes, never a badge)', () => {
    const parsed = parseNote(fm(''), 'n.md');
    expect(parsed.createdBy).toBe('');
    expect(parsed.lastEditedBy).toBe('');
    expect(parsed.lastEdited).toBe('');
  });

  it('rejects out-of-vocabulary *_by values (only ai|human are kept)', () => {
    const parsed = parseNote(fm('created_by: robot\nlast_edited_by: bot\n'), 'n.md');
    expect(parsed.createdBy).toBe('');
    expect(parsed.lastEditedBy).toBe('');
  });

  it('serialize writes provenance only when present', () => {
    const withProv = serializeNote({
      title: 'x',
      body: 'b',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      createdBy: 'ai',
      lastEditedBy: 'human',
      lastEdited: '2026-01-03T00:00:00.000Z',
    });
    expect(withProv).toMatch(/\ncreated_by: ai\n/);
    expect(withProv).toMatch(/\nlast_edited_by: human\n/);
    expect(withProv).toMatch(/\nlast_edited: 2026-01-03T00:00:00.000Z\n/);

    const without = serializeNote({ title: 'x', body: 'b', created: '', modified: '' });
    expect(without).not.toMatch(/created_by:/);
    expect(without).not.toMatch(/last_edited_by:/);
    expect(without).not.toMatch(/\nlast_edited:/);
  });

  it('round-trips provenance through serialize -> parse (no stripping on save)', () => {
    const text = serializeNote({
      title: 'AI note',
      body: 'body',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-02T00:00:00.000Z',
      createdBy: 'ai',
      lastEditedBy: 'ai',
      lastEdited: '2026-01-02T00:00:00.000Z',
    });
    const parsed = parseNote(text, 'ai.md');
    expect(parsed.createdBy).toBe('ai');
    expect(parsed.lastEditedBy).toBe('ai');
    expect(parsed.lastEdited).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('firstLineOf', () => {
  it('strips a heading marker', () => {
    expect(firstLineOf('# My Title\n\nrest')).toBe('My Title');
  });
  it('strips a bullet marker', () => {
    expect(firstLineOf('- a bullet')).toBe('a bullet');
  });
  it('skips leading blank lines', () => {
    expect(firstLineOf('\n\n   \nfirst real line')).toBe('first real line');
  });
  it('returns empty string for empty input', () => {
    expect(firstLineOf('')).toBe('');
    expect(firstLineOf('   \n  ')).toBe('');
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });
  it('trims leading/trailing separators', () => {
    expect(slugify('  --Wow!!  ')).toBe('wow');
  });
  it('falls back to "untitled" for empty/symbol-only input', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
  });
  it('caps length at 40 chars', () => {
    expect(slugify('a'.repeat(100)).length).toBe(40);
  });
});

describe('buildNoteFilename', () => {
  it('formats "YYYY-MM-DD - <title>.md"', () => {
    expect(buildNoteFilename('2026-01-02T03:04:05.000Z', 'My Note')).toBe(
      '2026-01-02 - My Note.md'
    );
  });
  it('replaces filesystem-illegal characters', () => {
    expect(buildNoteFilename('2026-01-02', 'a/b:c*?"<>|d')).toBe('2026-01-02 - a b c d.md');
  });
  it('defaults an empty title to "Untitled"', () => {
    expect(buildNoteFilename('2026-01-02', '   ')).toBe('2026-01-02 - Untitled.md');
  });
  it('falls back to today for an unparseable date', () => {
    expect(buildNoteFilename('not-a-date', 'x')).toMatch(/^\d{4}-\d{2}-\d{2} - x\.md$/);
  });
});

describe('uniqueNoteName', () => {
  it('returns the name unchanged when it is free', async () => {
    const out = await uniqueNoteName('a.md', () => false);
    expect(out).toBe('a.md');
  });
  it('appends " (2)" before the extension on collision', async () => {
    const taken = new Set(['a.md']);
    const out = await uniqueNoteName('a.md', (n) => taken.has(n));
    expect(out).toBe('a (2).md');
  });
  it('supports an async nameExists predicate', async () => {
    const taken = new Set(['a.md', 'a (2).md']);
    const out = await uniqueNoteName('a.md', async (n) => taken.has(n));
    expect(out).toBe('a (3).md');
  });
});

describe('generateNoteId', () => {
  it('returns "wren-" + 12 base36 chars', () => {
    expect(generateNoteId()).toMatch(/^wren-[0-9a-z]{12}$/);
  });
  it('is (practically) unique across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateNoteId()));
    expect(ids.size).toBe(1000);
  });
});

describe('AI-readable frontmatter fields (id / summary / due)', () => {
  const baseNote = () => ({
    filename: 'n.md',
    title: 'Note',
    body: 'body',
    color: 'default',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    tags: [],
  });

  it('stamps a wrenId on first serialize and writes the id: line', () => {
    const note = baseNote();
    expect(note.wrenId).toBeUndefined();
    const text = serializeNote(note);
    expect(note.wrenId).toMatch(/^wren-[0-9a-z]{12}$/);
    expect(text).toContain(`id: ${note.wrenId}`);
  });

  it('keeps an existing wrenId stable across re-serialize (never regenerates)', () => {
    const note = { ...baseNote(), wrenId: 'wren-abc123def456' };
    serializeNote(note);
    expect(note.wrenId).toBe('wren-abc123def456');
    expect(serializeNote(note)).toContain('id: wren-abc123def456');
  });

  it('round-trips id, summary, and due (summary with a colon survives)', () => {
    const note = {
      ...baseNote(),
      wrenId: 'wren-aaaaaaaaaaaa',
      summary: 'Meeting recap: discuss Q3 plans, 2:1 vote',
      due: '2026-06-15T09:30:00.000Z',
    };
    const parsed = parseNote(serializeNote(note), 'n.md');
    expect(parsed.wrenId).toBe('wren-aaaaaaaaaaaa');
    expect(parsed.summary).toBe('Meeting recap: discuss Q3 plans, 2:1 vote');
    expect(parsed.due).toBe('2026-06-15T09:30:00.000Z');
  });

  it('writes NO summary/due/tags lines when they are empty/absent', () => {
    const text = serializeNote(baseNote());
    expect(text).not.toMatch(/\nsummary:/);
    expect(text).not.toMatch(/\ndue:/);
    expect(text).not.toMatch(/\ntags:/);
  });

  it('parse stays read-only: an id-less note parses to wrenId "" (no generation)', () => {
    const parsed = parseNote('---\ntitle: x\n---\nbody', 'old.md');
    expect(parsed.wrenId).toBe('');
    expect(parsed.summary).toBe('');
    expect(parsed.due).toBe('');
  });

  it('field order is id, title, created, modified, color, due, summary, tags', () => {
    const note = {
      ...baseNote(),
      wrenId: 'wren-bbbbbbbbbbbb',
      color: 'amber',
      due: '2026-06-15',
      summary: 'hi',
      tags: ['project:wren'],
    };
    const keys = serializeNote(note)
      .split('\n')
      .filter((l) => /^[a-z]+:/.test(l))
      .map((l) => l.slice(0, l.indexOf(':')));
    expect(keys).toEqual(['id', 'title', 'created', 'modified', 'color', 'due', 'summary', 'tags']);
  });
});

describe('isReservedNoteName', () => {
  it('flags Wren-managed files', () => {
    expect(isReservedNoteName('_index.md')).toBe(true);
    expect(isReservedNoteName('tasks.md')).toBe(true);
  });
  it('leaves normal notes alone', () => {
    expect(isReservedNoteName('2026-05-31 - My Note.md')).toBe(false);
    expect(isReservedNoteName(undefined)).toBe(false);
  });
});
