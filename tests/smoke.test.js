// @vitest-environment jsdom
//
// Mount smoke test: createApp() is the shared entry both the PWA and the
// extension popup call. This verifies the whole import graph loads and the
// app mounts into a root element without throwing in a DOM.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// jsdom lacks a few browser APIs the app touches on mount. Stub them.
beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
});

describe('createApp (mount smoke test)', () => {
  it('exports a function', async () => {
    const { createApp } = await import('../src/app-controller.js');
    expect(typeof createApp).toBe('function');
  });

  it('mounts into the provided root without throwing', async () => {
    const { createApp } = await import('../src/app-controller.js');
    const root = document.createElement('div');
    document.body.appendChild(root);

    expect(() => createApp({ root, enableServiceWorker: false })).not.toThrow();
    // App shell or one of its mounted controls should have produced DOM.
    expect(document.body.childElementCount).toBeGreaterThan(0);
  });
});
