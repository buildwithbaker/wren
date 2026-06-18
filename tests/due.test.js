// Tests for the pure due-date helpers (Note Lifecycle, Part A). A fixed "now"
// (local June 17, 2026) keeps the classification deterministic.
import { describe, it, expect } from 'vitest';
import { dueStatus, normalizeDue, formatDueLabel, isDueOrOverdue, todayStr } from '../src/due.js';

const NOW = new Date(2026, 5, 17); // local 2026-06-17

describe('normalizeDue', () => {
  it('keeps a bare YYYY-MM-DD', () => {
    expect(normalizeDue('2026-06-20')).toBe('2026-06-20');
  });
  it('trims an ISO timestamp to its date part', () => {
    expect(normalizeDue('2026-06-20T14:30:00.000Z')).toBe('2026-06-20');
  });
  it('returns "" for absent / unparseable values', () => {
    expect(normalizeDue('')).toBe('');
    expect(normalizeDue(undefined)).toBe('');
    expect(normalizeDue('soon')).toBe('');
    expect(normalizeDue(20260620)).toBe('');
  });
});

describe('dueStatus', () => {
  it('classifies overdue / today / upcoming', () => {
    expect(dueStatus('2026-06-10', NOW)).toBe('overdue');
    expect(dueStatus('2026-06-17', NOW)).toBe('today');
    expect(dueStatus('2026-06-20', NOW)).toBe('upcoming');
  });
  it('returns "" when there is no valid due date (absent → no chip/badge)', () => {
    expect(dueStatus('', NOW)).toBe('');
    expect(dueStatus(undefined, NOW)).toBe('');
    expect(dueStatus('nope', NOW)).toBe('');
  });
});

describe('isDueOrOverdue', () => {
  it('is true for today and earlier, false for upcoming / none', () => {
    expect(isDueOrOverdue('2026-06-17', NOW)).toBe(true);
    expect(isDueOrOverdue('2026-06-01', NOW)).toBe(true);
    expect(isDueOrOverdue('2026-06-18', NOW)).toBe(false);
    expect(isDueOrOverdue('', NOW)).toBe(false);
  });
});

describe('formatDueLabel', () => {
  it('labels overdue / today plainly', () => {
    expect(formatDueLabel('2026-06-10', NOW)).toBe('Overdue');
    expect(formatDueLabel('2026-06-17', NOW)).toBe('Due today');
  });
  it('labels an upcoming date with month/day', () => {
    expect(formatDueLabel('2026-06-20', NOW)).toBe('Due Jun 20');
  });
  it('returns "" for no due date', () => {
    expect(formatDueLabel('', NOW)).toBe('');
  });
});

describe('todayStr', () => {
  it('formats local date as YYYY-MM-DD', () => {
    expect(todayStr(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
