/**
 * ID của hệ thống (SPEC 3.5): UUID v7 sinh ở ứng dụng.
 * Engine là hàm thuần nên không được sinh số ngẫu nhiên; các dòng do engine tạo ra
 * (step_runs) dùng UUID v5 dẫn xuất từ (runId, nodeId, attempt) để phát lại cho đúng từng bit.
 * Tệp này không phụ thuộc Node hay thư viện ngoài để chạy được trên web và React Native.
 */

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push((i + 0x100).toString(16).slice(1));

function format(b: Uint8Array): string {
  const h = (i: number) => HEX[b[i]!]!;
  return (
    h(0) + h(1) + h(2) + h(3) + '-' + h(4) + h(5) + '-' + h(6) + h(7) + '-' + h(8) + h(9) + '-' +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  );
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(out);
  } else {
    // React Native cũ không có crypto.getRandomValues. ID chỉ cần duy nhất, không cần bí mật.
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/** UUID v7: 48 bit thời gian (ms) + 74 bit ngẫu nhiên. */
export function newId(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  const ts = Math.floor(nowMs);
  b[0] = Math.floor(ts / 2 ** 40) & 0xff;
  b[1] = Math.floor(ts / 2 ** 32) & 0xff;
  b[2] = Math.floor(ts / 2 ** 24) & 0xff;
  b[3] = Math.floor(ts / 2 ** 16) & 0xff;
  b[4] = Math.floor(ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return format(b);
}

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

function sha1(msg: Uint8Array): Uint8Array {
  const ml = msg.length;
  const padded = new Uint8Array((((ml + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[ml] = 0x80;
  const bits = ml * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0);
  ov.setUint32(4, h1);
  ov.setUint32(8, h2);
  ov.setUint32(12, h3);
  ov.setUint32(16, h4);
  return out;
}

function parse(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('uuid không hợp lệ');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Không gian tên riêng của hệ thống cho mọi ID dẫn xuất. */
export const MIHATO_NAMESPACE = '6d696861-746f-5f64-8965-756861696e68';

/** UUID v5 (RFC 4122) theo tên: cùng đầu vào luôn cho cùng ID. Hàm thuần. */
export function deterministicId(name: string, namespace: string = MIHATO_NAMESPACE): string {
  const ns = parse(namespace);
  const nameBytes = utf8(name);
  const buf = new Uint8Array(16 + nameBytes.length);
  buf.set(ns);
  buf.set(nameBytes, 16);
  const hash = sha1(buf).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return format(hash);
}

/** ID của một dòng step_runs: ổn định theo (lượt chạy, nút, lần thử). */
export function stepRunId(runId: string, nodeId: string, attempt: number): string {
  return deterministicId(`step:${runId}:${nodeId}:${attempt}`);
}

/** eventId của từng mục trong thao tác hàng loạt: UUID v5 của (khoá chống lặp, stepId) (SPEC 10.5). */
export function batchEventId(idempotencyKey: string, stepId: string): string {
  return deterministicId(`batch:${idempotencyKey}:${stepId}`);
}
