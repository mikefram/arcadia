/**
 * Đường dẫn kích hoạt do Văn phòng gửi (SPEC 10.2): `mihato://activate?token=…&api=…`.
 * Cùng nội dung nằm trong mã QR. Người dùng cũng có thể dán cả đường dẫn, hoặc chỉ dán mã.
 * Hàm thuần, không phụ thuộc lớp URL của nền tảng (Hermes không có đủ URLSearchParams).
 */
export type ActivationInput = {
  token: string;
  /** địa chỉ máy chủ đi kèm đường dẫn; null khi người dùng chỉ dán mã */
  apiBaseUrl: string | null;
};

const MIN_TOKEN_LENGTH = 20;

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    out[key] = eq === -1 ? '' : decode(part.slice(eq + 1));
  }
  return out;
}

export function normalizeApiBaseUrl(raw: string): string | null {
  const url = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url) ? url : null;
}

/** Máy phát triển: localhost, máy ảo Android (10.0.2.2) và mạng nội bộ. Chỉ các máy này được dùng http. */
function isDevelopmentHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    name === '10.0.2.2' ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(name) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(name)
  );
}

/** Token đi trên đường truyền phải được mã hoá: máy chủ thật bắt buộc https (SPEC 11.4). */
export function isAcceptableApiUrl(url: string): boolean {
  const m = /^(https?):\/\/([^\s/?#]+)/i.exec(url);
  if (!m) return false;
  return m[1]?.toLowerCase() === 'https' || isDevelopmentHost(m[2] ?? '');
}

/** Đọc đường dẫn kích hoạt, nội dung mã QR, hoặc mã dán tay. Trả null khi không nhận ra. */
export function parseActivationInput(raw: string): ActivationInput | null {
  const text = raw.trim();
  if (!text) return null;

  const q = text.indexOf('?');
  if (q !== -1 && /activate/i.test(text.slice(0, q))) {
    const hash = text.indexOf('#', q);
    const params = parseQuery(text.slice(q + 1, hash === -1 ? undefined : hash));
    const token = (params.token ?? '').trim();
    if (token.length < MIN_TOKEN_LENGTH) return null;
    const api = params.api ? normalizeApiBaseUrl(params.api) : null;
    return { token, apiBaseUrl: api };
  }

  // Chỉ có mã: một chuỗi liền, không dấu cách.
  if (text.length >= MIN_TOKEN_LENGTH && !/[\s/?#&=]/.test(text)) return { token: text, apiBaseUrl: null };
  return null;
}

/**
 * Chọn địa chỉ máy chủ. Bản phát hành ghim địa chỉ trong app.json (`extra.apiBaseUrl`, đặt lúc dựng bởi app.config.ts):
 * khi đã ghim thì bỏ qua địa chỉ trong đường dẫn, để một mã QR giả không dẫn được app sang máy chủ khác.
 * Bản phát triển chưa ghim thì nhận địa chỉ trong đường dẫn, miễn là https hoặc máy phát triển.
 *
 * `releaseBuild` (bản `preview` hoặc `production`): KHÔNG BAO GIỜ nhận địa chỉ từ đường dẫn. Địa chỉ ghim phải là https;
 * thiếu hoặc không phải https (cấu hình dựng sai) thì trả null và màn kích hoạt từ chối, thay vì rơi về địa chỉ trong
 * đường dẫn (rà soát 07/10/2026, exec-1).
 */
export function resolveApiBaseUrl(fromLink: string | null, pinned: string | null, releaseBuild = false): string | null {
  const fixed = pinned ? normalizeApiBaseUrl(pinned) : null;
  if (releaseBuild) return fixed && /^https:\/\//i.test(fixed) ? fixed : null;
  if (fixed) return fixed;
  if (fromLink && isAcceptableApiUrl(fromLink)) return fromLink;
  return null;
}
