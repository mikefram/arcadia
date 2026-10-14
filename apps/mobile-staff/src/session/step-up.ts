import { p256 } from '@noble/curves/nist.js';
import { KV_KEYS, type SecureKV } from './kv';

/**
 * Ký thử thách nâng quyền (SPEC 10.2, [GIẢ ĐỊNH, Q16]).
 *
 * Máy chủ nhận `assertion` là JWS compact ES256 có thân là chuỗi thử thách, kiểm bằng khoá công khai
 * (JWK P-256) mà thiết bị gửi lúc `devices.activate` ở trường `stepUpPublicKey`
 * (`stepUp` ở packages/backend/src/auth/service.ts: `importJWK(jwk, 'ES256')` rồi `compactVerify`).
 *
 * App KHÔNG tự viết thuật toán mật mã. Ba cài đặt:
 * - `NobleStepUpSigner` (iOS, Android): ECDSA P-256 và SHA-256 của thư viện đã kiểm toán `@noble/curves`.
 *   Số ngẫu nhiên để sinh khoá lấy từ `expo-crypto`; khoá riêng nằm trong kho an toàn của máy.
 * - `WebCryptoStepUpSigner` (bản web): ECDSA P-256 có sẵn của trình duyệt (`crypto.subtle`).
 * - `UnsupportedStepUpSigner`: không có cả hai. Màn Duyệt khi đó báo việc có số tiền cần duyệt trên web.
 * Phần tự viết ở đây chỉ là mã hoá base64url và ghép ba đoạn của JWS.
 *
 * Cơ chế này vẫn là [GIẢ ĐỊNH, Q16]: khoá riêng là khoá phần mềm lưu trong Keychain hoặc Keystore, chưa phải khoá
 * sinh và giữ trong Secure Enclave hay StrongBox. `NobleStepUpSigner` CHƯA chạy trên máy thật; mới kiểm bằng test
 * (chữ ký kiểm được bằng `jose` đúng như máy chủ làm).
 */
export interface StepUpSigner {
  readonly supported: boolean;
  /** Khoá công khai gửi lúc kích hoạt; tạo cặp khoá nếu chưa có. Null khi không hỗ trợ. */
  publicJwk(): Promise<Record<string, unknown> | null>;
  /** JWS compact ES256 trên chuỗi thử thách. */
  sign(challenge: string): Promise<string>;
}

export class StepUpUnsupportedError extends Error {
  constructor() {
    super('step_up_unsupported');
    this.name = 'StepUpUnsupportedError';
  }
}

export class UnsupportedStepUpSigner implements StepUpSigner {
  readonly supported = false;
  async publicJwk(): Promise<null> {
    return null;
  }
  async sign(): Promise<string> {
    throw new StepUpUnsupportedError();
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64[c & 63];
  }
  return out;
}

/** Giải mã base64url (không đệm). Trả null khi có ký tự lạ. */
export function fromBase64Url(text: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v === -1) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, n);
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** Phần được ký của JWS compact (RFC 7515): base64url(header) + "." + base64url(thân). */
function signingInputOf(challenge: string): string {
  return `${base64Url(utf8(JSON.stringify({ alg: 'ES256' })))}.${base64Url(utf8(challenge))}`;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

type StoredKey = { privateJwk: JsonWebKey; publicJwk: JsonWebKey };

function parseStoredKey(raw: string | null): StoredKey | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const r = v as { privateJwk?: unknown; publicJwk?: unknown };
    if (typeof r.privateJwk !== 'object' || r.privateJwk === null || typeof r.publicJwk !== 'object' || r.publicJwk === null) return null;
    return { privateJwk: r.privateJwk as JsonWebKey, publicJwk: r.publicJwk as JsonWebKey };
  } catch {
    return null;
  }
}

export class WebCryptoStepUpSigner implements StepUpSigner {
  readonly supported = true;

  constructor(
    private readonly subtle: SubtleCrypto,
    private readonly kv: SecureKV,
  ) {}

  private async loadOrCreate(): Promise<StoredKey> {
    const existing = parseStoredKey(await this.kv.get(KV_KEYS.stepUpKey));
    if (existing) return existing;
    const pair = await this.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
    const created: StoredKey = {
      privateJwk: await this.subtle.exportKey('jwk', pair.privateKey),
      publicJwk: await this.subtle.exportKey('jwk', pair.publicKey),
    };
    await this.kv.set(KV_KEYS.stepUpKey, JSON.stringify(created));
    return created;
  }

