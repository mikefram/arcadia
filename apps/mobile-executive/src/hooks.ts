import type { FontScale } from '@mihato/ui-tokens';
import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ProfileName } from '@senior/metrics';
import { useMe } from './data/queries';
import { addressForRoles } from './features/address';
import { assistantEnabledFor, type LocalProfile } from './features/local-profile';
import type { SessionSnapshot } from './session/controller';
import { localProfile, session } from './services';

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

export function useLocalProfile(): LocalProfile {
  return useSyncExternalStore(localProfile.subscribe, localProfile.getSnapshot, localProfile.getSnapshot);
}

const subscribeOnline = (listener: () => void) => onlineManager.subscribe(listener);
const getOnline = () => onlineManager.isOnline();

/** Đang có mạng hay không, theo cùng nguồn mà TanStack Query dùng. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnline, getOnline);
}

/** Giờ hiện tại, tự cập nhật, để lời chào theo buổi và chữ "hôm nay" không cũ khi màn hình mở lâu. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type DisplayPrefs = {
  /** cách gọi người dùng trong mọi câu: "Chủ tịch", "Giám đốc", "Phó giám đốc" */
  address: string;
  profile: ProfileName;
  fontScale: FontScale;
  officePhone: string | null;
  /** tổ chức tắt AI thì ẩn tab Trợ lý; mọi thao tác chạm vẫn dùng được (SPEC 11.7) */
  assistantEnabled: boolean;
};

/**
 * Cách gọi, hồ sơ giao diện và cỡ chữ đang dùng: lấy từ hồ sơ vừa tải (`me`), chưa có thì lấy bản nhớ trên máy.
 * Hồ sơ `standard` (Giám đốc, Phó giám đốc) đổi được sang `senior` ở Cài đặt; lựa chọn đó nằm trên máy này.
 */
export function useDisplayPrefs(): DisplayPrefs {
  const local = useLocalProfile();
  const { status } = useSession();
  const me = useMe(status === 'unlocked' || status === 'onboarding').data;
  const serverProfile: ProfileName = me ? (me.uiProfile === 'senior' ? 'senior' : 'standard') : local.uiProfile;
  return {
    address: me ? addressForRoles(me.roles) : local.address,
    profile: local.profileOverride ?? serverProfile,
    fontScale: me?.prefs.fontScale ?? local.fontScale,
    officePhone: me ? me.officePhone : local.officePhone,
    assistantEnabled: me ? assistantEnabledFor(me.ai, me.permissions) : local.assistantEnabled,
  };
}

/** Cách gọi người dùng, dùng với `fmtExecutive(template, vars, address)`. */
export function useAddress(): string {
  return useDisplayPrefs().address;
}
