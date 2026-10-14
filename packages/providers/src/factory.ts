/**
 * Chọn bản thật hay bản giả theo biến môi trường (SPEC 6.9, 13.1). Mặc định là bản giả: không cần mạng,
 * không tốn tiền; CI luôn dùng bản giả. Đổi nhà cung cấp là đổi cấu hình, không sửa nghiệp vụ.
 */
import { AnthropicLlm, DEFAULT_LLM_MODEL, FakeLlm, type LlmClient } from './llm';
import { DeepgramStt, FakeStt, type FakeSttUtterance, type SttProvider } from './stt';
import { FakeTts, VbeeTts, type TtsProvider } from './tts';

/** Dạng của `process.env`: chỉ đọc các biến liệt kê ở `.env.example`, cộng `FAKE_STT_SCRIPT` (tuỳ chọn, chỉ cho STT giả). */
export type ProvidersEnv = Readonly<Record<string, string | undefined>>;

export type ProviderKinds = { stt: 'fake' | 'deepgram'; llm: 'fake' | 'anthropic'; tts: 'fake' | 'vbee' };

export type Providers = {
  stt: SttProvider;
  llm: LlmClient;
  tts: TtsProvider;
  /** bản nào đang chạy, để ghi nhật ký lúc khởi động và trả ở /healthz */
  kinds: ProviderKinds;
};

/** Bỏ chú thích cuối dòng kiểu `fake   # fake | deepgram` và khoảng trắng; chữ thường. */
function choice(raw: string | undefined): string {
  return (raw ?? '').split('#')[0]!.trim().toLowerCase() || 'fake';
}

const value = (raw: string | undefined) => (raw ?? '').trim();

/** Cờ bật tắt trong `.env`: `on`, `true`, `1`, `yes` (bỏ chú thích cuối dòng) là bật; mọi giá trị khác, kể cả trống, là tắt. */
function flag(raw: string | undefined): boolean {
  return ['on', 'true', '1', 'yes'].includes((raw ?? '').split('#')[0]!.trim().toLowerCase());
}

/**
 * Kịch bản cho STT giả khi thử tay với app: `FAKE_STT_SCRIPT="tình hình đón đoàn Nhật|đi thúc anh Tuấn|đồng ý"`.
 * Mỗi lượt bấm micro "nghe" được câu kế tiếp (độ tin cậy 0.95), hết thì quay lại từ đầu. Bỏ trống: mọi lượt nói là im lặng,
 * tức nhánh "nghe chưa rõ"; đường gõ chữ vẫn chạy đủ.
 */
function fakeSttScript(raw: string | undefined): FakeSttUtterance[] {
  return value(raw)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((final) => ({ interim: [final.split(' ').slice(0, 2).join(' ')], final, confidence: 0.95 }));
}

/**
 * `FAKE_STT_AUTO_END_CHUNKS=25`: STT giả tự coi người nói đã ngừng sau từng này khối âm thanh (mỗi khối 60 ms từ app) và chốt lượt,
 * như Deepgram báo `UtteranceEnd`. Có nó thì chế độ trò chuyện của app chạy trọn vòng (nói, ngừng, trợ lý trả lời, nghe tiếp) mà
 * không cần Deepgram. Bỏ trống: lượt nói chỉ chốt khi người dùng bấm "Đã nói xong" hoặc dừng trò chuyện.
 */
function fakeSttAutoEnd(raw: string | undefined): number | undefined {
  const n = Number((raw ?? '').split('#')[0]!.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function createProviders(env: ProvidersEnv): Providers {
  const sttKind = choice(env.STT_PROVIDER);
  const llmKind = choice(env.LLM_PROVIDER);
  const ttsKind = choice(env.TTS_PROVIDER);

  let stt: SttProvider;
  if (sttKind === 'fake') {
    const autoEndAfterChunks = fakeSttAutoEnd(env.FAKE_STT_AUTO_END_CHUNKS);
    stt = new FakeStt(fakeSttScript(env.FAKE_STT_SCRIPT), { loop: true, ...(autoEndAfterChunks ? { autoEndAfterChunks } : {}) });
  }
  // DEEPGRAM_KEYTERMS mặc định tắt: đo thật ngày 04/10/2026, từ 3 từ khoá trở lên thì tiếng Việt không nhận ra chữ nào.
  else if (sttKind === 'deepgram') stt = new DeepgramStt({ apiKey: value(env.DEEPGRAM_API_KEY), useKeyterms: flag(env.DEEPGRAM_KEYTERMS) });
  // Vbee STT (SPEC 6.2, dự phòng) chưa cài: đưa vào bài đo ở Giai đoạn 0 rồi mới dựng.
  else throw new Error(`STT_PROVIDER không hợp lệ hoặc chưa được cài: ${sttKind}`);

  let llm: LlmClient;
  if (llmKind === 'fake') llm = new FakeLlm();
  else if (llmKind === 'anthropic') {
    if (!value(env.ANTHROPIC_API_KEY)) throw new Error('AnthropicLlm: thiếu ANTHROPIC_API_KEY');
    llm = new AnthropicLlm({ apiKey: value(env.ANTHROPIC_API_KEY), model: value(env.LLM_MODEL) || DEFAULT_LLM_MODEL });
  } else throw new Error(`LLM_PROVIDER không hợp lệ: ${llmKind}`);

  let tts: TtsProvider;
  if (ttsKind === 'fake') tts = new FakeTts();
  else if (ttsKind === 'vbee') tts = new VbeeTts({ appId: value(env.VBEE_APP_ID), token: value(env.VBEE_TOKEN) });
  else throw new Error(`TTS_PROVIDER không hợp lệ: ${ttsKind}`);

  return { stt, llm, tts, kinds: { stt: sttKind, llm: llmKind, tts: ttsKind } };
}
