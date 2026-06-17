// @vitest-environment jsdom
//
// Desktop quick-capture integration (Tauri). These tests run in the BROWSER
// environment (no window.__TAURI_INTERNALS__), so they verify the graceful
// degradation contract: setupDesktopIntegration() returns a disabled stub and
// never throws or touches a Tauri plugin in the web build. Plus the pure
// hotkey helpers.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  humanizeHotkey,
  getHotkey,
  DEFAULT_HOTKEYS,
  setupDesktopIntegration,
} from '../src/desktop.js';

describe('humanizeHotkey', () => {
  it('renders CmdOrCtrl as Ctrl', () => {
    expect(humanizeHotkey('CmdOrCtrl+Alt+N')).toBe('Ctrl+Alt+N');
    expect(humanizeHotkey('CommandOrControl+Alt+W')).toBe('Ctrl+Alt+W');
  });
  it('is empty-safe', () => {
    expect(humanizeHotkey('')).toBe('');
    expect(humanizeHotkey(undefined)).toBe('');
  });
});

describe('getHotkey defaults', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  it('falls back to the defaults when unset', () => {
    expect(getHotkey('newNote')).toBe(DEFAULT_HOTKEYS.newNote);
    expect(getHotkey('toggle')).toBe(DEFAULT_HOTKEYS.toggle);
  });
  it('returns a stored override', () => {
    localStorage.setItem('wren.hotkey.newNote', 'CmdOrCtrl+Shift+J');
    expect(getHotkey('newNote')).toBe('CmdOrCtrl+Shift+J');
  });
});

describe('default hotkey combos (the SOW non-conflicting picks)', () => {
  it('are Ctrl+Alt+N (new note) and Ctrl+Alt+W (show/hide)', () => {
    expect(humanizeHotkey(DEFAULT_HOTKEYS.newNote)).toBe('Ctrl+Alt+N');
    expect(humanizeHotkey(DEFAULT_HOTKEYS.toggle)).toBe('Ctrl+Alt+W');
  });
});

describe('setupDesktopIntegration in the browser (no Tauri)', () => {
  it('returns a disabled stub and never throws — no dead controls', async () => {
    expect(window.__TAURI_INTERNALS__).toBeUndefined();
    const api = await setupDesktopIntegration({ onNewNote: () => {} });
    expect(api.enabled).toBe(false);
    expect(api.warnings).toEqual([]);
    // The disabled stub exposes no desktop controls.
    expect(api.rebindHotkey).toBeUndefined();
    expect(api.setAutostart).toBeUndefined();
  });
});
