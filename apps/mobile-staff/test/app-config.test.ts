/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import type { ExpoConfig } from 'expo/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import appConfig, { buildKindOf } from '../app.config';

/**
 * Cấu hình dựng bản gốc của app nhân viên (app.json, app.config.ts, eas.json), cùng cách kiểm với app Chủ tịch
 * (apps/mobile-executive/test/app-config.test.ts). Rà soát 07/10/2026: bản phát hành phải ghim máy chủ và có projectId.
 */

const appJson = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as { expo: ExpoConfig };
const fresh = (): ExpoConfig => structuredClone(appJson.expo);

type PluginEntry = { name: string; options: Record<string, unknown> };
const pluginsOf = (config: ExpoConfig): PluginEntry[] =>
  (config.plugins ?? []).map((plugin) => (Array.isArray(plugin) ? { name: String(plugin[0]), options: (plugin[1] ?? {}) as Record<string, unknown> } : { name: String(plugin), options: {} }));

const run = (config: ExpoConfig): ExpoConfig => appConfig({ config, projectRoot: '.', staticConfigPath: null, packageJsonPath: null });

const ENV_KEYS = ['APP_VARIANT', 'MIHATO_API_BASE_URL', 'EAS_PROJECT_ID', 'MIHATO_PRIVACY_POLICY_URL', 'EXPO_OWNER', 'EAS_BUILD_PROFILE'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const PROJECT_ID = '0199c000-0000-7000-8000-00000000abcd';
function releaseEnv(variant: 'production' | 'preview' = 'production'): void {
  process.env.APP_VARIANT = variant;
  process.env.MIHATO_API_BASE_URL = 'https://api.vrg.example';
  process.env.EAS_PROJECT_ID = PROJECT_ID;
}

describe('app.json (app nhân viên)', () => {
  it('mã gói trùng giữa iOS và Android, còn thông báo đẩy', () => {
    const config = fresh();
    expect(config.ios?.bundleIdentifier).toBe('vn.mihato.viectoi');
    expect(config.android?.package).toBe('vn.mihato.viectoi');
    expect(pluginsOf(config).map((p) => p.name)).toContain('expo-notifications');
  });

  it('không có quyền micro lạc: app nhân viên không thu âm (plugin máy ảnh tắt micro, không khai RECORD_AUDIO), không có plugin âm thanh', () => {
    const plugins = pluginsOf(fresh());
    const camera = plugins.find((p) => p.name === 'expo-camera');
    expect(camera?.options.microphonePermission).toBe(false);
    expect(camera?.options.recordAudioAndroid).toBe(false);
    expect(plugins.map((p) => p.name)).not.toContain('expo-audio');
    expect(JSON.stringify(appJson.expo)).not.toMatch(/RECORD_AUDIO|NSMicrophoneUsageDescription/);
  });

  it('không đặt gì: app.config.ts trả đúng app.json, không thêm mod nào', () => {
    const result = run(fresh());
    expect(result).toEqual(fresh());
    expect((result as ExpoConfig & { mods?: unknown }).mods).toBeUndefined();
  });

  it('không sửa đối tượng đầu vào', () => {
    releaseEnv();
    const input = fresh();
    run(input);
    expect(input).toEqual(fresh());
  });
});

describe('app.json: tệp dựng cho cửa hàng (07/10/2026)', () => {
  const root = new URL('../', import.meta.url);
  const pngInfo = (path: string) => {
    const buffer = readFileSync(new URL(path, root));
    expect(buffer.subarray(1, 4).toString('ascii'), `${path} không phải PNG`).toBe('PNG');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] ?? -1 };
  };

  it('icon 1024x1024 KHÔNG có kênh alpha (App Store Connect từ chối biểu tượng có alpha)', () => {
    expect(appJson.expo.icon).toBe('./assets/icon.png');
    const info = pngInfo('assets/icon.png');
    expect([info.width, info.height]).toEqual([1024, 1024]);
    expect([0, 2]).toContain(info.colorType);
  });

  it('adaptive icon Android: lớp trước 1024 có alpha, nền là màu; ảnh khởi động có mặt và có tệp thật', () => {
    const adaptive = appJson.expo.android?.adaptiveIcon;
    expect(adaptive?.backgroundColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(adaptive?.foregroundImage).toBe('./assets/adaptive-icon.png');
    expect(pngInfo('assets/adaptive-icon.png')).toMatchObject({ width: 1024, height: 1024, colorType: 6 });
    const splash = pluginsOf(fresh()).find((p) => p.name === 'expo-splash-screen');
    expect(splash?.options.image).toBe('./assets/splash-icon.png');
    expect(existsSync(new URL('assets/splash-icon.png', root))).toBe(true);
  });

  it('số bản dựng khởi tạo, khai báo mã hoá miễn trừ, không dùng cập nhật qua mạng, không khai chạy nền thừa', () => {
    const { expo } = appJson;
    expect(expo.ios?.buildNumber).toBe('1');
    expect(expo.android?.versionCode).toBe(1);
    expect(expo.ios?.config?.usesNonExemptEncryption).toBe(false);
    expect(expo.updates?.enabled).toBe(false);
    expect(expo.runtimeVersion).toEqual({ policy: 'appVersion' });
    expect(expo.ios?.infoPlist?.UIBackgroundModes).toBeUndefined();
    // ghim máy chủ KHÔNG nằm trong app.json: app.config.ts đặt lúc dựng
    expect(expo.extra?.apiBaseUrl ?? null).toBeNull();
  });

  it('privacy manifest khai bốn nhóm API cần lý do của React Native và Expo, không theo dõi', () => {
    const manifest = appJson.expo.ios?.privacyManifests;
    expect(manifest?.NSPrivacyTracking).toBe(false);
    const reasons = Object.fromEntries((manifest?.NSPrivacyAccessedAPITypes ?? []).map((t) => [t.NSPrivacyAccessedAPIType, t.NSPrivacyAccessedAPITypeReasons]));
    expect(reasons).toEqual({
      NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
      NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
      NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1'],
      NSPrivacyAccessedAPICategoryDiskSpace: ['E174.1'],
    });
    for (const item of manifest?.NSPrivacyCollectedDataTypes ?? []) expect(item.NSPrivacyCollectedDataTypeTracking).toBe(false);
  });

  it('Android chặn các quyền ảnh và kho ngoài mà expo-screen-capture và expo-file-system kéo theo', () => {
    expect(appJson.expo.android?.blockedPermissions).toEqual(expect.arrayContaining(['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE']));
  });

  it('hai câu Face ID của hai plugin giống nhau (một chữ hiện cho người dùng)', () => {
    const plugins = pluginsOf(fresh());
    expect(plugins.find((p) => p.name === 'expo-secure-store')?.options.faceIDPermission).toBe(plugins.find((p) => p.name === 'expo-local-authentication')?.options.faceIDPermission);
  });

  it('không có tệp thừa: hình trong app.json đều có thật', () => {
    for (const path of ['assets/icon.png', 'assets/adaptive-icon.png', 'assets/adaptive-icon-mono.png', 'assets/splash-icon.png', 'assets/favicon.png']) expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
  });
});

