import type { ConfigContext, ExpoConfig } from 'expo/config';
import { withInfoPlist } from 'expo/config-plugins';

/**
 * Cấu hình động của app nhân viên, chồng lên app.json (07/10/2026, dựng bản phát hành; cùng cách làm với app Chủ tịch).
 * Bản dựng có ba loại, chọn bằng biến môi trường lúc dựng (xem `buildKindOf`):
 *
 * - `preview` (`APP_VARIANT=preview` hoặc hồ sơ EAS `preview`) và `production` (`APP_VARIANT=production` hoặc hồ sơ EAS
 *   `production`): bản phân phối, GHIM MÁY CHỦ. `extra.apiBaseUrl` lấy từ `MIHATO_API_BASE_URL` lúc dựng, bắt buộc https;
 *   thiếu thì `production` không dựng được (ném lỗi), để một đường dẫn hay mã QR giả không đổi được máy chủ của app
 *   (rà soát 07/10/2026, exec-1; app nhân viên cùng lỗ hổng). `extra.eas.projectId` lấy từ `EAS_PROJECT_ID` (bắt buộc: thiếu
 *   thì không có thông báo đẩy). ATS của iOS chặt (không cho http, kể cả mạng nội bộ).
 * - `local` (không đặt gì: `expo start`, Expo Go, bản dựng phát triển của EAS, test): giữ nguyên app.json; chỉ thêm các biến nếu có đặt.
 *   App nhân viên không có biến thể `dev` như app Chủ tịch (không có mô-đun gốc riêng, nên không cần Apple ID miễn phí).
 *
 * `MIHATO_PRIVACY_POLICY_URL` (https, tuỳ chọn) thành `extra.privacyPolicyUrl`: app hiện nút mở chính sách khi có.
 * `EXPO_OWNER` (tuỳ chọn) thành `owner`: tên tổ chức Expo.
 */
type Env = Record<string, string | undefined>;
export type BuildKind = 'preview' | 'production' | 'local';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildKindOf(env: Env): BuildKind {
  const variant = env.APP_VARIANT?.trim();
  if (variant === 'production' || env.EAS_BUILD_PROFILE === 'production') return 'production';
  if (variant === 'preview' || env.EAS_BUILD_PROFILE === 'preview') return 'preview';
  return 'local';
}

const isDistribution = (kind: BuildKind): boolean => kind === 'production' || kind === 'preview';

function httpsUrl(name: string, raw: string): string {
  const text = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} không phải địa chỉ hợp lệ.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} phải bắt đầu bằng https:// (bản phát hành không cho http).`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} không được kèm tài khoản, tham số hay mục neo.`);
  return text;
}

/** Địa chỉ máy chủ ghim vào bản dựng. `production` bắt buộc; `preview` và các loại khác chỉ ghim khi có đặt. */
export function pinnedApiBaseUrl(kind: BuildKind, env: Env): string | null {
  const raw = env.MIHATO_API_BASE_URL?.trim();
  if (!raw) {
    if (kind === 'production') throw new Error('Bản production phải ghim máy chủ: đặt MIHATO_API_BASE_URL (https://…) lúc dựng. Xem docs/ops/mobile-release.md.');
    return null;
  }
  // Bản local được dùng http (máy trong mạng nội bộ); mọi bản phân phối bắt buộc https.
  if (kind === 'local') return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : httpsUrl('MIHATO_API_BASE_URL', raw);
  return httpsUrl('MIHATO_API_BASE_URL', raw);
}

/** projectId của EAS (thông báo đẩy cần). Bản phân phối bắt buộc. Không bao giờ tự đặt giá trị: lấy từ `eas init`. */
export function easProjectIdOf(kind: BuildKind, env: Env): string | null {
  const raw = env.EAS_PROJECT_ID?.trim();
  if (!raw) {
    if (isDistribution(kind)) throw new Error('Thiếu EAS_PROJECT_ID: chạy `eas init` trong thư mục app rồi đặt mã dự án vào biến môi trường dựng. Không có mã này thì không nhận được thông báo đẩy.');
    return null;
  }
  if (!UUID.test(raw)) throw new Error('EAS_PROJECT_ID phải là mã UUID do `eas init` cấp (đang là giá trị khác, ví dụ mã mẫu chưa thay).');
  return raw.toLowerCase();
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const env: Env = process.env;
  const kind = buildKindOf(env);
  const base = config as ExpoConfig;

  const apiBaseUrl = pinnedApiBaseUrl(kind, env);
  const projectId = easProjectIdOf(kind, env);
  const privacyRaw = env.MIHATO_PRIVACY_POLICY_URL?.trim();
  const privacyPolicyUrl = privacyRaw ? httpsUrl('MIHATO_PRIVACY_POLICY_URL', privacyRaw) : null;
  const owner = env.EXPO_OWNER?.trim();

  let result: ExpoConfig = base;
  const extra: Record<string, unknown> = { ...base.extra };
  if (apiBaseUrl) extra.apiBaseUrl = apiBaseUrl;
  if (projectId) extra.eas = { ...(typeof extra.eas === 'object' && extra.eas !== null ? extra.eas : {}), projectId };
  if (privacyPolicyUrl) extra.privacyPolicyUrl = privacyPolicyUrl;
  if (kind !== 'local') extra.appVariant = kind;
  const extraChanged = JSON.stringify(extra) !== JSON.stringify(base.extra ?? {});
  if (extraChanged) result = { ...result, extra };
  if (owner) result = { ...result, owner };

  if (isDistribution(kind)) {
    result = {
      ...result,
      ios: {
        ...result.ios,
        // ATS chặt: chỉ https. Mẫu của Expo mở thêm NSAllowsLocalNetworking cho máy phát triển; bản phân phối không cần.
        infoPlist: { ...result.ios?.infoPlist, NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: false } },
      },
    };
    // Gói expo-dev-launcher nằm trong node_modules phẳng của kho nên Expo tự áp dụng plugin của nó cho cả app này và thêm
    // khoá dò máy phát triển trong mạng nội bộ (câu xin quyền bằng tiếng Anh). App nhân viên không có dev-launcher: gỡ khỏi bản phân phối.
    return withInfoPlist(result, (plist) => {
      delete plist.modResults.NSBonjourServices;
      delete plist.modResults.NSLocalNetworkUsageDescription;
      return plist;
    });
  }

  return result;
};
