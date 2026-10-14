import { createApiClient } from '@mihato/api-client';

/** Cookie không-httpOnly do máy chủ đặt; client gửi lại ở header X-CSRF-Token (SPEC 10.1). Cookie phiên thì httpOnly. */
const CSRF_COOKIE = 'mihato_csrf';

export function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const item = part.trim();
    if (item.startsWith(prefix)) {
      try {
        return decodeURIComponent(item.slice(prefix.length));
      } catch {
        return item.slice(prefix.length);
      }
    }
  }
  return null;
}

type UnauthenticatedHandler = (code: string) => void;
let unauthenticatedHandler: UnauthenticatedHandler | null = null;

/** router.tsx đăng ký: 401 ở bất kỳ đâu thì về /dang-nhap và nhớ đường dẫn cũ. */
export function setUnauthenticatedHandler(handler: UnauthenticatedHandler | null): void {
  unauthenticatedHandler = handler;
}

/** Dành cho nơi gọi mạng ngoài `api` (ví dụ tải tệp xuống): báo 401 cho cùng một chỗ xử lý. */
export function notifyUnauthenticated(code: string): void {
  unauthenticatedHandler?.(code);
}

/** Client duy nhất của web quản trị: cùng origin (proxy /v1), cookie phiên, CSRF, Idempotency-Key tự sinh. */
export const api = createApiClient({
  baseUrl: '',
  credentials: 'include',
  getCsrfToken: () => readCookie(CSRF_COOKIE),
  onUnauthenticated: (code) => unauthenticatedHandler?.(code),
});
