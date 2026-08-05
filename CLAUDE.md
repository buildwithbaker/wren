# CLAUDE.md - Wren

See @README.md for what this project is and why.
See @docs/internal/architecture.md for the deep architecture reference (file map, boot flow, storage layer, extension points, gotchas).

## Build, test, deploy
- `npm run dev`      # Vite dev server (PWA) at localhost:5173
- `npm run build`    # gen-icons + builds dist/ (PWA) and dist-extension/ (MV3)
- `npm run preview`  # serves the production build; the ONLY way to exercise the
                     #   production service worker (SW is enabled only when PROD)
- Deploy: Cloudflare Pages (project "wren-9p5" on the bakeradm6@gmail.com
  account, served at the primary origin https://wren.buildwithbaker.io;
  https://wren-9p5.pages.dev is that project's own domain)
  auto-builds from main via Cloudflare's Git integration - build command
  `npm run build`, output dir `dist/`, configured in the Cloudflare dashboard
  (NOT in this repo). There is no GitHub Actions deploy workflow. Lint is
  `npm run lint` (eslint, flat config in `eslint.config.js`); CI runs
  `npm run lint --if-present`, which now executes it.

## Branching (main is protected - PR only)

`main` is protected: direct pushes are rejected. **Never run `git push origin main`.**

1. `git checkout main && git pull origin main` - start from an up-to-date main
2. `git checkout -b <type>/<slug>` - branch BEFORE staging, so local `main` never diverges
3. edit, then `git add -- <explicit paths>` - never `git add -A`
4. `git commit -m "<message>"`
5. `git push -u origin <branch>`
6. `gh pr create --base main --fill`
7. `gh pr checks <branch> --watch` - wait for the required checks
8. `gh pr merge <branch> --squash --delete-branch`
9. `git checkout main && git pull origin main`

Never merge while a required check is failing or pending, and never disable a check to
force a merge through - stop and report instead.

The Cloudflare Pages build runs on the post-merge `main`, so nothing is live until the PR
is merged. CI runs `npm run lint --if-present` (eslint flat config).

## File organization (root is locked)
Do not add files to the repo root unless they are in the permitted-root-files
table of the Build with Baker Repo Standard v2.0. Before creating any new file:
1) identify which folder it belongs in, 2) create it if missing, 3) add it there.
- New JS -> src/ (UI in src/ui/, storage in src/storage/, sync in src/sync/,
  oauth in src/oauth/, tags in src/tags/); new CSS -> src/styles/;
  new image/icon -> public/; build script -> scripts/;
  planning/research/spec doc -> docs/internal/.
- src-tauri/ -> the Tauri (Rust) desktop crate; everything Tauri-related lives
  under it.

## Code style
- ES modules only (import/export), never require()
- 2-space indent

## Code signing (audit D4)
The Windows installer is **unsigned**. `public/signing.html` (served at
`/signing`) is the public Code Signing Policy and currently SAYS SO — if signing
goes live, that page, `public/download.html` and `README.md` all have to stop
claiming it in the same change. The release workflow already carries a signing
step, inert behind the repo variable `SIGNING_ENABLED`; do not enable it or
remove the "not signed" wording independently of each other. Status, the
SignPath application answers, and the go-live checklist live in
[`docs/internal/code-signing.md`](docs/internal/code-signing.md).

## Do not touch
- dist/ and dist-extension/ are generated - never edit by hand
- public/sw.js and public/manifest.json location is load-bearing. Vite copies
  public/ to the published root; a service worker MUST live at the published
  root or its scope silently shrinks - a worker served from a sub-path can only
  control that sub-path, and you can't rely on a Service-Worker-Allowed header
  to widen its scope.
- The OAuth Client ID in src/oauth/gisClient.js is a PUBLIC web client ID and is
  safe in version control. Its Authorized JavaScript origins are registered in
  Google Cloud (project "Wren"): http://localhost:5173, http://localhost,
  https://wren.buildwithbaker.io (primary production origin), and
  https://wren-ckn.pages.dev - which is the OLD Pages project's domain. The
  project moved to "wren-9p5" on 2026-08-05; https://wren-9p5.pages.dev is NOT
  yet registered, so Drive sign-in fails on preview URLs until it is. Production
  is unaffected, because the custom domain did not change. Do not add a new
  origin or change the flow without updating that registration, or OAuth login
  breaks in that environment.
  There is no client SECRET in this repo (GIS Token Model is public-client only)
  - if one ever appears, stop and rotate it.
- src/oauth/gisClient.js DRIVE_SCOPE is drive.file (non-sensitive). Widening the
  scope triggers Google's CASA/brand-verification path - do not change casually.
