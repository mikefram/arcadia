/**
 * Báo cáo của bài đo STT: bảng Markdown (cho `docs/benchmarks/stt-2026.md`) và JSON chi tiết cạnh bên.
 *
 * Công cụ chỉ báo "đạt / không đạt NGƯỠNG ĐỀ XUẤT" (SPEC 6.2.1 điều 4, [MỤC TIÊU], Mike chốt); không tự chọn nhà cung cấp.
 * Chạy bằng cấu hình `fake` thì báo cáo ghi rõ "chỉ chứng minh công cụ đúng, KHÔNG phải số đo thật".
 */
import type { SkippedConfig } from './configs';
import { SENTENCE_GROUPS, listSpeakers, type Manifest, type SentenceGroup, type SpeakerInfo } from './manifest';
import { PROPOSED_THRESHOLDS, judge, summarize, type MoneyResult, type DateResult, type NameResult, type Rate, type Summary, type Verdict } from './metrics';
import type { ItemOutcome, PassResult, RunSettings } from './runner';

export const REPORT_VERSION = 1;

/** Dòng này có trong mọi báo cáo có chạy bản giả; dùng để nhận ra báo cáo giả khi quyết định có ghi đè hay không. */
export const FAKE_MARKER = 'KHÔNG phải số đo thật';

// ───────────────────────── Dữ liệu báo cáo ─────────────────────────

export type ReportItem = {
  id: string;
  speaker: string;
  file: string;
  reference: string;
  hypothesis: string;
  /** độ tin cậy cả câu (trung bình theo độ dài chữ); để chọn ngưỡng tin cậy từ số đo thật */
  confidence: number | null;
  status: ItemOutcome['scored']['status'];
  errorCode: string | null;
  wer: { errors: number; substitutions: number; deletions: number; insertions: number; refWords: number; errorsNoDiacritics: number };
  names: NameResult[];
  money: MoneyResult | null;
  dates: DateResult | null;
  latencyMs: number | null;
  earlyUtteranceEnds: number;
  earlyFinals: number;
  finals: number;
  interims: number;
  bytesSent: number;
};

export type ReportRow = {
  key: string;
  configId: string;
  label: string;
  real: boolean;
  utteranceEndMs: number;
  usdPerMinute: number | null;
  summary: Summary;
  bySpeaker: { speaker: string; age?: number; region?: string; summary: Summary }[];
  byGroup: Record<SentenceGroup, Summary>;
  /** null với bản giả: ngưỡng chỉ có nghĩa với số đo thật */
  verdict: Verdict | null;
  items: ReportItem[];
};

export type BenchReport = {
  tool: 'stt-bench';
  version: number;
  generatedAt: string;
  mode: 'fake' | 'real' | 'mixed';
  manifest: {
    description?: string;
    sentences: number;
    speakers: SpeakerInfo[];
    audioMinutes: number;
    now: string | null;
    /** số chỗ manifest và bộ tách tiền/ngày không khớp trên câu chuẩn (0 là sạch) */
    entityLintIssues: number;
  };
  settings: { chunkMs: number; speed: number | 'max'; endMode: string; speechEnd: string; concurrency: number; utteranceEndMs: number[] };
  thresholds: { peopleErrorMax: number; moneyErrorMax: number; source: string };
  skipped: SkippedConfig[];
  rows: ReportRow[];
};

export type BuildReportArgs = {
  generatedAt: string;
  manifest: Manifest;
  datasetAudioMinutes: number;
  now: Date | null;
  settings: RunSettings;
  utteranceEndValues: readonly number[];
  skipped: readonly SkippedConfig[];
  passes: readonly PassResult[];
  entityLintIssues: number;
};

