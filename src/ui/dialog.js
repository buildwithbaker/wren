// dialog.js - minimal accessible confirm modal. Returns a Promise<boolean>.

export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    // Remember what had focus so we can restore it on close (WCAG SC 2.4.3).
    const lastFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'sc-overlay';

    const modal = document.createElement('div');
    modal.className = 'sc-modal';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');

    const h = document.createElement('h2');
    h.className = 'sc-modal-title';
    h.textContent = title;

    const p = document.createElement('p');
    p.className = 'sc-modal-body';
    p.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'sc-modal-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'sc-btn sc-btn--ghost';
    cancel.textContent = cancelLabel;

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'sc-btn ' + (danger ? 'sc-btn--danger' : 'sc-btn--primary');
    confirm.textContent = confirmLabel;

    actions.append(cancel, confirm);
    modal.append(h, p, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    confirm.focus();

    function cleanup(result) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (lastFocused && typeof lastFocused.focus === 'function') {
        try {
          lastFocused.focus();
        } catch {
          /* element gone from the DOM — nothing to restore */
        }
      }
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    }
    cancel.addEventListener('click', () => cleanup(false));
    confirm.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });
    document.addEventListener('keydown', onKey);
  });
}
