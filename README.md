# Wren

Local-first sticky-notes app. Your notes are plain `.md` files (YAML frontmatter + markdown body) stored in a folder you choose on disk via the File System Access API — no account, no cloud.

Ships in two forms that read/write the same folder:

- **PWA** — two-panel web app (installable, works offline)
- **Chrome extension** — Manifest V3 single-panel popup

Built with [Vite](https://vitejs.dev/) and [Tiptap v2](https://tiptap.dev/) (bundled locally — MV3 forbids CDN/inline scripts).

## Setup

Requires Node 20 (see `.nvmrc`).

```bash
npm install
npm run dev          # Vite dev server (PWA) at localhost:5173
```

### Google Drive sync (OAuth)

Wren can optionally sync the chosen folder to Google Drive (scope
`drive.file`). The OAuth **client ID is a public web client ID** committed in
[`src/oauth/gisClient.js`](src/oauth/gisClient.js) — there is no client secret
(GIS Token Model is a public-client flow). To run Drive sync against your own
Google Cloud project, replace that ID and register your **Authorized JavaScript
origins** to include both `http://localhost:5173` (dev) and your production
origin. Wren is hosted on **Cloudflare Pages** at `https://wren-ckn.pages.dev`,
which is the registered production origin. OAuth fails from any origin not on
that list.

> Use `npm run preview` (not `npm run dev`) to exercise the **production service
> worker** — the SW is only enabled in production builds, so offline behaviour
> can't be tested from the dev server.

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
