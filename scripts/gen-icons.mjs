// gen-icons.mjs
// Rasterizes the Wren icon to PNG at the sizes the PWA, extension, and CWS
// need. Pure Node (zlib only) - no native image deps so the build is portable.
// Geometry mirrors public/icon.svg: chestnut gradient rounded tile with a
// white sticky-note glyph (pentagon body + folded corner flap), a 2px black
// outline, and a compact bold "W" lettermark (indigo fill, 2-unit black
// outline) centered inside the note body. Two canvas variants:
//   - standard: 12.5% transparent padding, rounded tile (favicons, PWA "any")
//   - maskable: full-bleed tile, no corner radius (Android adaptive + apple-touch)

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// --- color tokens (see wren-sow.md)
const TOP_STOP = [0xa8, 0x78, 0x52]; // #A87852 lifted chestnut
const BOTTOM_STOP = [0x8b, 0x5e, 0x3c]; // #8B5E3C --wr-accent
const WHITE = [0xff, 0xff, 0xff];
const FLAP_FILL = [0xf7, 0xf0, 0xea]; // #F7F0EA --wr-accent-soft
const STROKE = [0x0f, 0x16, 0x26]; // #0F1626 near-black
const W_FILL = [0x2b, 0x4a, 0x8b]; // #2B4A8B BwB umbrella indigo (W lettermark)

// --- SVG-space geometry (192-unit inner group, mirrors public/icon.svg)
const SVG_UNIT = 192;
const TILE_RADIUS_UNIT = 42;
const STROKE_WIDTH_UNIT = 2;

const PENTAGON_UNIT = [
  [54, 50],
  [111, 50],
  [142, 81],
  [142, 146],
  [54, 146],
];
const FLAP_UNIT = [
  [111, 50],
  [142, 81],
  [111, 81],
];

// Compact bold W lettermark, centered at x=98 (note body visual center).
// Rendered as two stacked stroked polylines: black underlay + indigo overlay.
const W_POLYLINE_UNIT = [
  [76, 96],
  [87, 130],
  [98, 110],
  [109, 130],
  [120, 96],
];
const W_OUTER_STROKE_UNIT = 17;
const W_INNER_STROKE_UNIT = 13;

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

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function gradientColor(t) {
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return [
    Math.round(lerp(TOP_STOP[0], BOTTOM_STOP[0], t)),
    Math.round(lerp(TOP_STOP[1], BOTTOM_STOP[1], t)),
    Math.round(lerp(TOP_STOP[2], BOTTOM_STOP[2], t)),
  ];
}

function buildContext(size, variant) {
  let tileX, tileY, tileW, tileH, tileR;
  if (variant === 'standard') {
    tileX = 0.125 * size;
    tileY = 0.125 * size;
    tileW = 0.75 * size;
    tileH = 0.75 * size;
    tileR = 0.22 * tileW;
  } else {
    tileX = 0;
    tileY = 0;
    tileW = size;
    tileH = size;
    tileR = 0;
  }
  const scale = tileW / SVG_UNIT;
  const mapPoly = (poly) => poly.map(([px, py]) => [tileX + px * scale, tileY + py * scale]);
  return {
    tileX, tileY, tileW, tileH, tileR,
    pentagon: mapPoly(PENTAGON_UNIT),
    flap: mapPoly(FLAP_UNIT),
    wPolyline: mapPoly(W_POLYLINE_UNIT),
    wOuterR: (W_OUTER_STROKE_UNIT * scale) / 2,
    wInnerR: (W_INNER_STROKE_UNIT * scale) / 2,
    strokeR: (STROKE_WIDTH_UNIT * scale) / 2,
    variant,
  };
}

