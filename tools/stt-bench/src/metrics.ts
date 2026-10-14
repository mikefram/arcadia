/**
 * Các số đo của bài đo STT (SPEC 6.2.1 điều 3). Mọi hàm ở đây là hàm thuần, có test bảng.
 *
 *  (a) WER toàn câu, có dấu và không dấu, kèm số thay/xoá/chèn.
 *  (b) Tên người và tên đơn vị: có xuất hiện đúng trong kết quả không (khớp có dấu, rồi khớp không dấu để thấy lỗi dấu).
 *  (c) Số tiền và ngày SAU chuẩn hoá: chạy `parseMoney`/`resolveDate` trên kết quả (extract.ts) rồi so với kỳ vọng.
 *  (d) Độ trễ chốt kết quả: p50, p95 (hạng gần nhất).
 *  (e) Số lần cắt ngang câu sớm.
 *  (f) Phút âm thanh và chi phí ước tính.
 */
import { DEFAULT_CALENDAR, type WorkCalendar } from '@mihato/domain';
import { stripDiacritics } from '@mihato/domain/vi-normalize';
import { BYTES_PER_MS } from './audio';
import { extractDates, extractMoney } from './extract';
import type { Entities, ManifestItem, SentenceGroup } from './manifest';

// ───────────────────────── (a) WER ─────────────────────────

/**
 * Chuẩn hoá để so chữ: Unicode dựng sẵn (NFC), chữ thường, mọi dấu câu và ký hiệu thành khoảng trắng, gộp khoảng trắng.
 * "20.000.000" thành "20 000 000" ở cả hai phía nên không tạo ra lỗi giả. `stripMarks` bỏ cả dấu thanh và dấu mũ (đ thành d).
 */
export function normalizeForWer(text: string, opts: { stripMarks?: boolean } = {}): string {
  let s = text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
  if (opts.stripMarks) s = stripDiacritics(s);
  return s.replace(/\s+/g, ' ').trim();
}

export function wordsOf(text: string, opts: { stripMarks?: boolean } = {}): string[] {
  const n = normalizeForWer(text, opts);
  return n === '' ? [] : n.split(' ');
}

export type WordErrors = {
  substitutions: number;
  deletions: number;
  insertions: number;
  /** thay + xoá + chèn */
  errors: number;
  refWords: number;
  hypWords: number;
  /** errors / refWords; câu chuẩn rỗng thì 0 nếu kết quả cũng rỗng, ngược lại 1 */
  rate: number;
};

const rateOfErrors = (errors: number, refWords: number, hypWords: number): number => (refWords === 0 ? (hypWords === 0 ? 0 : 1) : errors / refWords);

/**
 * Khoảng cách Levenshtein mức từ, kèm số thay/xoá/chèn theo một đường căn chỉnh tối ưu. Khi nhiều đường cùng tối ưu thì
 * ưu tiên thay thế (rồi xoá, rồi chèn) lúc truy ngược; tổng số lỗi không đổi, chỉ cách chia thay/xoá/chèn có thể khác.
 */
export function wordErrors(ref: readonly string[], hyp: readonly string[]): WordErrors {
  const n = ref.length;
  const m = hyp.length;
  const width = m + 1;
  const d = new Int32Array((n + 1) * width);
  for (let i = 0; i <= n; i++) d[i * width] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = (d[(i - 1) * width + (j - 1)] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const del = (d[(i - 1) * width + j] as number) + 1;
      const ins = (d[i * width + (j - 1)] as number) + 1;
      d[i * width + j] = Math.min(sub, del, ins);
    }
  }
  let i = n;
  let j = m;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 || j > 0) {
    const here = d[i * width + j] as number;
    if (i > 0 && j > 0 && here === (d[(i - 1) * width + (j - 1)] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && here === (d[(i - 1) * width + j] as number) + 1) {
      deletions += 1;
      i -= 1;
    } else {
      insertions += 1;
      j -= 1;
    }
  }
  const errors = substitutions + deletions + insertions;
  return { substitutions, deletions, insertions, errors, refWords: n, hypWords: m, rate: rateOfErrors(errors, n, m) };
}

/** WER của một câu. `stripMarks` cho biến thể không phân biệt dấu (tách lỗi dấu khỏi lỗi từ). */
export function wer(reference: string, hypothesis: string, opts: { stripMarks?: boolean } = {}): WordErrors {
  return wordErrors(wordsOf(reference, opts), wordsOf(hypothesis, opts));
}

