// editor.js
// Tiptap v2 editor factory with the full Scope 1 extension set.
// Bundled locally by Vite for both the PWA and the MV3 extension popup.

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';

export function createEditor({ element, content = '', onUpdate, onSelectionUpdate, editable = true }) {
  return new Editor({
    element,
    editable,
    extensions: [
      StarterKit.configure({
        // tiptap-markdown handles serialization; keep defaults otherwise.
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
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
