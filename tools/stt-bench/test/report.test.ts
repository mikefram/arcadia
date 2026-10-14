import { describe, expect, it } from 'vitest';
import { parseManifest, type Manifest } from '../src/manifest';
import { buildReport, FAKE_MARKER, fmtPct, fmtRate, formatVnTime, isFakeOnly, mdEscape, renderJson, renderMarkdown, renderSummary, REPORT_VERSION, type BenchReport } from '../src/report';
import { runBench, type LoadedItem, type RunSettings } from '../src/runner';
import type { ConfigId } from '../src/configs';
import { configFor, makeLoaded, SETTINGS, TimedStt, VirtualClock } from './helpers';

const NOW = new Date('2026-10-03T09:00:00+07:00');

const manifest: Manifest = parseManifest({
  description: 'Bộ thử cho báo cáo',
  now: '2026-10-03T09:00:00+07:00',
  items: [
    { id: 'a1', file: 'a1.wav', speaker: 'S01', age: 64, region: 'Bắc', reference: 'đi thúc anh Tuấn', entities: { people: ['Tuấn'] } },
    { id: 'a2', file: 'a2.wav', speaker: 'S01', age: 64, region: 'Bắc', reference: 'duyệt hai chục triệu cho chị Phương', entities: { people: ['Phương'], amountsVnd: [20_000_000] } },
    { id: 'b1', file: 'b1.wav', speaker: 'S02', age: 70, reference: 'họp phòng Kinh doanh ngày mai', entities: { units: ['Kinh doanh'], dates: ['2026-10-04'] } },
    { id: 'b2', file: 'b2.wav', speaker: 'S02', age: 70, reference: 'tình hình đón đoàn', entities: {} },
  ],
});

const loaded: LoadedItem[] = manifest.items.map((item) => makeLoaded(2000, 1600, item));

/** Nhà cung cấp thật (giả lập) chốt đúng 400 ms sau khung cuối và báo hết câu 1250 ms sau; chữ do `say` quyết định. */
async function runReal(say: (reference: string, id: string) => string, over: { settings?: Partial<RunSettings>; real?: boolean; usd?: number | null; id?: ConfigId } = {}) {
  const clock = new VirtualClock();
  const config = configFor(
    (item) =>
      new TimedStt(clock, {
        onAudio(api) {
          if (api.bytes() !== 64_000) return;
          api.later(400, () => api.emit({ type: 'final', text: say(item.reference, item.id), confidence: 0.9 }));
          api.later(1250, () => api.emit({ type: 'utteranceEnd' }));
        },
      }),
    { id: over.id ?? 'deepgram-nova3', label: 'Deepgram Nova-3 vi (không keyterm)', real: over.real ?? true, usdPerMinute: over.usd === undefined ? 0.0077 : over.usd },
  );
  const settings = { ...SETTINGS, ...over.settings };
  const passes = await clock.drive(runBench({ configs: [config], utteranceEndValues: [1300], items: loaded, keyterms: [], settings, score: { now: NOW }, clock }));
  return { passes, settings };
}

function report(passes: Awaited<ReturnType<typeof runReal>>['passes'], settings: RunSettings = SETTINGS, extra: Partial<Parameters<typeof buildReport>[0]> = {}): BenchReport {
  return buildReport({
    generatedAt: '2026-10-03T13:00:00.000Z',
    manifest,
    datasetAudioMinutes: 8 / 60,
    now: NOW,
    settings,
    utteranceEndValues: [1300],
    skipped: [],
    passes,
    entityLintIssues: 0,
    ...extra,
  });
}

