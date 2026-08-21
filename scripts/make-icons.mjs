// Generate the PWA icons as real PNGs.
//
// Written by hand rather than pulled from a dependency: this needs two files,
// and a raster encoder is about forty lines with node's own zlib. A manifest
// pointing at icons that do not exist means the app cannot be installed to a
// home screen, which is the entire point of a PWA for a vendor.
//
// The mark is the carnet: deep green ground, the gold margin rule down the
// left, and a gold block for the amount that always sits beside it.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const VERT_NUIT = [0x0b, 0x2e, 0x22];
const OR_SIKA = [0xc9, 0xa2, 0x27];
const CRAIE = [0xf4, 0xf1, 0xe8];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode RGB pixel rows as a PNG. */
function png(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0; // filter: none
    p += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
      p += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  // Keep the mark inside the middle ~80% so a maskable crop on Android does
  // not slice the rule off.
  const pad = Math.round(size * 0.22);
  const ruleX = pad;
  const ruleW = Math.max(2, Math.round(size * 0.045));

  const barX = pad + Math.round(size * 0.16);
  const barW = size - barX - pad;
  const barH = Math.max(2, Math.round(size * 0.085));
  const gap = Math.round(barH * 1.15);
  const barTop = Math.round(size * 0.34);

  return (x, y) => {
    // the gold margin rule
    if (x >= ruleX && x < ruleX + ruleW && y >= pad && y < size - pad) return OR_SIKA;

    // three ruled entries beside it, the top one gold (the amount)
    for (let i = 0; i < 3; i += 1) {
      const top = barTop + i * (barH + gap);
      const w = i === 0 ? barW : Math.round(barW * (i === 1 ? 0.72 : 0.5));
      if (y >= top && y < top + barH && x >= barX && x < barX + w) {
        return i === 0 ? OR_SIKA : CRAIE;
      }
    }

    return VERT_NUIT;
  };
}

mkdirSync('public', { recursive: true });

for (const size of [192, 512]) {
  const file = `public/icone-${size}.png`;
  writeFileSync(file, png(size, size, draw(size)));
  console.log(`  wrote ${file}`);
}

console.log('icons generated');