describe('eas.json', () => {
  const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')) as {
    cli: { appVersionSource: string };
    build: Record<string, { distribution?: string; autoIncrement?: boolean; channel?: string; environment?: string; env?: Record<string, string>; developmentClient?: boolean; extends?: string }>;
    submit: { production: { ios: Record<string, string>; android: Record<string, string> } };
  };

  it('có ba hồ sơ dựng; số bản dựng do EAS tăng (nguồn từ xa), không ghi tay', () => {
    expect(eas.cli.appVersionSource).toBe('remote');
    expect(Object.keys(eas.build)).toEqual(expect.arrayContaining(['development', 'preview', 'production']));
    expect(eas.build.development?.developmentClient).toBe(true);
    expect(eas.build.preview?.distribution).toBe('internal');
    expect(eas.build.production?.distribution).toBe('store');
    expect(eas.build.production?.autoIncrement).toBe(true);
  });

  it('hồ sơ preview và production đặt APP_VARIANT khớp, để app.config.ts bắt buộc ghim máy chủ; development không đặt APP_VARIANT=dev', () => {
    expect(eas.build.preview?.env?.APP_VARIANT).toBe('preview');
    expect(eas.build.production?.env?.APP_VARIANT).toBe('production');
    expect(eas.build.development?.env?.APP_VARIANT).toBeUndefined();
    for (const name of ['development', 'preview', 'production']) expect(eas.build[name]?.channel).toBe(name);
  });

  it('chỗ trống của mục nộp là chuỗi mẫu, không phải mã bịa; khoá tài khoản dịch vụ nằm trong thư mục bị bỏ qua', () => {
    expect(Object.keys(eas.submit.production.ios)).toEqual(expect.arrayContaining(['ascAppId', 'appleTeamId']));
    expect(eas.submit.production.android.serviceAccountKeyPath).toMatch(/^\.\/secrets\//);
  });
});

