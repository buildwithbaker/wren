// Unit tests for the pure parts of the cross-window broadcast wrapper
// (src/sync/broadcast.js): the note-saved message shape and the self-ignore
// filter. These run in plain Node — no BroadcastChannel needed.
import { describe, it, expect } from 'vitest';
import {
  buildNoteSavedMessage,
  shouldIgnoreMessage,
} from '../src/sync/broadcast.js';

describe('buildNoteSavedMessage', () => {
  it('produces the canonical note-saved shape carrying both ids', () => {
    const msg = buildNoteSavedMessage(
      { id: 'note.md', wrenId: 'wren-abc', modified: '2026-06-11T00:00:00.000Z' },
      'win-1'
    );
    expect(msg).toEqual({
      type: 'note-saved',
      id: 'note.md',
      wrenId: 'wren-abc',
      modified: '2026-06-11T00:00:00.000Z',
      source: 'win-1',
    });
  });

  it('defaults missing note fields to empty strings (never undefined)', () => {
    const msg = buildNoteSavedMessage({}, 'win-2');
    expect(msg.id).toBe('');
    expect(msg.wrenId).toBe('');
    expect(msg.modified).toBe('');
    expect(msg.source).toBe('win-2');
  });

  it('tolerates a null note', () => {
    const msg = buildNoteSavedMessage(null, 'win-3');
    expect(msg.type).toBe('note-saved');
    expect(msg.id).toBe('');
  });
});

describe('shouldIgnoreMessage', () => {
  it('ignores a message from the same window (own echo)', () => {
    const msg = buildNoteSavedMessage({ id: 'a.md' }, 'win-1');
    expect(shouldIgnoreMessage(msg, 'win-1')).toBe(true);
  });

  it('does NOT ignore a message from a different window', () => {
    const msg = buildNoteSavedMessage({ id: 'a.md' }, 'win-1');
    expect(shouldIgnoreMessage(msg, 'win-2')).toBe(false);
  });

  it('ignores malformed / foreign messages', () => {
    expect(shouldIgnoreMessage(null, 'w')).toBe(true);
    expect(shouldIgnoreMessage(undefined, 'w')).toBe(true);
    expect(shouldIgnoreMessage('nope', 'w')).toBe(true);
    expect(shouldIgnoreMessage({ type: 'other', source: 'x' }, 'w')).toBe(true);
    expect(shouldIgnoreMessage({}, 'w')).toBe(true);
  });
});
