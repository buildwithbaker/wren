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
