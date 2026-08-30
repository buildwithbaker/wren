// @vitest-environment jsdom
//
// Regression (audit T3, E3, U21, 2026-07-25).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8'));

describe('Window minimum sizes (T3)', () => {
  it('the main window cannot be resized below a usable size', () => {
    const conf = readJson('src-tauri/tauri.conf.json');
    const main = conf.app.windows[0];
    expect(main.resizable).toBe(true);
    expect(main.minWidth).toBeGreaterThanOrEqual(320);
    expect(main.minHeight).toBeGreaterThanOrEqual(360);
    expect(main.minWidth).toBeLessThanOrEqual(main.width);
    expect(main.minHeight).toBeLessThanOrEqual(main.height);
  });

  it('sticky windows pass a minimum size to WebviewWindow', async () => {
    // A sticky is decorations:false, so it has no OS frame to stop a drag —
    // without a floor it can shrink past its own 32px title bar and lose its
    // close button.
    const src = readFileSync(resolve(repoRoot, 'src/sticky/opener.js'), 'utf8');
    expect(src).toMatch(/minWidth:\s*MIN_W/);
    expect(src).toMatch(/minHeight:\s*MIN_H/);
    const w = Number(/const MIN_W = (\d+);/.exec(src)[1]);
    const h = Number(/const MIN_H = (\d+);/.exec(src)[1]);
    // Must clear the sticky title bar (32px) with room for content.
    expect(h).toBeGreaterThan(32);
    expect(w).toBeGreaterThanOrEqual(200);
  });
});

describe('Extension minimum Chrome version (E3)', () => {
  it('is at least the showDirectoryPicker({mode:"readwrite"}) floor', () => {
    const manifest = readJson('extension/public/manifest.json');
    // Wren's whole storage model is showDirectoryPicker with mode:'readwrite'.
    // That option landed in Chrome 105; the manifest claimed 86, which let the
    // extension install on browsers where the app cannot work at all.
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(105);
  });
});

describe('getStoredTheme survives blocked storage (U21)', () => {
  let originalStorage;

  beforeEach(() => {
    originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
  });

  afterEach(() => {
    if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage);
    vi.resetModules();
  });

  it('falls back to "system" instead of throwing when getItem throws', async () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new DOMException('Access denied', 'SecurityError');
        },
        setItem() {
          throw new DOMException('Access denied', 'SecurityError');
        },
        removeItem() {
          throw new DOMException('Access denied', 'SecurityError');
        },
      },
    });
    vi.resetModules();
    const { getStoredTheme, setStoredTheme } = await import('../src/theme.js');
    expect(() => getStoredTheme()).not.toThrow();
    expect(getStoredTheme()).toBe('system');
    // A blocked write must not break the toggle — the theme still applies for
    // this session, it just doesn't survive a reload.
    expect(() => setStoredTheme('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('Toast stacking (U21)', () => {
  it('stacks toasts in a shared layer that sits above the modal scrim', () => {
    const css = readFileSync(resolve(repoRoot, 'src/styles/style.css'), 'utf8');
    const stack = /\.sc-toast-stack\s*\{([^}]*)\}/.exec(css)[1];
    const overlay = /\.sc-overlay\s*\{([^}]*)\}/.exec(css)[1];
    const zOf = (block) => Number(/z-index:\s*(\d+)/.exec(block)[1]);
    // A toast fired while a dialog is open used to render behind the scrim.
    expect(zOf(stack)).toBeGreaterThan(zOf(overlay));
    // Stacked, not overlapping: the layer is a flex column with a gap.
    expect(stack).toMatch(/flex-direction:\s*column/);
    expect(stack).toMatch(/gap:/);
    // The individual toast no longer positions itself.
    const toast = /\n\.sc-toast\s*\{([^}]*)\}/.exec(css)[1];
    expect(toast).not.toMatch(/position:\s*fixed/);
  });
});
