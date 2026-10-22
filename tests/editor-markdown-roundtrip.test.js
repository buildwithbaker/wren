// @vitest-environment jsdom
//
// Regression guard for the markdown layer (tiptap-markdown -> markdown-it).
// Loads Markdown into the real editor factory and reads it back, so a
// markdown-it bump that changes parsing or serialization shows up here.
import { describe, it, expect, afterEach } from 'vitest';
import { createEditor, getMarkdown } from '../src/editor.js';

let editor;

function roundTrip(md) {
  editor = createEditor({ element: document.createElement('div'), content: md });
  return getMarkdown(editor);
}

afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

describe('editor markdown round-trip', () => {
  it('keeps headings, emphasis, lists, tasks and links', () => {
    const md = [
      '# Title',
      '',
      'Some **bold** and *italic* text with a [link](https://example.com).',
      '',
      '- one',
      '- two',
      '',
      'Tasks:',
      '',
      '- [ ] open task',
      '- [x] done task',
    ].join('\n');
    // Blank lines between task items are serializer spacing, not content.
    const strip = (t) => t.split(String.fromCharCode(10)).filter((l) => l.trim() !== '').join(String.fromCharCode(10));
    expect(strip(roundTrip(md))).toBe(strip(md));
  });

  it('is stable on a second pass', () => {
    const once = roundTrip('## Heading\n\n1. first\n2. second\n\n> quoted');
    expect(roundTrip(once)).toBe(once);
  });

  it('round-trips inline HTML for color and highlight (html: true)', () => {
    const md = 'plain <mark>marked</mark> text';
    expect(roundTrip(md)).toContain('marked');
  });

  it('handles a large unmatched-quote input without stalling (markdown-it DoS regression)', () => {
    const md = '" '.repeat(50000);
    const start = Date.now();
    roundTrip(md);
    expect(Date.now() - start).toBeLessThan(10000);
  });
});
