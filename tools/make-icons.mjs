// One-off generator for the PWA raster icons.
// Re-run with: node tools/make-icons.mjs
// The geometry mirrors public/favicon.svg so the installed app icon matches
// the in-page favicon.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const BG = [0x4f, 0x46, 0xe5]; // indigo-600, matches favicon.svg
const CLOUD = [0xf8, 0xfa, 0xfc]; // slate-50
const RAIN = [0xc7, 0xd2, 0xfe]; // indigo-200

const SS = 3; // supersampling factor for antialiasing

// ---- shapes, all in the SVG's 64x64 user-space -------------------------
const roundRect = (x, y, w, h, r) => (px, py) => {
  const cx = Math.max(x + r, Math.min(x + w - r, px));
  const cy = Math.max(y + r, Math.min(y + h - r, py));
  return Math.hypot(px - cx, py - cy) <= r;
};

const circle = (cx, cy, r) => (px, py) => Math.hypot(px - cx, py - cy) <= r;

const capsule = (x1, y1, x2, y2, r) => (px, py) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) <= r;
};

// Paint order mirrors the SVG: background, cloud body, rain streaks.
const art = [
  { shape: roundRect(0, 0, 64, 64, 14), color: BG },
  { shape: circle(24, 27, 9), color: CLOUD },
  { shape: circle(37, 25, 11), color: CLOUD },
  { shape: circle(46, 31, 7.5), color: CLOUD },
  { shape: roundRect(18, 29, 29, 9, 4.5), color: CLOUD },
  { shape: capsule(24, 45, 21, 54, 1.75), color: RAIN },
  { shape: capsule(33, 45, 30, 54, 1.75), color: RAIN },
  { shape: capsule(42, 45, 39, 54, 1.75), color: RAIN },
];

/**
 * @param {number} size    output pixel size
 * @param {object} opts
 * @param {boolean} opts.maskable  full-bleed background, content inside the
 *                                 80% safe zone (Android adaptive icons)
 * @param {boolean} opts.opaque    forbid transparency (Apple touch icons)
 */
function render(size, { maskable = false, opaque = false } = {}) {
  const px = new Uint8ClampedArray(size * size * 4);
  const step = 1 / SS;
  // maskable: bleed the background to the edges and shrink the art to 66%,
  // which keeps every pixel inside the safe circle Android may crop to.
  const scale = maskable ? 0.66 : opaque ? 0.92 : 1;
  const offset = (64 * (1 - scale)) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = ((x + (sx + 0.5) * step) / size) * 64;
          const uy = ((y + (sy + 0.5) * step) / size) * 64;
          // sample point -> user space, undoing the content transform
          const uxf = (ux - offset) / scale;
          const uyf = (uy - offset) / scale;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const { shape, color } of art) {
            if (shape(uxf, uyf)) {
              cr = color[0];
              cg = color[1];
              cb = color[2];
              ca = 255;
            }
          }
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const total = SS * SS;
      const i = (y * size + x) * 4;
      const alpha = a / total;
      if (alpha > 0) {
        // un-premultiply so edges keep their colour
        px[i] = r / a;
        px[i + 1] = g / a;
        px[i + 2] = b / a;
      }
      px[i + 3] = opaque ? 255 : alpha;
    }
  }
  return px;
}

// ---- minimal PNG encoder (RGBA8, no interlace) -------------------------
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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // rows prefixed with filter byte 0 (None)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- emit --------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192, opts: {} },
  { file: "icon-512.png", size: 512, opts: {} },
  { file: "icon-maskable-192.png", size: 192, opts: { maskable: true } },
  { file: "icon-maskable-512.png", size: 512, opts: { maskable: true } },
  { file: "apple-touch-icon.png", size: 180, opts: { opaque: true } },
];

for (const { file, size, opts } of targets) {
  const png = encodePng(render(size, opts), size);
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
}