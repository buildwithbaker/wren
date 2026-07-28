// sync-version.mjs — single-source the app version from package.json.
//
// package.json `version` is the ONE source of truth. Three derived files must
// match it or they ship stale version numbers (audit D3/D5 — the extension
// manifest was stuck at 1.2.0 and Cargo.toml at 0.1.0 while package/tauri were
// at 1.2.4):
//   - src-tauri/tauri.conf.json  (baked into the desktop build + release tags)
//   - src-tauri/Cargo.toml       ([package] version)
//   - extension/public/manifest.json (the Chrome Web Store version)
//
// Modes:
//   node scripts/sync-version.mjs           → CHECK: exit 1 on any mismatch.
//                                             Wired into `npm run build`, so a
//                                             drifted version fails the build.
//   node scripts/sync-version.mjs --write   → WRITE: rewrite the derived files
//                                             to match package.json. Run this on
//                                             a version bump (npm run version:sync).
//
// Kept deliberately dependency-free (regex for Cargo.toml, JSON for the rest) so
// it runs in the plain build environment.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

const pkgPath = resolve(root, 'package.json');
const canonical = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
if (!canonical) {
  console.error('[sync-version] package.json has no "version" — nothing to sync.');
  process.exit(1);
}

// ---- JSON targets (tauri.conf.json, extension manifest) -------------------

function jsonTarget(relPath, label) {
  const path = resolve(root, relPath);
  return {
    label,
    path,
    read() {
      return JSON.parse(readFileSync(path, 'utf8')).version;
    },
    write() {
      const src = readFileSync(path, 'utf8');
      // Preserve formatting: replace only the "version": "…" value of the first
      // top-level occurrence rather than re-serializing the whole file.
      const next = src.replace(/("version"\s*:\s*")[^"]*(")/, `$1${canonical}$2`);
      writeFileSync(path, next);
    },
  };
}

// ---- Cargo.toml (TOML — targeted regex on the [package] version) ----------

function cargoTarget(relPath, label) {
  const path = resolve(root, relPath);
  // Match the `version = "…"` that belongs to the [package] section: the first
  // bare `version` key after the [package] header. `rust-version` does not match
  // (it isn't a bare `version` key at a line start).
  const RE = /(\[package\][\s\S]*?\n\s*version\s*=\s*")[^"]*(")/;
  return {
    label,
    path,
    read() {
      const m = readFileSync(path, 'utf8').match(RE);
      return m ? m[0].match(/"([^"]*)"$/)?.[1] : null;
    },
    write() {
      const src = readFileSync(path, 'utf8');
      writeFileSync(path, src.replace(RE, `$1${canonical}$2`));
    },
  };
}

const targets = [
  jsonTarget('src-tauri/tauri.conf.json', 'tauri.conf.json'),
  cargoTarget('src-tauri/Cargo.toml', 'Cargo.toml'),
  jsonTarget('extension/public/manifest.json', 'extension manifest'),
];

let drift = false;
for (const t of targets) {
  const current = t.read();
  if (current === canonical) continue;
  drift = true;
  if (write) {
    t.write();
    console.log(`[sync-version] ${t.label}: ${current} → ${canonical}`);
  } else {
    console.error(`[sync-version] MISMATCH ${t.label}: ${current} (expected ${canonical})`);
  }
}

if (!drift) {
  console.log(`[sync-version] all files match package.json (${canonical}).`);
  process.exit(0);
}

if (write) {
  console.log(`[sync-version] synced to ${canonical}.`);
  process.exit(0);
}

console.error(
  `[sync-version] version drift — run "npm run version:sync" to align the files with package.json (${canonical}).`
);
process.exit(1);
