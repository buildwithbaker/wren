// Unit tests for the tag grammar in src/tags/tag-parser.js.
import { describe, it, expect } from 'vitest';
import { parseTag, isValidTag, getAllNamespaces } from '../src/tags/tag-parser.js';

describe('parseTag', () => {
  it('splits a namespaced tag on the first colon', () => {
    expect(parseTag('status:todo')).toEqual({
      namespace: 'status',
      value: 'todo',
      raw: 'status:todo',
    });
  });
  it('defaults un-namespaced tags to _uncategorized', () => {
    expect(parseTag('important')).toEqual({
      namespace: '_uncategorized',
      value: 'important',
      raw: 'important',
    });
  });
  it('keeps colons after the first inside the value', () => {
    expect(parseTag('link:https://example.com')).toEqual({
      namespace: 'link',
      value: 'https://example.com',
      raw: 'link:https://example.com',
    });
  });
  it('returns null for empty, whitespace, or non-string input', () => {
    expect(parseTag('')).toBeNull();
    expect(parseTag('   ')).toBeNull();
    expect(parseTag(42)).toBeNull();
    expect(parseTag(null)).toBeNull();
  });
});

describe('isValidTag', () => {
  it('accepts a well-formed tag', () => {
    expect(isValidTag('status:todo')).toBe(true);
    expect(isValidTag('important')).toBe(true);
  });
  it('rejects leading/trailing whitespace', () => {
    expect(isValidTag(' status:todo')).toBe(false);
  });
  it('rejects newlines and double-quotes (would break frontmatter JSON)', () => {
    expect(isValidTag('a"b')).toBe(false);
    expect(isValidTag('a\nb')).toBe(false);
  });
  it('rejects an empty value', () => {
    expect(isValidTag('')).toBe(false);
    expect(isValidTag('ns:')).toBe(false);
  });
});

describe('getAllNamespaces', () => {
  it('returns sorted, de-duplicated namespaces', () => {
    const notes = [
      { tags: ['status:todo', 'priority:high'] },
      { tags: ['status:done', 'important'] },
      { tags: [] },
      {},
    ];
    expect(getAllNamespaces(notes)).toEqual([
      '_uncategorized',
      'priority',
      'status',
    ]);
  });
  it('handles empty / nullish input', () => {
    expect(getAllNamespaces([])).toEqual([]);
    expect(getAllNamespaces(null)).toEqual([]);
  });
});
