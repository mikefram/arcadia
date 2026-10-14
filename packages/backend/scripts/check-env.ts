import { ProductionEnvError } from '../src/env-check';
import { assertRuntime, env } from '../src/env';

/**
 * pnpm env:check (và deploy/scripts/check-env.sh, trong container `check-env`): kiểm cấu hình đầy đủ trước khi triển khai.
 * Ở production kiểm MỌI điều kiện (địa chỉ https/wss, khoá đủ mạnh, khoá ES256, nhà cung cấp thật và khoá API, ba địa chỉ CSDL,
 * thư mục tệp ghi được). Ngoài production chỉ báo môi trường hiện tại. Không in giá trị nào.
 */
try {
  assertRuntime('check');
  if (!env.isProd) console.log(`NODE_ENV=${env.nodeEnv}: không phải production, không kiểm cấu hình triển khai.`);
  else {
    console.log('Cấu hình production hợp lệ.');
    console.log(`  tên miền web: ${new URL(env.webOrigin).host}; kho tệp: ${env.fileStorageDir}`);
    console.log(`  nhà cung cấp: stt=${env.providers.stt} llm=${env.providers.llm} tts=${env.providers.tts} push=${env.providers.push}; Scribe ${env.scribeEnabled ? 'bật' : 'tắt'}; TOTP ${env.enforceMfa ? 'bắt buộc' : 'KHÔNG bắt buộc'}`);
  }
} catch (err) {
  console.error(err instanceof ProductionEnvError || err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
