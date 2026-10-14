import { ApiError } from '@mihato/domain';
import { ALL_KV_KEYS, KV_KEYS, type SecureKV } from './kv';
import { MAX_PIN_FAILURES, createPinRecord, parsePinRecord, verifyPin, type PinHasher, type PinRecord } from './pin';

/**
 * Phiên của app nhân viên (SPEC 10.2, 11.2). Lớp này không phụ thuộc React Native: kho an toàn, hàm băm,
 * đồng hồ và lời gọi làm mới token đều truyền vào, nên test được bằng Vitest.
 *
 * Vòng đời:
 *   loading → signedOut → (kích hoạt) → onboarding → (đặt PIN, xong các bước) → unlocked
 *   mở lại app, hoặc ở nền quá 2 phút → locked → (sinh trắc học hoặc PIN) → unlocked
 *   quá 5 lần sai PIN, thiết bị bị thu hồi, đăng xuất → xoá phiên trên máy → signedOut kèm lý do
 */
export type SessionStatus = 'loading' | 'signedOut' | 'onboarding' | 'locked' | 'unlocked';

export type SessionEndReason =
  /** người dùng tự đăng xuất */
  | 'signed_out'
  /** quá 5 lần nhập PIN chưa khớp */
  | 'pin_attempts'
  /** máy chủ báo device_revoked */
  | 'device_revoked'
  /** 401 khác: refresh token hết hạn hoặc không còn hợp lệ */
  | 'session_expired';

export type SessionSnapshot = {
  status: SessionStatus;
  apiBaseUrl: string | null;
  deviceId: string | null;
  pinSet: boolean;
  noticeRead: boolean;
  biometricsEnabled: boolean;
  /** số lần nhập PIN chưa khớp liên tiếp */
  pinFailures: number;
  /** vì sao phiên trước kết thúc; màn kích hoạt dùng để giải thích bằng chữ */
  endReason: SessionEndReason | null;
  /** đọc kho an toàn lúc mở app bị lỗi (Keystore/Keychain): trạng thái vẫn là `loading`, màn khởi động cho thử lại hoặc kích hoạt lại */
  loadFailed: boolean;
};

export type TokenPair = { accessToken: string; refreshToken: string };

export type PinCheck = { ok: true } | { ok: false; attemptsLeft: number; wiped: boolean };

export type SessionDeps = {
  kv: SecureKV;
  hasher: PinHasher;
  now: () => number;
  /** POST /v1/auth/refresh. Ném ApiError khi máy chủ không nhận, ném lỗi khác khi mất mạng. */
  refreshCall: (apiBaseUrl: string, refreshToken: string) => Promise<TokenPair>;
  /** gọi sau khi phiên trên máy đã bị xoá: dọn bộ nhớ đệm và hàng đợi ngoại tuyến */
  onEnded?: (reason: SessionEndReason) => void | Promise<void>;
};

/** Ở nền quá mức này thì phải mở khoá lại. */
export const BACKGROUND_LOCK_MS = 2 * 60 * 1000;

const INITIAL: SessionSnapshot = {
  status: 'loading',
  apiBaseUrl: null,
  deviceId: null,
  pinSet: false,
  noticeRead: false,
  biometricsEnabled: false,
  pinFailures: 0,
  endReason: null,
  loadFailed: false,
};

export class SessionController {
  private state: SessionSnapshot = INITIAL;
  private tokens: TokenPair | null = null;
  private pin: PinRecord | null = null;
  private listeners = new Set<() => void>();
  private refreshing: Promise<boolean> | null = null;
  private onboardingOpen = false;
  private backgroundedAt: number | null = null;
  /** cặp token mới đã nhận từ máy chủ nhưng chưa ghi được vào kho an toàn (máy đang khoá, Keystore lỗi tạm) */
  private tokensUnsaved = false;

  constructor(private readonly deps: SessionDeps) {}

  // ───── đọc trạng thái (dùng với useSyncExternalStore) ─────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.state;

