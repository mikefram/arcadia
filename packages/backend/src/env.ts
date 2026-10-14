import { accessSync, constants, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductionEnvError, allowFakeProviders, cleanValue, productionEnvProblems, scribeEnabled } from './env-check';

/** Gốc repo: thư mục có pnpm-workspace.yaml. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const root = repoRoot();
// Production chỉ đọc biến môi trường thật (docker compose nạp từ tệp ngoài repo): không nhặt một tệp .env nằm sót trong ảnh hay thư mục chạy.
if (process.env.NODE_ENV !== 'production') {
  const envFile = join(root, '.env');
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {}
  }
}

const e = process.env;
const isTest = e.NODE_ENV === 'test' || e.VITEST !== undefined;
const isProd = e.NODE_ENV === 'production';

// Ở production, cấu hình sai thì không khởi động và nói rõ sai ở đâu (chỉ tên biến, không in giá trị). Các biến kết nối CSDL
// kiểm hình dạng ở đây; việc có đủ biến theo vai trò của tiến trình kiểm ở assertRuntime().
if (isProd) {
  const problems = productionEnvProblems(e);
  if (problems.length > 0) throw new ProductionEnvError(problems);
}
const port = e.PG_PORT ?? '5455';
const dbName = isTest ? 'mihato_test' : 'mihato_dev';
const local = (user: string, pass: string) => `postgres://${user}:${pass}@127.0.0.1:${port}/${dbName}`;

function pick(name: string, prod: string | undefined, test: string | undefined, fallback: string): string {
  const v = isTest ? test : prod;
  if (v) return v;
  if (isProd) throw new Error(`Thiếu biến môi trường ${name} ở môi trường production`);
  return fallback;
}

/** Cấu hình bắt buộc ở production (địa chỉ web và API đi vào liên kết gửi cho người dùng). */
function required(name: string, devDefault: string): string {
  const v = e[name];
  if (v) return v;
  if (isProd) throw new Error(`Thiếu biến môi trường ${name} ở môi trường production`);
  return devDefault;
}

function secret(name: string, devDefault: string): string {
  const v = e[name];
  if (v) return v;
  if (isProd) throw new Error(`Thiếu biến môi trường ${name} ở môi trường production`);
  return devDefault;
}

type ProviderChoice<T extends string> = T | 'fake';

