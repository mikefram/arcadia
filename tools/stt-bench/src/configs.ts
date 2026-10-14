/**
 * Các cấu hình so sánh của bài đo STT (SPEC 6.2.1 điều 2) và lớp chặn chi phí.
 *
 * Cấu hình THẬT chỉ chạy khi có CẢ cờ `--real` VÀ khoá API trong môi trường (CLAUDE.md luật 10: CI không gọi nhà cung cấp
 * trả phí). Thiếu một trong hai thì bỏ qua cấu hình đó và nói rõ lý do. `fake` luôn chạy được, không cần mạng.
 * Nhà cung cấp thật chỉ được DỰNG khi có người gọi `createProvider`, và chỉ kết nối khi `open()`; chọn cấu hình
 * thôi thì chưa chạm mạng.
 */
import { DeepgramStt, FakeStt, limitKeyterms, type FakeSttUtterance, type SttProvider } from '@mihato/providers';
import { BYTES_PER_MS, chunkCount } from './audio';
import type { ManifestItem } from './manifest';
import { VbeeStt, VBEE_MAX_SESSION_MS } from './vbee-stt';

export type ConfigId = 'deepgram-nova3' | 'deepgram-nova3-keyterm' | 'deepgram-nova2' | 'vbee' | 'fake';
export const CONFIG_IDS: readonly ConfigId[] = ['deepgram-nova3', 'deepgram-nova3-keyterm', 'deepgram-nova2', 'vbee', 'fake'];

/** Nova-3 đơn ngữ, giá thường (SPEC 6.2, dòng Giá; dự toán mục 12 cũng dùng mức này cho thận trọng). */
export const DEEPGRAM_NOVA3_USD_PER_MINUTE = 0.0077;

/** Thời gian chờ thêm sau `utterance_end_ms` để nhà cung cấp kịp báo hết câu, trước khi bỏ cuộc và đóng phiên. */
export const TAIL_MARGIN_MS = 1500;

export type EndMode = 'utterance-end' | 'close';

export type ProviderContext = {
  item: ManifestItem;
  audioBytes: number;
  chunkMs: number;
};

export type BenchConfig = {
  id: ConfigId;
  label: string;
  /** gọi nhà cung cấp thật, tốn tiền */
  real: boolean;
  /** USD mỗi phút âm thanh theo SPEC; null nếu SPEC chưa nêu giá (không bịa) */
  usdPerMinute: number | null;
  /** gửi `keyterm` (tên người, đơn vị của cả manifest) khi mở phiên */
  sendKeyterms: boolean;
  /** giới hạn độ dài phiên của nhà cung cấp, mili giây */
  maxSessionMs: number | null;
  /** khoảng `utterance_end_ms` nhà cung cấp nhận; ngoài khoảng thì adapter âm thầm kẹp lại, làm sai nhãn của bảng kết quả */
  utteranceEndRangeMs: { min: number; max: number };
  createProvider(ctx: ProviderContext): SttProvider;
};

export type SkippedConfig = { id: ConfigId; reason: string };

export type ResolveOptions = {
  /** cờ `--real` */
  real: boolean;
  /** thường là process.env; truyền vào để test không đụng môi trường thật */
  env: Readonly<Record<string, string | undefined>>;
  /** chỉ để test trỏ về máy chủ WebSocket cục bộ */
  deepgramBaseUrl?: string;
  vbeeBaseUrl?: string;
};

export function parseConfigIds(list: string): ConfigId[] {
  const out: ConfigId[] = [];
  for (const raw of list.split(',')) {
    const id = raw.trim();
    if (id === '') continue;
    if (!(CONFIG_IDS as readonly string[]).includes(id)) throw new Error(`Cấu hình "${id}" không có. Chọn trong: ${CONFIG_IDS.join(', ')}`);
    if (!out.includes(id as ConfigId)) out.push(id as ConfigId);
  }
  if (out.length === 0) throw new Error('--providers trống');
  return out;
}

const present = (env: ResolveOptions['env'], name: string): string => (env[name] ?? '').trim();

