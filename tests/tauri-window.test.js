// @vitest-environment jsdom
//
// Unit tests for the pure / storage bits of src/tauri-window.js. The Tauri-only
// functions (applyWindowSize, watchResize) no-op outside Tauri, so we only test
// the size-resolution and per-view slot persistence here.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  WINDOW_PRESETS,
  WINDOW_LS_KEYS,
  slotForView,
  resolveWindowSize,
  readRememberedSize,
  writeRememberedSize,
  applyWindowSize,
  watchResize,
} from '../src/tauri-window.js';

beforeEach(() => {
  localStorage.clear();
});

describe('slotForView', () => {
  it('maps compact to the compact slot', () => {
    expect(slotForView('compact')).toBe('compact');
  });
  it('maps every full mode to the expanded slot', () => {
    expect(slotForView('list')).toBe('expanded');
    expect(slotForView('kanban')).toBe('expanded');
    expect(slotForView('anything-else')).toBe('expanded');
  });
});

describe('resolveWindowSize', () => {
  it('returns the preset when there is no remembered size', () => {
    expect(resolveWindowSize('compact', null)).toEqual(WINDOW_PRESETS.compact);
    expect(resolveWindowSize('expanded', undefined)).toEqual(WINDOW_PRESETS.expanded);
  });
  it('returns the remembered size when present and valid', () => {
    expect(resolveWindowSize('compact', { w: 420, h: 900 })).toEqual({ w: 420, h: 900 });
  });
  it('rounds remembered fractional sizes', () => {
    expect(resolveWindowSize('expanded', { w: 1199.6, h: 820.4 })).toEqual({ w: 1200, h: 820 });
  });
  it('falls back to the preset for malformed remembered sizes', () => {
    expect(resolveWindowSize('compact', { w: 0, h: 780 })).toEqual(WINDOW_PRESETS.compact);
    expect(resolveWindowSize('compact', { w: NaN, h: 780 })).toEqual(WINDOW_PRESETS.compact);
    expect(resolveWindowSize('compact', { w: -10, h: -10 })).toEqual(WINDOW_PRESETS.compact);
    expect(resolveWindowSize('compact', {})).toEqual(WINDOW_PRESETS.compact);
  });
  it('does not return the same object reference as the preset (no mutation risk)', () => {
    const r = resolveWindowSize('compact', null);
    expect(r).not.toBe(WINDOW_PRESETS.compact);
  });
});

describe('readRememberedSize / writeRememberedSize round-trip', () => {
  it('persists per view independently', () => {
    writeRememberedSize('compact', { w: 400, h: 800 });
    writeRememberedSize('expanded', { w: 1300, h: 850 });
    expect(readRememberedSize('compact')).toEqual({ w: 400, h: 800 });
    expect(readRememberedSize('expanded')).toEqual({ w: 1300, h: 850 });
    // Uses the documented namespaced keys.
    expect(localStorage.getItem(WINDOW_LS_KEYS.compact)).toBe('{"w":400,"h":800}');
  });
  it('rounds before storing', () => {
    writeRememberedSize('compact', { w: 399.7, h: 779.2 });
    expect(readRememberedSize('compact')).toEqual({ w: 400, h: 779 });
  });
  it('returns null when nothing is stored', () => {
    expect(readRememberedSize('compact')).toBeNull();
  });
  it('returns null for corrupt stored JSON', () => {
    localStorage.setItem(WINDOW_LS_KEYS.expanded, 'not json{');
    expect(readRememberedSize('expanded')).toBeNull();
  });
  it('ignores invalid sizes on write', () => {
    writeRememberedSize('compact', { w: 0, h: 0 });
    expect(readRememberedSize('compact')).toBeNull();
  });
});

describe('Tauri-only functions no-op outside Tauri', () => {
  it('applyWindowSize resolves without touching a window API', async () => {
    expect(window.__TAURI_INTERNALS__).toBeUndefined();
    await expect(applyWindowSize('compact')).resolves.toBeUndefined();
  });
  it('watchResize returns a callable unlisten and writes nothing', async () => {
    const unlisten = await watchResize(() => 'compact');
    expect(typeof unlisten).toBe('function');
    expect(readRememberedSize('compact')).toBeNull();
  });
});
