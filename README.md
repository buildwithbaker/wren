# Wren

Local-first sticky-notes app. Your notes are plain `.md` files (YAML frontmatter + markdown body) stored in a folder you choose on disk via the File System Access API — no account, no cloud.

Ships in three forms that read/write the same folder:

- **PWA** — two-panel web app (installable, works offline) — <https://wren.buildwithbaker.io>
- **Chrome extension** — Manifest V3 single-panel popup
- **Windows desktop app** — Tauri build with an always-on-top compact window and
  tear-off sticky notes. Download the installer from
  [the download page](https://wren.buildwithbaker.io/download) or
  [GitHub Releases](https://github.com/buildwithbaker/wren/releases).

Built with [Vite](https://vitejs.dev/) and [Tiptap v2](https://tiptap.dev/) (bundled locally — MV3 forbids CDN/inline scripts).

> **Internals:** see [docs/internal/architecture.md](docs/internal/architecture.md) for the full architecture reference — file map, boot flow, storage layer, extension points, and gotchas.

> **Releases and signing:** desktop installers are built only by the
> [Release workflow](.github/workflows/tauri-release.yml) from a pushed version
> tag and published as GitHub Release assets. The installer is **not yet
> code-signed** — see the [Code Signing Policy](https://wren.buildwithbaker.io/signing)
> for how a release is built, who approves it, and how to verify a download.

> **Contributing:** `main` is protected; changes land through a pull request
> with CI green. Please read the [Code of Conduct](.github/CODE_OF_CONDUCT.md)
> and [SECURITY.md](SECURITY.md).

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
origin. Wren is served at **`https://wren.buildwithbaker.io`** (the primary
production origin), a custom domain on the `wren-9p5` **Cloudflare Pages**
project. That host and the Pages project's own `*.pages.dev` domain both need to
be registered production origins. OAuth fails from any origin not on that list.

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
