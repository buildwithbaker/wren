// Audit T1 (Medium) — the Tauri fs:scope allow-list covered the notes folder
// with "$DOCUMENT/Wren Notes/**" and nothing else, so access to the two paths
// the app cannot function without — the .trash/ folder that every delete moves
// notes into, and the .wren-index.json the MCP server reads — depended entirely
// on "**" matching a leading dot.
//
// Glob implementations disagree about that. Tauri's scope matching is currently
// permissive, which is why this was latent rather than broken, and why the
// Windows-only desktop build never showed it. It is exactly the kind of
// dependency that breaks on a dependency bump or a macOS/Linux build, and the
// failure mode is a delete that silently cannot write to .trash.
//
// The fix is to stop relying on the ambiguity: name the dotted paths.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const caps = JSON.parse(
  readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8')
);

function fsScopeAllows() {
  const entry = caps.permissions.find((p) => p && p.identifier === 'fs:scope');
  if (!entry) throw new Error('no fs:scope permission entry in capabilities/default.json');
  return entry.allow.map((a) => a.path);
}

describe('T1 — dotted paths are named explicitly, not left to "**"', () => {
  it('grants the .trash folder and its contents by name', () => {
    const allows = fsScopeAllows();
    // Both entries are needed: the directory itself (created and stat-ed) and
    // its contents (each deleted note written into it).
    expect(allows).toContain('$DOCUMENT/Wren Notes/.trash');
    expect(allows).toContain('$DOCUMENT/Wren Notes/.trash/**');
  });

  it('grants the index file the MCP server reads', () => {
    expect(fsScopeAllows()).toContain('$DOCUMENT/Wren Notes/.wren-index.json');
  });

  it('still grants the ordinary notes folder', () => {
    // The dotfile entries are additive. Removing the general grant would break
    // every normal note, so assert the fix did not trade one for the other.
    const allows = fsScopeAllows();
    expect(allows).toContain('$DOCUMENT/Wren Notes');
    expect(allows).toContain('$DOCUMENT/Wren Notes/**');
  });

  it('covers every dotted notes-folder name the app declares', () => {
    // The real guard against this regressing. The reserved names inside the
    // notes folder are declared once, as exported constants — TRASH_DIR in
    // notes-store.js and INDEX_JSON_NAME in ai/note-index.js. Anchoring on
    // those rather than scanning for dotted string literals keeps the test off
    // CSS class names and makes it track a rename automatically: add a fourth
    // reserved dot-name and this fails until fs:scope names it too.
    const sources = ['src/notes-store.js', 'src/ai/note-index.js'].map((rel) =>
      readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    );
    const dotted = new Set(
      sources.flatMap((src) =>
        [...src.matchAll(/export const\s+\w+\s*=\s*'(\.[^']+)'/g)].map((m) => m[1])
      )
    );

    const allows = fsScopeAllows();
    for (const name of dotted) {
      expect(
        allows.some((p) => p.endsWith(`/${name}`)),
        `reserved name "${name}" is declared in source but has no fs:scope entry`
      ).toBe(true);
    }

    // Guard the guard: if the constants are ever renamed or moved, the loop
    // above passes vacuously and this test quietly becomes decoration.
    expect(dotted).toEqual(new Set(['.trash', '.wren-index.json']));
  });
});
