import { createPrivateKey } from 'node:crypto';

/**
 * Kiểm cấu hình ở production (docs/ops/runbook.md, docs/security/secrets.md). Hàm thuần: nhận một bảng biến môi trường,
 * trả danh sách vấn đề. Chỉ nêu TÊN biến và lý do, không bao giờ in giá trị (khoá, mật khẩu, địa chỉ có thông tin nhạy cảm).
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;
export type EnvProblem = { name: string; reason: string };

export type EnvCheckOptions = {
  /** bắt buộc có khoá ES256 ký token phiên Scribe (tiến trình api; script check-env) */
  requireScribeKey?: boolean;
  /** bắt buộc có khoá API của nhà cung cấp thật đã chọn (scribe; script check-env) */
  requireProviderKeys?: boolean;
  /** các biến kết nối CSDL bắt buộc phải có (tuỳ vai trò của tiến trình) */
  requireDatabaseUrls?: readonly ('DATABASE_URL' | 'DATABASE_URL_OWNER' | 'DATABASE_URL_SCAN')[];
};

export const MIN_SECRET_LENGTH = 32;

/** Chuỗi chứa dấu hiệu giá trị mẫu hoặc giá trị dành cho máy phát triển. */
const PLACEHOLDER = /dev-|change-me|changeme|example|placeholder/i;

const PROVIDER_CHOICES = {
  STT_PROVIDER: ['fake', 'deepgram'],
  LLM_PROVIDER: ['fake', 'anthropic'],
  TTS_PROVIDER: ['fake', 'vbee'],
  PUSH_PROVIDER: ['fake', 'expo'],
} as const;

/** Bỏ chú thích cuối dòng kiểu `fake   # fake | deepgram`. */
export function cleanValue(raw: string | undefined): string {
  return (raw ?? '').split('#')[0]!.trim();
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const isLoopbackHost = (host: string) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host) || host === '0.0.0.0';

function checkPublicUrl(problems: EnvProblem[], e: EnvSource, name: string, scheme: 'https:' | 'wss:', opts: { origin: boolean }): void {
  const raw = cleanValue(e[name]);
  if (!raw) {
    problems.push({ name, reason: `thiếu; phải là địa chỉ ${scheme === 'https:' ? 'https://' : 'wss://'}tên-miền` });
    return;
  }
  const url = parseUrl(raw);
  const prefix = scheme === 'https:' ? 'https://' : 'wss://';
  if (!url || url.protocol !== scheme) {
    problems.push({ name, reason: `phải bắt đầu bằng ${prefix} ở production (TLS bắt buộc, SPEC 11.4)` });
    return;
  }
  if (isLoopbackHost(url.hostname)) problems.push({ name, reason: 'không được trỏ về localhost ở production' });
  if (opts.origin && url.origin !== raw) problems.push({ name, reason: 'phải là nguồn (origin) thuần: có tên miền, không có đường dẫn, không có dấu / ở cuối' });
}

function checkSecret(problems: EnvProblem[], e: EnvSource, name: string): void {
  const v = (e[name] ?? '').trim();
  if (!v) {
    problems.push({ name, reason: 'thiếu' });
    return;
  }
  if (v.length < MIN_SECRET_LENGTH) problems.push({ name, reason: `ngắn hơn ${MIN_SECRET_LENGTH} ký tự (sinh bằng: openssl rand -base64 48)` });
  if (PLACEHOLDER.test(v)) problems.push({ name, reason: 'còn là giá trị mẫu hoặc giá trị của máy phát triển (chứa "dev-", "change-me" hoặc "example")' });
}

