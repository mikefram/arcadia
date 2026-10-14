import {
  ApiError,
  newId,
  requiresIdempotencyKey,
  routes,
  type Problem,
  type RouteArgs,
  type RouteDef,
  type RouteKey,
  type RouteResponse,
} from '@mihato/domain';

/**
 * Client dùng chung cho web quản trị và hai app (SPEC 3.4). Kiểu của từng lời gọi suy ra từ bảng
 * `routes` trong @mihato/domain, nên không có bước sinh mã và không thể lệch hợp đồng với máy chủ.
 */
export type ApiClientOptions = {
  /** '' khi web gọi cùng origin qua proxy; 'https://api…' với app */
  baseUrl: string;
  fetch?: typeof fetch;
  /** App: bearer token. Web bỏ trống và dùng cookie phiên. */
  getAccessToken?: () => string | null | Promise<string | null>;
  /** Web: 'include' để gửi cookie phiên */
  credentials?: RequestCredentials;
  /** Web: giá trị cookie CSRF để gửi lại ở header X-CSRF-Token */
  getCsrfToken?: () => string | null;
  /** Header cố định, ví dụ X-App-Version và X-Platform */
  defaultHeaders?: () => Record<string, string>;
  /** App: access token hết hạn (401 token_expired). Trả true nếu đã làm mới để gửi lại một lần. */
  onTokenExpired?: () => Promise<boolean>;
  /** 401 khác (phiên hết, thiết bị bị thu hồi): đưa người dùng về màn đăng nhập hoặc kích hoạt */
  onUnauthenticated?: (code: string) => void;
};

export type CallOptions = {
  /** Mặc định client tự sinh. Hàng đợi ngoại tuyến truyền khoá đã lưu để gửi lại chỉ có hiệu lực một lần. */
  idempotencyKey?: string;
  stepUpToken?: string;
  ifMatch?: string | number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

type AnyArgs = { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };

export function buildPath(def: RouteDef, args: AnyArgs): string {
  let path = def.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    const v = args.params?.[name];
    if (v === undefined || v === null) throw new Error(`Thiếu tham số đường dẫn: ${name}`);
    return encodeURIComponent(String(v));
  });
  if (args.query) {
    const qs: string[] = [];
    for (const [k, v] of Object.entries(args.query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (qs.length) path += `?${qs.join('&')}`;
  }
  return path;
}

async function toApiError(res: Response): Promise<ApiError> {
  let problem: Partial<Problem> = {};
  try {
    problem = (await res.json()) as Partial<Problem>;
  } catch {}
  return new ApiError(problem.code ?? (res.status >= 500 ? 'internal_error' : 'input_invalid'), { ...problem, status: res.status });
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(opts: ApiClientOptions) {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));

  async function send(def: RouteDef, args: AnyArgs, o: CallOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(opts.defaultHeaders?.() ?? {}), ...(o.headers ?? {}) };
    const token = await opts.getAccessToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (def.method !== 'GET') {
      const csrf = opts.getCsrfToken?.();
      if (csrf) headers['X-CSRF-Token'] = csrf;
      if (requiresIdempotencyKey(def)) headers['Idempotency-Key'] = o.idempotencyKey ?? newId();
    }
    if (o.stepUpToken) headers['X-Step-Up-Token'] = o.stepUpToken;
    if (o.ifMatch !== undefined) headers['If-Match'] = String(o.ifMatch);
    let body: string | undefined;
    if (args.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(args.body);
    }
    return doFetch(opts.baseUrl + buildPath(def, args), {
      method: def.method,
      headers,
      body,
      credentials: opts.credentials,
      signal: o.signal,
    });
  }

  /** Gọi một route theo khoá trong bảng hợp đồng, ví dụ `api.call('steps.complete', { params: { id }, body: {} })`. */
  async function call<K extends RouteKey>(key: K, args: RouteArgs<K>, o: CallOptions = {}): Promise<RouteResponse<K>> {
    const def: RouteDef = routes[key];
    // Giữ nguyên khoá chống lặp giữa lần gửi đầu và lần gửi lại sau khi làm mới token.
    const callOpts: CallOptions = requiresIdempotencyKey(def) ? { ...o, idempotencyKey: o.idempotencyKey ?? newId() } : o;
    let res = await send(def, args as AnyArgs, callOpts);
    if (res.status === 401 && opts.onTokenExpired) {
      const err = await toApiError(res.clone());
      if (err.code === 'token_expired' && (await opts.onTokenExpired())) {
        res = await send(def, args as AnyArgs, callOpts);
      }
    }
    if (!res.ok) {
      const err = await toApiError(res);
      if (res.status === 401) opts.onUnauthenticated?.(err.code);
      throw err;
    }
    if (res.status === 204) return undefined as RouteResponse<K>;
    return (await res.json()) as RouteResponse<K>;
  }

  return { call, routes };
}

export { ApiError, routes };
export type { RouteArgs, RouteKey, RouteResponse };
