import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { SignJWT, exportJWK, importJWK, importPKCS8, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Khoá ký token phiên Scribe (SPEC 10.7.1). Ở production khoá riêng ES256 nằm ở SCRIBE_JWT_PRIVATE_KEY (PEM PKCS8);
 * dịch vụ scribe chỉ nhận khoá công khai qua GET /internal/v1/jwks.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('khoá ký token phiên Scribe', () => {
  it('đọc khoá riêng PEM PKCS8 từ biến môi trường (kể cả khi xuống dòng viết thành "\\n") và phát đúng khoá công khai', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    vi.stubEnv('SCRIBE_JWT_PRIVATE_KEY', pem.trim().replace(/\n/g, '\\n'));
    vi.resetModules();
    const { scribePublicJwk } = await import('../src/services/scribe');

    const jwk = await scribePublicJwk();
    const expected = await exportJWK(createPublicKey(privateKey));
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', x: expected.x, y: expected.y, alg: 'ES256', use: 'sig' });
    expect(jwk.kid).toMatch(/^[\w-]{43}$/);
    // Khoá công khai không bao giờ mang thành phần bí mật.
    expect(jwk).not.toHaveProperty('d');
    expect(await scribePublicJwk()).toEqual(jwk);

    // Token ký bằng khoá riêng đó kiểm được bằng JWK vừa phát; token ký bằng khoá khác thì không.
    const signed = await new SignJWT({ scope: 'scribe' }).setProtectedHeader({ alg: 'ES256' }).setExpirationTime('2m').sign(await importPKCS8(pem, 'ES256'));
    expect((await jwtVerify(signed, await importJWK(jwk, 'ES256'), { algorithms: ['ES256'] })).payload.scope).toBe('scribe');
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const forged = await new SignJWT({ scope: 'scribe' }).setProtectedHeader({ alg: 'ES256' }).setExpirationTime('2m').sign(await importPKCS8(stranger, 'ES256'));
    await expect(jwtVerify(forged, await importJWK(jwk, 'ES256'), { algorithms: ['ES256'] })).rejects.toThrow();
  });

  it('không có biến môi trường ở môi trường thử: sinh khoá tạm, ổn định trong suốt tiến trình', async () => {
    vi.stubEnv('SCRIBE_JWT_PRIVATE_KEY', '');
    vi.resetModules();
    const { scribePublicJwk } = await import('../src/services/scribe');
    const a = await scribePublicJwk();
    expect(a).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(await scribePublicJwk()).toEqual(a);
  });
});
