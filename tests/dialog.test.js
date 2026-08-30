// @vitest-environment jsdom
//
// Audit blocker 3 (U4): Enter must not confirm a destructive dialog when focus
// is on the Cancel button. A focused Cancel + Enter used to fire the confirm
// (permanently deleting the note); it must cancel instead. Escape still cancels,
// and Enter on the default-focused Confirm still confirms.
import { describe, it, expect } from 'vitest';
import { confirmDialog } from '../src/ui/dialog.js';

function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function buttons() {
  return [...document.querySelectorAll('.sc-modal-actions button')];
}

describe('confirmDialog keyboard behavior', () => {
  it('Enter with the Cancel button focused resolves false (does NOT confirm)', async () => {
    const p = confirmDialog({
      title: 'Delete note?',
      message: 'x',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    const cancelBtn = buttons().find((b) => b.textContent === 'Cancel');
    cancelBtn.focus();
    expect(document.activeElement).toBe(cancelBtn);
    pressKey('Enter');
    await expect(p).resolves.toBe(false);
  });

  it('Enter with the Confirm button focused (the default) resolves true', async () => {
    const p = confirmDialog({ title: 'Delete note?', message: 'x', confirmLabel: 'Delete' });
    // confirmDialog focuses Confirm on open — do not move focus.
    pressKey('Enter');
    await expect(p).resolves.toBe(true);
  });

  it('Escape always cancels', async () => {
    const p = confirmDialog({ title: 'Delete note?', message: 'x' });
    pressKey('Escape');
    await expect(p).resolves.toBe(false);
  });
});
