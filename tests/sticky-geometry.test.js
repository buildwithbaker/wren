// Unit tests for the pure sticky-window helpers: geometry parse/validate/
// serialize/round-trip + key derivation (src/sticky/geometry.js), the open-
// sticky registry parser (src/sticky/registry.js), and the URL/feature/name
// builders (src/sticky/opener.js). All pure — no DOM / localStorage needed.
import { describe, it, expect } from 'vitest';
import {
  geomStorageKey,
  isValidGeometry,
  parseGeometry,
  serializeGeometry,
  geometryEquals,
  physicalToLogicalGeometry,
  readTauriGeometry,
} from '../src/sticky/geometry.js';
import { parseRegistry } from '../src/sticky/registry.js';
import {
  parseStickyParams,
  buildStickyUrl,
  stickyWindowName,
  buildStickyFeatures,
} from '../src/sticky/opener.js';

describe('geomStorageKey', () => {
  it('keys by wrenId when present', () => {
    expect(geomStorageKey('wren-abc', 'note.md')).toBe('wren.sticky.geom.wren-abc');
  });
  it('falls back to the storage id when wrenId is empty', () => {
    expect(geomStorageKey('', 'note.md')).toBe('wren.sticky.geom.id:note.md');
  });
});

describe('isValidGeometry', () => {
  it('accepts a well-formed geometry', () => {
    expect(isValidGeometry({ x: 0, y: 0, w: 320, h: 360 })).toBe(true);
  });
  it('allows negative positions (multi-monitor) but not non-positive sizes', () => {
    expect(isValidGeometry({ x: -1920, y: -100, w: 320, h: 360 })).toBe(true);
    expect(isValidGeometry({ x: 0, y: 0, w: 0, h: 360 })).toBe(false);
    expect(isValidGeometry({ x: 0, y: 0, w: 320, h: -1 })).toBe(false);
  });
  it('rejects missing / non-finite / non-object input', () => {
    expect(isValidGeometry(null)).toBe(false);
    expect(isValidGeometry({ x: 0, y: 0, w: 320 })).toBe(false);
    expect(isValidGeometry({ x: NaN, y: 0, w: 320, h: 360 })).toBe(false);
    expect(isValidGeometry({ x: Infinity, y: 0, w: 320, h: 360 })).toBe(false);
  });
});

describe('parseGeometry / serializeGeometry round-trip', () => {
  it('round-trips a valid geometry, rounding to whole pixels', () => {
    const g = { x: 100.4, y: 200.6, w: 320.2, h: 360.9 };
    const serialized = serializeGeometry(g);
    expect(parseGeometry(serialized)).toEqual({ x: 100, y: 201, w: 320, h: 361 });
  });
  it('returns null for malformed / missing / invalid JSON', () => {
    expect(parseGeometry(null)).toBeNull();
    expect(parseGeometry('')).toBeNull();
    expect(parseGeometry('not json')).toBeNull();
    expect(parseGeometry('{"x":0,"y":0,"w":0,"h":0}')).toBeNull();
    expect(parseGeometry('[1,2,3]')).toBeNull();
  });
  it('coerces numeric strings and drops extra keys', () => {
    expect(parseGeometry('{"x":"10","y":"20","w":"320","h":"360","junk":1}')).toEqual({
      x: 10,
      y: 20,
      w: 320,
      h: 360,
    });
  });
  it('serializeGeometry returns null for invalid input', () => {
    expect(serializeGeometry({ x: 0, y: 0, w: 0, h: 0 })).toBeNull();
  });
});

describe('geometryEquals', () => {
  it('treats sub-pixel differences as equal', () => {
    expect(geometryEquals({ x: 0.2, y: 0, w: 320, h: 360 }, { x: 0.4, y: 0, w: 320, h: 360 })).toBe(true);
  });
  it('detects a real move', () => {
    expect(geometryEquals({ x: 0, y: 0, w: 320, h: 360 }, { x: 40, y: 0, w: 320, h: 360 })).toBe(false);
  });
});

