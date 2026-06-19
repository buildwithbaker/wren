// Unit tests for the sidebar sort comparators (src/ui/note-sort.js).
// Pure logic — no DOM. Covers each option and the "no due date sorts last" rule.
import { describe, it, expect } from 'vitest';
import { sortNotes, DEFAULT_SORT, SORT_OPTIONS } from '../src/ui/note-sort.js';

const ids = (notes) => notes.map((n) => n.id);

describe('sortNotes', () => {
  const a = { id: 'a', title: 'Banana', created: '2026-01-01T00:00:00.000Z', modified: '2026-03-01T00:00:00.000Z', due: '2026-06-10' };
  const b = { id: 'b', title: 'apple', created: '2026-02-01T00:00:00.000Z', modified: '2026-01-15T00:00:00.000Z', due: '2026-06-01' };
  const c = { id: 'c', title: 'Cherry', created: '2026-01-15T00:00:00.000Z', modified: '2026-02-10T00:00:00.000Z', due: '' };
  const input = [a, b, c];

  it('does not mutate the input array', () => {
    const copy = [...input];
    sortNotes(input, 'title');
    expect(input).toEqual(copy);
  });

  it('modified — newest first (default)', () => {
    expect(ids(sortNotes(input, 'modified'))).toEqual(['a', 'c', 'b']);
  });

  it('created — newest first', () => {
    expect(ids(sortNotes(input, 'created'))).toEqual(['b', 'c', 'a']);
  });

  it('title — A–Z, case-insensitive', () => {
    expect(ids(sortNotes(input, 'title'))).toEqual(['b', 'a', 'c']); // apple, Banana, Cherry
  });

  it('due — soonest first, and notes with NO due date sort last', () => {
    const out = sortNotes(input, 'due');
    expect(ids(out)).toEqual(['b', 'a', 'c']); // 06-01, 06-10, then the no-due note
    expect(out[out.length - 1].id).toBe('c'); // no-due note is last
  });

  it('multiple no-due notes both sort after dated notes', () => {
    const d = { id: 'd', title: 'D', due: '' };
    const out = sortNotes([d, a, c, b], 'due');
    // dated notes (b=06-01, a=06-10) first; the two no-due notes (c, d) last
    expect(ids(out).slice(0, 2)).toEqual(['b', 'a']);
    expect(ids(out).slice(2).sort()).toEqual(['c', 'd']);
  });

  it('unknown sortBy falls back to the default (modified)', () => {
    expect(ids(sortNotes(input, 'nope'))).toEqual(ids(sortNotes(input, DEFAULT_SORT)));
  });

  it('handles empty / missing input', () => {
    expect(sortNotes([], 'title')).toEqual([]);
    expect(sortNotes(undefined, 'title')).toEqual([]);
  });

  it('SORT_OPTIONS includes the four documented options', () => {
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual(['modified', 'due', 'created', 'title']);
  });
});
