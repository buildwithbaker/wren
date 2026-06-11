// sticky/registry.js
// The "open stickies" registry (Sticky Float Phase 2). A localStorage list of
// the stickies currently/last open, so the main app can offer "Restore N
// stickies" after a full browser restart. Each entry is { wrenId, id } where
// `id` is the storage id (FS filename / Drive fileId) and `wrenId` is the
// stable logical id (may be '' for legacy notes).
//
// A sticky adds itself on successful boot and removes itself on pagehide. The
// registry simply being non-empty on the next main-app launch is the
// best-effort "stickies were open" signal — there is no live liveness check
// (cross-window enumeration isn't available to a PWA).
//
// parseRegistry is pure (unit-testable); the read/add/remove/clear wrappers are
// the thin localStorage layer.
//
// Decision provenance: project-blueprints/wren/future-enhancements/sticky-float-sow.md (Phase 2)

const REGISTRY_KEY = 'wren.stickies.open';

/**
 * Parse the raw JSON registry into a clean array of { wrenId, id } entries.
 * Defensive: drops anything that isn't an object with a non-empty string `id`,
 * and de-dupes by id (last wins). Pure.
 *
 * @param {string|null|undefined} raw
 * @returns {Array<{wrenId: string, id: string}>}
 */
export function parseRegistry(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const byId = new Map();
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id) continue;
    byId.set(id, { wrenId: typeof entry.wrenId === 'string' ? entry.wrenId : '', id });
  }
  return Array.from(byId.values());
}

/** Read the current registry. Never throws. */
export function readRegistry() {
  try {
    return parseRegistry(localStorage.getItem(REGISTRY_KEY));
  } catch {
    return [];
  }
}

function writeRegistry(entries) {
  try {
    if (!entries || entries.length === 0) {
      localStorage.removeItem(REGISTRY_KEY);
    } else {
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(entries));
    }
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Add (or refresh) an entry, de-duped by storage id. */
export function addToRegistry(wrenId, id) {
  if (!id) return;
  const entries = readRegistry().filter((e) => e.id !== id);
  entries.push({ wrenId: wrenId || '', id });
  writeRegistry(entries);
}

/** Remove an entry by storage id. */
export function removeFromRegistry(id) {
  if (!id) return;
  writeRegistry(readRegistry().filter((e) => e.id !== id));
}

/** Clear the whole registry (the "Dismiss" action on the restore bar). */
export function clearRegistry() {
  writeRegistry([]);
}