describe('parseRegistry', () => {
  it('parses a clean list of entries', () => {
    const raw = JSON.stringify([
      { wrenId: 'wren-a', id: 'a.md' },
      { wrenId: '', id: 'b.md' },
    ]);
    expect(parseRegistry(raw)).toEqual([
      { wrenId: 'wren-a', id: 'a.md' },
      { wrenId: '', id: 'b.md' },
    ]);
  });
  it('drops entries with no id and de-dupes by id (last wins)', () => {
    const raw = JSON.stringify([
      { wrenId: 'old', id: 'a.md' },
      { id: '' },
      { foo: 'bar' },
      { wrenId: 'new', id: 'a.md' },
    ]);
    expect(parseRegistry(raw)).toEqual([{ wrenId: 'new', id: 'a.md' }]);
  });
  it('returns [] for malformed / missing input', () => {
    expect(parseRegistry(null)).toEqual([]);
    expect(parseRegistry('')).toEqual([]);
    expect(parseRegistry('not json')).toEqual([]);
    expect(parseRegistry('{"not":"an array"}')).toEqual([]);
  });
});

describe('opener — pure URL / name / feature builders', () => {
  it('parseStickyParams extracts storageId + wrenId, or null without note', () => {
    expect(parseStickyParams('?note=a.md&wid=wren-1')).toEqual({ storageId: 'a.md', wrenId: 'wren-1' });
    expect(parseStickyParams('?note=a.md')).toEqual({ storageId: 'a.md', wrenId: '' });
    expect(parseStickyParams('')).toBeNull();
    expect(parseStickyParams('?foo=bar')).toBeNull();
  });
  it('buildStickyUrl encodes both ids and replaces the prior query', () => {
    const url = buildStickyUrl('2026 - My Note.md', 'wren-xyz', 'https://wren.example/app/?old=1');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('note')).toBe('2026 - My Note.md');
    expect(parsed.searchParams.get('wid')).toBe('wren-xyz');
    expect(parsed.searchParams.get('old')).toBeNull(); // prior query dropped
  });
  it('buildStickyUrl omits wid when wrenId is empty', () => {
    const url = buildStickyUrl('a.md', '', 'https://wren.example/');
    expect(new URL(url).searchParams.get('wid')).toBeNull();
  });
  it('stickyWindowName keys by wrenId, falling back to storage id', () => {
    expect(stickyWindowName('wren-1', 'a.md')).toBe('wren-sticky-wren-1');
    expect(stickyWindowName('', 'a.md')).toBe('wren-sticky-a.md');
  });
  it('buildStickyFeatures builds a popup feature string with rounded geometry', () => {
    expect(buildStickyFeatures({ x: 10.6, y: 20.2, w: 320, h: 360 })).toBe(
      'popup=yes,width=320,height=360,left=11,top=20'
    );
  });
});

// --- Tauri native-window geometry (sticky reopen drift, 2026-10-22) ---------
//
// A mock native window: built from the LOGICAL options that WebviewWindow takes
// (x, y, width, height), it stores PHYSICAL pixels (logical * scale, rounded
// like a real window manager does) and reports them the way Tauri's
// outerPosition / innerSize / scaleFactor do.
function mockNativeWindow({ x, y, width, height }, scale) {
  const px = { x: Math.round(x * scale), y: Math.round(y * scale) };
  const sz = { width: Math.round(width * scale), height: Math.round(height * scale) };
  return {
    outerPosition: async () => px,
    innerSize: async () => sz,
    scaleFactor: async () => scale,
  };
}

