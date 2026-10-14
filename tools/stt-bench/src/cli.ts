/**
 * Dòng lệnh của bài đo STT (SPEC 6.2.1, 13.6, việc S1-06).
 *
 *   pnpm stt-bench --manifest tools/stt-bench/fixtures/manifest.json --providers fake
 *   pnpm stt-bench --manifest recordings/stt-2026/manifest.json --real --max-minutes 120 \
 *       --providers deepgram-nova3,deepgram-nova3-keyterm,deepgram-nova2,vbee --out docs/benchmarks/stt-2026.md
 *
 * Cấu hình thật chỉ chạy khi có CẢ cờ `--real` VÀ khoá API trong môi trường (DEEPGRAM_API_KEY, VBEE_APP_ID, VBEE_TOKEN;
 * có đọc `.env` ở gốc repo khi có `--real`). Thiếu thì bỏ qua cấu hình đó và nói lý do. Lượt chạy thật in cảnh báo tốn tiền,
 * áp trần `--max-minutes` (mặc định 30) và hỏi xác nhận (hoặc `--yes`).
 * Nhật ký (stderr) chỉ có mã, đếm và tên cấu hình; không bao giờ có khoá hay văn bản câu nói. Báo cáo là đầu ra do người
 * dùng chọn: in ra màn hình, hoặc ghi vào `--out`. KHÔNG tự ghi vào docs/benchmarks/ nếu không có `--out`.
 *
 * Mã thoát: 0 xong; 1 người dùng không xác nhận chạy thật; 2 tham số, manifest hoặc âm thanh sai, hoặc bị chặn (trần phút, ghi đè).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { BYTES_PER_MS, MAX_CHUNK_MS, MIN_CHUNK_MS } from './audio';
import { keytermUsage, parseConfigIds, planRun, resolveConfigs, utteranceEndProblems, type ConfigId, type EndMode } from './configs';
import { collectKeyterms, loadManifest, ManifestError } from './manifest';
import { lintEntities } from './metrics';
import { FAKE_MARKER, buildReport, isFakeOnly, renderJson, renderMarkdown, renderSummary } from './report';
import { DEFAULT_SETTINGS, loadItems, runBench, type Clock, type RunSettings } from './runner';

const USAGE = `Bài đo STT (tools/stt-bench)

Cách dùng: pnpm stt-bench --manifest <manifest.json> [tuỳ chọn]

  --manifest <tệp>          manifest JSON của bộ ghi âm (bắt buộc)
  --providers a,b,c         cấu hình so sánh: deepgram-nova3, deepgram-nova3-keyterm, deepgram-nova2, vbee, fake (mặc định fake)
  --real                    cho phép gọi nhà cung cấp THẬT (tốn tiền); vẫn cần khoá API trong môi trường
  --yes                     không hỏi xác nhận trước khi chạy thật
  --max-minutes <n>         trần tổng số phút âm thanh gửi cho nhà cung cấp thật (mặc định 30)
  --utterance-end-ms a,b,c  các giá trị utterance_end_ms cần quét (mặc định 1300)
  --speed <n|max>           tốc độ phát: 1 = thời gian thực; n = nhanh gấp n; max = không chờ. Mặc định 1 khi chạy thật, max khi chỉ chạy bản giả.
                            Độ trễ chỉ đáng tin khi 1
  --chunk-ms <${MIN_CHUNK_MS}..${MAX_CHUNK_MS}>      độ dài mỗi khung âm thanh (mặc định ${DEFAULT_SETTINGS.chunkMs})
  --end-mode <m>            utterance-end (mặc định): chờ nhà cung cấp báo hết câu; close: đóng ngay khi hết tệp
  --speech-end <m>          vad (mặc định): dò điểm hết tiếng nói bằng năng lượng; audio: coi hết tệp là hết tiếng
  --concurrency <n>         số câu chạy song song (mặc định 1)
  --now <ISO>               mốc "bây giờ" cho câu có ngày, ví dụ 2026-10-03T09:00:00+07:00 (ghi đè "now" của manifest)
  --out <tệp.md>            ghi báo cáo Markdown vào tệp, kèm JSON chi tiết cạnh bên (.json)
  --force                   cho phép bản giả ghi đè báo cáo thật đã có ở --out
  --max-errors <n>          số câu sai liệt kê mỗi cấu hình (mặc định 10; 0 là không liệt kê)
  --help                    in trợ giúp
`;

export type CliDeps = {
  env: Readonly<Record<string, string | undefined>>;
  /** thư mục người dùng đứng khi gõ lệnh; đường dẫn tương đối tính từ đây */
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
  /** hỏi xác nhận chạy thật; mặc định hỏi trên terminal, không có terminal thì từ chối */
  confirm?: (question: string) => Promise<boolean>;
  clock?: Clock;
  /** tệp .env nạp khi có --real; null là không nạp */
  envFile?: string | null;
  /** chỉ để test trỏ về máy chủ WebSocket cục bộ */
  deepgramBaseUrl?: string;
  vbeeBaseUrl?: string;
};

