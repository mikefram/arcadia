import { ApiError } from '@mihato/api-client';
import { describe, expect, it } from 'vitest';
import { fetchFileContent, type DownloadDeps } from '../src/features/file-download';

const FILE_ID = '0199f000-0000-7000-8000-000000000001';
const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

type Call = { url: string; headers: Record<string, string>; method: string };

function problem(status: number, code: string): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), { status, headers: { 'Content-Type': 'application/problem+json' } });
}
const ok = (): Response => new Response(BYTES, { status: 200, headers: { 'Content-Type': 'application/pdf' } });

function setup(responses: (() => Response | Promise<Response>)[], over: Partial<DownloadDeps> = {}) {
  const calls: Call[] = [];
  const unauthenticated: string[] = [];
  let token = 'tok-1';
  let refreshes = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, method: init?.method ?? 'GET' });
    const next = responses.shift();
    if (!next) throw new Error('hết phản hồi giả');
    return next();
  };
  const deps: DownloadDeps = {
    baseUrl: () => 'https://api.mihato.test',
    getAccessToken: () => token,
    refresh: async () => {
      refreshes += 1;
      token = 'tok-2';
      return true;
    },
    onUnauthenticated: (code) => unauthenticated.push(code),
    defaultHeaders: () => ({ 'X-App-Version': '1.0.0', 'X-Platform': 'ios' }),
    fetch: fetchFn,
    ...over,
  };
  return { deps, calls, unauthenticated, refreshes: () => refreshes };
}

describe('tải nội dung tệp kèm token đăng nhập', () => {
  it('gọi GET /v1/files/:id/content với bearer token và header của app, trả đúng byte', async () => {
    const { deps, calls } = setup([ok]);
    const buffer = await fetchFileContent(deps, FILE_ID);
    expect([...new Uint8Array(buffer)]).toEqual([...BYTES]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.mihato.test/v1/files/${FILE_ID}/content`);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer tok-1', 'X-App-Version': '1.0.0', 'X-Platform': 'ios' });
  });

  it('token hết hạn (401 token_expired): làm mới một lần rồi gửi lại với token mới', async () => {
    const { deps, calls, refreshes, unauthenticated } = setup([() => problem(401, 'token_expired'), ok]);
    const buffer = await fetchFileContent(deps, FILE_ID);
    expect(buffer.byteLength).toBe(BYTES.length);
    expect(refreshes()).toBe(1);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(unauthenticated).toEqual([]);
  });

  it('làm mới không được: ném lỗi token_expired; mã này được chuyển cho lớp phiên, lớp phiên bỏ qua nó (tự kết thúc phiên khi máy chủ từ chối làm mới)', async () => {
    const { deps, unauthenticated } = setup([() => problem(401, 'token_expired')], { refresh: async () => false });
    await expect(fetchFileContent(deps, FILE_ID)).rejects.toMatchObject({ code: 'token_expired', status: 401 });
    expect(unauthenticated).toEqual(['token_expired']);
  });

  it('401 khác (thiết bị bị thu hồi): báo mất phiên và ném lỗi, không làm mới', async () => {
    const { deps, unauthenticated, refreshes } = setup([() => problem(401, 'device_revoked')]);
    await expect(fetchFileContent(deps, FILE_ID)).rejects.toMatchObject({ code: 'device_revoked' });
    expect(unauthenticated).toEqual(['device_revoked']);
    expect(refreshes()).toBe(0);
  });

  it('tệp ngoài tầm nhìn hoặc không còn: 404 not_found; không tới được máy chủ thì lỗi mạng của fetch', async () => {
    const missing = setup([() => problem(404, 'not_found')]);
    const err = await fetchFileContent(missing.deps, FILE_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
    const down = setup([() => Promise.reject(new TypeError('Network request failed'))]);
    await expect(fetchFileContent(down.deps, FILE_ID)).rejects.toBeInstanceOf(TypeError);
  });

  it('phản hồi lỗi không phải JSON vẫn thành mã lỗi theo trạng thái; id có ký tự lạ được mã hoá trong đường dẫn', async () => {
    const html = setup([() => new Response('<html>502</html>', { status: 502 })]);
    await expect(fetchFileContent(html.deps, FILE_ID)).rejects.toMatchObject({ code: 'internal_error', status: 502 });
    const odd = setup([ok]);
    await fetchFileContent(odd.deps, 'a/b?c');
    expect(odd.calls[0]?.url).toBe('https://api.mihato.test/v1/files/a%2Fb%3Fc/content');
  });
});
