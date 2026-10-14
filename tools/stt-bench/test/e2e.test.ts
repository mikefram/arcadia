/**
 * Kiểm đầu cuối: ba tệp âm thanh giả + FakeStt chạy qua runner, báo cáo và dòng lệnh; số đo đối chiếu với TÍNH TAY.
 * Đường `--real` được thử với máy chủ WebSocket cục bộ đóng vai Deepgram và Vbee, nên không gọi nhà cung cấp nào.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateFixtures } from '../scripts/make-fixtures';
import { main, type CliDeps } from '../src/cli';
import { resolveConfigs } from '../src/configs';
import { collectKeyterms, loadManifest } from '../src/manifest';
import { buildReport, FAKE_MARKER, renderMarkdown, type BenchReport } from '../src/report';
import { DEFAULT_SETTINGS, loadItems, runBench } from '../src/runner';
import { capture, FIXTURE_MANIFEST, FIXTURES_DIR, VirtualClock } from './helpers';
import { startDeepgramMock, startVbeeMock, type Mock } from './mocks';

const { manifest, baseDir } = loadManifest(FIXTURE_MANIFEST);
const FAKE_TEXTS = manifest.items.map((i) => i.fake?.final ?? '');
const NOW = new Date(manifest.now as string);
/** Bộ nối Deepgram gửi 400 ms im lặng ngay sau khi mở phiên (đo thật ngày 04/10/2026): 16 kHz, 16-bit là 12.800 byte. Vbee không có. */
const DEEPGRAM_PREROLL_BYTES = 12_800;

// ───────────────────────── Số đo tính tay cho ba câu mẫu ─────────────────────────
//
//  fx-01  "tình hình đón đoàn Nhật thế nào"  (7 từ)   nghe "tinh hình …"  → 1 thay (chỉ sai dấu)
//  fx-02  "đi thúc anh Tuấn việc kiểm tra tuyến tham quan" (10 từ)  nghe "… anh Tú …" → 1 thay, sai tên
//  fx-03  "duyệt đề nghị tạm ứng hai chục triệu cho chị Phương trước thứ Tư ngày bảy tháng mười" (18 từ)
//         nghe "… hai chục nghìn …" → 1 thay, sai số tiền (20.000 thay vì 20.000.000); tên và ngày vẫn đúng
//
//  Tổng 35 từ; WER 3/35. Bỏ dấu: fx-01 hết lỗi nên 2/35. Tên người: Tuấn sai, Phương đúng → 1/2.
//  Số tiền: 1/1 câu sai. Ngày: 0/1. Âm thanh: 2 + 2,5 + 3 giây = 7,5 giây = 0,125 phút.

