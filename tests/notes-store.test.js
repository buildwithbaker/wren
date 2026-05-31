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