function samplePixel(x, y, ctx) {
  if (ctx.variant === 'standard') {
    if (!inRoundedRect(x, y, ctx.tileX, ctx.tileY, ctx.tileW, ctx.tileH, ctx.tileR)) return null;
  } else {
    if (x < ctx.tileX || y < ctx.tileY || x > ctx.tileX + ctx.tileW || y > ctx.tileY + ctx.tileH) return null;
  }
  const dPent = distToPolygonOutline(x, y, ctx.pentagon);
  const dFlap = distToPolygonOutline(x, y, ctx.flap);
  if (dPent <= ctx.strokeR || dFlap <= ctx.strokeR) return STROKE;
  if (pointInPoly(x, y, ctx.flap)) return FLAP_FILL;
  if (pointInPoly(x, y, ctx.pentagon)) {
    const dW = distToPolyline(x, y, ctx.wPolyline);
    if (dW <= ctx.wInnerR) return W_FILL;
    if (dW <= ctx.wOuterR) return STROKE;
    return WHITE;
  }
  const t = (y - ctx.tileY) / ctx.tileH;
  return gradientColor(t);
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

function renderOgCard(w, h, ss = 3) {
  const hiW = w * ss;
  const hiH = h * ss;
  const out = new Uint8Array(hiW * hiH * 4);
  for (let y = 0; y < hiH; y++) {
    const [gr, gg, gb] = gradientColor(y / hiH);
    for (let x = 0; x < hiW; x++) {
      const idx = (y * hiW + x) * 4;
      out[idx] = gr; out[idx + 1] = gg; out[idx + 2] = gb; out[idx + 3] = 255;
    }
  }
  const noteH = 0.5 * hiH;
  const noteW = noteH * (88 / 96);
  const bx = (hiW - noteW) / 2;
  const by = (hiH - noteH) / 2;
  const sx = noteW / 88;
  const sy = noteH / 96;
  const mapTo = (poly) => poly.map(([px, py]) => [bx + (px - 54) * sx, by + (py - 50) * sy]);
  const pent = mapTo(PENTAGON_UNIT);
  const flap = mapTo(FLAP_UNIT);
  const wPoly = mapTo(W_POLYLINE_UNIT);
  const strokeR = (STROKE_WIDTH_UNIT * sx) / 2;
  const wOuterR = (W_OUTER_STROKE_UNIT * sx) / 2;
  const wInnerR = (W_INNER_STROKE_UNIT * sx) / 2;
  const halfStep = 1 / ss;
  for (let y = Math.floor(by) - 2; y < Math.ceil(by + noteH) + 2; y++) {
    for (let x = Math.floor(bx) - 2; x < Math.ceil(bx + noteW) + 2; x++) {
      let opaque = 0;
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const sxp = x + (dx + 0.5) * halfStep;
          const syp = y + (dy + 0.5) * halfStep;
          const dPent = distToPolygonOutline(sxp, syp, pent);
          const dFlap = distToPolygonOutline(sxp, syp, flap);
          let c = null;
          if (dPent <= strokeR || dFlap <= strokeR) c = STROKE;
          else if (pointInPoly(sxp, syp, flap)) c = FLAP_FILL;
          else if (pointInPoly(sxp, syp, pent)) {
            const dW = distToPolyline(sxp, syp, wPoly);
            if (dW <= wInnerR) c = W_FILL;
            else if (dW <= wOuterR) c = STROKE;
            else c = WHITE;
          }
          if (c) { opaque++; r += c[0]; g += c[1]; b += c[2]; }
        }
      }
      if (opaque > 0 && x >= 0 && y >= 0 && x < hiW && y < hiH) {
        const idx = (y * hiW + x) * 4;
        const a = opaque / (ss * ss);
        out[idx] = Math.round(out[idx] * (1 - a) + (r / opaque) * a);
        out[idx + 1] = Math.round(out[idx + 1] * (1 - a) + (g / opaque) * a);
        out[idx + 2] = Math.round(out[idx + 2] * (1 - a) + (b / opaque) * a);
      }
    }
  }
  const ruleY = by + noteH + hiH * 0.06;
  const ruleH = Math.max(2, hiH * 0.012);
  const ruleW = noteW * 0.8;
  const rxr = (hiW - ruleW) / 2;
  for (let y = Math.floor(ruleY); y < ruleY + ruleH; y++) {
    for (let x = Math.floor(rxr); x < rxr + ruleW; x++) {
      if (x < 0 || y < 0 || x >= hiW || y >= hiH) continue;
      const idx = (y * hiW + x) * 4;
      out[idx] = FLAP_FILL[0]; out[idx + 1] = FLAP_FILL[1]; out[idx + 2] = FLAP_FILL[2]; out[idx + 3] = 255;
    }
  }
  return boxDownsampleBuffer(out, hiW, hiH, ss);
}

function boxDownsampleBuffer(buf, hiW, hiH, ss) {
  const w = hiW / ss;
  const h = hiH / ss;
  const out = new Uint8Array(w * h * 4);
  const n = ss * ss;
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const idx = ((oy * ss + sy) * hiW + (ox * ss + sx)) * 4;
          r += buf[idx]; g += buf[idx + 1]; b += buf[idx + 2]; a += buf[idx + 3];
        }
      }
      const o = (oy * w + ox) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
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

function encodeIco(entries) {
  const dirSize = 6 + entries.length * 16;
  let offset = dirSize;
  const dir = Buffer.alloc(dirSize);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const off = 6 + i * 16;
    dir[off + 0] = e.size === 256 ? 0 : e.size;
    dir[off + 1] = e.size === 256 ? 0 : e.size;
    dir[off + 2] = 0; dir[off + 3] = 0;
    dir.writeUInt16LE(1, off + 4);
    dir.writeUInt16LE(32, off + 6);
    dir.writeUInt32LE(e.png.length, off + 8);
    dir.writeUInt32LE(offset, off + 12);
    offset += e.png.length;
  }
  return Buffer.concat([dir, ...entries.map((e) => e.png)]);
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
  const maskable512 = renderIcon(512, 'maskable');
  const appleTouch180 = renderIcon(180, 'maskable');
  writePng(resolve(pub, 'icon-maskable-512.png'), 512, 512, maskable512);
  writePng(resolve(pub, 'apple-touch-icon-180.png'), 180, 180, appleTouch180);
  const ico = encodeIco([
    { size: 16, png: encodePng(16, 16, stdCache[16]) },
    { size: 32, png: encodePng(32, 32, stdCache[32]) },
    { size: 48, png: encodePng(48, 48, stdCache[48]) },
  ]);
  const icoPath = resolve(root, 'favicon.ico');
  writeFileSync(icoPath, ico);
  console.log(`  wrote ${icoPath.replace(root + '\\', '').replace(root + '/', '')} (16+32+48)`);
  const og = renderOgCard(1200, 630);
  writePng(resolve(pub, 'og-card.png'), 1200, 630, og);
  console.log('Icons done.');
}

main();
