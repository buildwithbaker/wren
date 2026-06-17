// @vitest-environment jsdom
//
// Unit tests for the pure label helper added in Phase 3b (Tauri stickies) and
// the Tauri WebviewWindow creation options. The label must be a valid Tauri v2
// label (/^[a-zA-Z0-9\-/:_]+$/) and dedupe by note identity; the window must be
// created WITHOUT native decorations (the sticky draws its own title bar) while
// keeping the always-on-top pin behavior.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stickyWindowLabel, openStickyTauri } from '../src/sticky/opener.js';

// Capture WebviewWindow constructions from the (mocked) Tauri API. Hoisted so
// the vi.mock factory below can reference it.
const tauri = vi.hoisted(() => ({ calls: [], existing: null }));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    constructor(label, options) {
      tauri.calls.push({ label, options });
      this.label = label;
    }
    once() {}
    async setFocus() {}
    static async getByLabel() {
      return tauri.existing;
    }
  },
}));

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

describe('openStickyTauri window options', () => {
  beforeEach(() => {
    tauri.calls.length = 0;
    tauri.existing = null;
  });

  it('creates the window WITHOUT native decorations (custom title bar)', async () => {
    await openStickyTauri({ id: 'n.md', wrenId: 'wren-1', title: 'Hello' });
    expect(tauri.calls).toHaveLength(1);
    expect(tauri.calls[0].options.decorations).toBe(false);
  });

  it('keeps the always-on-top pin behavior intact', async () => {
    await openStickyTauri({ id: 'n.md', wrenId: 'wren-1' });
    expect(tauri.calls[0].options.alwaysOnTop).toBe(true);
  });

  it('still sets the native window title (OS/taskbar), falling back to a default', async () => {
    await openStickyTauri({ id: 'n.md', wrenId: 'wren-1', title: 'My note' });
    expect(tauri.calls[0].options.title).toBe('My note');
    tauri.calls.length = 0;
    await openStickyTauri({ id: 'n2.md', wrenId: 'wren-2' });
    expect(tauri.calls[0].options.title).toBe('Wren note');
  });

  it('focuses an existing window instead of creating a duplicate', async () => {
    let focused = false;
    tauri.existing = { setFocus: async () => { focused = true; } };
    const result = await openStickyTauri({ id: 'n.md', wrenId: 'wren-1' });
    expect(focused).toBe(true);
    expect(tauri.calls).toHaveLength(0);
    expect(result).toBe(tauri.existing);
  });
});