function toReportItem(o: ItemOutcome): ReportItem {
  const s = o.scored;
  return {
    id: o.id,
    speaker: o.speaker,
    file: o.file,
    reference: o.reference,
    hypothesis: o.hypothesis,
    confidence: o.confidence,
    status: s.status,
    errorCode: o.errorCode,
    wer: {
      errors: s.score.wer.errors,
      substitutions: s.score.wer.substitutions,
      deletions: s.score.wer.deletions,
      insertions: s.score.wer.insertions,
      refWords: s.score.wer.refWords,
      errorsNoDiacritics: s.score.werPlain.errors,
    },
    names: s.score.names,
    money: s.score.money,
    dates: s.score.dates,
    latencyMs: s.latencyMs === null ? null : Math.round(s.latencyMs),
    earlyUtteranceEnds: s.earlyUtteranceEnds,
    earlyFinals: s.earlyFinals,
    finals: o.finals,
    interims: o.interims,
    bytesSent: s.bytesSent,
  };
}

export function buildReport(args: BuildReportArgs): BenchReport {
  const speakers = listSpeakers(args.manifest);
  const rows: ReportRow[] = args.passes.map((pass) => {
    const scored = pass.outcomes.map((o) => o.scored);
    const bySpeaker = speakers.map((sp) => ({
      speaker: sp.speaker,
      ...(sp.age !== undefined ? { age: sp.age } : {}),
      ...(sp.region !== undefined ? { region: sp.region } : {}),
      summary: summarize(
        scored.filter((i) => i.speaker === sp.speaker),
        pass.usdPerMinute,
      ),
    }));
    const byGroup = Object.fromEntries(
      SENTENCE_GROUPS.map((g) => [
        g,
        summarize(
          scored.filter((i) => i.groups[g]),
          pass.usdPerMinute,
        ),
      ]),
    ) as Record<SentenceGroup, Summary>;
    const summary = summarize(scored, pass.usdPerMinute);
    return {
      key: `${pass.configId}@${pass.utteranceEndMs}`,
      configId: pass.configId,
      label: pass.label,
      real: pass.real,
      utteranceEndMs: pass.utteranceEndMs,
      usdPerMinute: pass.usdPerMinute,
      summary,
      bySpeaker,
      byGroup,
      verdict: pass.real ? judge(summary) : null,
      items: pass.outcomes.map(toReportItem),
    };
  });
  const realRows = rows.filter((r) => r.real).length;
  return {
    tool: 'stt-bench',
    version: REPORT_VERSION,
    generatedAt: args.generatedAt,
    mode: realRows === 0 ? 'fake' : realRows === rows.length ? 'real' : 'mixed',
    manifest: {
      ...(args.manifest.description ? { description: args.manifest.description } : {}),
      sentences: args.manifest.items.length,
      speakers,
      audioMinutes: args.datasetAudioMinutes,
      now: args.now ? args.now.toISOString() : null,
      entityLintIssues: args.entityLintIssues,
    },
    settings: {
      chunkMs: args.settings.chunkMs,
      speed: args.settings.speed === Infinity ? 'max' : args.settings.speed,
      endMode: args.settings.endMode,
      speechEnd: args.settings.speechEnd,
      concurrency: args.settings.concurrency,
      utteranceEndMs: [...args.utteranceEndValues],
    },
    thresholds: { ...PROPOSED_THRESHOLDS, source: 'SPEC 6.2.1 điều 4 [MỤC TIÊU], Mike chốt' },
    skipped: [...args.skipped],
    rows,
  };
}

export const renderJson = (report: BenchReport): string => `${JSON.stringify(report, null, 2)}\n`;

// ───────────────────────── Định dạng ─────────────────────────

const vn = (n: number, digits: number) => n.toFixed(digits).replace('.', ',');

/** Giờ hiển thị theo Asia/Ho_Chi_Minh (CLAUDE.md luật 4); JSON vẫn giữ UTC. Việt Nam không đổi giờ mùa nên cộng thẳng 7 giờ. */
export function formatVnTime(value: Date | string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} (giờ Việt Nam)`;
}
export const fmtPct = (rate: number | null, digits = 1): string => (rate === null ? '—' : vn(rate * 100, digits));
export const fmtRate = (r: Rate): string => (r.rate === null ? '—' : `${fmtPct(r.rate)} (${r.wrong}/${r.total})`);
const fmtMs = (v: number | null): string => (v === null ? '—' : String(Math.round(v)));
const fmtUsd = (v: number | null): string => (v === null ? '—' : vn(v, 4));

/** Chữ thường gặp trong Markdown thì thoát, để câu nói không phá bảng hay danh sách. */
export const mdEscape = (s: string): string => s.replace(/\s+/g, ' ').replace(/([\\`*_[\]<>|])/g, '\\$1').trim();

