/**
 * Kiểm token phiên Scribe (SPEC 10.7.1): JWT ký bất đối xứng ES256, sống 120 giây, dùng một lần, `scope: 'scribe'`.
 * Khoá công khai lấy từ `GET /internal/v1/jwks` của API và đệm 10 phút. Token này không gọi được endpoint công khai nào;
 * việc "dùng một lần" do API giữ qua `claim` (409 nếu đã dùng).
 */
import { createLocalJWKSet, errors, type JSONWebKeySet, jwtVerify } from 'jose';

export type SessionClaims = {
  sessionId: string;
  jti: string;
  /** người dùng (sub) và tổ chức (org) ghi trong token; gửi kèm `claim` và đối chiếu lại với kết quả */
  userId: string;
  orgId: string;
};

export type TokenErrorCode = 'expired' | 'invalid' | 'wrong_scope' | 'jwks_unavailable';

export class TokenError extends Error {
  constructor(readonly code: TokenErrorCode) {
    super(`token:${code}`);
    this.name = 'TokenError';
  }
}

export type TokenVerifierOptions = {
  fetchJwks: () => Promise<JSONWebKeySet>;
  /** thời gian đệm bộ khoá; mặc định 10 phút */
  cacheMs?: number;
  /** khoảng tối thiểu giữa hai lần tải lại khi gặp khoá lạ, để token rác không kéo sập API */
  minRefetchMs?: number;
  now?: () => number;
};

export class SessionTokenVerifier {
  private cached: { keys: ReturnType<typeof createLocalJWKSet>; at: number } | null = null;
  private loading: Promise<ReturnType<typeof createLocalJWKSet>> | null = null;
  private readonly cacheMs: number;
  private readonly minRefetchMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: TokenVerifierOptions) {
    this.cacheMs = opts.cacheMs ?? 10 * 60_000;
    this.minRefetchMs = opts.minRefetchMs ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  private async keys(force: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
    const fresh = this.cached && this.now() - this.cached.at < this.cacheMs;
    if (this.cached && fresh && !force) return this.cached.keys;
    if (this.cached && force && this.now() - this.cached.at < this.minRefetchMs) return this.cached.keys;
    this.loading ??= this.opts
      .fetchJwks()
      .then((jwks) => {
        const keys = createLocalJWKSet(jwks);
        this.cached = { keys, at: this.now() };
        return keys;
      })
      .finally(() => {
        this.loading = null;
      });
    try {
      return await this.loading;
    } catch {
      // API tạm không trả lời: dùng tiếp bộ khoá cũ nếu còn, vì khoá hiếm khi đổi.
      if (this.cached) return this.cached.keys;
      throw new TokenError('jwks_unavailable');
    }
  }

  async verify(token: string): Promise<SessionClaims> {
    const check = async (force: boolean) => jwtVerify(token, await this.keys(force), { algorithms: ['ES256'], requiredClaims: ['exp', 'jti', 'sub'], clockTolerance: 2 });
    let payload: Awaited<ReturnType<typeof check>>['payload'];
    try {
      try {
        ({ payload } = await check(false));
      } catch (err) {
        // Khoá vừa được xoay vòng: tải lại bộ khoá một lần rồi thử lại.
        if (!(err instanceof errors.JWKSNoMatchingKey)) throw err;
        ({ payload } = await check(true));
      }
    } catch (err) {
      if (err instanceof TokenError) throw err;
      if (err instanceof errors.JWTExpired) throw new TokenError('expired');
      throw new TokenError('invalid');
    }
    if (payload.scope !== 'scribe') throw new TokenError('wrong_scope');
    if (typeof payload.org !== 'string' || !payload.org) throw new TokenError('invalid');
    // API đặt `jti` bằng id phiên (packages/backend/src/services/scribe.ts); `claim` kiểm lại hai giá trị này khớp nhau.
    const jti = payload.jti as string;
    return { sessionId: jti, jti, userId: payload.sub as string, orgId: payload.org };
  }
}
