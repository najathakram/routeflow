// Zero-dependency PNG icon generator (node:zlib + CRC32): a rounded brand-blue square with a white
// "R" and "F" drawn from rectangles. Generated at runtime, so no image is committed to git.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const BRAND = [0x24, 0x56, 0xd6];
const WHITE = [255, 255, 255];

// "RF" mark as rectangles in a 100x100 unit square: [x, y, w, h].
const MARK = [
  [22, 25, 9, 50],
  [31, 25, 17, 9],
  [31, 46, 17, 9],
  [48, 30, 9, 20],
  [40, 55, 9, 9],
  [49, 64, 9, 11],
  [62, 25, 9, 50],
  [71, 25, 15, 9],
  [71, 46, 11, 9],
];

/** Returns a PNG Buffer of a size x size icon. `full` = no rounded corners (apple-touch). */
export function renderIcon(size, { full = false } = {}) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = full ? 0 : size * 0.22;
  const u = size / 100;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let a = 255;
      const dx = Math.max(r - x - 0.5, x + 0.5 - (size - r), 0);
      const dy = Math.max(r - y - 0.5, y + 0.5 - (size - r), 0);
      if (r > 0 && Math.hypot(dx, dy) > r) a = 0;
      let col = BRAND;
      for (const [mx, my, mw, mh] of MARK) {
        if (x >= mx * u && x < (mx + mw) * u && y >= my * u && y < (my + mh) * u) col = WHITE;
      }
      const o = row + 1 + x * 4;
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