const rowLabel = (r: ReportRow): string => `${r.label}${r.real ? '' : ' (giả)'}`;

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

// ───────────────────────── Markdown ─────────────────────────

export type RenderOptions = {
  /** số câu sai liệt kê mỗi cấu hình; 0 là không liệt kê */
  maxErrors: number;
};

const STATUS_LABEL: Record<Verdict['status'], string> = { pass: 'Đạt', fail: 'Không đạt', insufficient: 'Chưa đủ dữ liệu' };

function sentenceFlags(it: ReportItem): string[] {
  const flags: string[] = [];
  if (it.status === 'failed') flags.push(`phiên lỗi${it.errorCode ? ` (${it.errorCode})` : ''}`);
  if (it.status === 'no_result') flags.push('không có kết quả');
  if (it.wer.errors > 0) flags.push(it.wer.errorsNoDiacritics === 0 ? 'chỉ sai dấu' : 'sai chữ');
  const bad = it.names.filter((n) => n.verdict !== 'exact');
  if (bad.some((n) => n.verdict === 'missing')) flags.push('sai tên');
  if (bad.some((n) => n.verdict === 'diacritic')) flags.push('sai dấu ở tên');
  if (it.money && !it.money.ok) flags.push('sai số tiền');
  if (it.dates && !it.dates.ok) flags.push('sai ngày');
  if (it.earlyUtteranceEnds > 0) flags.push('cắt sớm');
  return flags;
}

/** Điểm nặng để xếp: phiên lỗi, rồi sai thực thể, rồi nhiều lỗi chữ. */
function severity(it: ReportItem): number {
  let s = it.wer.errors;
  if (it.status !== 'ok') s += 1000;
  s += 100 * it.names.filter((n) => n.verdict !== 'exact').length;
  if (it.money && !it.money.ok) s += 100;
  if (it.dates && !it.dates.ok) s += 100;
  if (it.earlyUtteranceEnds > 0) s += 50;
  return s;
}

function mainTable(report: BenchReport): string {
  const header = ['Cấu hình', 'utterance_end_ms', 'WER %', 'WER không dấu %', 'Sai tên %', 'Sai tiền %', 'Sai ngày %', 'Trễ p50 (ms)', 'Trễ p95 (ms)', 'Cắt sớm', 'Phút âm thanh', 'Chi phí ước tính (USD)'];
  const rows = report.rows.map((r) => {
    const s = r.summary;
    // Bản giả phát sự kiện ngay lập tức nên độ trễ vô nghĩa.
    const p50 = r.real ? fmtMs(s.latencyMs.p50) : '—';
    const p95 = r.real ? fmtMs(s.latencyMs.p95) : '—';
    const cost = r.real ? (s.costUsd === null ? 'chưa có giá' : fmtUsd(s.costUsd)) : '0';
    return [rowLabel(r), String(r.utteranceEndMs), fmtPct(s.wer.rate), fmtPct(s.werPlain.rate), fmtRate(s.names), fmtRate(s.money), fmtRate(s.dates), p50, p95, String(s.earlyCuts), vn(s.audioMinutes, 2), cost];
  });
  return table(header, rows);
}

