// @vitest-environment jsdom
//
// The formatting-bar collapse default (2026-09-19). A pop-out sticky is small
// and is opened to write in, so its bar starts COLLAPSED; the main editor keeps
// its original expanded-by-default behavior. The two surfaces use separate
// localStorage keys so toggling one never moves the other, and an explicitly
// stored value always beats the default.
import { describe, it, expect } from 'vitest';
import { formatCollapsedKey, initialFormatCollapsed } from '../src/ui/note-editor.js';

describe('formatCollapsedKey', () => {
  it('gives pop-out stickies their own key', () => {
    expect(formatCollapsedKey(true)).toBe('wren.sticky.formatCollapsed');
  });

  it('leaves the main editor on the original key', () => {
    expect(formatCollapsedKey(false)).toBe('wren.formatCollapsed');
  });

  it('never returns the same key for both surfaces', () => {
    expect(formatCollapsedKey(true)).not.toBe(formatCollapsedKey(false));
  });
});

describe('initialFormatCollapsed', () => {
  it('starts a sticky collapsed when nothing is stored', () => {
    expect(initialFormatCollapsed(true, null)).toBe(true);
    expect(initialFormatCollapsed(true, undefined)).toBe(true);
  });

  it('starts the main editor expanded when nothing is stored', () => {
    expect(initialFormatCollapsed(false, null)).toBe(false);
    expect(initialFormatCollapsed(false, undefined)).toBe(false);
  });

  it('lets an explicitly stored value beat the default, in both directions', () => {
    // A sticky the user expanded stays expanded.
    expect(initialFormatCollapsed(true, 'false')).toBe(false);
    // A main editor the user collapsed stays collapsed.
    expect(initialFormatCollapsed(false, 'true')).toBe(true);
  });

  it('treats any non-"true" stored string as expanded', () => {
    expect(initialFormatCollapsed(true, 'garbage')).toBe(false);
    expect(initialFormatCollapsed(true, '')).toBe(false);
  });

  it('coerces a missing sticky flag to a boolean rather than returning undefined', () => {
    expect(initialFormatCollapsed(undefined, null)).toBe(false);
  });
});
