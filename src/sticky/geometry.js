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
 * Convert a Tauri window's PHYSICAL position/size into the LOGICAL geometry we
 * store and hand back to `new WebviewWindow({ x, y, width, height })`. Pure.
 *
 * Which pair round-trips (@tauri-apps/api 2.11 docs + WebviewWindowOptions):
 *   - x / y are "in logical pixels" and place the window's OUTER top-left, the
 *     same point `outerPosition()` reports (relative to the desktop, physical).
 *     `innerPosition()` is the client-area origin and would drift by the frame
 *     / title-bar offset on every save -> restore cycle.
 *   - width / height are the initial INNER (client) size in logical pixels, so
 *     the matching source is `innerSize()`. For a frameless sticky outer and
 *     inner sizes coincide; reading inner keeps the round trip exact either way.
 * `window.screenX/Y/outerWidth/outerHeight` are NOT used on Tauri: they come
 * from the embedded webview, not from the native window Tauri positions.
 *
 * Logical = physical / scaleFactor. A missing / non-positive scaleFactor is
 * treated as 1.
 *
 * @param {{ position:{x:number,y:number}, size:{width:number,height:number}, scaleFactor:number }} p
 * @returns {{x:number,y:number,w:number,h:number}|null} null when the result is invalid
 */
export function physicalToLogicalGeometry({ position, size, scaleFactor }) {
  const f = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  if (!position || !size) return null;
  const g = {
    x: position.x / f,
    y: position.y / f,
    w: size.width / f,
    h: size.height / f,
  };
  return isValidGeometry(g) ? g : null;
}

/**
 * Read the current geometry of a Tauri window-like object (anything with
 * outerPosition / innerSize / scaleFactor, e.g. getCurrentWindow()) as stored
 * logical geometry. Takes the window as an argument so it needs no Tauri import
 * and is unit-testable with a mock. Resolves null when the geometry is invalid.
 *
 * @param {{ outerPosition():Promise<{x:number,y:number}>, innerSize():Promise<{width:number,height:number}>, scaleFactor():Promise<number> }} win
 */
export async function readTauriGeometry(win) {
  const [position, size, scaleFactor] = await Promise.all([
    win.outerPosition(),
    win.innerSize(),
    win.scaleFactor(),
  ]);
  return physicalToLogicalGeometry({ position, size, scaleFactor });
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
