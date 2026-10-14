/**
 * Dịch vụ hội thoại AI Scribe (SPEC 6, 10.7): nghe (STT), hiểu và gọi tool (LLM), đọc lại (TTS).
 * Mặc định mọi nhà cung cấp là bản giả (STT_PROVIDER, LLM_PROVIDER, TTS_PROVIDER = fake): không cần mạng, không tốn tiền.
 */
import { createProviders } from '@mihato/providers';
import { loadRootEnvFile, readEnv } from './env';
import { createLogger } from './log';
import { createScribeServer } from './server';

loadRootEnvFile();
const env = readEnv();
const log = createLogger();
const providers = createProviders(process.env);
const server = createScribeServer({ env, providers, log });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // stop_grace_period của compose là 30 giây: các phiên đang mở bị đóng, quá 25 giây thì thoát cưỡng bức.
  setTimeout(() => process.exit(1), 25_000).unref();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const port = await server.listen(env.port);
log.info('listening', { port, stt: providers.kinds.stt, llm: providers.kinds.llm, tts: providers.kinds.tts });
// STT giả không có kịch bản: mọi lượt nói bằng giọng báo "nghe chưa rõ" dù micro và mạng đều tốt, rất dễ nhầm là lỗi.
if (providers.kinds.stt === 'fake' && !(process.env.FAKE_STT_SCRIPT ?? '').trim()) log.warn('stt_fake_empty_script', { fix: 'set_STT_PROVIDER_deepgram_or_FAKE_STT_SCRIPT' });
