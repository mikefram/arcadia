import type { Me } from '@mihato/domain';
import { DEFAULT_ADDRESS } from '@mihato/i18n';
import type { FontScale } from '@mihato/ui-tokens';
import { KV_KEYS, type SecureKV } from '../session/kv';
import { addressForRoles } from './address';

/**
 * Vài điều app cần trước khi tải được hồ sơ từ máy chủ (màn khoá, lúc mất mạng): cách gọi, hồ sơ giao diện,
 * cỡ chữ, số Văn phòng, công tắc trợ lý. Lưu trong kho an toàn; KHÔNG chứa dữ liệu công việc (SPEC 7.8).
 */
export type LocalProfile = {
  address: string;
  uiProfile: 'senior' | 'standard';
  fontScale: FontScale;
  officePhone: string | null;
  assistantEnabled: boolean;
  /** người dùng tự đổi hồ sơ giao diện trên máy này ở Cài đặt; null: theo hồ sơ máy chủ */
  profileOverride: 'senior' | 'standard' | null;
};

export const DEFAULT_LOCAL_PROFILE: LocalProfile = {
  address: DEFAULT_ADDRESS,
  uiProfile: 'senior',
  fontScale: 'large',
  officePhone: null,
  assistantEnabled: true,
  profileOverride: null,
};

/**
 * Trợ lý dùng được khi tổ chức bật AI và có LLM (SPEC 11.7) và người này có quyền dùng Trợ lý AI (docs/DECISIONS.md, 05/10/2026,
 * tổ chức chỉnh được quyền theo vai trò và theo người): tắt thì app ẩn tab Trợ lý. Bỏ trống `permissions` thì chỉ xét phía tổ chức.
 */
export function assistantEnabledFor(ai: Me['ai'], permissions?: Me['permissions']): boolean {
  return ai.enabled && ai.llm !== 'off' && (permissions === undefined || permissions.includes('assistant.use'));
}

export function localProfileFromMe(me: Me, previous: LocalProfile): LocalProfile {
  return {
    address: addressForRoles(me.roles),
    uiProfile: me.uiProfile === 'senior' ? 'senior' : 'standard',
    fontScale: me.prefs.fontScale,
    officePhone: me.officePhone,
    assistantEnabled: assistantEnabledFor(me.ai, me.permissions),
    profileOverride: previous.profileOverride,
  };
}

function parse(raw: string | null): Partial<LocalProfile> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return {};
    const r = v as Record<string, unknown>;
    const out: Partial<LocalProfile> = {};
    if (typeof r.address === 'string' && r.address) out.address = r.address;
    if (r.uiProfile === 'senior' || r.uiProfile === 'standard') out.uiProfile = r.uiProfile;
    if (r.fontScale === 'large' || r.fontScale === 'xlarge' || r.fontScale === 'xxlarge') out.fontScale = r.fontScale;
    if (typeof r.officePhone === 'string' || r.officePhone === null) out.officePhone = r.officePhone;
    if (typeof r.assistantEnabled === 'boolean') out.assistantEnabled = r.assistantEnabled;
    return out;
  } catch {
    return {};
  }
}

export class LocalProfileStore {
  private state: LocalProfile = DEFAULT_LOCAL_PROFILE;
  private listeners = new Set<() => void>();

  constructor(private readonly kv: SecureKV) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LocalProfile => this.state;

  private set(next: LocalProfile): void {
    this.state = next;
    for (const l of this.listeners) l();
  }

  async load(): Promise<void> {
    const [raw, override] = await Promise.all([this.kv.get(KV_KEYS.localProfile), this.kv.get(KV_KEYS.uiProfile)]);
    this.set({ ...DEFAULT_LOCAL_PROFILE, ...parse(raw), profileOverride: override === 'senior' || override === 'standard' ? override : null });
  }

  /** Hồ sơ vừa tải từ máy chủ: cập nhật bản trên máy nếu có gì đổi. */
  async rememberMe(me: Me): Promise<void> {
    const next = localProfileFromMe(me, this.state);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.set(next);
    const { profileOverride: _override, ...stored } = next;
    await this.kv.set(KV_KEYS.localProfile, JSON.stringify(stored));
  }

  async setProfileOverride(profile: 'senior' | 'standard' | null): Promise<void> {
    this.set({ ...this.state, profileOverride: profile });
    if (profile) await this.kv.set(KV_KEYS.uiProfile, profile);
    else await this.kv.remove(KV_KEYS.uiProfile);
  }

  /** Phiên trên máy kết thúc: quên hết. */
  reset(): void {
    this.set(DEFAULT_LOCAL_PROFILE);
  }
}
