// Unit tests for the pure label helper added in Phase 3b (Tauri stickies).
// The Tauri WebviewWindow label must be a valid Tauri v2 label
// (/^[a-zA-Z0-9\-/:_]+$/) and must dedupe by note identity.
import { describe, it, expect } from 'vitest';
import { stickyWindowLabel } from '../src/sticky/opener.js';

describe('stickyWindowLabel', () => {
  it('keys by wrenId when present', () => {
    expect(stickyWindowLabel('wren-b4vxch1izbo8', '2026-06-15 - Hello.md')).toBe(
      'sticky-wren-b4vxch1izbo8'
    );
  });

  it('falls back to the storage id when there is no wrenId', () => {
    expect(stickyWindowLabel('', 'note1.md')).toBe('sticky-note1_md');
  });

  it('sanitizes characters illegal in a Tauri label (spaces, dots, @)', () => {
    const label = stickyWindowLabel('', '2026-06-15 - Hello@.md');
    // Spaces, '@' and '.' → '_'; the hyphen is a legal label char and is kept.
    expect(label).toBe('sticky-2026-06-15_-_Hello__md');
    // Whole label matches the Tauri v2 label grammar.
    expect(label).toMatch(/^[a-zA-Z0-9\-/:_]+$/);
  });

  it('produces a grammar-valid label even for empty input', () => {
    const label = stickyWindowLabel('', '');
    expect(label).toBe('sticky-');
    expect(label).toMatch(/^[a-zA-Z0-9\-/:_]+$/);
  });

  it('distinct notes get distinct labels (dedupe key)', () => {
    expect(stickyWindowLabel('wren-aaa', 'x')).not.toBe(stickyWindowLabel('wren-bbb', 'x'));
  });
});