  async publicJwk(): Promise<Record<string, unknown>> {
    const { publicJwk } = await this.loadOrCreate();
    // Chỉ gửi các trường của khoá công khai P-256.
    return { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
  }

  async sign(challenge: string): Promise<string> {
    const { privateJwk } = await this.loadOrCreate();
    const key = await this.subtle.importKey('jwk', privateJwk, ALGORITHM, false, ['sign']);
    const signingInput = signingInputOf(challenge);
    // WebCrypto trả chữ ký ECDSA dạng r||s 64 byte, đúng dạng JWS ES256 yêu cầu (RFC 7518 mục 3.4).
    const signature = await this.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput));
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  }
}

/** Nguồn số ngẫu nhiên an toàn của hệ điều hành (`getRandomBytes` của expo-crypto). */
export type RandomBytes = (byteCount: number) => Uint8Array;

type EcPublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

/** Khoá công khai P-256 dạng JWK, tính từ khoá riêng: điểm không nén là 0x04 || X (32 byte) || Y (32 byte). */
function publicJwkOf(secretKey: Uint8Array): EcPublicJwk {
  const point = p256.getPublicKey(secretKey, false);
  return { kty: 'EC', crv: 'P-256', x: base64Url(point.slice(1, 33)), y: base64Url(point.slice(33, 65)) };
}

/**
 * Bộ ký cho iOS và Android, nơi Hermes không có `crypto.subtle`: dùng `@noble/curves` (P-256, SHA-256).
 * Khoá lưu cùng dạng với `WebCryptoStepUpSigner` (JWK có `d`), ở cùng khoá của kho an toàn.
 * [GIẢ ĐỊNH, Q16] và CHƯA chạy trên máy thật: xem chú thích đầu tệp.
 */
export class NobleStepUpSigner implements StepUpSigner {
  readonly supported = true;

  constructor(
    private readonly kv: SecureKV,
    private readonly randomBytes: RandomBytes,
  ) {}

  private async loadOrCreate(): Promise<{ secretKey: Uint8Array; publicJwk: EcPublicJwk }> {
    const stored = parseStoredKey(await this.kv.get(KV_KEYS.stepUpKey));
    const d = typeof stored?.privateJwk.d === 'string' ? fromBase64Url(stored.privateJwk.d) : null;
    if (d && p256.utils.isValidSecretKey(d)) return { secretKey: d, publicJwk: publicJwkOf(d) };

    // Sinh khoá: lấy đủ số byte ngẫu nhiên noble yêu cầu từ hệ điều hành, noble đổi thành khoá riêng hợp lệ.
    const secretKey = p256.utils.randomSecretKey(this.randomBytes(p256.lengths.seed ?? 48));
    const publicJwk = publicJwkOf(secretKey);
    const created: StoredKey = { privateJwk: { ...publicJwk, d: base64Url(secretKey) }, publicJwk };
    await this.kv.set(KV_KEYS.stepUpKey, JSON.stringify(created));
    return { secretKey, publicJwk };
  }

  async publicJwk(): Promise<Record<string, unknown>> {
    return { ...(await this.loadOrCreate()).publicJwk };
  }

  async sign(challenge: string): Promise<string> {
    const { secretKey } = await this.loadOrCreate();
    const signingInput = signingInputOf(challenge);
    // `prehash: true`: noble băm SHA-256 trước khi ký. `compact`: chữ ký r||s 64 byte, đúng dạng JWS ES256 (RFC 7518 mục 3.4).
    const signature = p256.sign(utf8(signingInput), secretKey, { prehash: true, format: 'compact' });
    return `${signingInput}.${base64Url(signature)}`;
  }
}

export type StepUpEnvironment = {
  /** `Platform.OS` của React Native */
  platform: string;
  randomBytes?: RandomBytes;
};

/** Chọn bộ ký theo nền tảng: iOS và Android dùng `@noble/curves`, bản web dùng `crypto.subtle`. */
export function createStepUpSigner(kv: SecureKV, env: StepUpEnvironment = { platform: 'web' }): StepUpSigner {
  if ((env.platform === 'ios' || env.platform === 'android') && env.randomBytes) return new NobleStepUpSigner(kv, env.randomBytes);
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  return subtle ? new WebCryptoStepUpSigner(subtle, kv) : new UnsupportedStepUpSigner();
}