export const env = {
  root,
  nodeEnv: e.NODE_ENV ?? 'development',
  isProd,
  isTest,
  // Ba địa chỉ CSDL đọc lười (getter): mỗi tiến trình chỉ cần và chỉ được cấp địa chỉ của vai trò mình (api không cần
  // app_owner và app_scan; migrate không cần app_user). Thiếu ở production thì báo lỗi nêu tên biến ngay lần dùng đầu tiên,
  // và assertRuntime() kiểm trước khi nhận việc.
  /** app_user: API và worker khi xử lý một tổ chức; chịu RLS */
  get databaseUrl(): string {
    return pick('DATABASE_URL', e.DATABASE_URL, e.TEST_DATABASE_URL, local('app_user', 'app_user_dev'));
  },
  /** app_owner: chỉ để chạy migration; không dùng lúc chạy */
  get databaseUrlOwner(): string {
    return pick('DATABASE_URL_OWNER', e.DATABASE_URL_OWNER, e.TEST_DATABASE_URL_OWNER, local('app_owner', 'app_owner_dev'));
  },
  /** app_scan: BYPASSRLS, chỉ SELECT và UPDATE trên timers, effects */
  get databaseUrlScan(): string {
    return pick('DATABASE_URL_SCAN', e.DATABASE_URL_SCAN, e.TEST_DATABASE_URL_SCAN, local('app_scan', 'app_scan_dev'));
  },
  /**
   * Thư mục lưu tệp đính kèm trên đĩa của máy chủ (docs/DECISIONS.md, 06/10/2026). Tạm thời cho tới khi có kho đối tượng
   * tương thích S3 (SPEC 12, Q9); production phải trỏ vào ổ có sao lưu. Test dùng thư mục riêng.
   */
  fileStorageDir: e.FILE_STORAGE_DIR ?? join(root, isTest ? 'storage-test' : 'storage'),
  apiPort: Number(e.API_PORT ?? e.PORT ?? 3100),
  scribePort: Number(e.SCRIBE_PORT ?? 3200),
  webOrigin: required('WEB_ORIGIN', 'http://localhost:5273'),
  /**
   * Nguồn (origin) khác web quản trị được gọi API từ trình duyệt, phân cách bằng dấu phẩy. Dùng để thử bản web của app
   * (Expo web, cổng 8081). Ở phát triển mặc định là cổng đó; ở production mặc định trống: app thật không chạy trong trình duyệt.
   */
  corsExtraOrigins: (e.CORS_EXTRA_ORIGINS ?? (isProd ? '' : 'http://localhost:8081,http://127.0.0.1:8081'))
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ''),
  publicApiUrl: required('PUBLIC_API_URL', 'http://localhost:3100'),
  publicScribeWsUrl: required('PUBLIC_SCRIBE_WS_URL', 'ws://localhost:3200/scribe/ws'),
  apiInternalUrl: e.API_INTERNAL_URL ?? 'http://127.0.0.1:3100',
  /** service token của ai_service, phạm vi read và propose (SPEC 10.7.1) */
  internalServiceToken: secret('INTERNAL_SERVICE_TOKEN', 'dev-internal-service-token-change-me'),
  /** ký access token, mfaToken, stepUpToken (HS256) */
  authSecret: secret('AUTH_SECRET', 'dev-auth-secret-change-me-0123456789abcdef'),
  /** có dùng trợ lý (Scribe) không; tắt thì không đòi SCRIBE_JWT_PRIVATE_KEY ở production */
  scribeEnabled: scribeEnabled(e),
  /** cho phép nhà cung cấp fake ở production: chỉ staging */
  allowFakeProviders: allowFakeProviders(e),
  /** khoá riêng ES256 (PKCS8 PEM) ký token phiên Scribe; trống thì sinh tạm khi khởi động (chỉ phát triển) */
  scribeJwtPrivateKey: e.SCRIBE_JWT_PRIVATE_KEY ?? '',
  providers: {
    stt: (cleanValue(e.STT_PROVIDER).toLowerCase() || 'fake') as ProviderChoice<'deepgram' | 'vbee'>,
    llm: (cleanValue(e.LLM_PROVIDER).toLowerCase() || 'fake') as ProviderChoice<'anthropic'>,
    tts: (cleanValue(e.TTS_PROVIDER).toLowerCase() || 'fake') as ProviderChoice<'vbee'>,
    push: (cleanValue(e.PUSH_PROVIDER).toLowerCase() || 'fake') as ProviderChoice<'expo'>,
    email: (cleanValue(e.EMAIL_PROVIDER).toLowerCase() || 'fake') as ProviderChoice<'resend'>,
  },
  llmModel: e.LLM_MODEL ?? 'claude-sonnet-5-5',
  llmEffort: (e.LLM_EFFORT ?? 'low') as 'low' | 'medium',
  anthropicApiKey: e.ANTHROPIC_API_KEY ?? '',
  deepgramApiKey: e.DEEPGRAM_API_KEY ?? '',
  vbeeAppId: e.VBEE_APP_ID ?? '',
  vbeeToken: e.VBEE_TOKEN ?? '',
  vbeeVoice: e.VBEE_VOICE ?? '',
  expoAccessToken: e.EXPO_ACCESS_TOKEN ?? '',
  /**
   * Cấu hình thư DỰ PHÒNG theo máy chủ. Cách chính là đặt ở web quản trị (Cài đặt → Gửi thư), lưu mã hoá trong CSDL theo
   * từng tổ chức; các biến này chỉ dùng khi tổ chức chưa đặt gì.
   */
  resendApiKey: e.RESEND_API_KEY ?? '',
  emailFrom: e.EMAIL_FROM ?? '',
  /** khoá mã hoá bí mật lưu trong CSDL (khoá API thư của tổ chức); trống thì dẫn xuất từ AUTH_SECRET */
  secretsEncryptionKey: e.SECRETS_ENCRYPTION_KEY ?? '',
  voiceConfirmMinConfidence: Number(e.VOICE_CONFIRM_MIN_CONFIDENCE ?? 0.8),
  /** đường dẫn app dùng cho liên kết kích hoạt và liên kết sâu */
  appScheme: e.APP_SCHEME ?? 'mihato',
  /**
   * Bắt buộc TOTP cho it_admin, office_admin, process_designer ở phiên web (SPEC 11.2): chưa bật TOTP thì chỉ được
   * bật TOTP, xem hồ sơ và đăng xuất. Mặc định bật ở production, tắt ở phát triển và thử nghiệm để dữ liệu mẫu dùng ngay.
   */
  enforceMfa: e.ENFORCE_MFA !== undefined ? e.ENFORCE_MFA === 'true' : isProd,
} as const;

/** Cờ có thể đổi lúc chạy, để test bật/tắt mà không phải nạp lại module. Không bao giờ đổi ở production. */
export const runtimeFlags = { enforceMfa: env.enforceMfa };

export type Env = typeof env;

export type RuntimeRole = 'api' | 'worker' | 'migrate' | 'bootstrap' | 'check';

/** Thử ghi vào thư mục tệp đính kèm; ném lỗi nêu rõ nếu không ghi được (volume chưa gắn, sai quyền, ổ chỉ đọc). */
export function assertFileStorageWritable(dir: string = env.fileStorageDir): void {
  const probe = join(dir, `.ghi-thu-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(`FILE_STORAGE_DIR không ghi được (${code}): kiểm tra volume đã gắn và quyền ghi của người dùng chạy tiến trình`, { cause: err });
  }
}

/**
 * Kiểm theo vai trò của tiến trình, gọi đầu hàm main của api, worker và script. Ngoài production là no-op.
 * Báo MỌI vấn đề một lần, chỉ nêu tên biến.
 */
export function assertRuntime(role: RuntimeRole): void {
  if (!isProd) return;
  const need = {
    api: ['DATABASE_URL'],
    worker: ['DATABASE_URL', 'DATABASE_URL_SCAN'],
    migrate: ['DATABASE_URL_OWNER'],
    bootstrap: ['DATABASE_URL'],
    check: ['DATABASE_URL', 'DATABASE_URL_OWNER', 'DATABASE_URL_SCAN'],
  }[role] as ('DATABASE_URL' | 'DATABASE_URL_OWNER' | 'DATABASE_URL_SCAN')[];
  const problems = productionEnvProblems(e, {
    requireDatabaseUrls: need,
    requireScribeKey: role === 'api' || role === 'check',
    requireProviderKeys: role === 'check',
  });
  if (role === 'api' || role === 'worker' || role === 'check') {
    try {
      assertFileStorageWritable();
    } catch (err) {
      problems.push({ name: 'FILE_STORAGE_DIR', reason: err instanceof Error ? err.message : 'không ghi được' });
    }
  }
  if (problems.length > 0) throw new ProductionEnvError(problems);
}
