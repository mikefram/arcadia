/**
 * Cấu hình của dịch vụ scribe. Tự đọc `process.env`: scribe KHÔNG nhập `@mihato/backend` và không truy cập CSDL
 * (SPEC 3.1, 10.7.1); mọi dữ liệu đi qua giao diện nội bộ của API.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ScribeEnv = {
  nodeEnv: string;
  port: number;
  apiInternalUrl: string;
  /** service token của ai_service, phạm vi read và propose (SPEC 10.7.1) */
  internalServiceToken: string;
  llmEffort: 'low' | 'medium';
  /** ngưỡng độ tin cậy STT: dưới ngưỡng thì trả câu "nghe chưa rõ", không gọi LLM (SPEC 6.6) */
  voiceConfirmMinConfidence: number;
  /** giọng mặc định khi người dùng chưa chọn */
  defaultVoice: string;
  /** điểm xuất phát 1200 đến 1500 ms [GIẢ ĐỊNH], chỉnh theo bài đo ở SPEC 6.2.1 */
  utteranceEndMs: number;
};

/** Bỏ chú thích cuối dòng kiểu `low   # low | medium` mà một số trình nạp .env để nguyên. */
const clean = (raw: string | undefined) => (raw ?? '').split('#')[0]!.trim();

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/** Nạp `.env` ở gốc repo nếu có (môi trường phát triển). Biến đã đặt sẵn trong môi trường được giữ nguyên. */
export function loadRootEnvFile(): void {
  // Production chỉ đọc biến môi trường thật (compose nạp từ tệp ngoài repo), không nhặt tệp .env nằm sót.
  if (process.env.NODE_ENV === 'production') return;
  const file = join(repoRoot(), '.env');
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {}
}

const MIN_TOKEN_LENGTH = 32;

/**
 * Luật cấu hình production của scribe (cùng luật với packages/backend/src/env-check.ts; scribe không nhập @mihato/backend).
 * Chỉ nêu TÊN biến, không in giá trị.
 */
export function productionProblems(source: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  const token = (source.INTERNAL_SERVICE_TOKEN ?? '').trim();
  if (!token) problems.push('INTERNAL_SERVICE_TOKEN: thiếu');
  else {
    if (token.length < MIN_TOKEN_LENGTH) problems.push(`INTERNAL_SERVICE_TOKEN: ngắn hơn ${MIN_TOKEN_LENGTH} ký tự`);
    if (/dev-|change-me|changeme|example|placeholder/i.test(token)) problems.push('INTERNAL_SERVICE_TOKEN: còn là giá trị mẫu hoặc giá trị của máy phát triển');
  }
  const apiUrl = clean(source.API_INTERNAL_URL);
  if (!apiUrl) problems.push('API_INTERNAL_URL: thiếu (địa chỉ nội bộ của api, ví dụ http://api:3100)');
  const fakeOk = clean(source.ALLOW_FAKE_PROVIDERS).toLowerCase() === 'true';
  const fake = ['STT_PROVIDER', 'LLM_PROVIDER', 'TTS_PROVIDER'].filter((n) => (clean(source[n]).toLowerCase() || 'fake') === 'fake');
  if (fake.length > 0 && !fakeOk) problems.push(`${fake.join(', ')}: đang là fake (kể cả để trống) ở production; đặt nhà cung cấp thật, hoặc ALLOW_FAKE_PROVIDERS=true chỉ cho staging`);
  return problems;
}

export function readEnv(source: Readonly<Record<string, string | undefined>> = process.env): ScribeEnv {
  const nodeEnv = clean(source.NODE_ENV) || 'development';
  if (nodeEnv === 'production') {
    const problems = productionProblems(source);
    if (problems.length > 0) throw new Error(`Cấu hình production của scribe không hợp lệ (${problems.length} lỗi):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  const token = clean(source.INTERNAL_SERVICE_TOKEN);
  const effort = clean(source.LLM_EFFORT) || 'low';
  if (effort !== 'low' && effort !== 'medium') throw new Error(`LLM_EFFORT phải là low hoặc medium (SPEC 6.3), nhận "${effort}"`);
  const confidence = Number(clean(source.VOICE_CONFIRM_MIN_CONFIDENCE) || 0.8);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('VOICE_CONFIRM_MIN_CONFIDENCE phải nằm trong khoảng 0 đến 1');
  return {
    nodeEnv,
    port: Number(clean(source.SCRIBE_PORT) || 3200),
    apiInternalUrl: (clean(source.API_INTERNAL_URL) || 'http://127.0.0.1:3100').replace(/\/+$/, ''),
    internalServiceToken: token || 'dev-internal-service-token-change-me',
    llmEffort: effort,
    voiceConfirmMinConfidence: confidence,
    defaultVoice: clean(source.VBEE_VOICE),
    utteranceEndMs: Number(clean(source.STT_UTTERANCE_END_MS) || 1300),
  };
}