function verdictSection(report: BenchReport): string {
  const t = report.thresholds;
  const limit = `${fmtPct(t.peopleErrorMax, 0)}%`;
  const real = report.rows.filter((r) => r.verdict !== null);
  if (real.length === 0) return `Không áp dụng: báo cáo này chỉ có dòng chạy bằng bản giả, ${FAKE_MARKER}. Ngưỡng đề xuất (sai tên người và sai số tiền không quá ${limit}) chỉ có nghĩa với số đo thật.`;
  const rows = real.map((r) => {
    const v = r.verdict as Verdict;
    return [rowLabel(r), String(r.utteranceEndMs), fmtRate(v.people), fmtRate(v.money), STATUS_LABEL[v.status]];
  });
  const passed = real.filter((r) => r.verdict?.status === 'pass').map((r) => `${r.label} (${r.utteranceEndMs})`);
  const broken = real.filter((r) => r.summary.failed > 0).map((r) => `${r.label} (${r.utteranceEndMs}): ${r.summary.failed} phiên`);
  const line =
    `**Kết luận:** ${passed.length}/${real.length} lượt chạy đạt ngưỡng đề xuất (sai tên người và sai số tiền đều không quá ${limit}; ` +
    `${t.source}).${passed.length ? ` Đạt: ${passed.join('; ')}.` : ''} Công cụ chỉ báo đạt hay không đạt, KHÔNG tự chọn nhà cung cấp.` +
    (broken.length ? ` **Có phiên lỗi** (${broken.join('; ')}): phiên lỗi tính như câu rỗng nên số đo của các lượt đó chưa đáng tin, nên chạy lại.` : '');
  return [table(['Cấu hình', 'utterance_end_ms', 'Sai tên người', 'Sai số tiền', `So với ngưỡng ${limit}`], rows), '', line].join('\n');
}

/** Nhãn dòng trong bảng chi tiết: thêm utterance_end_ms khi có quét nhiều giá trị. */
const detailLabel = (report: BenchReport, r: ReportRow): string => rowLabel(r) + (report.settings.utteranceEndMs.length > 1 ? ` · ${r.utteranceEndMs}` : '');

function speakerHead(sp: SpeakerInfo): string {
  const extra = [sp.age !== undefined ? `${sp.age} tuổi` : null, sp.region ?? null].filter(Boolean).join(', ');
  return `${sp.speaker}${extra ? ` (${extra})` : ''}, ${sp.sentences} câu`;
}

function speakerMatrix(report: BenchReport, title: string, cell: (s: Summary) => string): string {
  const speakers = report.manifest.speakers;
  const rows = report.rows.map((r) => [detailLabel(report, r), ...speakers.map((sp) => { const found = r.bySpeaker.find((b) => b.speaker === sp.speaker); return found ? cell(found.summary) : '—'; })]);
  return [`#### ${title}`, '', table(['Cấu hình', ...speakers.map(speakerHead)], rows)].join('\n');
}

function detailSections(report: BenchReport): string {
  const groupRows = report.rows.map((r) => {
    const g = r.byGroup;
    return [
      detailLabel(report, r),
      String(g.name.sentences),
      fmtPct(g.name.wer.rate),
      fmtRate(g.name.names),
      String(g.money.sentences),
      fmtPct(g.money.wer.rate),
      fmtRate(g.money.money),
      String(g.date.sentences),
      fmtPct(g.date.wer.rate),
      fmtRate(g.date.dates),
    ];
  });
  const otherRows = report.rows.map((r) => {
    const s = r.summary;
    const w = s.wer;
    return [detailLabel(report, r), `${w.substitutions} / ${w.deletions} / ${w.insertions}`, fmtRate(s.people), fmtRate(s.units), String(s.nameDiacriticOnly), String(s.earlyCutSentences), String(s.earlyFinals), String(s.failed), String(s.noResult), String(s.spuriousMoney)];
  });
  return [
    '### Chi tiết',
    '',
    speakerMatrix(report, 'WER theo người nói (%)', (s) => fmtPct(s.wer.rate)),
    '',
    speakerMatrix(report, 'Sai tên theo người nói (% tên sai)', (s) => fmtRate(s.names)),
    '',
    speakerMatrix(report, 'Sai số tiền theo người nói (% câu có số tiền sai)', (s) => fmtRate(s.money)),
    '',
    '#### Theo nhóm câu',
    '',
    table(['Cấu hình', 'Câu có tên', 'WER %', 'Sai tên %', 'Câu có tiền', 'WER %', 'Sai tiền %', 'Câu có ngày', 'WER %', 'Sai ngày %'], groupRows),
    '',
    '#### Các số đếm khác',
    '',
    table(['Cấu hình', 'Từ thay / xoá / chèn', 'Sai tên người', 'Sai tên đơn vị', 'Trong số tên sai: chỉ sai dấu', 'Câu bị cắt sớm', 'Final giữa câu', 'Phiên lỗi', 'Không có kết quả', 'Số tiền thừa ở câu không có tiền'], otherRows),
  ].join('\n');
}

