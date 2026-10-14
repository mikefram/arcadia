import { ApiError, buildPath, routes } from '@mihato/api-client';
import type { Problem } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { errorMessage } from '../api/errors';

/**
 * Tải nội dung một tệp đính kèm (`GET /v1/files/:id/content`) bằng bearer token của phiên.
 * Route này trả nhị phân, không phải JSON, nên không đi qua `api.call` của client dùng chung (luôn đọc JSON).
 * Cách làm giống client: token hết hạn (401 `token_expired`) thì làm mới một lần rồi gửi lại; 401 khác thì báo phiên đã hết.
 * Mọi phụ thuộc truyền vào để test bằng Vitest (test/file-download.test.ts).
 */

export type DownloadDeps = {
  baseUrl: () => string;
  getAccessToken: () => string | null;
  /** làm mới token; true nếu đã có token mới */
  refresh: () => Promise<boolean>;
  /** 401 không phải token hết hạn (phiên hết, thiết bị bị thu hồi) */
  onUnauthenticated: (code: string) => void;
  defaultHeaders?: () => Record<string, string>;
  fetch?: typeof fetch;
};

async function toApiError(res: Response): Promise<ApiError> {
  let problem: Partial<Problem> = {};
  try {
    problem = (await res.json()) as Partial<Problem>;
  } catch {
    // phản hồi không phải JSON: dùng mã chung theo trạng thái
  }
  return new ApiError(problem.code ?? (res.status >= 500 ? 'internal_error' : res.status === 404 ? 'not_found' : 'forbidden'), { ...problem, status: res.status });
}

/** Nội dung tệp. Lỗi mạng ném TypeError (như `fetch`); lỗi của máy chủ ném `ApiError` với mã trong bảng lỗi. */
export async function fetchFileContent(deps: DownloadDeps, fileId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const url = deps.baseUrl() + buildPath(routes['files.download'], { params: { id: fileId } });
  const send = (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: '*/*', ...(deps.defaultHeaders?.() ?? {}) };
    const token = deps.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return doFetch(url, { method: 'GET', headers, signal });
  };
  let res = await send();
  if (res.status === 401) {
    const err = await toApiError(res.clone());
    if (err.code === 'token_expired' && (await deps.refresh())) res = await send();
  }
  if (!res.ok) {
    const err = await toApiError(res);
    if (res.status === 401) deps.onUnauthenticated(err.code);
    throw err;
  }
  return res.arrayBuffer();
}

/** Lỗi mở tệp không do máy chủ: cần mạng, máy không có cách mở, không lưu được vào máy. */
export class FileOpenError extends Error {
  constructor(readonly reason: 'need_network' | 'share_unavailable' | 'save_failed') {
    super(reason);
    this.name = 'FileOpenError';
  }
}

/** Câu tiếng Việt cho một lỗi khi mở tệp. Không bao giờ hiện chữ của máy chủ hay của hệ điều hành. */
export function openErrorText(err: unknown): string {
  if (err instanceof FileOpenError) {
    if (err.reason === 'need_network') return vi.staff.files.needNetwork;
    if (err.reason === 'share_unavailable') return vi.staff.files.shareUnavailable;
    return vi.staff.files.saveFailed;
  }
  return errorMessage(err);
}