class UsageError extends Error {}

const num = (name: string, raw: string): number => {
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new UsageError(`${name} phải là số, nhận "${raw}"`);
  return v;
};

function parseSpeed(raw: string): number {
  if (raw === 'max') return Infinity;
  const v = num('--speed', raw);
  if (v <= 0) throw new UsageError('--speed phải lớn hơn 0 (hoặc "max")');
  return v;
}

function parseUtteranceEnd(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(',')) {
    if (part.trim() === '') continue;
    const v = num('--utterance-end-ms', part.trim());
    if (!Number.isInteger(v) || v <= 0) throw new UsageError(`--utterance-end-ms phải gồm các số nguyên dương, nhận "${part.trim()}"`);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length === 0) throw new UsageError('--utterance-end-ms trống');
  return out.sort((a, b) => a - b);
}

const vn = (n: number, digits: number) => n.toFixed(digits).replace('.', ',');

async function askOnTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return ['y', 'yes', 'c', 'co', 'có'].includes(answer);
  } finally {
    rl.close();
  }
}

const jsonPathFor = (out: string): string => `${out.replace(/\.md$/i, '')}.json`;

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const err = (line = '') => deps.stderr(`${line}\n`);
  // pnpm chuyển nguyên dấu `--` đứng trước tuỳ chọn (pnpm stt-bench -- --manifest …); parseArgs coi nó là hết tuỳ chọn.
  const args = argv[0] === '--' ? argv.slice(1) : argv;

  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        manifest: { type: 'string' },
        providers: { type: 'string' },
        real: { type: 'boolean' },
        yes: { type: 'boolean' },
        'max-minutes': { type: 'string' },
        'utterance-end-ms': { type: 'string' },
        speed: { type: 'string' },
        'chunk-ms': { type: 'string' },
        'end-mode': { type: 'string' },
        'speech-end': { type: 'string' },
        concurrency: { type: 'string' },
        now: { type: 'string' },
        out: { type: 'string' },
        force: { type: 'boolean' },
        'max-errors': { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (e) {
    err(e instanceof Error ? e.message : 'tham số không hợp lệ');
    err('Chạy với --help để xem các tuỳ chọn.');
    return 2;
  }
  if (values.help) {
    deps.stdout(USAGE);
    return 0;
  }

  const str = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const real = values.real === true;

  let settings: RunSettings;
  let speedArg: number | undefined;
  let utteranceEndValues: number[];
  let maxMinutes: number;
  let maxErrors: number;
  let nowOverride: Date | null = null;
  let configIds: ConfigId[];
  try {
    const chunkMs = str('chunk-ms') === undefined ? DEFAULT_SETTINGS.chunkMs : num('--chunk-ms', str('chunk-ms') as string);
    if (!Number.isInteger(chunkMs) || chunkMs < MIN_CHUNK_MS || chunkMs > MAX_CHUNK_MS) throw new UsageError(`--chunk-ms phải là số nguyên từ ${MIN_CHUNK_MS} đến ${MAX_CHUNK_MS}`);
    const endMode = str('end-mode') ?? DEFAULT_SETTINGS.endMode;
    if (endMode !== 'utterance-end' && endMode !== 'close') throw new UsageError('--end-mode phải là utterance-end hoặc close');
    const speechEnd = str('speech-end') ?? DEFAULT_SETTINGS.speechEnd;
    if (speechEnd !== 'vad' && speechEnd !== 'audio') throw new UsageError('--speech-end phải là vad hoặc audio');
    const concurrency = str('concurrency') === undefined ? DEFAULT_SETTINGS.concurrency : num('--concurrency', str('concurrency') as string);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new UsageError('--concurrency phải là số nguyên từ 1 đến 32');
    speedArg = str('speed') === undefined ? undefined : parseSpeed(str('speed') as string);
    settings = { ...DEFAULT_SETTINGS, chunkMs, endMode: endMode as EndMode, speechEnd, concurrency };
    utteranceEndValues = parseUtteranceEnd(str('utterance-end-ms') ?? '1300');
    maxMinutes = str('max-minutes') === undefined ? 30 : num('--max-minutes', str('max-minutes') as string);
    if (maxMinutes <= 0) throw new UsageError('--max-minutes phải lớn hơn 0');
    maxErrors = str('max-errors') === undefined ? 10 : num('--max-errors', str('max-errors') as string);
    if (!Number.isInteger(maxErrors) || maxErrors < 0) throw new UsageError('--max-errors phải là số nguyên không âm');
    if (str('now') !== undefined) {
      nowOverride = new Date(str('now') as string);
      if (Number.isNaN(nowOverride.getTime()) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(str('now') as string)) throw new UsageError('--now phải là thời điểm ISO có múi giờ, ví dụ 2026-10-03T09:00:00+07:00');
    }
    configIds = parseConfigIds(str('providers') ?? 'fake');
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const manifestArg = str('manifest');
  if (!manifestArg) {
    err('Thiếu --manifest <tệp>. Chạy với --help để xem cách dùng.');
    return 2;
  }

  // ── Manifest và âm thanh: đọc hết, kiểm hết, TRƯỚC khi gọi nhà cung cấp nào.
  let loaded;
  try {
    loaded = loadManifest(resolve(deps.cwd, manifestArg));
  } catch (e) {
    if (e instanceof ManifestError) {
      err(e.message);
      return 2;
    }
    throw e;
  }
  const { manifest, baseDir } = loaded;
  const { items, problems } = loadItems(manifest, baseDir);
  if (problems.length > 0) {
    err('Không dùng được tệp âm thanh:');
    for (const p of problems) err(`  - ${p}`);
    return 2;
  }
  const now = nowOverride ?? (manifest.now ? new Date(manifest.now) : null);
  if (now === null && manifest.items.some((i) => i.entities.dates.length > 0)) {
    err('Có câu mong đợi ngày nhưng thiếu mốc now: đặt "now" trong manifest hoặc dùng --now.');
    return 2;
  }
  const lint = lintEntities(manifest.items, { now });
  if (lint.length > 0) {
    err(`Cảnh báo manifest: ${lint.length} chỗ thực thể ghi trong manifest không khớp với câu chuẩn khi đọc bằng bộ tách tiền/ngày (số đo tên, tiền, ngày sẽ lệch):`);
    for (const issue of lint.slice(0, 20)) err(`  - ${issue.id}: ${{ name: 'tên', money: 'số tiền', date: 'ngày' }[issue.problem]} lệch ${issue.count}`);
    if (lint.length > 20) err(`  … và ${lint.length - 20} chỗ nữa`);
  }

  // ── Cấu hình: thật chỉ chạy khi có --real VÀ khoá.
  let env: Readonly<Record<string, string | undefined>> = deps.env;
  if (real && deps.envFile && existsSync(deps.envFile)) {
    try {
      env = { ...parseEnv(readFileSync(deps.envFile, 'utf8')), ...deps.env };
    } catch {
      err('Không đọc được tệp .env (bỏ qua).');
    }
  }
  const { runnable, skipped } = resolveConfigs(configIds, { real, env, deepgramBaseUrl: deps.deepgramBaseUrl, vbeeBaseUrl: deps.vbeeBaseUrl });
  for (const k of skipped) err(`Bỏ qua ${k.id}: ${k.reason}.`);
  if (runnable.length === 0) {
    err('Không có cấu hình nào chạy được. Dùng --providers fake để thử công cụ, hoặc thêm --real và khoá API.');
    return 2;
  }
  const anyReal = runnable.some((c) => c.real);
  // Thời gian thực chỉ cần cho số đo thật; bản giả chạy hết tốc độ cho nhanh.
  settings = { ...settings, speed: speedArg ?? (anyReal ? 1 : Infinity) };
  const rangeProblems = utteranceEndProblems(runnable, utteranceEndValues);
  if (rangeProblems.length > 0) {
    for (const p of rangeProblems) err(p);
    return 2;
  }

  // ── Kế hoạch, cảnh báo tốn tiền, trần phút, xác nhận.
  const planItems = items.map((i) => ({ id: i.item.id, audioBytes: i.pcm.byteLength }));
  const plan = planRun({ configs: runnable, utteranceEndValues, items: planItems, endMode: settings.endMode });
  if (plan.problems.length > 0) {
    for (const p of plan.problems) err(p);
    return 2;
  }
  if (anyReal) {
    err();
    err('  CẢNH BÁO: lượt chạy này gọi nhà cung cấp THẬT và TỐN TIỀN.');
    err(`  Cấu hình thật: ${runnable.filter((c) => c.real).map((c) => c.id).join(', ')}; utterance_end_ms: ${utteranceEndValues.join(', ')}.`);
    err(`  Dự kiến ${vn(plan.realMinutes, 1)} phút âm thanh (trần --max-minutes ${maxMinutes}), chi phí ước tính khoảng ${vn(plan.realCostUsd, 4)} USD.`);
    if (plan.unpriced.length > 0) err(`  Chưa có giá trong SPEC nên chưa tính: ${plan.unpriced.join(', ')}.`);
    err('  Âm thanh được gửi cho nhà cung cấp ngoài: chỉ chạy với bản ghi đã có phiếu đồng ý bằng văn bản (SPEC 11, 13.6).');
    if (settings.speed !== 1) err(`  Tốc độ ${settings.speed === Infinity ? 'max' : settings.speed}× không phải thời gian thực: số đo độ trễ sẽ KHÔNG đáng tin.`);
    const kt = runnable.find((c) => c.sendKeyterms) ? keytermUsage(collectKeyterms(manifest)) : null;
    if (kt && kt.sent < kt.total) err(`  Chỉ ${kt.sent}/${kt.total} keyterm vừa trần token của Deepgram; phần còn lại bị bỏ.`);
    err();
    if (plan.realMinutes > maxMinutes) {
      err(`Vượt trần: kế hoạch cần ${vn(plan.realMinutes, 1)} phút âm thanh, --max-minutes là ${maxMinutes}. Tăng --max-minutes, bớt câu, bớt cấu hình hoặc giá trị utterance_end_ms, hay dùng --end-mode close. Chưa gọi nhà cung cấp nào.`);
      return 2;
    }
    if (values.yes !== true) {
      const ask = deps.confirm ?? askOnTerminal;
      if (!(await ask('Tiếp tục chạy THẬT? (gõ y để chạy)'))) {
        err('Đã dừng, chưa gọi nhà cung cấp nào. Thêm --yes để chạy không cần hỏi.');
        return 1;
      }
    }
  }

  // ── Chạy.
  err(`Chạy ${runnable.length} cấu hình × ${utteranceEndValues.length} giá trị utterance_end_ms trên ${items.length} câu (${vn(items.reduce((a, i) => a + i.pcm.byteLength, 0) / BYTES_PER_MS / 60_000, 2)} phút âm thanh).`);
  let label = '';
  const passes = await runBench({
    configs: runnable,
    utteranceEndValues,
    items,
    keyterms: collectKeyterms(manifest),
    settings,
    score: { now },
    clock: deps.clock,
    onPassStart: (config, ms) => {
      label = `${config.id} · utterance_end_ms ${ms}`;
      err(`> ${label}`);
    },
    onProgress: (done, total) => {
      if (done === total || done % 10 === 0) err(`  ${label}: ${done}/${total} câu`);
    },
  });

  const report = buildReport({
    generatedAt: deps.now().toISOString(),
    manifest,
    datasetAudioMinutes: items.reduce((a, i) => a + i.pcm.byteLength, 0) / BYTES_PER_MS / 60_000,
    now,
    settings,
    utteranceEndValues,
    skipped,
    passes,
    entityLintIssues: lint.length,
  });
  const failed = report.rows.reduce((a, r) => a + r.summary.failed, 0);
  if (failed > 0) err(`CẢNH BÁO: ${failed} phiên lỗi (xem mã lỗi trong JSON); số đo của các cấu hình đó chưa đáng tin, nên chạy lại.`);

  // ── Xuất báo cáo.
  const outArg = str('out');
  if (!outArg) {
    deps.stdout(renderMarkdown(report, { maxErrors }));
    return 0;
  }
  const outPath = resolve(deps.cwd, outArg);
  if (isFakeOnly(report) && existsSync(outPath) && values.force !== true && !readFileSync(outPath, 'utf8').includes(FAKE_MARKER)) {
    err(`Từ chối ghi đè ${outArg}: tệp đã có không phải báo cáo giả, còn lượt chạy này chỉ dùng bản giả. Thêm --force nếu đúng là muốn ghi đè.`);
    return 2;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderMarkdown(report, { maxErrors }));
  writeFileSync(jsonPathFor(outPath), renderJson(report));
  deps.stdout(renderSummary(report));
  err(`Đã ghi ${outArg} và ${jsonPathFor(outArg)}.`);
  return 0;
}

// ───────────────────────── Điểm vào ─────────────────────────

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    // pnpm chạy script với thư mục hiện hành là thư mục gói; INIT_CWD giữ nơi người dùng gõ lệnh.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    now: () => new Date(),
    envFile: join(repoRoot, '.env'),
  });
}
