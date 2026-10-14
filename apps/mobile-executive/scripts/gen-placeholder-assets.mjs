#!/usr/bin/env node
/**
 * Sinh biểu tượng và màn khởi động TẠM cho hai app di động (quyết định 07/10/2026: chưa có logo hay nhận dạng thương hiệu).
 * Chỉ dùng Node thuần: ghi tệp PNG hợp lệ bằng zlib, chữ "M" vẽ bằng hình học (đoạn thẳng có độ dày), không cần gói nào.
 * Đây là bản tạm trung tính, KHÔNG phải logo: thay khi có nhận dạng (docs/ops/mobile-release.md, mục "Biểu tượng tạm").
 *
 * Chạy lại: node apps/mobile-executive/scripts/gen-placeholder-assets.mjs
 * Đầu ra cho mỗi app (apps/mobile-executive/assets và apps/mobile-staff/assets):
 *   icon.png                1024x1024, RGB, KHÔNG có kênh alpha (App Store Connect từ chối biểu tượng có alpha)
 *   adaptive-icon.png       1024x1024, RGBA, nền trong suốt, hình nằm trong vùng an toàn 66% của Android
 *   adaptive-icon-mono.png  như trên, một màu (biểu tượng theo chủ đề của Android 13)
 *   splash-icon.png         1024x1024, RGBA, hình vuông bo góc, góc trong suốt
 *   favicon.png             48x48, RGB (bản web)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const GREEN = [0x1d, 0x5b, 0x43];
const WHITE = [0xff, 0xff, 0xff];
const GOLD = [0xc9, 0xa2, 0x4b];
const SAGE = [0x9f, 0xd0, 0xb8];

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {number} size @param {Uint8Array} pixels  RGBA (4 kênh) hoặc RGB (3 kênh) @param {boolean} alpha */
function encodePng(size, pixels, alpha) {
  const channels = alpha ? 4 : 3;
  const stride = size * channels;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // bộ lọc None
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8 bit mỗi kênh
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Khoảng cách từ điểm tới đoạn thẳng. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Chữ "M" trong hộp đơn vị: hai nét đứng và hai nét chéo gặp nhau ở giữa. `scale` thu nhỏ quanh tâm.
 * Trả về hàm phủ (0..1) của một điểm trong [0,1]².
 */
function letterM({ scale, accent }) {
  const half = 0.5 * scale;
  const left = 0.5 - half * 0.9;
  const right = 0.5 + half * 0.9;
  const top = 0.5 - half * 0.95 - (accent ? 0.04 * scale : 0);
  const bottom = 0.5 + half * 0.7 - (accent ? 0.04 * scale : 0);
  const middleY = top + (bottom - top) * 0.62;
  const thick = 0.085 * scale;
  const segments = [
    [left, bottom, left, top],
    [left, top, 0.5, middleY],
    [0.5, middleY, right, top],
    [right, top, right, bottom],
  ];
  const barTop = bottom + 0.07 * scale;
  return {
    letter: (x, y) => segments.some(([ax, ay, bx, by]) => distanceToSegment(x, y, ax, ay, bx, by) <= thick / 2),
    bar: (x, y) => accent && x >= left - thick / 2 && x <= right + thick / 2 && y >= barTop && y <= barTop + 0.05 * scale,
  };
}

/** Dựng ảnh với lấy mẫu 3x3 để mép mịn. */
function render({ size, background, corner, scale, glyph, bar, alpha }) {
  const channels = alpha ? 4 : 3;
  const pixels = new Uint8Array(size * size * channels);
  const m = letterM({ scale, accent: bar !== null });
  const samples = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inBackground = 0;
      let inLetter = 0;
      let inBar = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / size;
          const v = (y + (sy + 0.5) / samples) / size;
          if (background && insideRounded(u, v, corner)) inBackground += 1;
          if (m.letter(u, v)) inLetter += 1;
          if (bar && m.bar(u, v)) inBar += 1;
        }
      }
      const total = samples * samples;
      // Hợp các lớp: nền, rồi thanh nhấn, rồi chữ, theo độ phủ của từng lớp.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const layer = (colour, coverage) => {
        if (coverage === 0) return;
        const k = coverage / total;
        const outA = k + a * (1 - k);
        r = (colour[0] * k + r * a * (1 - k)) / outA;
        g = (colour[1] * k + g * a * (1 - k)) / outA;
        b = (colour[2] * k + b * a * (1 - k)) / outA;
        a = outA;
      };
      if (background) layer(background, inBackground);
      if (bar) layer(bar, inBar);
      layer(glyph, inLetter);
      const i = (y * size + x) * channels;
      pixels[i] = Math.round(r);
      pixels[i + 1] = Math.round(g);
      pixels[i + 2] = Math.round(b);
      if (alpha) pixels[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, pixels, alpha);
}

/** Hình vuông bo góc trong [0,1]²; corner = 0 là hình vuông. */
function insideRounded(u, v, corner) {
  if (corner <= 0) return true;
  const cx = u < corner ? corner : u > 1 - corner ? 1 - corner : u;
  const cy = v < corner ? corner : v > 1 - corner ? 1 - corner : v;
  return Math.hypot(u - cx, v - cy) <= corner;
}

const here = dirname(fileURLToPath(import.meta.url));
const apps = join(here, '..', '..');
const targets = [
  { app: 'mobile-executive', bar: GOLD },
  { app: 'mobile-staff', bar: SAGE },
];

for (const { app, bar } of targets) {
  const dir = join(apps, app, 'assets');
  mkdirSync(dir, { recursive: true });
  // Biểu tượng 1024: nền xanh đặc phủ kín (hệ điều hành tự bo góc), không alpha.
  writeFileSync(join(dir, 'icon.png'), render({ size: 1024, background: GREEN, corner: 0, scale: 0.62, glyph: WHITE, bar, alpha: false }));
  // Android: lớp trước trong suốt, chữ nhỏ hơn để nằm trong vùng an toàn 66%; nền xanh khai ở app.json (adaptiveIcon.backgroundColor).
  writeFileSync(join(dir, 'adaptive-icon.png'), render({ size: 1024, background: null, corner: 0, scale: 0.5, glyph: WHITE, bar, alpha: true }));
  writeFileSync(join(dir, 'adaptive-icon-mono.png'), render({ size: 1024, background: null, corner: 0, scale: 0.5, glyph: WHITE, bar: WHITE, alpha: true }));
  // Màn khởi động: hình vuông xanh bo góc trên nền kem của app.
  writeFileSync(join(dir, 'splash-icon.png'), render({ size: 1024, background: GREEN, corner: 0.22, scale: 0.55, glyph: WHITE, bar, alpha: true }));
  writeFileSync(join(dir, 'favicon.png'), render({ size: 48, background: GREEN, corner: 0, scale: 0.7, glyph: WHITE, bar, alpha: false }));
  console.log(`đã ghi ${dir}`);
}
