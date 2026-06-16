// @vitest-environment jsdom
//
// Unit tests for src/platform.js. T1 only verifies the probe's shape:
// isTauri() is a function that returns a boolean. (T2 will branch on it.)
import { describe, it, expect, afterEach } from 'vitest';
import { isTauri } from '../src/platform.js';

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('isTauri', () => {
  it('is a function', () => {
    expect(typeof isTauri).toBe('function');
  });

  it('returns a boolean', () => {
    expect(typeof isTauri()).toBe('boolean');
  });

  it('is false in a plain browser environment (no Tauri global)', () => {
    expect(isTauri()).toBe(false);
  });

  it('is true when the Tauri internals global is present', () => {
    window.__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
  });
});