  private set(patch: Partial<SessionSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ───── mở app ─────

  /**
   * Đọc phiên từ kho an toàn. Kho có thể ném lỗi (Keystore Android không giải mã được sau khi cập nhật hệ điều hành,
   * Keychain iOS từ chối khi máy đang khoá): khi đó KHÔNG được kẹt ở màn chờ. Trạng thái giữ `loading` kèm `loadFailed`,
   * màn khởi động cho người dùng thử lại hoặc kích hoạt lại (`end`). Không tự xoá gì, vì lỗi có thể chỉ là tạm thời.
   */
  async load(): Promise<void> {
    let stored: Awaited<ReturnType<SessionController['readStored']>>;
    try {
      stored = await this.readStored();
    } catch {
      this.set({ status: 'loading', loadFailed: true });
      return;
    }
    const { accessToken, refreshToken, apiBaseUrl, deviceId, pinRaw, failures, biometrics, noticeReadAt } = stored;
    if (!accessToken || !refreshToken || !apiBaseUrl || !deviceId) {
      this.tokens = null;
      this.pin = null;
      this.set({ ...INITIAL, status: 'signedOut', endReason: this.state.endReason });
      return;
    }
    this.tokens = { accessToken, refreshToken };
    this.pin = parsePinRecord(pinRaw);
    const pinSet = this.pin !== null;
    this.set({
      // Đã kích hoạt nhưng chưa đặt PIN (app bị tắt giữa chừng): quay lại các bước kích hoạt.
      status: pinSet ? 'locked' : 'onboarding',
      apiBaseUrl,
      deviceId,
      pinSet,
      noticeRead: noticeReadAt !== null,
      biometricsEnabled: biometrics === '1',
      pinFailures: Number(failures ?? '0') || 0,
      endReason: null,
      loadFailed: false,
    });
  }

  private async readStored() {
    const { kv } = this.deps;
    const [accessToken, refreshToken, apiBaseUrl, deviceId, pinRaw, failures, biometrics, noticeReadAt] = await Promise.all([
      kv.get(KV_KEYS.accessToken),
      kv.get(KV_KEYS.refreshToken),
      kv.get(KV_KEYS.apiBaseUrl),
      kv.get(KV_KEYS.deviceId),
      kv.get(KV_KEYS.pin),
      kv.get(KV_KEYS.pinFailures),
      kv.get(KV_KEYS.biometrics),
      kv.get(KV_KEYS.noticeReadAt),
    ]);
    return { accessToken, refreshToken, apiBaseUrl, deviceId, pinRaw, failures, biometrics, noticeReadAt };
  }

  // ───── kích hoạt ─────

  /** Lưu kết quả của devices.activate. Mã kích hoạt chỉ dùng được một lần nên phải lưu ngay. */
  async activate(input: TokenPair & { apiBaseUrl: string; deviceId: string }): Promise<void> {
    const { kv } = this.deps;
    await Promise.all([
      kv.set(KV_KEYS.accessToken, input.accessToken),
      kv.set(KV_KEYS.refreshToken, input.refreshToken),
      kv.set(KV_KEYS.apiBaseUrl, input.apiBaseUrl),
      kv.set(KV_KEYS.deviceId, input.deviceId),
      kv.remove(KV_KEYS.pin),
      kv.remove(KV_KEYS.pinFailures),
      kv.remove(KV_KEYS.biometrics),
      kv.remove(KV_KEYS.noticeReadAt),
    ]);
    this.tokens = { accessToken: input.accessToken, refreshToken: input.refreshToken };
    this.pin = null;
    this.onboardingOpen = true;
    this.set({ ...INITIAL, status: 'onboarding', apiBaseUrl: input.apiBaseUrl, deviceId: input.deviceId });
  }

  /** Nhân viên bấm "Tôi đã đọc" ở đoạn "Hệ thống ghi nhận gì về tôi" (SPEC 11.7). */
  async acknowledgeNotice(): Promise<void> {
    await this.deps.kv.set(KV_KEYS.noticeReadAt, new Date(this.deps.now()).toISOString());
    this.set({ noticeRead: true });
  }

  async setPin(pin: string): Promise<void> {
    const record = await createPinRecord(pin, this.deps.hasher);
    await this.deps.kv.set(KV_KEYS.pin, JSON.stringify(record));
    await this.deps.kv.remove(KV_KEYS.pinFailures);
    this.pin = record;
    this.set({ pinSet: true, pinFailures: 0 });
  }

  async setBiometricsEnabled(enabled: boolean): Promise<void> {
    if (enabled) await this.deps.kv.set(KV_KEYS.biometrics, '1');
    else await this.deps.kv.remove(KV_KEYS.biometrics);
    this.set({ biometricsEnabled: enabled });
  }

  /** Xong các bước kích hoạt: vào app, không phải nhập lại PIN vừa đặt. */
  finishOnboarding(): void {
    if (!this.tokens || !this.pin) return;
    this.onboardingOpen = false;
    this.set({ status: 'unlocked' });
  }

  // ───── khoá và mở khoá ─────

  /**
   * Kiểm PIN trên máy. Sai thì đếm; sai lần thứ 5 thì xoá phiên trên máy và về màn kích hoạt (SPEC 11.2 điều 3).
   * Số lần sai lưu trong kho an toàn nên tắt app rồi mở lại không được thêm lượt.
   */
  async checkPin(pin: string): Promise<PinCheck> {
    if (!this.pin) return { ok: false, attemptsLeft: 0, wiped: false };
    if (await verifyPin(pin, this.pin, this.deps.hasher)) {
      if (this.state.pinFailures !== 0) {
        await this.deps.kv.remove(KV_KEYS.pinFailures);
        this.set({ pinFailures: 0 });
      }
      return { ok: true };
    }
    const failures = this.state.pinFailures + 1;
    if (failures >= MAX_PIN_FAILURES) {
      await this.end('pin_attempts');
      return { ok: false, attemptsLeft: 0, wiped: true };
    }
    await this.deps.kv.set(KV_KEYS.pinFailures, String(failures));
    this.set({ pinFailures: failures });
    return { ok: false, attemptsLeft: MAX_PIN_FAILURES - failures, wiped: false };
  }

  async unlockWithPin(pin: string): Promise<PinCheck> {
    const result = await this.checkPin(pin);
    if (result.ok && this.state.status === 'locked') this.set({ status: 'unlocked' });
    return result;
  }

  /** Gọi sau khi hệ điều hành xác nhận sinh trắc học thành công. */
  unlockWithBiometrics(): void {
    if (this.state.status === 'locked' && this.state.biometricsEnabled) this.set({ status: 'unlocked' });
  }

  lock(): void {
    if (this.state.status === 'unlocked') this.set({ status: 'locked' });
  }

  /** App chuyển xuống nền: ghi lại giờ. */
  noteBackground(): void {
    if (this.backgroundedAt === null) this.backgroundedAt = this.deps.now();
  }

  /** App trở lại nền trước: ở nền từ 2 phút thì khoá. */
  noteForeground(): void {
    void this.flushUnsavedTokens();
    const since = this.backgroundedAt;
    this.backgroundedAt = null;
    if (since !== null && this.deps.now() - since >= BACKGROUND_LOCK_MS) this.lock();
  }

  // ───── token ─────

  getAccessToken = (): string | null => this.tokens?.accessToken ?? null;

  /**
   * Làm mới access token (xoay vòng refresh token, SPEC 10.2). Chỉ một lần làm mới tại một thời điểm:
   * các yêu cầu cùng gặp 401 `token_expired` chờ chung một lời gọi, vì dùng lại refresh token cũ
   * sẽ khiến máy chủ thu hồi cả thiết bị.
   */
  refresh = (): Promise<boolean> => {
    void this.flushUnsavedTokens();
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  };

  private async doRefresh(): Promise<boolean> {
    const used = this.tokens?.refreshToken;
    const base = this.state.apiBaseUrl;
    if (!used || !base) return false;
    try {
      const pair = await this.deps.refreshCall(base, used);
      // Phiên có thể đã bị xoá trong lúc chờ (đăng xuất, sai PIN): không ghi lại token.
      if (this.tokens?.refreshToken !== used) return false;
      // Máy chủ đã đánh dấu refresh token cũ là đã dùng: cặp mới phải vào bộ nhớ NGAY, trước khi ghi kho. Nếu ghi kho lỗi
      // (iOS từ chối khi máy vừa khoá, Keystore lỗi tạm) mà app vẫn giữ token cũ thì lần làm mới sau bị coi là tái sử dụng
      // và máy chủ thu hồi cả thiết bị (rà soát 07/10/2026, staff-6). Ghi lỗi thì ghi lại ở lần sau (`flushUnsavedTokens`).
      const fresh: TokenPair = { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
      this.tokens = fresh;
      this.tokensUnsaved = true;
      await this.flushUnsavedTokens();
      return true;
    } catch (err) {
      // Máy chủ trả 401: phiên không còn. Lỗi mạng hay lỗi máy chủ thì giữ phiên, lần sau thử lại.
      if (err instanceof ApiError && err.status === 401) await this.endForCode(err.code);
      return false;
    }
  }

  /**
   * Ghi cặp token hiện tại vào kho an toàn nếu lần ghi trước lỗi. Ghi refresh token TRƯỚC: nếu app bị giết giữa hai lần
   * ghi thì chỉ còn access token cũ (hết hạn, làm mới được bằng refresh token mới), không phải ngược lại.
   */
  async flushUnsavedTokens(): Promise<void> {
    const pending = this.tokens;
    if (!this.tokensUnsaved || !pending) return;
    try {
      await this.deps.kv.set(KV_KEYS.refreshToken, pending.refreshToken);
      await this.deps.kv.set(KV_KEYS.accessToken, pending.accessToken);
    } catch {
      return; // vẫn còn cờ: thử lại khi app trở lại nền trước hoặc ở lần làm mới sau
    }
    if (this.tokens === pending) {
      this.tokensUnsaved = false;
    } else {
      // Phiên đã bị xoá hoặc đổi trong lúc ghi: không để token cũ nằm lại trong kho.
      await Promise.allSettled([this.deps.kv.remove(KV_KEYS.refreshToken), this.deps.kv.remove(KV_KEYS.accessToken)]);
    }
  }

  /** 401 từ một yêu cầu thường. `token_expired` do `refresh()` lo; mã khác nghĩa là phiên đã hết. */
  handleUnauthenticated = (code: string): void => {
    if (code === 'token_expired') return;
    void this.endForCode(code);
  };

  private endForCode(code: string): Promise<void> {
    return this.end(code === 'device_revoked' ? 'device_revoked' : 'session_expired');
  }

  // ───── kết thúc phiên ─────

  /** Xoá mọi thứ của phiên trên máy rồi về màn kích hoạt, kèm lý do để giải thích bằng chữ. */
  async end(reason: SessionEndReason): Promise<void> {
    if (this.state.status === 'signedOut' && this.tokens === null) return;
    this.tokens = null;
    this.pin = null;
    this.onboardingOpen = false;
    this.backgroundedAt = null;
    this.tokensUnsaved = false;
    // Kho lỗi thì vẫn kết thúc phiên trên máy: bộ nhớ đã sạch, lần mở sau sẽ đọc lại và xử lý như trên.
    await Promise.allSettled(ALL_KV_KEYS.map((key) => this.deps.kv.remove(key)));
    this.set({ ...INITIAL, status: 'signedOut', endReason: reason });
    await this.deps.onEnded?.(reason);
  }

  /** Người dùng đã đọc lời giải thích ở màn kích hoạt. */
  clearEndReason(): void {
    if (this.state.endReason !== null) this.set({ endReason: null });
  }

  /** Đang ở giữa các bước kích hoạt của lần chạy này (chưa bấm "Xem việc của tôi"). */
  get isOnboardingOpen(): boolean {
    return this.onboardingOpen;
  }
}
