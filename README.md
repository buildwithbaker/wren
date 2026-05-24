# Wren

Local-first sticky-notes app. Your notes are plain `.md` files (YAML frontmatter + markdown body) stored in a folder you choose on disk via the File System Access API — no account, no cloud.

Ships in two forms that read/write the same folder:

- **PWA** — two-panel web app (installable, works offline)
- **Chrome extension** — Manifest V3 single-panel popup

Built with [Vite](https://vitejs.dev/) and [Tiptap v2](https://tiptap.dev/) (bundled locally — MV3 forbids CDN/inline scripts).

## Develop

```bash
npm install
npm run dev          # Vite dev server (PWA)
```

## Build

```bash
npm run build        # generates icons, then builds both targets
```

Outputs:

- `dist/` — the PWA (deploy as a static site)
- `dist-extension/` — load-unpacked in Chrome, or zip for the Chrome Web Store

## Notes format

Each note is a `.md` file with YAML frontmatter (title, color, timestamps) and a markdown body. Because markdown has no syntax for text color/highlight, `tiptap-markdown` runs with `html: true` to round-trip those as inline HTML.

---

A *Build with Baker* project.