describe('physicalToLogicalGeometry', () => {
  it('is the identity at scale 1', () => {
    expect(
      physicalToLogicalGeometry({
        position: { x: 120, y: 80 },
        size: { width: 432, height: 486 },
        scaleFactor: 1,
      })
    ).toEqual({ x: 120, y: 80, w: 432, h: 486 });
  });

  it.each([1.25, 1.5, 2.0])('divides physical pixels by the scale factor (%s)', (scale) => {
    const g = physicalToLogicalGeometry({
      position: { x: 300 * scale, y: 200 * scale },
      size: { width: 432 * scale, height: 486 * scale },
      scaleFactor: scale,
    });
    expect(g.x).toBeCloseTo(300, 6);
    expect(g.y).toBeCloseTo(200, 6);
    expect(g.w).toBeCloseTo(432, 6);
    expect(g.h).toBeCloseTo(486, 6);
  });

  it('keeps negative positions (monitor left of / above the primary)', () => {
    const g = physicalToLogicalGeometry({
      position: { x: -1920, y: -40 },
      size: { width: 400, height: 500 },
      scaleFactor: 1,
    });
    expect(g).toEqual({ x: -1920, y: -40, w: 400, h: 500 });
  });

  it('treats a missing or non-positive scale factor as 1', () => {
    for (const scaleFactor of [undefined, 0, -2, NaN]) {
      expect(
        physicalToLogicalGeometry({
          position: { x: 10, y: 20 },
          size: { width: 300, height: 400 },
          scaleFactor,
        })
      ).toEqual({ x: 10, y: 20, w: 300, h: 400 });
    }
  });

  it('returns null for an unusable size instead of a garbage geometry', () => {
    expect(
      physicalToLogicalGeometry({ position: { x: 0, y: 0 }, size: { width: 0, height: 0 }, scaleFactor: 1 })
    ).toBeNull();
    expect(physicalToLogicalGeometry({ position: null, size: null, scaleFactor: 1 })).toBeNull();
  });
});

describe('sticky save -> restore round trip (Tauri)', () => {
  // Save the window's state exactly as the sticky does (read -> serialize ->
  // localStorage string -> parse), then restore through WebviewWindow options.
  async function cycle(win) {
    const logical = await readTauriGeometry(win);
    return parseGeometry(serializeGeometry(logical));
  }

  it.each([1.0, 1.25, 1.5, 2.0])('reopens at the same x/y/w/h at scale %s', async (scale) => {
    const start = { x: 340, y: 215, width: 432, height: 486 };
    let win = mockNativeWindow(start, scale);
    // Ten save/restore cycles: nothing may creep.
    for (let i = 0; i < 10; i++) {
      const saved = await cycle(win);
      expect(saved).toEqual({ x: 340, y: 215, w: 432, h: 486 });
      win = mockNativeWindow({ x: saved.x, y: saved.y, width: saved.w, height: saved.h }, scale);
    }
  });

  it('returns null from readTauriGeometry when the window reports nothing usable', async () => {
    const win = {
      outerPosition: async () => ({ x: 0, y: 0 }),
      innerSize: async () => ({ width: 0, height: 0 }),
      scaleFactor: async () => 1,
    };
    expect(await readTauriGeometry(win)).toBeNull();
  });

  // Model of the OLD behaviour: the webview's window.screenY sits one chrome
  // offset below the native window's outer origin, but the stored value was fed
  // straight back in as the outer position. Every cycle therefore drifted by the
  // offset. This pins the model, NOT the real WebView2 numbers (still to be
  // confirmed on a desktop smoke test).
  it('models why saving window.screenX/Y drifted, and that outerPosition does not', async () => {
    const CHROME = 31; // ~ a title bar's height in logical px
    let outerY = 200;
    for (let i = 0; i < 3; i++) {
      const screenY = outerY + CHROME; // what the webview reported
      outerY = screenY; // restored as the OUTER position
    }
    expect(outerY).toBe(200 + 3 * CHROME); // drifted

    let win = mockNativeWindow({ x: 100, y: 200, width: 400, height: 500 }, 1.5);
    for (let i = 0; i < 3; i++) {
      const saved = await cycle(win);
      win = mockNativeWindow({ x: saved.x, y: saved.y, width: saved.w, height: saved.h }, 1.5);
    }
    expect((await readTauriGeometry(win)).y).toBe(200); // stable
  });

  it('still loads geometry saved by earlier versions (same stored shape)', () => {
    const legacy = '{"x":512,"y":144,"w":432,"h":486}';
    expect(parseGeometry(legacy)).toEqual({ x: 512, y: 144, w: 432, h: 486 });
  });
});