/** STT giả chạy theo bản ghi sẵn trong manifest; chưa ghi thì coi như nghe đúng hoàn toàn (kết quả = câu chuẩn). */
function fakeProviderFor(ctx: ProviderContext): SttProvider {
  const t = ctx.item.fake;
  const utterance: FakeSttUtterance = { final: t?.final ?? ctx.item.reference, confidence: t?.confidence ?? 0.9 };
  if (t?.interim) utterance.interim = t.interim;
  // Báo hết câu ngay ở khung âm thanh cuối, giống nhà cung cấp chốt đúng lúc hết tiếng.
  return new FakeStt([utterance], { autoEndAfterChunks: chunkCount(ctx.audioBytes, ctx.chunkMs) });
}

function definitions(opts: ResolveOptions): Record<ConfigId, { config: BenchConfig; missing: () => string | null }> {
  const deepgram = (id: ConfigId, label: string, model: string, sendKeyterms: boolean, usdPerMinute: number | null) => {
    let cached: SttProvider | undefined;
    const config: BenchConfig = {
      id,
      label,
      real: true,
      usdPerMinute,
      sendKeyterms,
      maxSessionMs: null,
      // Deepgram: dưới 1000 ms không có lợi và adapter kẹp lên 1000 (SPEC 6.2).
      utteranceEndRangeMs: { min: 1000, max: 10_000 },
      // `useKeyterms` theo cấu hình: bộ nối mặc định không gửi keyterm (đo ngày 04/10/2026 thấy tiếng Việt trả rỗng), nhưng
      // cấu hình "có keyterm" của bài đo tồn tại đúng để đo lại điều đó, nên vẫn gửi.
      createProvider: () => (cached ??= new DeepgramStt({ apiKey: present(opts.env, 'DEEPGRAM_API_KEY'), model, baseUrl: opts.deepgramBaseUrl, useKeyterms: sendKeyterms })),
    };
    return { config, missing: () => (present(opts.env, 'DEEPGRAM_API_KEY') ? null : 'thiếu biến môi trường DEEPGRAM_API_KEY') };
  };
  let vbee: SttProvider | undefined;
  return {
    'deepgram-nova3': deepgram('deepgram-nova3', 'Deepgram Nova-3 vi (không keyterm)', 'nova-3', false, DEEPGRAM_NOVA3_USD_PER_MINUTE),
    'deepgram-nova3-keyterm': deepgram('deepgram-nova3-keyterm', 'Deepgram Nova-3 vi (có keyterm)', 'nova-3', true, DEEPGRAM_NOVA3_USD_PER_MINUTE),
    // keyterm chỉ dùng được với Nova-3 (SPEC 6.2); Nova-2 chạy không keyterm. SPEC chưa nêu giá Nova-2.
    'deepgram-nova2': deepgram('deepgram-nova2', 'Deepgram Nova-2 vi', 'nova-2', false, null),
    vbee: {
      config: {
        id: 'vbee',
        label: 'Vbee STT streaming',
        real: true,
        usdPerMinute: null,
        sendKeyterms: false,
        maxSessionMs: VBEE_MAX_SESSION_MS,
        // `speechCompleteTimeoutMs` của Vbee nhận 500 đến 3000 ms.
        utteranceEndRangeMs: { min: 500, max: 3000 },
        createProvider: () => (vbee ??= new VbeeStt({ appId: present(opts.env, 'VBEE_APP_ID'), token: present(opts.env, 'VBEE_TOKEN'), baseUrl: opts.vbeeBaseUrl })),
      },
      missing: () => (present(opts.env, 'VBEE_APP_ID') && present(opts.env, 'VBEE_TOKEN') ? null : 'thiếu biến môi trường VBEE_APP_ID hoặc VBEE_TOKEN'),
    },
    fake: {
      config: { id: 'fake', label: 'FakeStt theo bản ghi sẵn', real: false, usdPerMinute: 0, sendKeyterms: false, maxSessionMs: null, utteranceEndRangeMs: { min: 1, max: 60_000 }, createProvider: fakeProviderFor },
      missing: () => null,
    },
  };
}

/**
 * Chọn cấu hình chạy được. Giữ thứ tự người dùng nêu. Cấu hình thật bị bỏ qua nếu thiếu `--real` hoặc thiếu khoá;
 * lý do không chứa giá trị của khoá.
 */
