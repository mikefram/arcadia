import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { SignJWT, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { ApiError } from '@mihato/domain';
import { clock } from '../clock';
import { env } from '../env';

/**
 * LỚP XÁC THỰC TẠM (Q12, docs/DECISIONS.md). Không tự viết thuật toán mật mã: Argon2id qua
 * @node-rs/argon2, JWT qua jose, TOTP qua otplib. Phần quản lý phiên là mã tự viết và phải được thay
 * hoặc rà soát sau việc S1-10 trước khi dùng cho dữ liệu thật.
 */

export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Token mờ dạng `<orgId>.<ngẫu nhiên>`: phần đầu cho biết tổ chức để đặt app.org_id trước khi tra bằng băm. */
export function newOpaqueToken(orgId: string): string {
  return `${orgId}.${randomBytes(32).toString('base64url')}`;
}

export function orgOfToken(token: string): string | null {
  const i = token.indexOf('.');
  if (i !== 36) return null;
  const org = token.slice(0, 36);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(org) ? org : null;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Argon2id, tham số theo khuyến nghị OWASP (19 MiB, 2 vòng, 1 luồng); kiểm lại khi chốt thư viện. */
export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password);
  } catch {
    return false;
  }
}

const key = new TextEncoder().encode(env.authSecret);

export type TokenAudience = 'access' | 'mfa' | 'stepup' | 'stepup-challenge';

/** JWT HS256 nội bộ của API. `aud` tách loại token để token loại này không dùng được ở chỗ loại khác. */
export async function signToken(aud: TokenAudience, claims: JWTPayload, ttlSeconds: number): Promise<{ token: string; expiresAt: Date }> {
  const nowSec = Math.floor(clock.now().getTime() / 1000);
  const exp = nowSec + ttlSeconds;
  const token = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setAudience(aud).setIssuedAt(nowSec).setExpirationTime(exp).sign(key);
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyToken(aud: TokenAudience, token: string): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, key, { audience: aud, algorithms: ['HS256'], currentDate: clock.now() });
    return payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new ApiError(aud === 'access' ? 'token_expired' : aud === 'stepup' ? 'step_up_required' : 'unauthenticated');
    throw new ApiError(aud === 'stepup' ? 'step_up_required' : 'unauthenticated');
  }
}
