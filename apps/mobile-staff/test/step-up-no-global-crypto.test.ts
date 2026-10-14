import { compactVerify, importJWK, type JWK } from 'jose';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createMemoryKV } from '../src/session/kv';

/**
 * Hermes trên iOS và Android không có `globalThis.crypto`. Tệp này nạp bộ ký khi `crypto` toàn cục vắng mặt
 * (như trên máy thật), để chắc rằng `NobleStepUpSigner` chỉ cần số ngẫu nhiên được truyền vào (expo-crypto):
 * sinh khoá, xuất JWK và ký đều không đụng tới `crypto.getRandomValues` toàn cục.
 * Đây vẫn là mô phỏng trong Node, chưa phải chạy trên máy thật.
 */
const realCrypto = globalThis.crypto;
const randomBytes = (byteCount: number) => realCrypto.getRandomValues(new Uint8Array(byteCount));

describe('NobleStepUpSigner khi không có crypto toàn cục (như Hermes)', () => {
  afterAll(() => vi.unstubAllGlobals());

  it('vẫn sinh khoá và ký được; chữ ký kiểm được bằng jose', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(globalThis.crypto).toBeUndefined();

    // Nạp @noble/curves lần đầu trong điều kiện này.
    const { NobleStepUpSigner, createStepUpSigner, UnsupportedStepUpSigner } = await import('../src/session/step-up');
    const signer = createStepUpSigner(createMemoryKV(), { platform: 'android', randomBytes });
    expect(signer).toBeInstanceOf(NobleStepUpSigner);
    // Không có crypto.subtle và không phải iOS hay Android: báo chưa hỗ trợ, không ký bừa.
    expect(createStepUpSigner(createMemoryKV(), { platform: 'web' })).toBeInstanceOf(UnsupportedStepUpSigner);

    const challenge = 'thu-thach.cua-may-chu.60-giay';
    const jwk = await signer.publicJwk();
    const assertion = await signer.sign(challenge);
    // RFC 6979: cùng khoá, cùng thông điệp thì cùng chữ ký, vì không cần số ngẫu nhiên lúc ký.
    expect(await signer.sign(challenge)).toBe(assertion);

    vi.unstubAllGlobals();
    const { payload } = await compactVerify(assertion, await importJWK(jwk as JWK, 'ES256'), { algorithms: ['ES256'] });
    expect(new TextDecoder().decode(payload)).toBe(challenge);
  });
});