describe('định dạng', () => {
  it.each([
    [null, '—'],
    [0, '0,0'],
    [0.05, '5,0'],
    [0.0857142857, '8,6'],
    [1, '100,0'],
    [1.2346, '123,5'],
  ])('fmtPct(%s) = %s', (rate, text) => {
    expect(fmtPct(rate)).toBe(text);
  });
  it('fmtPct số chữ số', () => {
    expect(fmtPct(0.085714, 2)).toBe('8,57');
    expect(fmtPct(0.05, 0)).toBe('5');
  });
  it('fmtRate kèm số sai trên tổng', () => {
    expect(fmtRate({ wrong: 1, total: 2, rate: 0.5 })).toBe('50,0 (1/2)');
    expect(fmtRate({ wrong: 0, total: 0, rate: null })).toBe('—');
  });
  it.each([
    ['a|b', 'a\\|b'],
    ['*đậm* _nghiêng_', '\\*đậm\\* \\_nghiêng\\_'],
    ['`mã`', '\\`mã\\`'],
    ['[liên kết](x)', '\\[liên kết\\](x)'],
    ['<b>', '\\<b\\>'],
    ['nhiều   khoảng\n\ttrắng', 'nhiều khoảng trắng'],
    ['  cắt đầu cuối  ', 'cắt đầu cuối'],
    ['không có gì đặc biệt', 'không có gì đặc biệt'],
    ['dấu \\ gạch', 'dấu \\\\ gạch'],
  ])('mdEscape(%j)', (input, expected) => {
    expect(mdEscape(input)).toBe(expected);
  });
});

describe('formatVnTime', () => {
  it.each([
    ['2026-10-03T02:00:00.000Z', '2026-10-03 09:00 (giờ Việt Nam)'],
    ['2026-10-03T13:00:00.000Z', '2026-10-03 20:00 (giờ Việt Nam)'],
    ['2026-10-03T17:30:00Z', '2026-10-04 00:30 (giờ Việt Nam)'],
    ['2026-12-31T20:00:00Z', '2027-01-01 03:00 (giờ Việt Nam)'],
    ['2026-10-03T09:00:00+07:00', '2026-10-03 09:00 (giờ Việt Nam)'],
    ['không phải ngày', 'không phải ngày'],
  ])('%s', (input, expected) => {
    expect(formatVnTime(input)).toBe(expected);
  });
  it('nhận cả đối tượng Date', () => {
    expect(formatVnTime(new Date('2026-10-03T00:00:00Z'))).toBe('2026-10-03 07:00 (giờ Việt Nam)');
  });
});