export function resolveConfigs(ids: readonly ConfigId[], opts: ResolveOptions): { runnable: BenchConfig[]; skipped: SkippedConfig[] } {
  const defs = definitions(opts);
  const runnable: BenchConfig[] = [];
  const skipped: SkippedConfig[] = [];
  for (const id of ids) {
    const def = defs[id];
    if (def.config.real && !opts.real) {
      skipped.push({ id, reason: 'cần cờ --real (cấu hình này gọi nhà cung cấp THẬT và tốn tiền)' });
      continue;
    }
    const missing = def.config.real ? def.missing() : null;
    if (missing) {
      skipped.push({ id, reason: missing });
      continue;
    }
    runnable.push(def.config);
  }
  return { runnable, skipped };
}

/** Giá trị `utterance_end_ms` nào nằm ngoài khoảng mà cấu hình nhận (adapter sẽ kẹp lại âm thầm nên phải chặn từ đầu). */
export function utteranceEndProblems(configs: readonly BenchConfig[], values: readonly number[]): string[] {
  const out: string[] = [];
  for (const c of configs) {
    for (const v of values) {
      if (v < c.utteranceEndRangeMs.min || v > c.utteranceEndRangeMs.max) {
        out.push(`${c.id}: utterance_end_ms ${v} ngoài khoảng ${c.utteranceEndRangeMs.min} đến ${c.utteranceEndRangeMs.max} mà nhà cung cấp nhận`);
      }
    }
  }
  return out;
}

/** Bao nhiêu `keyterm` thực sự được gửi so với tổng số (Deepgram giới hạn 500 token mỗi yêu cầu, SPEC 6.2). */
export function keytermUsage(keyterms: readonly string[]): { total: number; sent: number } {
  return { total: keyterms.length, sent: limitKeyterms([...keyterms]).length };
}

// ───────────────────────── Kế hoạch và trần phút ─────────────────────────

export type PlanItem = { id: string; audioBytes: number };

export type PlanPass = {
  configId: ConfigId;
  label: string;
  real: boolean;
  utteranceEndMs: number;
  /** cận trên số phút âm thanh sẽ gửi, kể cả đuôi im lặng chờ báo hết câu */
  minutes: number;
  costUsd: number | null;
};

export type Plan = {
  passes: PlanPass[];
  /** tổng phút của các lượt chạy THẬT (cái bị chặn bởi --max-minutes) */
  realMinutes: number;
  /** tổng chi phí ước tính của các lượt thật có giá trong SPEC */
  realCostUsd: number;
  /** cấu hình thật chưa có giá trong SPEC nên không nằm trong tổng chi phí */
  unpriced: ConfigId[];
  /** câu vượt giới hạn phiên của nhà cung cấp: phải sửa trước khi chạy */
  problems: string[];
};

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function planRun(args: { configs: readonly BenchConfig[]; utteranceEndValues: readonly number[]; items: readonly PlanItem[]; endMode: EndMode }): Plan {
  const passes: PlanPass[] = [];
  const problems: string[] = [];
  const unpriced = new Set<ConfigId>();
  for (const config of args.configs) {
    for (const utteranceEndMs of args.utteranceEndValues) {
      const tailMs = args.endMode === 'utterance-end' ? utteranceEndMs + TAIL_MARGIN_MS : 0;
      let ms = 0;
      for (const item of args.items) {
        const itemMs = item.audioBytes / BYTES_PER_MS + tailMs;
        ms += itemMs;
        if (config.maxSessionMs !== null && itemMs > config.maxSessionMs) {
          problems.push(`${config.id}: câu ${item.id} dài ${Math.ceil(itemMs / 1000)} giây (kể cả đuôi chờ), vượt giới hạn phiên ${config.maxSessionMs / 1000} giây của nhà cung cấp`);
        }
      }
      const minutes = ms / 60_000;
      passes.push({
        configId: config.id,
        label: config.label,
        real: config.real,
        utteranceEndMs,
        minutes,
        costUsd: config.usdPerMinute === null ? null : round6(minutes * config.usdPerMinute),
      });
      if (config.real && config.usdPerMinute === null) unpriced.add(config.id);
    }
  }
  const real = passes.filter((p) => p.real);
  return {
    passes,
    realMinutes: real.reduce((a, p) => a + p.minutes, 0),
    realCostUsd: round6(real.reduce((a, p) => a + (p.costUsd ?? 0), 0)),
    unpriced: [...unpriced],
    problems: [...new Set(problems)],
  };
}
