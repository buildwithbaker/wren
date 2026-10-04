// gen-icons.mjs
// Rasterizes the Wren icon to PNG at the sizes the PWA, extension, and CWS
// need. Pure Node (zlib only) - no native image deps so the build is portable.
// Geometry mirrors public/icon.svg: a flat terracotta rounded tile with a cream
// "perched wren" mark (overlapping circles for head/shoulder/body + a cocked
// tail polygon + a pointed beak), a tile-color wing groove carved into the
// breast, and a single indigo eye. Three canvas variants:
//   - standard: 12.5% transparent padding, rounded tile (favicons, PWA "any")
//   - maskable: full-bleed tile, no corner radius (apple-touch icon)
//   - maskable-safe: maskable with the bird shrunk to fit the 40%-radius safe
//     zone, for the manifest's purpose:"maskable" icon (Android adaptive)

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// --- color tokens (mirror public/icon.svg)
const TILE = [0xc2, 0x69, 0x3c]; // #C2693C terracotta tile
const CREAM = [0xf7, 0xef, 0xe1]; // #F7EFE1 wren body
const WING = [0xc2, 0x69, 0x3c]; // wing groove = tile color carved into the breast
const EYE = [0x2b, 0x4a, 0x8b]; // #2B4A8B BwB indigo eye

// --- geometry in 1024-unit tile space (mirrors public/icon.svg viewBox)
const SVG_UNIT = 1024;
const TILE_RADIUS_RATIO = 230 / 1024;
// The tail tip reaches ~0.475 of the tile from centre; launchers may crop to a
// circle of radius 0.40. Scaling the bird by 0.8 brings it to ~0.38.
const MASKABLE_SAFE_GLYPH_SCALE = 0.8;

// Cocked tail and pointed beak are drawn with a round-join stroke of the same
// fill, which optically inflates the polygon; we reproduce that by treating a
// pixel as "inside" when it is within (strokeWidth / 2) of the polygon outline.
const TAIL_UNIT = [
  [632, 548],
  [792, 176],
  [860, 214],
  [724, 600],
];
const TAIL_STROKE_UNIT = 40;
const BEAK_UNIT = [
  [310, 420],
  [150, 470],
  [310, 520],
];
const BEAK_STROKE_UNIT = 18;

const BODY_UNIT = [520, 632, 238]; // cx, cy, r
const SHOULDER_UNIT = [516, 500, 120];
const HEAD_UNIT = [396, 470, 166];
const EYE_UNIT = [352, 456, 30];

// Wing groove: quadratic bezier M452,560 Q600,604 604,736, round-cap stroke 26.
const WING_P0 = [452, 560];
const WING_C = [600, 604];
const WING_P1 = [604, 736];
const WING_STROKE_UNIT = 26;

function flattenQuad(p0, c, p1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    pts.push([
      mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0],
      mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1],
    ]);
  }
  return pts;
}
const WING_POLY_UNIT = flattenQuad(WING_P0, WING_C, WING_P1, 28);

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function inRoundedRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, c) {
  const dx = x - c[0];
  const dy = y - c[1];
  return dx * dx + dy * dy <= c[2] * c[2];
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distToPolygonOutline(x, y, poly) {
  let minD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const d = distToSegment(x, y, poly[i][0], poly[i][1], poly[j][0], poly[j][1]);
    if (d < minD) minD = d;
  }
  return minD;
}

function distToPolyline(x, y, poly) {
  let minD = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = distToSegment(x, y, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
    if (d < minD) minD = d;
  }
  return minD;
}

function buildContext(size, variant) {
  let tileX, tileY, tileW, tileH, tileR;
  if (variant === 'standard') {
    tileX = 0.125 * size;
    tileY = 0.125 * size;
    tileW = 0.75 * size;
    tileH = 0.75 * size;
    tileR = TILE_RADIUS_RATIO * tileW;
  } else {
    tileX = 0;
    tileY = 0;
    tileW = size;
    tileH = size;
    tileR = 0;
  }
  const scale = tileW / SVG_UNIT;
  // Glyph scale about the tile centre (1 except for the safe-zone maskable).
  const g = variant === 'maskable-safe' ? MASKABLE_SAFE_GLYPH_SCALE : 1;
  const half = SVG_UNIT / 2;
  const mx = (px) => tileX + (half + (px - half) * g) * scale;
  const my = (py) => tileY + (half + (py - half) * g) * scale;
  const mapPoly = (poly) => poly.map(([px, py]) => [mx(px), my(py)]);
  const mapCircle = (c) => [mx(c[0]), my(c[1]), c[2] * g * scale];
  const gs = g * scale;
  return {
    tileX, tileY, tileW, tileH, tileR, variant,
    tail: mapPoly(TAIL_UNIT),
    tailR: (TAIL_STROKE_UNIT * gs) / 2,
    beak: mapPoly(BEAK_UNIT),
    beakR: (BEAK_STROKE_UNIT * gs) / 2,
    body: mapCircle(BODY_UNIT),
    shoulder: mapCircle(SHOULDER_UNIT),
    head: mapCircle(HEAD_UNIT),
    eye: mapCircle(EYE_UNIT),
    wing: mapPoly(WING_POLY_UNIT),
    wingR: (WING_STROKE_UNIT * gs) / 2,
  };
}