describe('ba tệp mẫu với FakeStt: số đo khớp tính tay', () => {
  async function run(): Promise<BenchReport> {
    const { items, problems } = loadItems(manifest, baseDir);
    expect(problems).toEqual([]);
    const clock = new VirtualClock();
    const configs = resolveConfigs(['fake'], { real: false, env: {} }).runnable;
    const settings = { ...DEFAULT_SETTINGS, speed: Infinity };
    const passes = await clock.drive(runBench({ configs, utteranceEndValues: [1300], items, keyterms: collectKeyterms(manifest), settings, score: { now: NOW }, clock }));
    return buildReport({ generatedAt: '2026-10-03T13:00:00.000Z', manifest, datasetAudioMinutes: 0.125, now: NOW, settings, utteranceEndValues: [1300], skipped: [], passes, entityLintIssues: 0 });
  }

  it('tổng hợp', async () => {
    const r = await run();
    expect(r.mode).toBe('fake');
    expect(r.rows).toHaveLength(1);
    const s = r.rows[0]!.summary;
    expect(s.sentences).toBe(3);
    expect(s.failed).toBe(0);
    expect(s.wer).toMatchObject({ substitutions: 3, deletions: 0, insertions: 0, errors: 3, refWords: 35 });
    expect(s.wer.rate).toBeCloseTo(3 / 35, 12);
    expect(s.werPlain).toMatchObject({ errors: 2, refWords: 35 });
    expect(s.werPlain.rate).toBeCloseTo(2 / 35, 12);
    expect(s.people).toEqual({ wrong: 1, total: 2, rate: 0.5 });
    expect(s.units).toEqual({ wrong: 0, total: 0, rate: null });
    expect(s.names).toEqual({ wrong: 1, total: 2, rate: 0.5 });
    expect(s.nameDiacriticOnly).toBe(0);
    expect(s.money).toEqual({ wrong: 1, total: 1, rate: 1 });
    expect(s.dates).toEqual({ wrong: 0, total: 1, rate: 0 });
    expect(s.earlyCuts).toBe(0);
    expect(s.earlyFinals).toBe(0);
    expect(s.audioMinutes).toBeCloseTo(0.125, 12);
    expect(s.costUsd).toBe(0);
    expect(s.latencyMs).toMatchObject({ n: 3, p50: 0, p95: 0 });
    expect(r.rows[0]!.verdict).toBeNull();
  });

  it('từng câu: kết quả nghe được và lỗi bắt được', async () => {
    const items = (await run()).rows[0]!.items;
    expect(items.map((i) => i.hypothesis)).toEqual(FAKE_TEXTS);
    // fx-01: một lỗi dấu, không lỗi từ
    expect(items[0]).toMatchObject({ id: 'fx-01', wer: { errors: 1, errorsNoDiacritics: 0, refWords: 7 }, names: [], money: null, dates: null });
    // fx-02: sai tên (Tú thay Tuấn: không phải lỗi dấu)
    expect(items[1]).toMatchObject({ id: 'fx-02', wer: { errors: 1, errorsNoDiacritics: 1, refWords: 10 }, names: [{ name: 'Tuấn', kind: 'person', verdict: 'missing' }] });
    // fx-03: sai số tiền, tên và ngày đúng
    expect(items[2]).toMatchObject({
      id: 'fx-03',
      wer: { errors: 1, refWords: 18 },
      names: [{ name: 'Phương', kind: 'person', verdict: 'exact' }],
      money: { expected: [20_000_000], got: [20_000], ok: false },
      dates: { expected: ['2026-10-07'], got: ['2026-10-07'], ok: true },
    });
    // gửi đủ từng tệp, không đuôi (bản giả báo hết câu ngay ở khung cuối)
    expect(items.map((i) => i.bytesSent)).toEqual([64_000, 80_000, 96_000]);
  });

  it('theo người nói', async () => {
    const [fx01, fx02] = (await run()).rows[0]!.bySpeaker;
    expect(fx01).toMatchObject({ speaker: 'FX01', age: 63, region: 'Bắc' });
    expect(fx01!.summary.sentences).toBe(2);
    expect(fx01!.summary.wer).toMatchObject({ errors: 2, refWords: 25 });
    expect(fx01!.summary.people).toEqual({ wrong: 0, total: 1, rate: 0 });
    expect(fx01!.summary.money).toEqual({ wrong: 1, total: 1, rate: 1 });
    expect(fx02).toMatchObject({ speaker: 'FX02', age: 67 });
    expect(fx02!.summary.wer).toMatchObject({ errors: 1, refWords: 10 });
    expect(fx02!.summary.people).toEqual({ wrong: 1, total: 1, rate: 1 });
    expect(fx02!.summary.money.total).toBe(0);
  });

  it('theo nhóm câu', async () => {
    const g = (await run()).rows[0]!.byGroup;
    expect(g.name.sentences).toBe(2);
    expect(g.name.wer).toMatchObject({ errors: 2, refWords: 28 });
    expect(g.money.sentences).toBe(1);
    expect(g.money.wer).toMatchObject({ errors: 1, refWords: 18 });
    expect(g.date.sentences).toBe(1);
    expect(g.date.dates).toEqual({ wrong: 0, total: 1, rate: 0 });
  });

  it('chạy hai lần ra đúng cùng một báo cáo (tất định)', async () => {
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it('Markdown có đúng các số của bảng chính và đánh dấu là giả', async () => {
    const md = renderMarkdown(await run(), { maxErrors: 10 });
    expect(md).toContain(`Chỉ chứng minh công cụ đúng, ${FAKE_MARKER}`);
    expect(md).toContain('| FakeStt theo bản ghi sẵn (giả) | 1300 | 8,6 | 5,7 | 50,0 (1/2) | 100,0 (1/1) | 0,0 (0/1) | — | — | 0 | 0,13 | 0 |');
    expect(md).toContain('**fx-02** (FX02, `02-di-thuc-anh-tuan.wav`): sai chữ, sai tên');
    expect(md).toContain('**fx-03** (FX01, `03-duyet-tam-ung.wav`): sai chữ, sai số tiền');
    expect(md).toContain('**fx-01** (FX01, `01-tinh-hinh-don-doan.wav`): chỉ sai dấu');
  });
});

describe('tệp mẫu', () => {
  it('khớp từng byte với những gì scripts/make-fixtures.ts sinh ra', () => {
    for (const f of generateFixtures()) {
      const onDisk = readFileSync(join(FIXTURES_DIR, f.name));
      expect(onDisk.byteLength).toBe(f.wav.byteLength);
      expect(Buffer.compare(onDisk, Buffer.from(f.wav))).toBe(0);
    }
  });
  it('sinh hai lần ra cùng một kết quả', () => {
    const a = generateFixtures();
    const b = generateFixtures();
    expect(a.map((f) => Buffer.from(f.wav).toString('base64'))).toEqual(b.map((f) => Buffer.from(f.wav).toString('base64')));
  });
  it('manifest không chứa tên thật và nhận mã ẩn danh', () => {
    expect(manifest.items.map((i) => i.speaker)).toEqual(['FX01', 'FX02', 'FX01']);
  });
  it('mô tả quy ước giá trị lỗi cố ý trong manifest khớp với dữ liệu', () => {
    expect(manifest.items.map((i) => i.fake?.final)).toEqual(FAKE_TEXTS);
    expect(manifest.description).toMatch(/một lỗi dấu .*một sai tên .*một sai số tiền/s);
  });
});

// ───────────────────────── Dòng lệnh ─────────────────────────

describe('dòng lệnh', () => {
  const dirs: string[] = [];
  const mocks: Mock[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'stt-bench-cli-'));
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    await Promise.all(mocks.splice(0).map((m) => m.close()));
  });

  async function cli(args: string[], over: Partial<CliDeps> = {}) {
    const io = capture();
    const code = await main(args, { env: {}, cwd: FIXTURES_DIR, stdout: io.stdout, stderr: io.stderr, now: () => new Date('2026-10-03T13:00:00.000Z'), envFile: null, ...over });
    return { code, out: io.out, err: io.err };
  }
  const BASE = ['--manifest', FIXTURE_MANIFEST];

  describe('trợ giúp và tham số', () => {
    it('--help in cách dùng và thoát 0', async () => {
      const r = await cli(['--help']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('--manifest');
      expect(r.out).toContain('--real');
      expect(r.out).toContain('--max-minutes');
      expect(r.out).toContain('--utterance-end-ms');
    });

    it('thiếu --manifest', async () => {
      const r = await cli([]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('Thiếu --manifest');
      expect(r.out).toBe('');
    });

    it('tuỳ chọn lạ', async () => {
      const r = await cli([...BASE, '--khong-co']);
      expect(r.code).toBe(2);
      expect(r.err).toContain('--khong-co');
    });

    it('đối số không phải tuỳ chọn', async () => {
      const r = await cli([...BASE, 'thua']);
      expect(r.code).toBe(2);
    });

    it('chịu được dấu -- mà pnpm chuyển nguyên', async () => {
      const r = await cli(['--', ...BASE, '--providers', 'fake']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('| FakeStt theo bản ghi sẵn (giả) |');
    });

    const bad: [string[], RegExp][] = [
      [['--chunk-ms', '10'], /--chunk-ms/],
      [['--chunk-ms', '101'], /--chunk-ms/],
      [['--chunk-ms', 'abc'], /--chunk-ms/],
      [['--chunk-ms', '33.5'], /--chunk-ms/],
      [['--speed', '0'], /--speed/],
      [['--speed', '-1'], /--speed/],
      [['--speed', 'nhanh'], /--speed/],
      [['--utterance-end-ms', 'abc'], /--utterance-end-ms/],
      [['--utterance-end-ms', '0'], /--utterance-end-ms/],
      [['--utterance-end-ms', '1300.5'], /--utterance-end-ms/],
      [['--utterance-end-ms', ','], /--utterance-end-ms/],
      [['--max-minutes', '0'], /--max-minutes/],
      [['--max-minutes', '-5'], /--max-minutes/],
      [['--max-minutes', 'nhieu'], /--max-minutes/],
      [['--concurrency', '0'], /--concurrency/],
      [['--concurrency', '33'], /--concurrency/],
      [['--concurrency', '2.5'], /--concurrency/],
      [['--end-mode', 'foo'], /--end-mode/],
      [['--speech-end', 'foo'], /--speech-end/],
      [['--now', 'hôm qua'], /--now/],
      [['--now', '2026-10-03T09:00:00'], /--now/],
      [['--max-errors', '-1'], /--max-errors/],
      [['--max-errors', 'x'], /--max-errors/],
      [['--providers', 'nova9'], /Cấu hình "nova9" không có/],
      [['--providers', ''], /trống|--providers/],
    ];
    it.each(bad)('%j bị từ chối với thông báo nêu đúng tham số', async (args, message) => {
      const r = await cli([...BASE, ...args]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(message);
      expect(r.out).toBe('');
    });
  });

  describe('manifest và âm thanh', () => {
    it('manifest không tồn tại', async () => {
      const r = await cli(['--manifest', join(tmp(), 'khong-co.json')]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('không đọc được tệp manifest');
    });

    it('manifest sai lược đồ', async () => {
      const dir = tmp();
      writeFileSync(join(dir, 'm.json'), JSON.stringify({ items: [] }));
      const r = await cli(['--manifest', join(dir, 'm.json')]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('ít nhất một mục');
    });

    it('tệp âm thanh thiếu hoặc sai định dạng: liệt kê theo id, chưa chạy gì', async () => {
      const dir = tmp();
      writeFileSync(join(dir, 'hong.wav'), new Uint8Array(100));
      writeFileSync(
        join(dir, 'm.json'),
        JSON.stringify({ items: [{ id: 'a1', file: 'khong-co.wav', speaker: 'S01', reference: 'xin chào' }, { id: 'a2', file: 'hong.wav', speaker: 'S01', reference: 'xin chào' }] }),
      );
      const r = await cli(['--manifest', join(dir, 'm.json')]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('a1: không đọc được tệp âm thanh');
      expect(r.err).toContain('a2: không phải tệp WAV');
      expect(r.err).not.toContain('Chạy 1 cấu hình');
    });

    it('có câu mong đợi ngày mà không có mốc now', async () => {
      const dir = tmp();
      writeFileSync(
        join(dir, 'm.json'),
        JSON.stringify({ items: [{ id: 'a1', file: join(FIXTURES_DIR, '01-tinh-hinh-don-doan.wav'), speaker: 'S01', reference: 'ngày mai', entities: { dates: ['2026-10-04'] } }] }),
      );
      const r = await cli(['--manifest', join(dir, 'm.json')]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('thiếu mốc now');
    });

    it('--now đổi cách đọc ngày, và manifest lệch với câu chuẩn thì cảnh báo mà không nêu nội dung', async () => {
      const r = await cli([...BASE, '--now', '2026-10-08T09:00:00+07:00']);
      expect(r.code).toBe(0);
      expect(r.err).toContain('Cảnh báo manifest');
      expect(r.err).toContain('fx-03: ngày lệch');
      expect(r.out).toContain('| FakeStt theo bản ghi sẵn (giả) | 1300 | 8,6 | 5,7 | 50,0 (1/2) | 100,0 (1/1) | 100,0 (1/1) |');
    });

    it('manifest khớp thì không cảnh báo', async () => {
      expect((await cli(BASE)).err).not.toContain('Cảnh báo manifest');
    });
  });

  describe('chạy bản giả', () => {
    it('mặc định chạy fake, in báo cáo ra màn hình, nhanh và không tốn tiền', async () => {
      const r = await cli(BASE);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Chỉ chứng minh công cụ đúng, ${FAKE_MARKER}`);
      expect(r.out).toContain('| FakeStt theo bản ghi sẵn (giả) | 1300 | 8,6 | 5,7 | 50,0 (1/2) | 100,0 (1/1) | 0,0 (0/1) |');
      expect(r.out).toContain('Không áp dụng');
      expect(r.err).toContain('Chạy 1 cấu hình × 1 giá trị utterance_end_ms trên 3 câu (0,13 phút âm thanh)');
      expect(r.err).toContain('3/3 câu');
      expect(r.err).not.toContain('CẢNH BÁO: lượt chạy này gọi nhà cung cấp THẬT');
    });

    it('nhật ký (stderr) không chứa nội dung câu nói, tên hay số tiền', async () => {
      const r = await cli(BASE);
      for (const secret of ['Tuấn', 'Phương', 'tinh hình', 'tình hình', 'kiểm tra tuyến', 'tạm ứng', 'hai chục', '20000000', '20.000.000']) expect(r.err).not.toContain(secret);
    });

    it('quét nhiều giá trị utterance_end_ms: mỗi giá trị một dòng', async () => {
      const r = await cli([...BASE, '--utterance-end-ms', '1500,1000,1300,1000']);
      expect(r.code).toBe(0);
      expect(r.err).toContain('Chạy 1 cấu hình × 3 giá trị utterance_end_ms');
      for (const ms of [1000, 1300, 1500]) expect(r.out).toContain(`| FakeStt theo bản ghi sẵn (giả) | ${ms} |`);
      expect(r.out.indexOf('| 1000 |')).toBeLessThan(r.out.indexOf('| 1300 |'));
    });

    it('--out ghi Markdown và JSON cạnh bên, màn hình chỉ có tóm tắt không có câu nói', async () => {
      const dir = tmp();
      const out = join(dir, 'docs', 'benchmarks', 'stt-2026.md');
      const r = await cli([...BASE, '--out', out]);
      expect(r.code).toBe(0);
      expect(existsSync(out)).toBe(true);
      const md = readFileSync(out, 'utf8');
      const json = JSON.parse(readFileSync(join(dir, 'docs', 'benchmarks', 'stt-2026.json'), 'utf8')) as BenchReport;
      expect(md).toContain('Nghe được: đi thúc anh Tú việc kiểm tra tuyến tham quan');
      expect(json.rows[0]!.summary.sentences).toBe(3);
      expect(json.rows[0]!.items[1]!.hypothesis).toBe('đi thúc anh Tú việc kiểm tra tuyến tham quan');
      expect(r.out).toContain('| FakeStt theo bản ghi sẵn (giả) |');
      expect(r.out).not.toContain('Nghe được');
      expect(r.err).toContain('Đã ghi');
    });

    it('--out không có đuôi .md thì JSON thêm .json', async () => {
      const dir = tmp();
      await cli([...BASE, '--out', join(dir, 'ketqua')]);
      expect(existsSync(join(dir, 'ketqua'))).toBe(true);
      expect(existsSync(join(dir, 'ketqua.json'))).toBe(true);
    });

    it('--out tương đối tính từ thư mục người dùng gõ lệnh', async () => {
      const dir = tmp();
      await cli([...BASE, '--out', 'bao-cao.md'], { cwd: dir });
      expect(existsSync(join(dir, 'bao-cao.md'))).toBe(true);
    });

    it('không có --out thì không ghi tệp nào', async () => {
      const dir = tmp();
      await cli(BASE, { cwd: dir });
      expect(existsSync(join(dir, 'docs'))).toBe(false);
    });

    it('bản giả không ghi đè báo cáo thật đã có, trừ khi --force', async () => {
      const dir = tmp();
      const out = join(dir, 'stt-2026.md');
      writeFileSync(out, '# Kết quả đo thật\n');
      const refused = await cli([...BASE, '--out', out]);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain('Từ chối ghi đè');
      expect(readFileSync(out, 'utf8')).toBe('# Kết quả đo thật\n');
      expect(existsSync(join(dir, 'stt-2026.json'))).toBe(false);

      const forced = await cli([...BASE, '--out', out, '--force']);
      expect(forced.code).toBe(0);
      expect(readFileSync(out, 'utf8')).toContain(FAKE_MARKER);
    });

    it('bản giả ghi đè được báo cáo giả cũ', async () => {
      const dir = tmp();
      const out = join(dir, 'stt-2026.md');
      expect((await cli([...BASE, '--out', out])).code).toBe(0);
      expect((await cli([...BASE, '--out', out])).code).toBe(0);
    });
  });

  describe('bản thật bị chặn khi thiếu cờ hoặc khoá, không chạm mạng', () => {
    it('chọn cấu hình thật mà không có --real', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...BASE, '--providers', 'deepgram-nova3'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(r.code).toBe(2);
      expect(r.err).toContain('Bỏ qua deepgram-nova3: cần cờ --real');
      expect(r.err).toContain('Không có cấu hình nào chạy được');
      expect(mock.connections).toHaveLength(0);
    });

    it('có --real mà thiếu khoá', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...BASE, '--providers', 'deepgram-nova3,vbee', '--real'], { env: {}, deepgramBaseUrl: mock.url });
      expect(r.code).toBe(2);
      expect(r.err).toContain('Bỏ qua deepgram-nova3: thiếu biến môi trường DEEPGRAM_API_KEY');
      expect(r.err).toContain('Bỏ qua vbee: thiếu biến môi trường VBEE_APP_ID hoặc VBEE_TOKEN');
      expect(mock.connections).toHaveLength(0);
    });

    it('chọn lẫn fake và thật không có --real: fake vẫn chạy, thật bị bỏ qua', async () => {
      const r = await cli([...BASE, '--providers', 'fake,deepgram-nova3'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' } });
      expect(r.code).toBe(0);
      expect(r.err).toContain('Bỏ qua deepgram-nova3');
      expect(r.out).toContain('Cấu hình đã bỏ qua: `deepgram-nova3`');
    });

    it('khoá không bao giờ xuất hiện trong nhật ký hay báo cáo', async () => {
      const r = await cli([...BASE, '--providers', 'fake,deepgram-nova3,vbee'], { env: { DEEPGRAM_API_KEY: 'khoa-rat-bi-mat', VBEE_APP_ID: 'app-rat-bi-mat', VBEE_TOKEN: 'token-rat-bi-mat' } });
      for (const secret of ['khoa-rat-bi-mat', 'app-rat-bi-mat', 'token-rat-bi-mat']) {
        expect(r.err).not.toContain(secret);
        expect(r.out).not.toContain(secret);
      }
    });

    it('giá trị utterance_end_ms ngoài khoảng nhà cung cấp nhận thì chặn trước khi chạy', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...BASE, '--providers', 'deepgram-nova3', '--real', '--yes', '--utterance-end-ms', '800'], { env: { DEEPGRAM_API_KEY: 'k' }, deepgramBaseUrl: mock.url });
      expect(r.code).toBe(2);
      expect(r.err).toContain('deepgram-nova3: utterance_end_ms 800 ngoài khoảng 1000 đến 10000');
      expect(mock.connections).toHaveLength(0);
    });
  });

  describe('lớp chặn chi phí', () => {
    const realArgs = [...BASE, '--providers', 'deepgram-nova3', '--real'];

    it('kế hoạch vượt trần --max-minutes thì dừng, chưa gọi nhà cung cấp nào', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...realArgs, '--yes', '--max-minutes', '0.1'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(r.code).toBe(2);
      expect(r.err).toContain('CẢNH BÁO: lượt chạy này gọi nhà cung cấp THẬT và TỐN TIỀN');
      expect(r.err).toContain('Vượt trần');
      expect(r.err).toContain('Chưa gọi nhà cung cấp nào');
      expect(mock.connections).toHaveLength(0);
    });

    it('trần mặc định 30 phút; kế hoạch của bộ mẫu (0,27 phút) nằm trong trần', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...realArgs, '--yes', '--speed', 'max'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(r.code).toBe(0);
      expect(r.err).toContain('trần --max-minutes 30');
      expect(r.err).toContain('Dự kiến 0,3 phút âm thanh');
    });

    it('cảnh báo nêu cấu hình chưa có giá và nhắc phiếu đồng ý', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...BASE, '--providers', 'deepgram-nova3,deepgram-nova2', '--real', '--yes', '--speed', 'max'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(r.err).toContain('Chưa có giá trong SPEC nên chưa tính: deepgram-nova2');
      expect(r.err).toContain('phiếu đồng ý bằng văn bản');
    });

    it('không có --yes và không xác nhận: dừng với mã 1, chưa gọi gì', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const asked: string[] = [];
      const r = await cli(realArgs, { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url, confirm: async (q) => { asked.push(q); return false; } });
      expect(r.code).toBe(1);
      expect(asked).toHaveLength(1);
      expect(r.err).toContain('Đã dừng, chưa gọi nhà cung cấp nào');
      expect(mock.connections).toHaveLength(0);
    });

    it('xác nhận trên terminal thì chạy tiếp', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...realArgs, '--speed', 'max'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url, confirm: async () => true });
      expect(r.code).toBe(0);
      expect(mock.connections).toHaveLength(3);
    });

    it('không có terminal và không --yes thì mặc định từ chối', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli(realArgs, { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(r.code).toBe(1);
      expect(mock.connections).toHaveLength(0);
    });

    it('chạy không phải thời gian thực thì cảnh báo độ trễ không đáng tin', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...realArgs, '--yes', '--speed', '100'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(r.err).toContain('KHÔNG đáng tin');
    });
  });

  describe('cấu hình thật với máy chủ cục bộ đóng vai Deepgram và Vbee', () => {
    const fast = ['--yes', '--speed', 'max', '--real'];

    it('ba cấu hình Deepgram gửi đúng mô hình và keyterm; báo cáo có ba dòng', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const dir = tmp();
      const out = join(dir, 'stt.md');
      const r = await cli([...BASE, '--providers', 'deepgram-nova3,deepgram-nova3-keyterm,deepgram-nova2', ...fast, '--out', out], {
        env: { DEEPGRAM_API_KEY: 'khoa-thu' },
        deepgramBaseUrl: mock.url,
      });
      expect(r.code).toBe(0);
      expect(mock.connections).toHaveLength(9);

      const query = (i: number) => new URL(`ws://x${mock.connections[i]!.url}`).searchParams;
      for (let i = 0; i < 9; i++) {
        const q = query(i);
        expect(q.get('language')).toBe('vi');
        expect(q.get('encoding')).toBe('linear16');
        expect(q.get('sample_rate')).toBe('16000');
        expect(q.get('interim_results')).toBe('true');
        expect(q.get('utterance_end_ms')).toBe('1300');
        expect(q.get('mip_opt_out')).toBe('true');
        expect(q.has('smart_format')).toBe(false);
        expect(mock.connections[i]!.auth).toBe('Token khoa-thu');
      }
      // ba câu đầu: Nova-3 không keyterm; ba câu giữa: Nova-3 có keyterm của cả manifest; ba câu cuối: Nova-2, không keyterm
      for (const i of [0, 1, 2]) {
        expect(query(i).get('model')).toBe('nova-3');
        expect(query(i).getAll('keyterm')).toEqual([]);
      }
      for (const i of [3, 4, 5]) {
        expect(query(i).get('model')).toBe('nova-3');
        expect(query(i).getAll('keyterm')).toEqual(['Tuấn', 'Phương']);
      }
      for (const i of [6, 7, 8]) {
        expect(query(i).get('model')).toBe('nova-2');
        expect(query(i).getAll('keyterm')).toEqual([]);
      }
      // âm thanh gửi đủ: im lặng chèn đầu phiên, tệp, rồi đuôi 28 khung (1300 + 1500 ms) vì máy chủ giả chỉ chốt khi nhận CloseStream
      expect(mock.connections.slice(0, 3).map((c) => c.bytes)).toEqual([64_000, 80_000, 96_000].map((b) => DEEPGRAM_PREROLL_BYTES + b + 28 * 3200));
      expect(mock.connections[0]!.messages.map((m) => m.type)).toEqual(['CloseStream']);

      const json = JSON.parse(readFileSync(join(dir, 'stt.json'), 'utf8')) as BenchReport;
      expect(json.mode).toBe('real');
      expect(json.rows.map((row) => row.configId)).toEqual(['deepgram-nova3', 'deepgram-nova3-keyterm', 'deepgram-nova2']);
      for (const row of json.rows) {
        // máy chủ giả trả đúng bản ghi sẵn của fixture nên số đo bằng bản giả
        expect(row.summary.wer.errors).toBe(3);
        expect(row.summary.people).toEqual({ wrong: 1, total: 2, rate: 0.5 });
        expect(row.summary.money).toEqual({ wrong: 1, total: 1, rate: 1 });
        expect(row.verdict).toMatchObject({ status: 'fail' });
        expect(row.summary.failed).toBe(0);
        expect(row.summary.audioMinutes).toBeCloseTo((64_000 + 80_000 + 96_000 + 3 * 28 * 3200) / 1_920_000, 9);
      }
      expect(json.rows[0]!.summary.costUsd).toBeCloseTo(json.rows[0]!.summary.audioMinutes * 0.0077, 6);
      expect(json.rows[2]!.summary.costUsd).toBeNull();
      const md = readFileSync(out, 'utf8');
      expect(md).not.toContain(FAKE_MARKER);
      expect(md).toContain('0/3 lượt chạy đạt ngưỡng đề xuất');
      expect(md).toContain('chưa có giá');
    });

    it('quét utterance_end_ms: đuôi và tham số đổi theo từng giá trị', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...BASE, '--providers', 'deepgram-nova3', ...fast, '--utterance-end-ms', '1000,1500'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(r.code).toBe(0);
      const ms = mock.connections.map((c) => new URL(`ws://x${c.url}`).searchParams.get('utterance_end_ms'));
      expect(ms).toEqual(['1000', '1000', '1000', '1500', '1500', '1500']);
      // đuôi (1000 + 1500) / 100 = 25 khung và (1500 + 1500) / 100 = 30 khung
      expect(mock.connections.map((c) => c.bytes)).toEqual([64_000, 80_000, 96_000, 64_000, 80_000, 96_000].map((b, i) => DEEPGRAM_PREROLL_BYTES + b + (i < 3 ? 25 : 30) * 3200));
    });

    it('--end-mode close: không gửi đuôi', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      await cli([...BASE, '--providers', 'deepgram-nova3', ...fast, '--end-mode', 'close'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(mock.connections.map((c) => c.bytes)).toEqual([64_000, 80_000, 96_000].map((b) => DEEPGRAM_PREROLL_BYTES + b));
    });

    it('khoá đọc từ .env khi có --real, biến môi trường thắng tệp', async () => {
      const dir = tmp();
      const envFile = join(dir, '.env');
      writeFileSync(envFile, 'DEEPGRAM_API_KEY=khoa-tu-tep-env\n');
      const a = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(a);
      await cli([...BASE, '--providers', 'deepgram-nova3', ...fast, '--end-mode', 'close'], { env: {}, envFile, deepgramBaseUrl: a.url });
      expect(a.connections[0]!.auth).toBe('Token khoa-tu-tep-env');
      const b = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(b);
      await cli([...BASE, '--providers', 'deepgram-nova3', ...fast, '--end-mode', 'close'], { env: { DEEPGRAM_API_KEY: 'khoa-moi-truong' }, envFile, deepgramBaseUrl: b.url });
      expect(b.connections[0]!.auth).toBe('Token khoa-moi-truong');
    });

    it('không có --real thì không đọc .env', async () => {
      const dir = tmp();
      const envFile = join(dir, '.env');
      writeFileSync(envFile, 'DEEPGRAM_API_KEY=khoa-tu-tep-env\n');
      const r = await cli([...BASE, '--providers', 'deepgram-nova3'], { env: {}, envFile });
      expect(r.err).toContain('cần cờ --real');
      expect(r.err).not.toContain('thiếu biến môi trường');
    });

    it('Vbee: xác thực trong địa chỉ, cấu hình ánh xạ utterance_end_ms, âm thanh base64, chốt bằng DONE', async () => {
      const mock = await startVbeeMock(FAKE_TEXTS);
      mocks.push(mock);
      const dir = tmp();
      const out = join(dir, 'vbee.md');
      const r = await cli([...BASE, '--providers', 'vbee', ...fast, '--utterance-end-ms', '1500', '--out', out], {
        env: { VBEE_APP_ID: 'app-1', VBEE_TOKEN: 'tok-1' },
        vbeeBaseUrl: mock.url,
      });
      expect(r.code).toBe(0);
      expect(mock.connections).toHaveLength(3);
      const q = new URL(`ws://x${mock.connections[0]!.url}`).searchParams;
      expect(q.get('token')).toBe('tok-1');
      expect(q.get('appId')).toBe('app-1');
      expect(mock.connections[0]!.messages[0]).toMatchObject({ type: 'STREAMING_CONFIG', config: { sampleRateHertz: 16000, vadConfig: { speechCompleteTimeoutMs: 1500 } } });
      expect(mock.connections[0]!.messages.at(-1)).toEqual({ type: 'DONE' });
      // đuôi (1500 + 1500) / 100 = 30 khung
      expect(mock.connections.map((c) => c.bytes)).toEqual([64_000, 80_000, 96_000].map((b) => b + 30 * 3200));
      const json = JSON.parse(readFileSync(join(dir, 'vbee.json'), 'utf8')) as BenchReport;
      expect(json.rows[0]).toMatchObject({ configId: 'vbee', utteranceEndMs: 1500, usdPerMinute: null });
      expect(json.rows[0]!.summary.wer.errors).toBe(3);
      expect(json.rows[0]!.summary.costUsd).toBeNull();
      // token không lọt vào nhật ký hay báo cáo
      expect(r.err + r.out + readFileSync(out, 'utf8')).not.toContain('tok-1');
    });

    it('Vbee: utterance_end_ms ngoài 500 đến 3000 bị chặn', async () => {
      const mock = await startVbeeMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...BASE, '--providers', 'vbee', ...fast, '--utterance-end-ms', '4000'], { env: { VBEE_APP_ID: 'a', VBEE_TOKEN: 't' }, vbeeBaseUrl: mock.url });
      expect(r.code).toBe(2);
      expect(r.err).toContain('vbee: utterance_end_ms 4000 ngoài khoảng 500 đến 3000');
      expect(mock.connections).toHaveLength(0);
    });

    it('chạy lẫn bản giả và bản thật: báo cáo hỗn hợp, ngưỡng chỉ áp cho dòng thật', async () => {
      const mock = await startDeepgramMock(FAKE_TEXTS);
      mocks.push(mock);
      const r = await cli([...BASE, '--providers', 'fake,deepgram-nova3', ...fast, '--end-mode', 'close'], { env: { DEEPGRAM_API_KEY: 'khoa-thu' }, deepgramBaseUrl: mock.url });
      expect(r.code).toBe(0);
      expect(r.out).toContain('có cả dòng chạy bằng bản giả');
      expect(r.out).toContain('0/1 lượt chạy đạt ngưỡng đề xuất');
    });

    it('nhà cung cấp không nối được: báo phiên lỗi, kết quả đánh dấu chưa đáng tin, không lộ khoá', async () => {
      const r = await cli([...BASE, '--providers', 'deepgram-nova3', ...fast, '--end-mode', 'close'], { env: { DEEPGRAM_API_KEY: 'khoa-rat-bi-mat' }, deepgramBaseUrl: 'ws://127.0.0.1:1/v1/listen' });
      expect(r.code).toBe(0);
      expect(r.err).toContain('CẢNH BÁO: 3 phiên lỗi');
      expect(r.err).not.toContain('khoa-rat-bi-mat');
      expect(r.out).not.toContain('khoa-rat-bi-mat');
      expect(r.out).toContain('stt_open_failed');
    });
  });
});

// ───────────────────────── Thư mục mẫu ─────────────────────────

describe('thư mục fixtures', () => {
  it('có đủ ba tệp WAV và manifest', () => {
    const present = ['01-tinh-hinh-don-doan.wav', '02-di-thuc-anh-tuan.wav', '03-duyet-tam-ung.wav', 'manifest.json'];
    for (const f of present) expect(existsSync(join(FIXTURES_DIR, f))).toBe(true);
  });
});