describe('app.config.ts: ghim máy chủ ở bản phân phối (rà soát 07/10/2026, exec-1)', () => {
  it('buildKindOf: production, preview theo APP_VARIANT hoặc hồ sơ EAS; còn lại là local', () => {
    // app nhân viên không có biến thể dev: APP_VARIANT=dev coi như local
    expect(buildKindOf({ APP_VARIANT: 'dev' })).toBe('local');
    expect(buildKindOf({ APP_VARIANT: 'production' })).toBe('production');
    expect(buildKindOf({ EAS_BUILD_PROFILE: 'production' })).toBe('production');
    expect(buildKindOf({ APP_VARIANT: 'preview' })).toBe('preview');
    expect(buildKindOf({ EAS_BUILD_PROFILE: 'preview' })).toBe('preview');
    expect(buildKindOf({ EAS_BUILD_PROFILE: 'development' })).toBe('local');
    expect(buildKindOf({})).toBe('local');
    // hồ sơ production của EAS thắng một APP_VARIANT nhập nhầm: không thể dựng bản production mà thoát việc ghim
    expect(buildKindOf({ APP_VARIANT: 'preview', EAS_BUILD_PROFILE: 'production' })).toBe('production');
  });

  it('production: ghim https, bỏ dấu / cuối, ghi appVariant và projectId, không đổi mã gói', () => {
    releaseEnv();
    process.env.MIHATO_API_BASE_URL = 'https://api.vrg.example/';
    const result = run(fresh());
    expect(result.extra?.apiBaseUrl).toBe('https://api.vrg.example');
    expect(result.extra?.appVariant).toBe('production');
    expect(result.extra?.eas).toEqual({ projectId: PROJECT_ID });
    expect(result.ios?.bundleIdentifier).toBe('vn.mihato.viectoi');
    expect(pluginsOf(result).map((p) => p.name)).toContain('expo-notifications');
  });

  it('production thiếu địa chỉ máy chủ thì KHÔNG dựng được', () => {
    process.env.APP_VARIANT = 'production';
    process.env.EAS_PROJECT_ID = PROJECT_ID;
    expect(() => run(fresh())).toThrow(/MIHATO_API_BASE_URL/);
    process.env.MIHATO_API_BASE_URL = '   ';
    expect(() => run(fresh())).toThrow(/MIHATO_API_BASE_URL/);
  });

  it('production: http, địa chỉ kèm tài khoản hay tham số, hoặc chuỗi không phải địa chỉ đều bị từ chối', () => {
    releaseEnv();
    for (const bad of ['http://api.vrg.example', 'http://192.168.1.4:3100', 'https://u:p@api.vrg.example', 'https://api.vrg.example?x=1', 'api.vrg.example', 'ftp://api.vrg.example']) {
      process.env.MIHATO_API_BASE_URL = bad;
      expect(() => run(fresh()), bad).toThrow(/MIHATO_API_BASE_URL/);
    }
  });

  it('hồ sơ EAS production tự nó đã bắt buộc ghim, dù APP_VARIANT không đặt', () => {
    process.env.EAS_BUILD_PROFILE = 'production';
    process.env.EAS_PROJECT_ID = PROJECT_ID;
    expect(() => run(fresh())).toThrow(/MIHATO_API_BASE_URL/);
  });

  it('preview: ghim nếu có (https), không bắt buộc địa chỉ; vẫn bắt buộc projectId để thử thông báo đẩy', () => {
    process.env.APP_VARIANT = 'preview';
    process.env.EAS_PROJECT_ID = PROJECT_ID;
    expect(run(fresh()).extra?.apiBaseUrl ?? null).toBeNull();
    process.env.MIHATO_API_BASE_URL = 'https://staging.vrg.example';
    expect(run(fresh()).extra?.apiBaseUrl).toBe('https://staging.vrg.example');
    process.env.MIHATO_API_BASE_URL = 'http://192.168.1.4:3100';
    expect(() => run(fresh())).toThrow(/https/);
    delete process.env.MIHATO_API_BASE_URL;
    delete process.env.EAS_PROJECT_ID;
    expect(() => run(fresh())).toThrow(/EAS_PROJECT_ID/);
  });

  it('EAS_PROJECT_ID: thiếu thì bản phân phối không dựng được; giá trị mẫu chưa thay (không phải UUID) cũng bị từ chối, không bịa mã', () => {
    releaseEnv();
    delete process.env.EAS_PROJECT_ID;
    expect(() => run(fresh())).toThrow(/EAS_PROJECT_ID/);
    for (const bad of ['<DIEN-MA-DU-AN-EAS>', 'abc', '0199c000-0000-7000-8000']) {
      process.env.EAS_PROJECT_ID = bad;
      expect(() => run(fresh()), bad).toThrow(/UUID/);
    }
  });

  it('ATS của bản phân phối chặt: không cho http kể cả mạng nội bộ; không khai chạy nền; đã đăng ký mod gỡ khoá dò máy phát triển', () => {
    releaseEnv();
    const result = run(fresh());
    expect(result.ios?.infoPlist?.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: false });
    expect(result.ios?.infoPlist?.UIBackgroundModes).toBeUndefined();
    expect(typeof (result as ExpoConfig & { mods?: { ios?: { infoPlist?: unknown } } }).mods?.ios?.infoPlist).toBe('function');
  });

  it('bản local (Expo Go, hồ sơ development của EAS): địa chỉ tuỳ chọn, cho phép http mạng nội bộ; không đụng ATS', () => {
    process.env.EAS_BUILD_PROFILE = 'development';
    expect(run(fresh())).toEqual(fresh());
    process.env.MIHATO_API_BASE_URL = 'http://192.168.1.4:3100/';
    const result = run(fresh());
    expect(result.extra?.apiBaseUrl).toBe('http://192.168.1.4:3100');
    expect(result.ios?.infoPlist?.NSAppTransportSecurity).toBeUndefined();
  });

  it('chính sách quyền riêng tư và tổ chức Expo: chỉ nhận https; có thì ghi vào extra, không có thì không thêm khoá', () => {
    releaseEnv();
    expect(run(fresh()).extra).not.toHaveProperty('privacyPolicyUrl');
    process.env.MIHATO_PRIVACY_POLICY_URL = 'https://vrg.example/quyen-rieng-tu';
    process.env.EXPO_OWNER = 'mihato';
    const result = run(fresh());
    expect(result.extra?.privacyPolicyUrl).toBe('https://vrg.example/quyen-rieng-tu');
    expect(result.owner).toBe('mihato');
    process.env.MIHATO_PRIVACY_POLICY_URL = 'http://vrg.example/x';
    expect(() => run(fresh())).toThrow(/MIHATO_PRIVACY_POLICY_URL/);
  });
});