function samplePixel(x, y, ctx) {
  if (ctx.variant === 'standard') {
    if (!inRoundedRect(x, y, ctx.tileX, ctx.tileY, ctx.tileW, ctx.tileH, ctx.tileR)) return null;
  } else {
    if (x < ctx.tileX || y < ctx.tileY || x > ctx.tileX + ctx.tileW || y > ctx.tileY + ctx.tileH) return null;
  }
  const inTail = pointInPoly(x, y, ctx.tail) || distToPolygonOutline(x, y, ctx.tail) <= ctx.tailR;
  const inBeak = pointInPoly(x, y, ctx.beak) || distToPolygonOutline(x, y, ctx.beak) <= ctx.beakR;
  const inBird =
    inTail ||
    inBeak ||
    inCircle(x, y, ctx.body) ||
    inCircle(x, y, ctx.shoulder) ||
    inCircle(x, y, ctx.head);
  if (inBird) {
    if (inCircle(x, y, ctx.eye)) return EYE;
    if (distToPolyline(x, y, ctx.wing) <= ctx.wingR) return WING;
    return CREAM;
  }
  return TILE;
}

function renderIcon(size, variant, ss = 4) {
  const hi = size * ss;
  const ctx = buildContext(hi, variant);
  const out = new Uint8Array(size * size * 4);
  const n = ss * ss;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let opaque = 0;
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = samplePixel(ox * ss + sx + 0.5, oy * ss + sy + 0.5, ctx);
          if (c) {
            opaque++;
            r += c[0]; g += c[1]; b += c[2];
          }
        }
      }
      const idx = (oy * size + ox) * 4;
      if (opaque > 0) {
        out[idx] = Math.round(r / opaque);
        out[idx + 1] = Math.round(g / opaque);
        out[idx + 2] = Math.round(b / opaque);
        out[idx + 3] = Math.round((255 * opaque) / n);
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

function writePng(path, width, height, rgba) {
  writeFileSync(path, encodePng(width, height, rgba));
  console.log(`  wrote ${path.replace(root + '\\', '').replace(root + '/', '')} (${width}x${height})`);
}

function main() {
  const pub = resolve(root, 'public');
  const extPub = resolve(root, 'extension', 'public');
  ensureDir(pub);
  ensureDir(extPub);
  console.log('Generating Wren icons...');
  const stdSizes = [16, 32, 48, 128, 192, 512, 1024];
  const stdCache = {};
  for (const s of stdSizes) stdCache[s] = renderIcon(s, 'standard');
  writePng(resolve(pub, 'icon-16.png'), 16, 16, stdCache[16]);
  writePng(resolve(pub, 'icon-32.png'), 32, 32, stdCache[32]);
  writePng(resolve(pub, 'icon-48.png'), 48, 48, stdCache[48]);
  writePng(resolve(pub, 'icon-128.png'), 128, 128, stdCache[128]);
  writePng(resolve(pub, 'icon-192.png'), 192, 192, stdCache[192]);
  writePng(resolve(pub, 'icon-512.png'), 512, 512, stdCache[512]);
  writePng(resolve(pub, 'icon-master-1024.png'), 1024, 1024, stdCache[1024]);
  // The extension manifest references only 16/48/128 (and the popup UI loads
  // icon.svg). icon-32.png is unreferenced in the extension, so it is not
  // emitted here (the PWA still gets its public/icon-32.png above).
  writePng(resolve(extPub, 'icon-16.png'), 16, 16, stdCache[16]);
  writePng(resolve(extPub, 'icon-48.png'), 48, 48, stdCache[48]);
  writePng(resolve(extPub, 'icon-128.png'), 128, 128, stdCache[128]);
  const maskable512 = renderIcon(512, 'maskable-safe');
  const appleTouch180 = renderIcon(180, 'maskable');
  writePng(resolve(pub, 'icon-maskable-512.png'), 512, 512, maskable512);
  writePng(resolve(pub, 'apple-touch-icon-180.png'), 180, 180, appleTouch180);
  // public/og-card.png (the share card) carries text, so it is built by
  // scripts/gen-og-card.py and committed; it is not regenerated here.
  console.log('Icons done.');
}

main();
