// @vitest-environment jsdom
//
// Audit S15 (Low) — "Error UX is alert(); Ctrl+1/2/3 hijack browser tab
// switching". Two independent defects filed under one id, so two describes.
//
//  Part A — every failure path used a blocking window.alert(). alert() freezes
//      the page, cannot be styled or dismissed programmatically, reads badly on
//      mobile, and in the Tauri shell can render behind the window with no way
//      to reach it. Replaced with a visually distinct error toast.
//
//  Part B — Ctrl+1/2/3 were bound unconditionally. Those are the browser's own
//      tab-switch shortcuts. In an installed PWA or the desktop shell there is
//      no tab strip, so the binding costs nothing; in an ordinary tab it
//      silently takes a shortcut the user never agreed to give up. The binding
//      is now gated on the window actually being tabless.
//
// Both parts are mutation-verified — revert either fix and these fail. The
// recorded runs are in the commit message.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountApp, cleanupApp } from './helpers/mount-app.js';

// import.meta.url is an http: URL under the jsdom environment, so the usual
// new URL('../x', import.meta.url) trick throws here. Resolve from the Vitest
// root instead, and let a wrong path fail loudly rather than read as "clean".
function readSource(rel) {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

const NOTE = {
  id: '2026-07-01 - Groceries.md',
  wrenId: 'wren-groceriesxx',
  title: 'Groceries',
  body: 'milk',
  tags: [],
  created: '2026-07-01T00:00:00.000Z',
  modified: '2026-07-01T00:00:00.000Z',
};

let alertSpy;
let standalone;

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.resetModules();
  // jsdom's window.alert only logs "not implemented" to stderr — it does not
  // throw. An un-migrated alert() would therefore sail through unnoticed, so it
  // is stubbed with a spy that the assertions can actually see.
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);

  // Default every test to an ORDINARY BROWSER TAB. Part B turns on this being
  // explicit: a missing matchMedia would look the same as "not standalone" for
  // the wrong reason, and effectiveViewMode() calls matchMedia unguarded.
  standalone = false;
  vi.stubGlobal('matchMedia', (q) => ({
    media: q,
    matches: /display-mode:\s*(standalone|window-controls-overlay)/.test(q) ? standalone : false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanupApp();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Open the note and press Delete through the real UI, through to confirm. */
async function failADelete(app) {
  await app.openNote(NOTE.id);
  app.adapter.deleteNote = () => Promise.reject(new Error('disk gone'));

  const del = document.querySelector('[aria-label="Delete note"]');
  if (!del) throw new Error('no delete button — did the editor mount?');
  del.click();

  const confirmBtn = await app.waitFor(() =>
    document.querySelector('.sc-modal-actions .sc-btn--danger')
  );
  confirmBtn.click();
}

describe('S15a — failures surface as an error toast, never a blocking alert()', () => {
  it('shows an error toast when a delete fails, and calls no alert()', async () => {
    const app = await mountApp({ notes: [NOTE] });
    await failADelete(app);

    const toast = await app.waitFor(() => document.querySelector('.sc-toast-error'), {
      timeout: 4000,
    });

    // The whole of S15a. With the alert() still in place the toast never
    // appears and alertSpy has been called in its stead.
    expect(alertSpy).not.toHaveBeenCalled();
    expect(toast).toBeTruthy();
    expect(toast.textContent).toBe('Could not delete the note.');
  });

  it('marks the error toast as an alert so it is announced immediately', async () => {
    const app = await mountApp({ notes: [NOTE] });
    await failADelete(app);
    const toast = await app.waitFor(() => document.querySelector('.sc-toast-error'), {
      timeout: 4000,
    });

    // The toast stack is aria-live="polite" (audit U21) so ordinary toasts wait
    // for a pause. A failure must not wait, so the error toast carries its own
    // role="alert" instead of inheriting the stack's politeness.
    expect(toast.getAttribute('role')).toBe('alert');
    expect(document.querySelector('.sc-toast-stack').getAttribute('aria-live')).toBe('polite');
  });

  it('leaves no window.alert( call anywhere in the controller', () => {
    // Deliberately a source assertion. The behavioural test above covers the
    // delete path, but S15 is about all nine of them, and driving every failure
    // path (archive, unarchive, promote, discard, create, two folder picks,
    // popup-blocked) through the UI would cost far more than it proves.
    const code = readSource('src/app-controller.js')
      // Strip comments first — the file legitimately *discusses* alert() in the
      // notes explaining why it was removed, and matching those would make this
      // test permanently red for the wrong reason.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code.match(/(?<![.\w])alert\s*\(/g) || []).toEqual([]);
  });

  it('styles the error toast distinctly from an ordinary one', () => {
    const rule = /\.sc-toast-error\s*\{([^}]*)\}/.exec(readSource('src/styles/style.css'));
    // A failure that looks exactly like "Saved" is the bug half-fixed.
    expect(rule).toBeTruthy();
    expect(rule[1]).toMatch(/border-left/);
  });
});

describe('S15b — Ctrl+1/2/3 is bound only where there is no tab strip to hijack', () => {
  it('does NOT switch view on Ctrl+2 in an ordinary browser tab', async () => {
    standalone = false;
    const app = await mountApp({ notes: [NOTE] });
    const before = app.app.dataset.viewmode;

    const e = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, cancelable: true });
    window.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 60));

    // Leaving defaultPrevented false IS the fix: the browser has to keep
    // receiving the keystroke so it can switch to tab 2.
    expect(e.defaultPrevented).toBe(false);
    expect(app.app.dataset.viewmode).toBe(before);
  });

  it('DOES switch view on Ctrl+2 in an installed standalone window', async () => {
    standalone = true;
    const app = await mountApp({ notes: [NOTE] });

    const e = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, cancelable: true });
    window.dispatchEvent(e);
    await app.waitFor(() => app.app.dataset.viewmode === 'kanban', { timeout: 2000 });

    // The gate must not have thrown the feature away — it still works for the
    // people who actually use it.
    expect(e.defaultPrevented).toBe(true);
    expect(app.app.dataset.viewmode).toBe('kanban');
  });

  it('DOES switch view inside the Tauri desktop shell', async () => {
    standalone = false;
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const app = await mountApp({ notes: [NOTE] });

    const e = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, cancelable: true });
    window.dispatchEvent(e);
    await app.waitFor(() => app.app.dataset.viewmode === 'kanban', { timeout: 2000 });

    expect(e.defaultPrevented).toBe(true);
  });
});
