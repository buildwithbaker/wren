// Unit tests for the shared note text-search predicate in src/ui/note-search.js.
// This predicate is reused by both the sidebar list and the compact view, so it
// must match on title + start-of-note preview (firstLine), case-insensitively.
import { describe, it, expect } from 'vitest';
import { noteMatchesQuery } from '../src/ui/note-search.js';

const NOTE = { title: 'Grocery List', firstLine: 'Milk, eggs, and BREAD' };

describe('noteMatchesQuery', () => {
  it('matches everything when the query is empty/whitespace/undefined', () => {
    expect(noteMatchesQuery(NOTE, '')).toBe(true);
    expect(noteMatchesQuery(NOTE, '   ')).toBe(true);
    expect(noteMatchesQuery(NOTE, undefined)).toBe(true);
  });

  it('matches on the title, case-insensitively', () => {
    expect(noteMatchesQuery(NOTE, 'grocery')).toBe(true);
    expect(noteMatchesQuery(NOTE, 'GROCERY')).toBe(true);
    expect(noteMatchesQuery(NOTE, 'List')).toBe(true);
  });

  it('matches on the firstLine preview, case-insensitively', () => {
    expect(noteMatchesQuery(NOTE, 'eggs')).toBe(true);
    expect(noteMatchesQuery(NOTE, 'bread')).toBe(true); // preview is uppercased
  });

  it('trims surrounding whitespace before matching', () => {
    expect(noteMatchesQuery(NOTE, '  milk  ')).toBe(true);
  });

  it('does not match when the query is absent from both fields', () => {
    expect(noteMatchesQuery(NOTE, 'spreadsheet')).toBe(false);
  });

  it('tolerates missing title/firstLine fields', () => {
    expect(noteMatchesQuery({}, 'anything')).toBe(false);
    expect(noteMatchesQuery({ title: 'Only title' }, 'only')).toBe(true);
    expect(noteMatchesQuery({ firstLine: 'only preview' }, 'preview')).toBe(true);
    expect(noteMatchesQuery(undefined, 'x')).toBe(false);
    expect(noteMatchesQuery(undefined, '')).toBe(true);
  });
});