function checkDatabaseUrl(problems: EnvProblem[], e: EnvSource, name: string, required: boolean): void {
  const raw = (e[name] ?? '').trim();
  if (!raw) {
    if (required) problems.push({ name, reason: 'thiếu' });
    return;
  }
  const url = parseUrl(raw);
  if (!url || !/^postgres(ql)?:$/.test(url.protocol)) {
    problems.push({ name, reason: 'không phải địa chỉ postgres:// hợp lệ' });
    return;
  }
  const password = decodeURIComponent(url.password);
  if (!password) problems.push({ name, reason: 'không có mật khẩu' });
  else if (/_dev$/.test(password) || PLACEHOLDER.test(password)) problems.push({ name, reason: 'còn mật khẩu mặc định của máy phát triển (đuôi _dev); đặt mật khẩu ngẫu nhiên' });
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) problems.push({ name, reason: 'thiếu tên CSDL' });
  else if (/(_dev|_test)$/.test(dbName)) problems.push({ name, reason: 'tên CSDL có đuôi _dev hoặc _test; CSDL production không dùng đuôi này (seed và reset dựa vào đuôi để từ chối)' });
}

/** Khoá ký token phiên Scribe: EC P-256 dạng PKCS8 PEM; `\n` dạng chữ được đổi về xuống dòng thật. */
export function scribeKeyProblem(raw: string): string | null {
  const pem = raw.replace(/\\n/g, '\n').trim();
  try {
    const key = createPrivateKey(pem);
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.asymmetricKeyType !== 'ec' || (curve !== 'prime256v1' && curve !== 'P-256')) return 'phải là khoá EC P-256 (ES256) dạng PKCS8 PEM';
    return null;
  } catch {
    return 'không đọc được khoá PEM (cần PKCS8: openssl ecparam -genkey -name prime256v1 | openssl pkcs8 -topk8 -nocrypt)';
  }
}

export function scribeEnabled(e: EnvSource): boolean {
  return cleanValue(e.SCRIBE_ENABLED).toLowerCase() !== 'false';
}

export function allowFakeProviders(e: EnvSource): boolean {
  return cleanValue(e.ALLOW_FAKE_PROVIDERS).toLowerCase() === 'true';
}

