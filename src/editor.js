// editor.js
// Tiptap v3 editor factory with the full Scope 1 extension set.
// Bundled locally by Vite for both the PWA and the MV3 extension popup.
//
// v3 migration notes:
//   - StarterKit v3 now bundles Underline AND Link (separate packages in v2),
//     so they are configured THROUGH StarterKit here rather than imported again
//     (importing them too would register duplicate extensions).
//   - `Color` moved into `@tiptap/extension-text-style` (the standalone
//     `@tiptap/extension-color` package is deprecated). TextStyle/Color are now
//     named exports — v3 dropped the default exports.

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';

export function createEditor({ element, content = '', onUpdate, onSelectionUpdate, editable = true }) {
  return new Editor({
    element,
    editable,
    extensions: [
      StarterKit.configure({
        // tiptap-markdown handles serialization; keep defaults otherwise.
        // Underline uses its v3 StarterKit defaults; Link is configured here
        // (both are bundled in StarterKit v3 — see migration notes above).
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, linkOnPaste: true },
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({
        // html:true lets text color and highlight (which have no Markdown
        // syntax) round-trip as inline HTML; standard formatting still emits
        // clean Markdown (**, #, -, []()).
        html: true,
        tightLists: true,
        bulletListMarker: '-',
        linkify: true,
        breaks: false,
        transformPastedText: true,
      }),
    ],
    content,
    editorProps: {
      attributes: {
        class: 'sc-prose',
        spellcheck: 'true',
      },
    },
    onUpdate: ({ editor }) => onUpdate?.(editor),
    onSelectionUpdate: ({ editor }) => onSelectionUpdate?.(editor),
    onTransaction: ({ editor }) => onSelectionUpdate?.(editor),
  });
}

// Markdown out of the editor (what we persist to the .md file body).
export function getMarkdown(editor) {
  return editor.storage.markdown.getMarkdown();
}
