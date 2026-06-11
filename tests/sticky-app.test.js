// @vitest-environment jsdom
//
// Mount smoke test for the pop-out sticky shell (src/sticky-app.js). Verifies
// the boot route's entry wiring: createStickyApp marks the body sticky and,
// with no storage backend resolvable in this environment, lands on the "open
// the main app" fallback card instead of throwing. The interactive note-edit /
// multi-window flows require a real notes folder and a human (see the PR body).
import { describe, it, expect, beforeEach } from 'vitest';
import { createStickyApp } from '../src/sticky-app.js';

beforeEach(() => {
  document.body.className = '';
  document.body.replaceChildren();
});

describe('createStickyApp (sticky boot route)', () => {
  it('with a ?note= param: marks the body sticky and does not throw', () => {
    window.history.replaceState({}, '', '/?note=test.md&wid=wren-1');
    const root = document.createElement('div');
    document.body.appendChild(root);
    expect(() => createStickyApp({ root })).not.toThrow();
    expect(document.body.classList.contains('is-sticky')).toBe(true);
  });

  it('falls back to an "open the main app" card when no backend is configured', async () => {
    window.history.replaceState({}, '', '/?note=test.md&wid=wren-1');
    const root = document.createElement('div');
    document.body.appendChild(root);
    createStickyApp({ root });
    // Let the async boot settle (resolveBackend → null in this environment).
    await new Promise((r) => setTimeout(r, 50));
    expect(root.querySelector('.sc-sticky-screen')).not.toBeNull();
    expect(root.textContent).toContain('Open Wren');
  });

  it('with no ?note= param: renders a "no note" message, not the sticky chrome', () => {
    window.history.replaceState({}, '', '/');
    const root = document.createElement('div');
    document.body.appendChild(root);
    createStickyApp({ root });
    expect(document.body.classList.contains('is-sticky')).toBe(false);
    expect(root.textContent).toContain('No note specified');
  });
});
