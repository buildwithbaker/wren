# Code signing — status, application answers, go-live checklist

Audit item **D5**. The Windows installer ships **unsigned**, so SmartScreen warns
on first run and `tauri-plugin-updater` can't be adopted (an unsigned updater is
worse than no updater — it's an unauthenticated code-execution path).

Everything in this document is preparation. Nothing here signs anything yet.

## Decision: apply to SignPath Foundation, Azure as fallback

Since June 2023 a CA must keep the private key on a hardware token or HSM, which
killed the "download a .pfx and sign in CI" path. What's left:

| Option | Cost | Hardware | Eligibility | Notes |
|---|---|---|---|---|
| **SignPath Foundation** | free | none | OSS projects | Wren qualifies: MIT, public, CI-built releases |
| **Azure Artifact Signing** (was Trusted Signing) | ~$10/mo | none | individuals US/CA; orgs US/CA/EU/UK | Adam is eligible either way |
| OV certificate | $150–300/yr | **token/HSM** | worldwide | a physical dongle in the loop per build |
| EV certificate | $400+/yr | **token/HSM** | worldwide | traditionally the only tier credited with immediate SmartScreen reputation — verify before paying |

SignPath first because it is free, needs no dongle, and Wren already meets the
part reviewers actually care about. Azure is the fallback if SignPath declines
or goes quiet.

**Signing does not switch SmartScreen off.** Reputation accrues per publisher as
downloads happen. Expect warnings to persist for a while after the first signed
release. Don't promise users otherwise.

## Application answers (paste into the SignPath form)

- **Project name:** Wren
- **Repository:** https://github.com/buildwithbaker/wren
- **Licence:** MIT (OSI-approved, no commercial dual-licensing)
- **Release / download URL:** https://wren.buildwithbaker.io/download →
  https://github.com/buildwithbaker/wren/releases
- **Artifact to sign:** one Windows NSIS installer per release,
  `Wren_<version>_x64-setup.exe`, built by
  [`.github/workflows/tauri-release.yml`](../../.github/workflows/tauri-release.yml)
  on a GitHub-hosted `windows-latest` runner from a pushed `v*` tag.
- **Description:**

  > Wren is a local-first sticky-notes app. Notes are plain Markdown files with
  > YAML frontmatter, stored in a folder the user picks on their own disk — no
  > account, no server, nothing uploaded. It ships as an installable web app, a
  > Chrome extension, and a Tauri-based Windows desktop app that adds an
  > always-on-top compact window and tear-off sticky notes; all three read and
  > write the same folder. Its users are people who want quick notes that stay
  > in files they own and can edit in any other editor. The artifact we would
  > like signed is the Windows NSIS installer, built and published only by our
  > public GitHub Actions release workflow.

- **Code Signing Policy URL:** https://wren.buildwithbaker.io/signing
- **Code of Conduct:** [`.github/CODE_OF_CONDUCT.md`](../../.github/CODE_OF_CONDUCT.md)
  (Contributor Covenant 2.1)
- **Team roles:** single maintainer, Adam Baker (@buildwithbaker), holding
  Author + Reviewer + Approver. `main` is protected; changes land only via PR
  with CI green. MFA on GitHub and on the signing service.

## What is already in place

- [x] OSI licence at the repo root (`LICENSE`, MIT)
- [x] Actively maintained, released in the form to be signed (tags through `v1.2.4`)
- [x] Automated public build producing the exact artifact
      (`.github/workflows/tauri-release.yml`)
- [x] GitHub Releases as the single distribution channel
- [x] Functionality described on the download page
- [x] `SECURITY.md`
- [x] `.github/CODE_OF_CONDUCT.md`
- [x] Code Signing Policy page (`public/signing.html` → `/signing`), linked from
      the download page's SmartScreen callout and both footers
- [x] Version single-sourced from `package.json` and enforced at build time by
      `scripts/sync-version.mjs`, which satisfies the "consistent product name
      and version metadata" condition
- [x] Signing step present in the release workflow but **inert** — gated on the
      repository variable `SIGNING_ENABLED`, so nothing changes until it is set

## Blocked on Adam (cannot be done from a session)

1. **Submit the SignPath Foundation application** — needs his identity and
   account: https://signpath.org/apply
2. **Confirm MFA** is enabled on the GitHub account (and later on SignPath).
3. **Add the attribution line** required by SignPath's terms once approved —
   see the go-live checklist. It must not be published before approval, because
   it would claim a relationship that doesn't exist yet.
4. **Decide whether `/signing` goes in `public/sitemap.xml`.** Deliberately left
   out for now: the page currently exists mainly to satisfy a pending
   application, and indexing a "we are not signed yet" page is not obviously
   desirable. One line to add when he wants it.

## Go-live checklist (only after approval)

1. Add repo secret `SIGNPATH_API_TOKEN`; add variables `SIGNPATH_ORG_ID`,
   `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`.
2. Set repository variable `SIGNING_ENABLED = true`.
3. Edit `public/signing.html`: delete the "Status — not yet code-signed"
   callout, and add the required attribution, verbatim:
   *"Free code signing provided by SignPath.io, certificate by SignPath Foundation"*.
4. Edit `public/download.html`: remove or soften the SmartScreen callout — but
   keep a note that reputation takes time, because the warning will not vanish
   on day one.
5. Edit `README.md`: drop "not yet code-signed".
6. Cut a throwaway tag first (e.g. `v1.2.5-rc1`, `prerelease: true`) and confirm
   the signed artifact comes back and verifies under Properties → Digital
   Signatures before advertising a signed release.
7. Only then revisit `tauri-plugin-updater` (the rest of D5).
