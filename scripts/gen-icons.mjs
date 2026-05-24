// gen-icons.mjs
// Rasterizes the Wren icon to PNG at the sizes the PWA, extension, and CWS
// need. Pure Node (zlib only) - no native image deps so the build is portable.
// Geometry mirrors public/icon.svg: indigo rounded square + white note with a
// folded top-right corner.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const INDIGO = [0x2b, 0x4a, 0x8b];
const WHITE = [0xff, 0xff, 0xff];
const FLAP = [0xae, 0xc3, 0xea];

// --- geometry helpers -------------------------------------------------------

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1];
    const xj = poly[j][0],
      yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Note polygons (pentagon body + folded-corner flap) inside a box.
function notePolys(x, y, w, h) {
  const f = 0.28; // fold size as fraction of the box
  const foldX = x + (1 - f) * w;
  const foldY = y + f * h;
  const pentagon = [
    [x, y],
    [foldX, y],
    [x + w, foldY],
    [x + w, y + h],
    [x, y + h],
  ];
  const flap = [
    [foldX, y],
    [x + w, foldY],
    [foldX, foldY],
  ];
  return { pentagon, flap };
}

// --- renderers (supersampled for anti-aliasing) ----------------------------

// Returns straight-alpha RGBA Uint8Array of size*size.
function renderIcon(size, ss = 4) {
  const hi = size * ss;
  const r = 0.22 * hi;
  const box = { x: 0.28 * hi, y: 0.26 * hi, w: 0.46 * hi, h: 0.5 * hi };
  const { pentagon, flap } = notePolys(box.x, box.y, box.w, box.h);

  const sample = (x, y) => {
    // painter order: bg(transparent) -> indigo tile -> white note -> light-indigo flap
    let c = null;
    if (inRoundedRect(x, y, hi, hi, r)) c = INDIGO;
    if (pointInPoly(x, y, pentagon)) c = WHITE;
    if (pointInPoly(x, y, flap)) c = FLAP;
    return c;
  };

  return downsample(size, ss, sample);
}

// Open Graph card: indigo field with the white note mark centered. (No baked
// text - rendering a wordmark needs a font engine; see build report.)
function renderOgCard(w, h, ss = 3) {
  const hiW = w * ss;
  const hiH = h * ss;
  const out = new Uint8Array(hiW * hiH * 4);

  // fill indigo field
  for (let i = 0; i < hiW * hiH; i++) {
    out[i * 4] = INDIGO[0];
    out[i * 4 + 1] = INDIGO[1];
    out[i * 4 + 2] = INDIGO[2];
    out[i * 4 + 3] = 255;
  }

  // centered note mark
  const noteH = 0.5 * hiH;
  const noteW = noteH * 0.92;
  const bx = (hiW - noteW) / 2;
  const by = (hiH - noteH) / 2;
  const { pentagon, flap } = notePolys(bx, by, noteW, noteH);

  for (let y = Math.floor(by); y < Math.ceil(by + noteH); y++) {
    for (let x = Math.floor(bx); x < Math.ceil(bx + noteW); x++) {
      let c = null;
      if (pointInPoly(x + 0.5, y + 0.5, pentagon)) c = WHITE;
      if (pointInPoly(x + 0.5, y + 0.5, flap)) c = FLAP;
      if (c) {
        const idx = (y * hiW + x) * 4;
        out[idx] = c[0];
        out[idx + 1] = c[1];
        out[idx + 2] = c[2];
        out[idx + 3] = 255;
      }
    }
  }

  // accent rule under the mark
  const ruleY = by + noteH + hiH * 0.06;
  const ruleH = Math.max(2, hiH * 0.012);
  const ruleW = noteW * 0.8;
  const rx = (hiW - ruleW) / 2;
  for (let y = Math.floor(ruleY); y < ruleY + ruleH; y++) {
    for (let x = Math.floor(rx); x < rx + ruleW; x++) {
      const idx = (y * hiW + x) * 4;
      out[idx] = FLAP[0];
      out[idx + 1] = FLAP[1];
      out[idx + 2] = FLAP[2];
      out[idx + 3] = 255;
    }
  }

  return boxDownsampleBuffer(out, hiW, hiH, ss);
}

// Generic downsampler for sampled (function-based) renders.
function downsample(size, ss, sample) {
  const out = new Uint8Array(size * size * 4);
  const n = ss * ss;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let opaque = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(ox * ss + sx + 0.5, oy * ss + sy + 0.5);
          if (c) {
            opaque++;
            r += c[0];
            g += c[1];
            b += c[2];
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

// Box downsampler for buffer-based renders (og card).
function boxDownsampleBuffer(buf, hiW, hiH, ss) {
  const w = hiW / ss;
  const h = hiH / ss;
  const out = new Uint8Array(w * h * 4);
  const n = ss * ss;
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const idx = ((oy * ss + sy) * hiW + (ox * ss + sx)) * 4;
          r += buf[idx];
          g += buf[idx + 1];
          b += buf[idx + 2];
          a += buf[idx + 3];
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

// --- PNG encoder ------------------------------------------------------------

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- write outputs ----------------------------------------------------------

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

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

  const sizes = [16, 32, 48, 128, 192, 512];
  const cache = {};
  for (const s of sizes) cache[s] = renderIcon(s);

  // PWA + favicons
  writePng(resolve(pub, 'icon-16.png'), 16, 16, cache[16]);
  writePng(resolve(pub, 'icon-32.png'), 32, 32, cache[32]);
  writePng(resolve(pub, 'icon-48.png'), 48, 48, cache[48]);
  writePng(resolve(pub, 'icon-128.png'), 128, 128, cache[128]);
  writePng(resolve(pub, 'icon-192.png'), 192, 192, cache[192]);
  writePng(resolve(pub, 'icon-512.png'), 512, 512, cache[512]);

  // Extension icons (CWS requires 128; 16/48 recommended)
  writePng(resolve(extPub, 'icon-16.png'), 16, 16, cache[16]);
  writePng(resolve(extPub, 'icon-48.png'), 48, 48, cache[48]);
  writePng(resolve(extPub, 'icon-128.png'), 128, 128, cache[128]);

  // Open Graph card
  const og = renderOgCard(1200, 630);
  writePng(resolve(pub, 'og-card.png'), 1200, 630, og);

  console.log('Icons done.');
}

main();