describe('báo cáo cho lượt chạy thật (giả lập)', () => {
  it('nghe đúng hoàn toàn: đạt ngưỡng, có độ trễ và chi phí, không có biểu ngữ giả', async () => {
    const { passes, settings } = await runReal((ref) => ref);
    const r = report(passes, settings);
    expect(r.mode).toBe('real');
    const row = r.rows[0]!;
    expect(row.summary.wer.errors).toBe(0);
    expect(row.verdict).toMatchObject({ status: 'pass', peopleOk: true, moneyOk: true });
    // final lúc 2400, utteranceEnd lúc 3250, khung chứa hết tiếng lúc 1600
    expect(row.summary.latencyMs).toMatchObject({ n: 4, p50: 1650, p95: 1650, max: 1650 });
    expect(row.summary.costUsd).toBeCloseTo(row.summary.audioMinutes * 0.0077, 6);
    const md = renderMarkdown(r, { maxErrors: 10 });
    expect(md).not.toContain(FAKE_MARKER);
    expect(md).toContain('1/1 lượt chạy đạt ngưỡng đề xuất');
    expect(md).toContain('Đạt: Deepgram Nova-3 vi (không keyterm) (1300)');
    expect(md).toContain('| 1650 | 1650 |');
    expect(md).toContain('không có câu sai');
  });

  it('một tên sai: không đạt, và câu sai được liệt kê kèm chữ chuẩn', async () => {
    const { passes, settings } = await runReal((ref, id) => (id === 'a1' ? 'đi thúc anh Tú' : ref));
    const r = report(passes, settings);
    expect(r.rows[0]!.verdict).toMatchObject({ status: 'fail', peopleOk: false });
    const md = renderMarkdown(r, { maxErrors: 10 });
    expect(md).toContain('0/1 lượt chạy đạt ngưỡng đề xuất');
    expect(md).toContain('Không đạt');
    expect(md).toContain('**a1** (S01, `a1.wav`): sai chữ, sai tên');
    expect(md).toContain('Chuẩn: đi thúc anh Tuấn');
    expect(md).toContain('Nghe được: đi thúc anh Tú');
  });

  it('sai số tiền cũng làm không đạt', async () => {
    const { passes, settings } = await runReal((ref) => ref.replace('triệu', 'nghìn'));
    const r = report(passes, settings);
    expect(r.rows[0]!.verdict).toMatchObject({ status: 'fail', moneyOk: false, peopleOk: true });
  });

  it('không có tên người hoặc số tiền trong bộ thì "chưa đủ dữ liệu"', async () => {
    const { passes, settings } = await runReal((ref) => ref);
    const stripped = report(passes, settings);
    stripped.rows[0]!.verdict = { ...stripped.rows[0]!.verdict!, status: 'insufficient' };
    expect(renderMarkdown(stripped, { maxErrors: 5 })).toContain('Chưa đủ dữ liệu');
  });

  it('có phiên lỗi thì kết luận nói rõ số đo chưa đáng tin', async () => {
    const clock = new VirtualClock();
    const config = configFor(
      (item) =>
        new TimedStt(clock, {
          onOpen() {
            if (item.id === 'a1') throw new Error('stt_open_failed');
          },
        }),
      { id: 'deepgram-nova3', label: 'Deepgram Nova-3 vi (không keyterm)', real: true, usdPerMinute: 0.0077 },
    );
    const passes = await clock.drive(runBench({ configs: [config], utteranceEndValues: [1300], items: loaded, keyterms: [], settings: { ...SETTINGS, endMode: 'close' }, score: { now: NOW }, clock }));
    const r = report(passes, { ...SETTINGS, endMode: 'close' });
    expect(r.rows[0]!.summary.failed).toBe(1);
    const md = renderMarkdown(r, { maxErrors: 5 });
    expect(md).toContain('**Có phiên lỗi** (Deepgram Nova-3 vi (không keyterm) (1300): 1 phiên)');
    expect(md).toContain('phiên lỗi (stt_open_failed)');
  });

  it('số từ thay, xoá, chèn có trong bảng số đếm', async () => {
    const { passes, settings } = await runReal((ref, id) => (id === 'a1' ? 'đi thúc anh Tú' : id === 'a2' ? 'duyệt hai chục triệu cho chị Phương xong rồi' : ref));
    const md = renderMarkdown(report(passes, settings), { maxErrors: 0 });
    // a1: 1 thay; a2: 2 chèn
    expect(md).toContain('| 1 / 0 / 2 |');
  });

  it('giá chưa có trong SPEC thì ghi "chưa có giá"', async () => {
    const { passes, settings } = await runReal((ref) => ref, { usd: null });
    expect(renderMarkdown(report(passes, settings), { maxErrors: 0 })).toContain('chưa có giá');
  });

  it('chạy sai tốc độ thì cảnh báo độ trễ không đáng tin', async () => {
    const { passes, settings } = await runReal((ref) => ref, { settings: { speed: 4 } });
    expect(renderMarkdown(report(passes, settings), { maxErrors: 0 })).toContain('ĐỘ TRỄ KHÔNG ĐÁNG TIN');
  });

  it('thời gian thực thì không có cảnh báo đó', async () => {
    const { passes, settings } = await runReal((ref) => ref);
    expect(renderMarkdown(report(passes, settings), { maxErrors: 0 })).not.toContain('ĐỘ TRỄ KHÔNG ĐÁNG TIN');
  });

  it('theo người nói và theo nhóm câu', async () => {
    const { passes, settings } = await runReal((ref, id) => (id === 'a2' ? ref.replace('triệu', 'nghìn') : id === 'b1' ? ref.replace('ngày mai', 'ngày kia') : ref));
    const r = report(passes, settings);
    const row = r.rows[0]!;
    expect(row.bySpeaker.map((s) => [s.speaker, s.summary.sentences])).toEqual([['S01', 2], ['S02', 2]]);
    expect(row.bySpeaker[0]!.summary.money).toEqual({ wrong: 1, total: 1, rate: 1 });
    expect(row.bySpeaker[1]!.summary.dates).toEqual({ wrong: 1, total: 1, rate: 1 });
    expect(row.byGroup.name.sentences).toBe(3);
    expect(row.byGroup.money.sentences).toBe(1);
    expect(row.byGroup.date.sentences).toBe(1);
    expect(row.byGroup.date.dates).toEqual({ wrong: 1, total: 1, rate: 1 });
    expect(row.bySpeaker[0]).toMatchObject({ age: 64, region: 'Bắc' });
    expect(row.bySpeaker[1]!.region).toBeUndefined();
  });

  it('khoá của dòng gồm cấu hình và utterance_end_ms', async () => {
    const { passes, settings } = await runReal((ref) => ref);
    expect(report(passes, settings).rows[0]!.key).toBe('deepgram-nova3@1300');
  });
});

