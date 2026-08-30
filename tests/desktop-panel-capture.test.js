// @vitest-environment jsdom
//
// Audit R2-3 (U16): closing the shortcuts dialog while a hotkey capture is armed
// ("Press keys…") must remove the document-level capture keydown listener —
// otherwise it outlives the dialog and swallows every keystroke.
import { describe, it, expect, afterEach } from 'vitest';
import { openShortcutsDialog } from '../src/ui/desktop-panel.js';

afterEach(() => {
  document.querySelectorAll('.sc-overlay').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

function mockDesktop() {
  return {
    enabled: true,
    warnings: [],
    getHotkey: () => 'CmdOrCtrl+Shift+N',
    rebindHotkey: async () => true,
    isAutostartEnabled: async () => false,
    setAutostart: async () => true,
  };
}

describe('shortcuts dialog capture cleanup', () => {
  it('removes the capture listener when the dialog closes mid-capture', () => {
    openShortcutsDialog({ desktop: mockDesktop() });

    // Arm a capture on the first rebindable hotkey.
    const changeBtn = document.querySelector('.sc-rebind-btn');
    expect(changeBtn).toBeTruthy();
    changeBtn.click();
    expect(changeBtn.textContent).toMatch(/Press keys/i);

    // While armed, a keystroke is captured (preventDefaulted) — proving the
    // document capture listener is live.
    const armed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    document.dispatchEvent(armed);
    expect(armed.defaultPrevented).toBe(true);

    // Close the dialog via its Done button.
    const done = [...document.querySelectorAll('.sc-modal-actions button')].find(
      (b) => /done/i.test(b.textContent)
    );
    expect(done).toBeTruthy();
    done.click();
    expect(document.querySelector('.sc-overlay')).toBeNull();

    // The capture listener must be gone now: a keystroke passes through untouched.
    const after = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    document.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
