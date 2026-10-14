/**
 * Chốt chặn cho script phá hoặc nạp dữ liệu (seed, reset): chỉ chạy ở phát triển hoặc thử nghiệm, trên CSDL có đuôi
 * _dev hoặc _test. Hàm thuần, nhận giá trị đã đọc nên test được mà không cần CSDL.
 */
export type GuardInput = { isProd: boolean; nodeEnv: string; databaseUrl: string };

export function devDatabaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.slice(1);
}

/** Trả lý do từ chối, hoặc null nếu được phép. */
export function devOnlyViolation({ isProd, nodeEnv, databaseUrl }: GuardInput): string | null {
  const name = devDatabaseName(databaseUrl);
  if (isProd) return `môi trường "${nodeEnv}" là production`;
  if (!/(_dev|_test)$/.test(name)) return `CSDL "${name}" không có đuôi _dev hoặc _test`;
  return null;
}

/** Địa chỉ máy chủ CSDL được coi là máy phát triển; ngoài danh sách này, reset đòi RESET_ALLOW_REMOTE=true. */
export function isLocalDatabaseHost(databaseUrl: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]', 'postgres'].includes(new URL(databaseUrl).hostname);
}