/** Gộp nhiều câu: tổng lỗi chia tổng số từ chuẩn (không lấy trung bình tỉ lệ từng câu). */
export function sumWordErrors(list: readonly WordErrors[]): WordErrors {
  const t = { substitutions: 0, deletions: 0, insertions: 0, refWords: 0, hypWords: 0 };
  for (const w of list) {
    t.substitutions += w.substitutions;
    t.deletions += w.deletions;
    t.insertions += w.insertions;
    t.refWords += w.refWords;
    t.hypWords += w.hypWords;
  }
  const errors = t.substitutions + t.deletions + t.insertions;
  return { ...t, errors, rate: rateOfErrors(errors, t.refWords, t.hypWords) };
}

// ───────────────────────── (b) Tên ─────────────────────────

export type NameKind = 'person' | 'unit';
/** exact: đúng cả dấu; diacritic: đúng chữ nhưng sai dấu; missing: không thấy */
export type NameVerdict = 'exact' | 'diacritic' | 'missing';
export type NameResult = { name: string; kind: NameKind; verdict: NameVerdict };

/** `needle` có xuất hiện nguyên dãy, liền nhau, trong `hay` không (so theo tiếng, không so theo ký tự con). */
export function containsSequence(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let at = 0; at + needle.length <= hay.length; at++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) {
      if (hay[at + k] !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Tên có trong kết quả không. Khớp theo dãy tiếng đã chuẩn hoá: "Tuấn" không khớp "Tuân" (sai dấu) nhưng khớp không dấu.
 * Dùng khớp chuỗi thay cho `matchPerson` vì `matchPerson` xếp hạng người trong danh bạ, không trả lời "tên này có mặt trong
 * câu không"; lỗi dấu mà `matchPerson` vẫn cứu được hiện ở mức `diacritic`.
 */
export function matchName(hypothesis: string, name: string): NameVerdict {
  const need = wordsOf(name);
  if (need.length === 0) return 'missing';
  if (containsSequence(wordsOf(hypothesis), need)) return 'exact';
  if (containsSequence(wordsOf(hypothesis, { stripMarks: true }), wordsOf(name, { stripMarks: true }))) return 'diacritic';
  return 'missing';
}

/** Kiểm từng tên người rồi từng tên đơn vị của một câu; tên trùng trong cùng loại chỉ tính một lần. */
export function checkNames(hypothesis: string, entities: Pick<Entities, 'people' | 'units'>): NameResult[] {
  const out: NameResult[] = [];
  const add = (names: readonly string[], kind: NameKind) => {
    const seen = new Set<string>();
    for (const name of names) {
      const key = normalizeForWer(name);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push({ name, kind, verdict: matchName(hypothesis, name) });
    }
  };
  add(entities.people, 'person');
  add(entities.units ?? [], 'unit');
  return out;
}

// ───────────────────────── (c) Tiền và ngày sau chuẩn hoá ─────────────────────────

export type SetCompare<T> = { ok: boolean; missing: T[]; extra: T[] };

const byValue = <T extends string | number>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** So hai danh sách như tập có lặp: `missing` là kỳ vọng chưa thấy, `extra` là thứ thừa. Cả hai xếp tăng dần. */
export function compareMultiset<T extends string | number>(expected: readonly T[], got: readonly T[]): SetCompare<T> {
  const left = new Map<T, number>();
  for (const e of expected) left.set(e, (left.get(e) ?? 0) + 1);
  const extra: T[] = [];
  for (const g of got) {
    const c = left.get(g) ?? 0;
    if (c > 0) left.set(g, c - 1);
    else extra.push(g);
  }
  const missing: T[] = [];
  for (const [value, count] of left) for (let k = 0; k < count; k++) missing.push(value);
  missing.sort(byValue);
  extra.sort(byValue);
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

export type MoneyResult = { expected: number[]; got: number[]; ok: boolean };
export type DateResult = { expected: string[]; got: string[]; ok: boolean };

/** Số tiền tách được từ kết quả (đã qua `parseMoney`) so với `amountsVnd`: đúng khi hai tập bằng nhau. */
export function checkMoney(hypothesis: string, expected: readonly number[]): MoneyResult {
  const got = extractMoney(hypothesis);
  return { expected: [...expected], got, ok: compareMultiset(expected, got).ok };
}

/** Ngày tách được từ kết quả (đã qua `resolveDate` với mốc `now`) so với `dates`: đúng khi hai tập bằng nhau. */
export function checkDates(hypothesis: string, expected: readonly string[], now: Date, calendar: WorkCalendar = DEFAULT_CALENDAR): DateResult {
  const got = extractDates(hypothesis, now, calendar);
  return { expected: [...expected], got, ok: compareMultiset(expected, got).ok };
}

// ───────────────────────── Chấm một câu ─────────────────────────

export type ScoreContext = {
  /** mốc "bây giờ" khi các câu được nói; bắt buộc nếu có câu mong đợi ngày */
  now: Date | null;
  calendar?: WorkCalendar;
};

export type ItemScore = {
  wer: WordErrors;
  werPlain: WordErrors;
  names: NameResult[];
  /** null nếu câu không có số tiền kỳ vọng */
  money: MoneyResult | null;
  /** null nếu câu không có ngày kỳ vọng */
  dates: DateResult | null;
  /** số tiền tách được ở câu KHÔNG kỳ vọng số tiền nào (báo động giả; chỉ để tham khảo) */
  spuriousMoney: number;
};

export function scoreItem(item: Pick<ManifestItem, 'reference' | 'entities'>, hypothesis: string, ctx: ScoreContext): ItemScore {
  const e = item.entities;
  if (e.dates.length > 0 && ctx.now === null) throw new Error('Thiếu mốc now: đặt "now" trong manifest hoặc dùng --now khi có câu mong đợi ngày');
  return {
    wer: wer(item.reference, hypothesis),
    werPlain: wer(item.reference, hypothesis, { stripMarks: true }),
    names: checkNames(hypothesis, e),
    money: e.amountsVnd.length > 0 ? checkMoney(hypothesis, e.amountsVnd) : null,
    dates: e.dates.length > 0 ? checkDates(hypothesis, e.dates, ctx.now as Date, ctx.calendar) : null,
    spuriousMoney: e.amountsVnd.length > 0 ? 0 : extractMoney(hypothesis).length,
  };
}

export type LintIssue = {
  id: string;
  problem: 'name' | 'money' | 'date';
  /** số thực thể lệch; KHÔNG chép tên hay số tiền vào đây vì kết quả được in ra nhật ký */
  count: number;
};

/**
 * Chấm chính câu chuẩn như thể STT nghe đúng 100%. Câu nào còn lệch nghĩa là manifest ghi sai thực thể, hoặc bộ tách
 * (extract.ts) không đọc nổi cách nói đó: phải sửa TRƯỚC khi chạy bản thật, kẻo kết quả sai mà không ai biết.
 */
export function lintEntities(items: readonly Pick<ManifestItem, 'id' | 'reference' | 'entities'>[], ctx: ScoreContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const mismatches = <T extends string | number>(expected: readonly T[], got: readonly T[]) => {
    const c = compareMultiset(expected, got);
    return Math.max(1, c.missing.length + c.extra.length);
  };
  for (const item of items) {
    const s = scoreItem(item, item.reference, ctx);
    const badNames = s.names.filter((n) => n.verdict !== 'exact').length;
    if (badNames > 0) issues.push({ id: item.id, problem: 'name', count: badNames });
    if (s.money && !s.money.ok) issues.push({ id: item.id, problem: 'money', count: mismatches(s.money.expected, s.money.got) });
    if (s.dates && !s.dates.ok) issues.push({ id: item.id, problem: 'date', count: mismatches(s.dates.expected, s.dates.got) });
  }
  return issues;
}

// ───────────────────────── (d) Độ trễ ─────────────────────────

/** Hạng gần nhất: giá trị ở thứ hạng ceil(p/100 × n) của dãy tăng dần. p trong [0, 100]. Rỗng thì null. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p >= 0 && p <= 100)) throw new RangeError(`Phân vị phải trong [0, 100], nhận ${p}`);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p * sorted.length) / 100)));
  return sorted[rank - 1] as number;
}

export type LatencyStats = { n: number; p50: number | null; p95: number | null; max: number | null; mean: number | null };

/** Bỏ giá trị null (câu không có độ trễ: lỗi, không có kết quả, bị cắt). */
export function summarizeLatency(values: readonly (number | null)[]): LatencyStats {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  return {
    n: v.length,
    p50: percentile(v, 50),
    p95: percentile(v, 95),
    max: v.length === 0 ? null : Math.max(...v),
    mean: v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length,
  };
}

// ───────────────────────── (e) Cắt sớm ─────────────────────────

export type TimedEvent = {
  type: 'interim' | 'final' | 'utteranceEnd';
  /** mốc đồng hồ lúc sự kiện tới, mili giây */
  atMs: number;
  /** số byte âm thanh của câu đã gửi tới lúc sự kiện tới */
  sentBytes: number;
};

export type EarlyCounts = {
  /** số `final` tới khi âm thanh của câu CHƯA hết (đoạn chốt giữa câu: bình thường với Deepgram, chỉ để tham khảo) */
  earlyFinals: number;
  /** số `utteranceEnd` tới khi người nói CHƯA nói xong: scribe chốt lượt ở đó nên phần sau của câu bị bỏ (cắt ngang câu) */
  earlyUtteranceEnds: number;
};

export function countEarlyEvents(events: readonly TimedEvent[], bounds: { audioBytes: number; speechEndBytes: number | null }): EarlyCounts {
  const speechEnd = bounds.speechEndBytes ?? bounds.audioBytes;
  let earlyFinals = 0;
  let earlyUtteranceEnds = 0;
  for (const e of events) {
    if (e.type === 'final' && e.sentBytes < bounds.audioBytes) earlyFinals += 1;
    if (e.type === 'utteranceEnd' && e.sentBytes < speechEnd) earlyUtteranceEnds += 1;
  }
  return { earlyFinals, earlyUtteranceEnds };
}

/**
 * Độ trễ chốt: từ lúc khung chứa tiếng nói cuối cùng được gửi tới sự kiện `final` hoặc `utteranceEnd` CUỐI CÙNG
 * (kết quả chốt đầy đủ). Null nếu không có mốc gửi (câu bị cắt hoặc lỗi trước khi nói xong) hoặc không có sự kiện chốt nào.
 * Âm thì kẹp về 0 (nhà cung cấp chốt trước khi bộ dò tiếng nói cho là hết tiếng).
 */
export function computeLatencyMs(events: readonly TimedEvent[], speechEndSentAtMs: number | null): number | null {
  if (speechEndSentAtMs === null) return null;
  let last: number | null = null;
  for (const e of events) {
    if ((e.type === 'final' || e.type === 'utteranceEnd') && (last === null || e.atMs > last)) last = e.atMs;
  }
  return last === null ? null : Math.max(0, last - speechEndSentAtMs);
}

// ───────────────────────── (f) Phút âm thanh và chi phí ─────────────────────────

export const audioMinutes = (bytesSent: number): number => bytesSent / BYTES_PER_MS / 60_000;

/** Ước tính, không phải hoá đơn. Null nếu SPEC chưa có giá cho cấu hình đó. */
export function estimateCostUsd(minutes: number, usdPerMinute: number | null): number | null {
  if (usdPerMinute === null) return null;
  return Math.round(minutes * usdPerMinute * 1e6) / 1e6;
}

// ───────────────────────── Gộp số liệu ─────────────────────────

export type Rate = { wrong: number; total: number; rate: number | null };
export const rateOf = (wrong: number, total: number): Rate => ({ wrong, total, rate: total === 0 ? null : wrong / total });

export type ItemStatus = 'ok' | 'no_result' | 'failed';

/** Một câu sau khi chạy và chấm: đủ để gộp theo tổng, theo người nói, theo nhóm câu. */
export type ScoredItem = {
  id: string;
  speaker: string;
  groups: Record<SentenceGroup, boolean>;
  status: ItemStatus;
  score: ItemScore;
  latencyMs: number | null;
  earlyUtteranceEnds: number;
  earlyFinals: number;
  bytesSent: number;
};

export type Summary = {
  sentences: number;
  /** phiên lỗi: kết quả tính như câu rỗng, nên số đo của cấu hình đó chưa đáng tin */
  failed: number;
  noResult: number;
  wer: WordErrors;
  werPlain: WordErrors;
  /** tên người và tên đơn vị, tính theo từng tên */
  names: Rate;
  people: Rate;
  units: Rate;
  /** trong số tên sai, bao nhiêu tên chỉ sai dấu */
  nameDiacriticOnly: number;
  /** tính theo câu có số tiền kỳ vọng, so theo tập */
  money: Rate;
  /** tính theo câu có ngày kỳ vọng, so theo tập */
  dates: Rate;
  spuriousMoney: number;
  latencyMs: LatencyStats;
  /** số sự kiện utteranceEnd tới sớm giữa câu */
  earlyCuts: number;
  /** số câu bị cắt sớm ít nhất một lần */
  earlyCutSentences: number;
  earlyFinals: number;
  audioMinutes: number;
  costUsd: number | null;
};

export function summarize(items: readonly ScoredItem[], usdPerMinute: number | null): Summary {
  const people = { wrong: 0, total: 0 };
  const units = { wrong: 0, total: 0 };
  let diacriticOnly = 0;
  let moneyWrong = 0;
  let moneyTotal = 0;
  let datesWrong = 0;
  let datesTotal = 0;
  let spuriousMoney = 0;
  let earlyCuts = 0;
  let earlyCutSentences = 0;
  let earlyFinals = 0;
  let bytes = 0;
  let failed = 0;
  let noResult = 0;
  for (const it of items) {
    if (it.status === 'failed') failed += 1;
    if (it.status === 'no_result') noResult += 1;
    for (const n of it.score.names) {
      const bucket = n.kind === 'person' ? people : units;
      bucket.total += 1;
      if (n.verdict !== 'exact') bucket.wrong += 1;
      if (n.verdict === 'diacritic') diacriticOnly += 1;
    }
    if (it.score.money) {
      moneyTotal += 1;
      if (!it.score.money.ok) moneyWrong += 1;
    }
    if (it.score.dates) {
      datesTotal += 1;
      if (!it.score.dates.ok) datesWrong += 1;
    }
    spuriousMoney += it.score.spuriousMoney;
    earlyCuts += it.earlyUtteranceEnds;
    if (it.earlyUtteranceEnds > 0) earlyCutSentences += 1;
    earlyFinals += it.earlyFinals;
    bytes += it.bytesSent;
  }
  const minutes = audioMinutes(bytes);
  return {
    sentences: items.length,
    failed,
    noResult,
    wer: sumWordErrors(items.map((i) => i.score.wer)),
    werPlain: sumWordErrors(items.map((i) => i.score.werPlain)),
    names: rateOf(people.wrong + units.wrong, people.total + units.total),
    people: rateOf(people.wrong, people.total),
    units: rateOf(units.wrong, units.total),
    nameDiacriticOnly: diacriticOnly,
    money: rateOf(moneyWrong, moneyTotal),
    dates: rateOf(datesWrong, datesTotal),
    spuriousMoney,
    latencyMs: summarizeLatency(items.map((i) => i.latencyMs)),
    earlyCuts,
    earlyCutSentences,
    earlyFinals,
    audioMinutes: minutes,
    costUsd: estimateCostUsd(minutes, usdPerMinute),
  };
}

// ───────────────────────── Ngưỡng đề xuất ─────────────────────────

/** SPEC 6.2.1 điều 4 **[MỤC TIÊU]**, Mike chốt: sai tên người và sai số tiền không quá 5% trên bộ câu kịch bản vàng. */
export const PROPOSED_THRESHOLDS = { peopleErrorMax: 0.05, moneyErrorMax: 0.05 } as const;

export type VerdictStatus = 'pass' | 'fail' | 'insufficient';

export type Verdict = {
  status: VerdictStatus;
  people: Rate;
  money: Rate;
  peopleOk: boolean | null;
  moneyOk: boolean | null;
};

/** wrong/total không quá 5%, so bằng số nguyên để không dính sai số số thực (2/40 đúng bằng 5%). */
const withinFivePercent = (r: Rate): boolean | null => (r.total === 0 ? null : r.wrong * 100 <= r.total * 5);

/**
 * Đạt hay không so với NGƯỠNG ĐỀ XUẤT; không phải quyết định chọn nhà cung cấp (việc của Mike).
 * `insufficient`: bộ dữ liệu không có tên người hoặc không có số tiền nên chưa đủ để kết luận.
 */
export function judge(summary: Summary): Verdict {
  const peopleOk = withinFivePercent(summary.people);
  const moneyOk = withinFivePercent(summary.money);
  const status: VerdictStatus = peopleOk === null || moneyOk === null ? 'insufficient' : peopleOk && moneyOk ? 'pass' : 'fail';
  return { status, people: summary.people, money: summary.money, peopleOk, moneyOk };
}
