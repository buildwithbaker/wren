// sticky/geometry.js
// Per-device window position + size memory for pop-out sticky windows (Sticky
// Float Phase 2). Geometry is intentionally device-local — it lives in
// localStorage, NEVER in note frontmatter, so it can't thrash .md files or
// create pointless Drive conflicts across monitors/devices.
//
// Keyed by the note's stable logical wrenId. Legacy/untagged notes that have no
// wrenId fall back to keying by their storage id so they still remember a
// position (see geomStorageKey).
//
// The parse/validate/serialize helpers are pure (no localStorage) so they are
// unit-testable; loadGeometry/saveGeometry are the thin localStorage wrappers.
//
// Decision provenance: project-blueprints/wren/future-enhancements/sticky-float-sow.md (Phase 2)

const KEY_PREFIX = 'wren.sticky.geom.';

/**
 * localStorage key for a sticky's geometry. Prefers the logical wrenId; falls
 * back to the storage id (prefixed to avoid colliding with a real wrenId) when
 * the note has no wrenId yet. Pure.
 *
 * @param {string} wrenId
 * @param {string} storageId
 */
export function geomStorageKey(wrenId, storageId) {
  const suffix = wrenId ? wrenId : `id:${storageId || ''}`;
  return `${KEY_PREFIX}${suffix}`;
}

/**
 * Validate a geometry object: all four fields present, finite, and within sane
 * bounds (no negative sizes; positions may be negative for multi-monitor
 * left/up layouts). Pure.
 *
 * @param {*} g
 * @returns {boolean}
 */
export function isValidGeometry(g) {
  if (!g || typeof g !== 'object') return false;
  for (const k of ['x', 'y', 'w', 'h']) {
    if (typeof g[k] !== 'number' || !Number.isFinite(g[k])) return false;
  }
  return g.w > 0 && g.h > 0;
}

/**
 * Parse a raw JSON string into a validated geometry object, or null when it is
 * missing / malformed / invalid. Coerces the four fields to plain numbers and
 * drops anything else. Pure (round-trips serializeGeometry output).
 *
 * @param {string|null|undefined} raw
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function parseGeometry(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const g = {
    x: Number(obj.x),
    y: Number(obj.y),
    w: Number(obj.w),
    h: Number(obj.h),
  };
  return isValidGeometry(g) ? g : null;
}

/**
 * Serialize a geometry object to its stored JSON form, rounding to whole
 * pixels. Returns null for invalid input so callers never persist garbage.
 * Pure.
 *
 * @param {*} g
 * @returns {string|null}
 */
export function serializeGeometry(g) {
  if (!isValidGeometry(g)) return null;
  return JSON.stringify({
    x: Math.round(g.x),
    y: Math.round(g.y),
    w: Math.round(g.w),
    h: Math.round(g.h),
  });
}

/**
 * Whether two geometries are equal once rounded to whole pixels. Used to skip
 * redundant writes during the sticky's poll loop. Pure.
 */
export function geometryEquals(a, b) {
  if (!isValidGeometry(a) || !isValidGeometry(b)) return false;
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.w) === Math.round(b.w) &&
    Math.round(a.h) === Math.round(b.h)
  );
}

/**
 * Read a sticky's remembered geometry from localStorage, or null. Never throws
 * (disabled/quota'd storage degrades to "no memory").
 */
export function loadGeometry(wrenId, storageId) {
  try {
    return parseGeometry(localStorage.getItem(geomStorageKey(wrenId, storageId)));
  } catch {
    return null;
  }
}

/**
 * Persist a sticky's geometry. No-op for invalid geometry or disabled storage.
 */
export function saveGeometry(wrenId, storageId, g) {
  const serialized = serializeGeometry(g);
  if (serialized === null) return;
  try {
    localStorage.setItem(geomStorageKey(wrenId, storageId), serialized);
  } catch {
    /* ignore quota / disabled storage */
  }
}
