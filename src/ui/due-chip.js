// due-chip.js
// Shared due-date chip for note cards (compact / list / kanban). Returns a small
// chip element, tinted by status (overdue / today / upcoming), or null when the
// note has no valid due date. Reuses the pure helpers in src/due.js so all three
// views stay in lockstep with the desktop reminder.

import { dueStatus, formatDueLabel, normalizeDue } from '../due.js';

/**
 * @param {string} due - the note's `due` value
 * @returns {HTMLSpanElement|null} the chip, or null when there's no due date
 */
export function buildDueChip(due) {
  const status = dueStatus(due);
  if (!status) return null;
  const chip = document.createElement('span');
  chip.className = `sc-due-chip sc-due-chip--${status}`;
  chip.textContent = formatDueLabel(due);
  chip.title = `Due ${normalizeDue(due)}`;
  return chip;
}
