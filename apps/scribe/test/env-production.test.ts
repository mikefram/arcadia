import { describe, expect, it } from 'vitest';
import { productionProblems, readEnv } from '../src/env';

const good = {
  NODE_ENV: 'production',
  INTERNAL_SERVICE_TOKEN: 'Zx9Cv8Bn7Mq6Ws5Ed4Rf3Tg2Yh1Uj0Ik9Ol8Ap7Sd6Fg5Hj4Kl',
  API_INTERNAL_URL: 'http://api:3100',
  STT_PROVIDER: 'deepgram',
  LLM_PROVIDER: 'anthropic',
  TTS_PROVIDER: 'vbee',
};

describe('cấu hình production của scribe', () => {
  it('đủ và đúng thì đọc được', () => {
    expect(productionProblems(good)).toEqual([]);
    expect(readEnv(good).internalServiceToken).toBe(good.INTERNAL_SERVICE_TOKEN);
  });

  it('INTERNAL_SERVICE_TOKEN thiếu, ngắn hay là giá trị dev thì không khởi động', () => {
    expect(() => readEnv({ ...good, INTERNAL_SERVICE_TOKEN: '' })).toThrow(/INTERNAL_SERVICE_TOKEN: thiếu/);
    expect(() => readEnv({ ...good, INTERNAL_SERVICE_TOKEN: 'ngan' })).toThrow(/ngắn hơn 32/);
    expect(() => readEnv({ ...good, INTERNAL_SERVICE_TOKEN: 'dev-internal-service-token-change-me' })).toThrow(/giá trị mẫu/);
  });

  it('nhà cung cấp fake (kể cả trống) bị từ chối nếu không có ALLOW_FAKE_PROVIDERS=true', () => {
    expect(() => readEnv({ ...good, STT_PROVIDER: 'fake', TTS_PROVIDER: '' })).toThrow(/STT_PROVIDER, TTS_PROVIDER/);
    expect(() => readEnv({ ...good, STT_PROVIDER: 'fake', ALLOW_FAKE_PROVIDERS: 'true' })).not.toThrow();
  });

  it('thông báo lỗi không chứa giá trị token', () => {
    try {
      readEnv({ ...good, INTERNAL_SERVICE_TOKEN: 'dev-bi-mat-rat-dac-biet' });
      throw new Error('phải ném lỗi');
    } catch (err) {
      expect(String(err)).not.toContain('dev-bi-mat-rat-dac-biet');
    }
  });

  it('ngoài production vẫn dùng token dev mặc định', () => {
    expect(readEnv({ NODE_ENV: 'development' }).internalServiceToken).toBe('dev-internal-service-token-change-me');
  });
});