function sentencesSection(report: BenchReport, maxErrors: number): string {
  if (maxErrors <= 0) return '';
  const out: string[] = [`### Câu sai (tối đa ${maxErrors} mỗi cấu hình, nặng nhất trước; nghe lại tệp ghi trong ngoặc)`, ''];
  for (const r of report.rows) {
    const bad = r.items
      .map((it) => ({ it, flags: sentenceFlags(it) }))
      .filter((x) => x.flags.length > 0)
      .sort((a, b) => severity(b.it) - severity(a.it))
      .slice(0, maxErrors);
    out.push(`#### ${rowLabel(r)} · utterance_end_ms ${r.utteranceEndMs}: ${bad.length === 0 ? 'không có câu sai' : `${bad.length} câu`}`, '');
    for (const { it, flags } of bad) {
      out.push(`- **${it.id}** (${it.speaker}, \`${it.file}\`): ${flags.join(', ')}`);
      out.push(`  - Chuẩn: ${mdEscape(it.reference)}`);
      out.push(`  - Nghe được: ${it.hypothesis ? mdEscape(it.hypothesis) : '(rỗng)'}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function notesSection(report: BenchReport): string {
  const s = report.settings;
  const lines = [
    '### Cách tính và giả định',
    '',
    '- **Mô phỏng scribe**: mỗi câu một phiên STT; khung âm thanh phát như micro; các `final` nối lại; gặp `utteranceEnd` là chốt lượt (ngừng gửi âm thanh, đóng phiên). Hết tệp mà chưa có `utteranceEnd` thì gửi tiếp khung im lặng cho tới khi có, tối đa `utterance_end_ms` + 1,5 giây (chế độ `utterance-end`).',
    '- **WER**: tổng lỗi (thay + xoá + chèn) chia tổng số từ của câu chuẩn, sau chuẩn hoá (Unicode NFC, chữ thường, bỏ dấu câu, gộp khoảng trắng). "WER không dấu" so sau khi bỏ cả dấu thanh; hiệu của hai cột là phần lỗi dấu. Số đọc bằng chữ so với chữ số ("hai chục" với "20") tính là lỗi chữ; xem cột sai tiền để biết sau chuẩn hoá có đúng không.',
    '- **Sai tên**: mỗi tên người và tên đơn vị trong manifest phải xuất hiện nguyên dãy tiếng, có dấu, trong kết quả. Khớp được khi bỏ dấu nhưng không khớp khi giữ dấu là "chỉ sai dấu" (vẫn tính là sai).',
    '- **Sai tiền, sai ngày**: tách cụm tiền và cụm ngày khỏi kết quả bằng bộ tách theo luật (extract.ts), đọc bằng `parseMoney` và `resolveDate` (mốc now ghi ở trên), rồi so TẬP với `amountsVnd` và `dates`. Tính theo câu có số tiền (hoặc có ngày). Bộ tách là phép xấp xỉ, dùng giống nhau cho mọi nhà cung cấp.',
    `- **Độ trễ chốt**: từ lúc khung chứa tiếng nói cuối cùng được gửi (bộ dò năng lượng, ${s.speechEnd === 'vad' ? 'bật' : 'tắt: lấy hết tệp'}) tới sự kiện \`final\` hoặc \`utteranceEnd\` cuối cùng; p50 và p95 theo hạng gần nhất. Câu bị cắt sớm hoặc lỗi không có độ trễ.${s.speed === 1 ? '' : ` ĐỘ TRỄ KHÔNG ĐÁNG TIN: chạy với tốc độ ${s.speed === 'max' ? 'tối đa' : `${s.speed} lần`}, không phải thời gian thực.`}`,
    '- **Cắt sớm**: số sự kiện `utteranceEnd` tới khi người nói chưa nói xong (theo bộ dò năng lượng); scribe chốt lượt ở đó nên phần sau của câu bị bỏ. Số `final` tới giữa câu (đoạn chốt trước khi hết âm thanh) đếm riêng ở bảng "Các số đếm khác": với Deepgram đó là bình thường, không phải lỗi.',
    '- **Chi phí**: ƯỚC TÍNH = phút âm thanh đã gửi (kể cả đuôi im lặng) × giá SPEC 6.2 (Nova-3 giá thường 0,0077 USD mỗi phút). Nova-2 và Vbee chưa có giá trong SPEC nên để trống; đây không phải hoá đơn.',
    '- **Mẫu nhỏ**: với vài chục câu có tên hoặc số tiền, một câu sai đã đổi vài điểm phần trăm; đọc cả tỉ lệ lẫn số câu (trong ngoặc).',
    '- Bản ghi âm chỉ dùng để đo, xoá sau khi đo xong hoặc theo hạn ghi trong phiếu đồng ý, không đưa vào repo (SPEC 13.6).',
  ];
  return lines.join('\n');
}

function banner(report: BenchReport): string {
  if (report.mode === 'real') return '';
  const what =
    report.mode === 'fake'
      ? `**Chỉ chứng minh công cụ đúng, ${FAKE_MARKER}.**`
      : `**Báo cáo có cả dòng chạy bằng bản giả (ghi "(giả)"): các dòng đó chỉ chứng minh công cụ đúng, ${FAKE_MARKER}.**`;
  return `> ${what} Kết quả của cấu hình \`fake\` lấy từ bản ghi sẵn trong manifest, không qua nhà cung cấp nào; không dùng để chọn nhà cung cấp, không so với ngưỡng.\n`;
}

/** Báo cáo Markdown đầy đủ. */
export function renderMarkdown(report: BenchReport, opts: RenderOptions): string {
  const m = report.manifest;
  const s = report.settings;
  const speakers = m.speakers.map((sp) => sp.speaker).join(', ');
  const lines: string[] = [
    '# Bài đo nhận dạng giọng nói (STT)',
    '',
    banner(report),
    `Chạy lúc ${formatVnTime(report.generatedAt)} bằng \`tools/stt-bench\` (SPEC 6.2.1, 13.6, việc S1-06).`,
    '',
    `- Bộ ghi âm: ${m.sentences} câu, ${m.speakers.length} người nói (${speakers}), ${vn(m.audioMinutes, 2)} phút âm thanh.${m.description ? ` ${mdEscape(m.description)}` : ''}`,
    `- Mốc now cho câu có ngày: ${m.now ? formatVnTime(m.now) : 'không đặt'}.`,
    `- Cài đặt: khung ${s.chunkMs} ms; tốc độ ${s.speed === 'max' ? 'tối đa (không chờ)' : `${s.speed}×`}; kết thúc lượt: \`${s.endMode}\`; điểm hết tiếng: ${s.speechEnd === 'vad' ? 'bộ dò năng lượng' : 'hết tệp'}; song song ${s.concurrency}; utterance_end_ms: ${s.utteranceEndMs.join(', ')}.`,
    ...(m.entityLintIssues > 0 ? [`- **Cảnh báo manifest**: ${m.entityLintIssues} chỗ thực thể ghi trong manifest không khớp với câu chuẩn khi đọc bằng bộ tách; số đo sai tên, tiền, ngày có thể lệch.`] : []),
    ...(report.skipped.length > 0 ? [`- Cấu hình đã bỏ qua: ${report.skipped.map((k) => `\`${k.id}\` (${k.reason})`).join('; ')}.`] : []),
    '',
    '## Kết quả',
    '',
    mainTable(report),
    '',
    '## So với ngưỡng đề xuất',
    '',
    verdictSection(report),
    '',
    detailSections(report),
    '',
    sentencesSection(report, opts.maxErrors),
    notesSection(report),
    '',
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Dạng ngắn để in ra màn hình khi đã ghi báo cáo đầy đủ ra tệp: chỉ bảng chính và kết luận, không có câu nói. */
export function renderSummary(report: BenchReport): string {
  return [banner(report), mainTable(report), '', verdictSection(report), ''].filter((x) => x !== '').join('\n');
}

export const isFakeOnly = (report: BenchReport): boolean => report.mode === 'fake';