describe('giới hạn câu sai liệt kê', () => {
  it('chỉ liệt kê tối đa N, nặng nhất trước', async () => {
    const { passes, settings } = await runReal((ref, id) => (id === 'a1' ? 'đi thúc anh Tú' : id === 'a2' ? 'duyệt' : ref));
    const r = report(passes, settings);
    const one = renderMarkdown(r, { maxErrors: 1 });
    expect(one).toContain('**a2**');
    expect(one).not.toContain('**a1**');
    const two = renderMarkdown(r, { maxErrors: 2 });
    expect(two.indexOf('**a2**')).toBeLessThan(two.indexOf('**a1**'));
  });
  it('0 thì bỏ cả mục', async () => {
    const { passes, settings } = await runReal((ref) => ref.slice(0, 3));
    const md = renderMarkdown(report(passes, settings), { maxErrors: 0 });
    expect(md).not.toContain('### Câu sai');
    expect(md).not.toContain('Nghe được');
  });
  it('chữ có ký tự Markdown được thoát', async () => {
    const { passes, settings } = await runReal(() => 'đi | thúc *anh* _Tuấn_');
    const md = renderMarkdown(report(passes, settings), { maxErrors: 5 });
    expect(md).toContain('Nghe được: đi \\| thúc \\*anh\\* \\_Tuấn\\_');
  });
});

describe('bản giả', () => {
  it('có biểu ngữ "chỉ chứng minh công cụ đúng", không có kết luận so ngưỡng, độ trễ hiện —', async () => {
    const { passes, settings } = await runReal((ref) => ref, { real: false, usd: 0 });
    const r = report(passes, settings);
    expect(r.mode).toBe('fake');
    expect(isFakeOnly(r)).toBe(true);
    expect(r.rows[0]!.verdict).toBeNull();
    const md = renderMarkdown(r, { maxErrors: 3 });
    expect(md).toContain(`Chỉ chứng minh công cụ đúng, ${FAKE_MARKER}`);
    expect(md).toContain('Không áp dụng');
    expect(md).toContain('(giả)');
    expect(md).not.toContain('Đạt:');
    expect(md).toContain('| — | — |');
  });
});

describe('báo cáo hỗn hợp', () => {
  it('có cả dòng giả và dòng thật: biểu ngữ nói rõ dòng nào là giả', async () => {
    const real = await runReal((ref) => ref);
    const fake = await runReal((ref) => ref, { real: false, usd: 0, id: 'fake' });
    const r = report([...real.passes, ...fake.passes], SETTINGS);
    expect(r.mode).toBe('mixed');
    const md = renderMarkdown(r, { maxErrors: 0 });
    expect(md).toContain('có cả dòng chạy bằng bản giả');
    expect(md).toContain(FAKE_MARKER);
    expect(md).toContain('1/1 lượt chạy đạt ngưỡng');
  });
});

