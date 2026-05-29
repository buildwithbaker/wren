# CLAUDE.md - Wren

See @README.md for what this project is and why.

## Build, test, deploy
- `npm run dev`      # Vite dev server (PWA) at localhost:5173
- `npm run build`    # gen-icons + builds dist/ (PWA) and dist-extension/ (MV3)
- `npm run preview`  # serves the production build; the ONLY way to exercise the
                     #   production service worker (SW is enabled only when PROD)
- Deploy: Pages auto-deploys from main via .github/workflows/deploy.yml
  (uploads dist/ as the Pages artifact). No lint script is configured yet; CI
  runs `npm run lint --if-present` and will simply skip it.

## File organization (root is locked)
Do not add files to the repo root unless they are in the permitted-root-files
table of the Build with Baker Repo Standard v2.0. Before creating any new file:
1) identify which folder it belongs in, 2) create it if missing, 3) add it there.
- New JS -> src/ (UI in src/ui/, storage in src/storage/, sync in src/sync/,
  oauth in src/oauth/, tags in src/tags/); new CSS -> src/styles/;
  new image/icon -> public/; build script -> scripts/;
  planning/research/spec doc -> docs/internal/.

## Code style
- ES modules only (import/export), never require()
- 2-space indent

## Do not touch
- dist/ and dist-extension/ are generated - never edit by hand
- public/sw.js and public/manifest.json location is load-bearing. Vite copies
  public/ to the published root; a service worker MUST live at the published
  root or its scope silently shrinks (GitHub Pages cannot send
  Service-Worker-Allowed to widen it).
- The OAuth Client ID in src/oauth/gisClient.js is a PUBLIC web client ID and is
  safe in version control. Its Authorized JavaScript origins are registered in
  Google Cloud (project "Wren"): http://localhost:5173, http://localhost,
  https://buildwithbaker.github.io. Do not add a new origin or change the flow
  without updating that registration, or OAuth login breaks in that environment.
  There is no client SECRET in this repo (GIS Token Model is public-client only)
  - if one ever appears, stop and rotate it.
- src/oauth/gisClient.js DRIVE_SCOPE is drive.file (non-sensitive). Widening the
  scope triggers Google's CASA/brand-verification path - do not change casually.