/** Mọi vấn đề cấu hình ở production; mảng rỗng nghĩa là hợp lệ. */
export function productionEnvProblems(e: EnvSource, opts: EnvCheckOptions = {}): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const need = new Set(opts.requireDatabaseUrls ?? []);

  checkDatabaseUrl(problems, e, 'DATABASE_URL', need.has('DATABASE_URL'));
  checkDatabaseUrl(problems, e, 'DATABASE_URL_OWNER', need.has('DATABASE_URL_OWNER'));
  checkDatabaseUrl(problems, e, 'DATABASE_URL_SCAN', need.has('DATABASE_URL_SCAN'));

  checkSecret(problems, e, 'AUTH_SECRET');
  checkSecret(problems, e, 'INTERNAL_SERVICE_TOKEN');
  const auth = (e.AUTH_SECRET ?? '').trim();
  if (auth && auth === (e.INTERNAL_SERVICE_TOKEN ?? '').trim()) problems.push({ name: 'INTERNAL_SERVICE_TOKEN', reason: 'trùng AUTH_SECRET; mỗi khoá phải sinh riêng' });

  checkPublicUrl(problems, e, 'WEB_ORIGIN', 'https:', { origin: true });
  checkPublicUrl(problems, e, 'PUBLIC_API_URL', 'https:', { origin: false });
  checkPublicUrl(problems, e, 'PUBLIC_SCRIBE_WS_URL', 'wss:', { origin: false });

  for (const origin of cleanValue(e.CORS_EXTRA_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean)) {
    const url = parseUrl(origin);
    if (!url || url.protocol !== 'https:') {
      problems.push({ name: 'CORS_EXTRA_ORIGINS', reason: 'mọi nguồn phải là https:// ở production' });
      break;
    }
  }

  const storage = (e.FILE_STORAGE_DIR ?? '').trim();
  if (!storage) problems.push({ name: 'FILE_STORAGE_DIR', reason: 'thiếu; phải trỏ vào ổ có sao lưu (volume dùng chung của api và worker)' });
  else if (!storage.startsWith('/')) problems.push({ name: 'FILE_STORAGE_DIR', reason: 'phải là đường dẫn tuyệt đối' });

  const key = (e.SCRIBE_JWT_PRIVATE_KEY ?? '').trim();
  if (key) {
    const bad = scribeKeyProblem(key);
    if (bad) problems.push({ name: 'SCRIBE_JWT_PRIVATE_KEY', reason: bad });
  } else if (opts.requireScribeKey && scribeEnabled(e)) {
    problems.push({ name: 'SCRIBE_JWT_PRIVATE_KEY', reason: 'thiếu khi Scribe bật (đặt SCRIBE_ENABLED=false nếu không dùng trợ lý)' });
  }

  const emailKind = cleanValue(e.EMAIL_PROVIDER).toLowerCase();
  if (emailKind && !['fake', 'resend'].includes(emailKind)) problems.push({ name: 'EMAIL_PROVIDER', reason: 'giá trị không hợp lệ; chọn một trong: fake, resend (hoặc bỏ trống và đặt ở web quản trị)' });

  const fakeOk = allowFakeProviders(e);
  const fakeUsed: string[] = [];
  for (const [name, choices] of Object.entries(PROVIDER_CHOICES)) {
    const v = cleanValue(e[name]).toLowerCase() || 'fake';
    if (!(choices as readonly string[]).includes(v)) {
      problems.push({ name, reason: `giá trị không hợp lệ; chọn một trong: ${choices.join(', ')}` });
    } else if (v === 'fake') fakeUsed.push(name);
  }
  if (fakeUsed.length > 0 && !fakeOk) {
    problems.push({ name: fakeUsed.join(', '), reason: 'đang là fake (kể cả khi để trống) ở production; đặt nhà cung cấp thật, hoặc ALLOW_FAKE_PROVIDERS=true chỉ cho staging' });
  }
  if (opts.requireProviderKeys) {
    const val = (name: string) => cleanValue(e[name]).toLowerCase();
    const has = (name: string) => (e[name] ?? '').trim() !== '';
    if (val('LLM_PROVIDER') === 'anthropic' && !has('ANTHROPIC_API_KEY')) problems.push({ name: 'ANTHROPIC_API_KEY', reason: 'thiếu khi LLM_PROVIDER=anthropic' });
    if (val('STT_PROVIDER') === 'deepgram' && !has('DEEPGRAM_API_KEY')) problems.push({ name: 'DEEPGRAM_API_KEY', reason: 'thiếu khi STT_PROVIDER=deepgram' });
    if (val('TTS_PROVIDER') === 'vbee') {
      for (const n of ['VBEE_APP_ID', 'VBEE_TOKEN']) if (!has(n)) problems.push({ name: n, reason: 'thiếu khi TTS_PROVIDER=vbee' });
    }
    // Thư là tuỳ chọn ở môi trường: cách chính là đặt ở web quản trị. Chọn resend ở môi trường thì phải đủ khoá và địa chỉ gửi.
    if (val('EMAIL_PROVIDER') === 'resend') {
      if (!has('RESEND_API_KEY')) problems.push({ name: 'RESEND_API_KEY', reason: 'thiếu khi EMAIL_PROVIDER=resend' });
      if (!has('EMAIL_FROM')) problems.push({ name: 'EMAIL_FROM', reason: 'thiếu khi EMAIL_PROVIDER=resend (địa chỉ gửi trên tên miền đã xác minh ở Resend)' });
    }
  }
  return problems;
}

export class ProductionEnvError extends Error {
  readonly problems: EnvProblem[];
  constructor(problems: EnvProblem[]) {
    super(`Cấu hình production không hợp lệ (${problems.length} lỗi):\n${problems.map((p) => `  - ${p.name}: ${p.reason}`).join('\n')}`);
    this.name = 'ProductionEnvError';
    this.problems = problems;
  }
}
