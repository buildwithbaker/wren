// @vitest-environment jsdom
//
// Unit tests for the custom sticky title bar (src/sticky/titlebar.js). The bar
// only renders under Tauri (the browser PWA/extension keeps its native window
// chrome), shows the Wren logo with NO title text, is a drag region, and wires
// a close button.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildStickyTitleBar } from '../src/sticky/titlebar.js';

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('buildStickyTitleBar', () => {
  it('returns null outside Tauri (browser keeps native chrome)', () => {
    expect(window.__TAURI_INTERNALS__).toBeUndefined();
    expect(buildStickyTitleBar()).toBeNull();
    expect(buildStickyTitleBar({ onClose: () => {} })).toBeNull();
  });

  describe('under Tauri', () => {
    function build(opts) {
      window.__TAURI_INTERNALS__ = {};
      return buildStickyTitleBar(opts);
    }

    it('renders a drag-region bar so the frameless window can move', () => {
      const bar = build();
      expect(bar).not.toBeNull();
      expect(bar.classList.contains('sc-sticky-titlebar')).toBe(true);
      expect(bar.hasAttribute('data-tauri-drag-region')).toBe(true);
    });

    it('shows the Wren logo (the ./icon.svg mark) on the left', () => {
      const bar = build();
      const logo = bar.querySelector('img.sc-sticky-logo');
      expect(logo).not.toBeNull();
      expect(logo.getAttribute('src')).toBe('./icon.svg');
      expect(logo.getAttribute('alt')).toBe('Wren');
    });

    it('has NO title text anywhere in the bar', () => {
      const bar = build();
      // Only the (aria-hidden) close glyph; no human-readable title text.
      expect(bar.textContent.trim()).toBe('');
    });

    it('renders a close button that fires onClose', () => {
      const onClose = vi.fn();
      const bar = build({ onClose });
      const close = bar.querySelector('button.sc-sticky-close');
      expect(close).not.toBeNull();
      expect(close.getAttribute('aria-label')).toBe('Close window');
      // Close button must NOT be a drag region or clicks would move the window.
      expect(close.hasAttribute('data-tauri-drag-region')).toBe(false);
      close.click();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not throw when clicked with no onClose handler', () => {
      const bar = build();
      const close = bar.querySelector('button.sc-sticky-close');
      expect(() => close.click()).not.toThrow();
    });
  });
});