describe('JSON và bản tóm tắt', () => {
  it('JSON phân tích lại được và đủ phiên bản, ngưỡng, từng câu', async () => {
    const { passes, settings } = await runReal((ref) => ref);
    const r = report(passes, settings);
    const parsed = JSON.parse(renderJson(r)) as BenchReport;
    expect(parsed).toEqual(r);
    expect(parsed.version).toBe(REPORT_VERSION);
    expect(parsed.thresholds).toMatchObject({ peopleErrorMax: 0.05, moneyErrorMax: 0.05 });
    expect(parsed.rows[0]!.items).toHaveLength(4);
    expect(parsed.rows[0]!.items[0]).toMatchObject({ id: 'a1', speaker: 'S01', file: 'a1.wav', hypothesis: 'đi thúc anh Tuấn', reference: 'đi thúc anh Tuấn' });
    expect(parsed.settings).toMatchObject({ chunkMs: 100, speed: 1, endMode: 'utterance-end', speechEnd: 'vad', utteranceEndMs: [1300] });
    expect(parsed.manifest).toMatchObject({ sentences: 4, entityLintIssues: 0 });
  });

  it('tốc độ tối đa ghi là "max" (JSON không chứa Infinity)', async () => {
    const { passes } = await runReal((ref) => ref, { settings: { speed: Infinity, endMode: 'close' } });
    const r = report(passes, { ...SETTINGS, speed: Infinity });
    expect(r.settings.speed).toBe('max');
    expect(renderJson(r)).toContain('"speed": "max"');
  });

  it('bản tóm tắt chỉ có bảng và kết luận, không có câu nói', async () => {
    const { passes, settings } = await runReal((ref) => ref.slice(0, 5));
    const s = renderSummary(report(passes, settings));
    expect(s).toContain('| Cấu hình |');
    expect(s).toContain('Kết luận');
    expect(s).not.toContain('Nghe được');
    expect(s).not.toContain('đi thúc');
  });
});

describe('ghi chú trong báo cáo', () => {
  it('nêu cấu hình đã bỏ qua và cảnh báo manifest', async () => {
    const { passes, settings } = await runReal((ref) => ref);
    const md = renderMarkdown(report(passes, settings, { skipped: [{ id: 'vbee', reason: 'thiếu biến môi trường VBEE_TOKEN' }], entityLintIssues: 2 }), { maxErrors: 0 });
    expect(md).toContain('Cấu hình đã bỏ qua: `vbee` (thiếu biến môi trường VBEE_TOKEN)');
    expect(md).toContain('**Cảnh báo manifest**: 2 chỗ');
  });

  it('mô tả cách tính, giả định và quy tắc xoá bản ghi', async () => {
    const { passes, settings } = await runReal((ref) => ref);
    const md = renderMarkdown(report(passes, settings), { maxErrors: 0 });
    for (const phrase of ['Mô phỏng scribe', 'WER', 'Sai tên', 'Sai tiền, sai ngày', 'Độ trễ chốt', 'Cắt sớm', 'ƯỚC TÍNH', 'Mẫu nhỏ', 'xoá sau khi đo']) expect(md).toContain(phrase);
  });

  it('ghi mốc now và người nói', async () => {
    const { passes, settings } = await runReal((ref) => ref);
    const md = renderMarkdown(report(passes, settings), { maxErrors: 0 });
    expect(md).toContain('4 câu, 2 người nói (S01, S02)');
    expect(md).toContain('Mốc now cho câu có ngày: 2026-10-03 09:00 (giờ Việt Nam)');
    expect(md).toContain('Chạy lúc 2026-10-03 20:00 (giờ Việt Nam)');
    expect(md).toContain('S01 (64 tuổi, Bắc), 2 câu');
  });
});
