// @vitest-environment jsdom
//
// AI-provenance badge (AI-write visibility P1): isAiNote() decides whether a
// card shows the badge; buildAiBadge() makes the chip. A note is "AI" when it
// was created OR last edited by the AI; legacy/human notes never are.
import { describe, it, expect } from 'vitest';
import { isAiNote, buildAiBadge } from '../src/ui/ai-badge.js';

describe('isAiNote', () => {
  it('true when created_by is ai', () => {
    expect(isAiNote({ createdBy: 'ai', lastEditedBy: 'human' })).toBe(true);
  });
  it('true when last_edited_by is ai (even if a human created it)', () => {
    expect(isAiNote({ createdBy: 'human', lastEditedBy: 'ai' })).toBe(true);
  });
  it('false for a human note', () => {
    expect(isAiNote({ createdBy: 'human', lastEditedBy: 'human' })).toBe(false);
  });
  it('false for a legacy note with no provenance', () => {
    expect(isAiNote({})).toBe(false);
    expect(isAiNote({ createdBy: '', lastEditedBy: '' })).toBe(false);
  });
  it('false / safe for null', () => {
    expect(isAiNote(null)).toBe(false);
    expect(isAiNote(undefined)).toBe(false);
  });
});

describe('buildAiBadge', () => {
  it('builds a labeled, accessible AI chip', () => {
    const badge = buildAiBadge();
    expect(badge.tagName).toBe('SPAN');
    expect(badge.className).toBe('sc-ai-badge');
    expect(badge.textContent).toBe('AI');
    expect(badge.getAttribute('aria-label')).toMatch(/AI/);
  });
});
