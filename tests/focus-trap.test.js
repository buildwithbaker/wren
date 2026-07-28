// @vitest-environment jsdom
//
// Audit R2-3 (U10/U11): while a modal overlay is open the rest of the page must
// be inert (so Tab/click can't escape it), and global shortcuts must see a modal
// is open so they stand down.
import { describe, it, expect, afterEach } from 'vitest';
import { lockPageExcept, isModalOpen } from '../src/ui/focus-trap.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focus-trap', () => {
  it('makes sibling content inert while the overlay stays interactive, and restores on unlock', () => {
    const app = document.createElement('div');
    app.id = 'app';
    const overlay = document.createElement('div');
    overlay.className = 'sc-overlay';
    document.body.append(app, overlay);

    const unlock = lockPageExcept(overlay);
    expect(app.inert).toBe(true);
    expect(overlay.inert).toBeFalsy(); // never touched (jsdom leaves it unset)

    unlock();
    expect(app.inert).toBe(false);
  });

  it('does not clear inert on an element it did not set (nested modals)', () => {
    const already = document.createElement('div');
    already.inert = true; // e.g. inert-ed by an outer modal
    const overlay = document.createElement('div');
    overlay.className = 'sc-overlay';
    document.body.append(already, overlay);

    const unlock = lockPageExcept(overlay);
    unlock();
    expect(already.inert).toBe(true); // left exactly as we found it
  });

  it('isModalOpen tracks overlay presence', () => {
    expect(isModalOpen()).toBe(false);
    const o = document.createElement('div');
    o.className = 'sc-overlay';
    document.body.appendChild(o);
    expect(isModalOpen()).toBe(true);
    o.remove();
    expect(isModalOpen()).toBe(false);
  });
});
