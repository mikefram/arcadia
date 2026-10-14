/**
 * Chốt chặn số liệu (SPEC 6.7) và kiểm văn phong (SPEC 6.6): con số do SQL cho, LLM chỉ viết lời.
 * Trước khi trả lời, `scribe` trích mọi số trong câu trả lời và đối chiếu với tập số trong kết quả tool
 * (cùng các số thứ tự và ngày hợp lệ). Có số lạ thì sinh lại đúng một lần kèm báo lỗi; vẫn sai thì dùng
 * mẫu văn bản dựng thẳng từ số liệu, không qua LLM.
 *
 * Mọi hàm ở đây là hàm thuần. Chốt chặn chỉ thấy số viết bằng CHỮ SỐ; system prompt yêu cầu model luôn viết số
 * bằng chữ số (phần đổi thành chữ để đọc do `toSpeakable` làm sau).
 */
import { findBannedWords } from '@mihato/i18n';
import { ASSISTANT_PHRASES } from './prompt';

// ───────────────────────── Trích số ─────────────────────────

export type NumberKind = 'number' | 'date' | 'time' | 'ordinal';

export type NumberToken = {
  /** nguyên văn trong câu */
  raw: string;
  kind: NumberKind;
  /** `number`: giá trị đã nhân đơn vị (20 triệu → 20000000). Loại khác: số đầu tiên trong cụm. */
  value: number;
  /** `number` đi kèm ký hiệu phần trăm */
  percent?: boolean;
  /** `date`: phần nào không nêu thì bỏ trống */
  day?: number;
  month?: number;
  year?: number;
  /** `date` dạng a/b không có ngữ cảnh: có thể là ngày/tháng, cũng có thể là "4/6 việc" */
  ambiguous?: boolean;
  /** `time`: giờ theo 24 giờ */
  hour?: number;
  minute?: number;
};

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const B = String.raw`(?<![\p{L}\p{N}_])`;
const E = String.raw`(?![\p{L}\p{N}_])`;
const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?`;

function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const validDayMonth = (d: number, m: number) => d >= 1 && d <= 31 && m >= 1 && m <= 12;

/** "20.000.000" → 20000000; "1,5" và "1.5" → 1.5. */
function parseNumeral(raw: string): number {
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) return Number(raw.replace(/\./g, '').replace(',', '.'));
  return Number(raw.replace(',', '.'));
}

const UNIT_SCALE: Record<string, number> = { nghìn: 1e3, ngàn: 1e3, k: 1e3, triệu: 1e6, tr: 1e6, tỷ: 1e9, tỉ: 1e9 };

type Rule = { re: RegExp; read: (m: RegExpExecArray) => NumberToken | NumberToken[] | null };

/** Các mẫu theo thứ tự ưu tiên; đoạn đã khớp được che đi để mẫu sau không đọc lại. */
const RULES: Rule[] = [
  // UUID: không phải số liệu.
  { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, read: () => null },
  // Thời điểm ISO (kết quả tool lưu UTC): đổi sang ngày và giờ Việt Nam.
  {
    re: /(?<![\d-])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})(?![\d])/gu,
    read: (m) => {
      const ms = Date.parse(m[0]);
      if (Number.isNaN(ms)) return null;
      const d = new Date(ms + VN_OFFSET_MS);
      return [
        { raw: m[0], kind: 'date', value: d.getUTCDate(), day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() },
        { raw: m[0], kind: 'time', value: d.getUTCHours(), hour: d.getUTCHours(), minute: d.getUTCMinutes() },
      ];
    },
  },
  // Ngày ISO: 2026-10-15
  {
    re: /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/gu,
    read: (m) => {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return isRealDate(y, mo, d) ? { raw: m[0], kind: 'date', value: d, day: d, month: mo, year: y } : null;
    },
  },
  // 15/10/2026, 15-10-2026
  {
    re: /(?<![\d/.-])(\d{1,2})([/-])(\d{1,2})\2(\d{4})(?![\d/-])/gu,
    read: (m) => {
      const [d, mo, y] = [Number(m[1]), Number(m[3]), Number(m[4])];
      return isRealDate(y, mo, d) ? { raw: m[0], kind: 'date', value: d, day: d, month: mo, year: y } : null;
    },
  },
  // "ngày 15 tháng 10 năm 2026", "mùng 5 tháng 9", "15 tháng 10"
  {
    re: new RegExp(String.raw`${B}(?:(?:ngày|mùng|mồng)\s+)?(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?${E}`, 'giu'),
    read: (m) => {
      const [d, mo] = [Number(m[1]), Number(m[2])];
      if (!validDayMonth(d, mo)) return null;
      return { raw: m[0], kind: 'date', value: d, day: d, month: mo, ...(m[3] ? { year: Number(m[3]) } : {}) };
    },
  },
  // "tháng 10 năm 2026", "tháng 10"
  {
    re: new RegExp(String.raw`${B}tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?${E}`, 'giu'),
    read: (m) => {
      const mo = Number(m[1]);
      if (mo < 1 || mo > 12) return null;
      return { raw: m[0], kind: 'date', value: mo, month: mo, ...(m[2] ? { year: Number(m[2]) } : {}) };
    },
  },
  // "năm 2026"
  {
    re: new RegExp(String.raw`${B}năm\s+(\d{4})${E}`, 'giu'),
    read: (m) => ({ raw: m[0], kind: 'date', value: Number(m[1]), year: Number(m[1]) }),
  },
  // "ngày 15/10", "hạn 15/10": ngày/tháng có ngữ cảnh
  {
    re: new RegExp(String.raw`${B}(?:ngày|hạn:?|hôm|mùng|mồng)\s+(\d{1,2})/(\d{1,2})(?![\d/])`, 'giu'),
    read: (m) => {
      const [d, mo] = [Number(m[1]), Number(m[2])];
      return validDayMonth(d, mo) ? { raw: m[0], kind: 'date', value: d, day: d, month: mo } : null;
    },
  },
  // Giờ: "17:00", "07:30"
  {
    re: /(?<![\d:])(\d{1,2}):(\d{2})(?::\d{2})?(?![\d:])/gu,
    read: (m) => {
      const [h, mi] = [Number(m[1]), Number(m[2])];
      return h <= 23 && mi <= 59 ? { raw: m[0], kind: 'time', value: h, hour: h, minute: mi } : null;
    },
  },
  // Giờ: "5 giờ chiều", "7 giờ 30 sáng", "9h30", "17h"
  {
    re: new RegExp(String.raw`${B}(\d{1,2})\s?(?:giờ|h)(?:\s?(\d{2})(?:\s?phút)?)?(?:\s+(sáng|trưa|chiều|tối|đêm))?${E}`, 'giu'),
    read: (m) => {
      let h = Number(m[1]);
      const mi = m[2] ? Number(m[2]) : undefined;
      if (h > 23 || (mi !== undefined && mi > 59)) return null;
      const period = m[3]?.toLowerCase();
      if ((period === 'chiều' || period === 'tối' || period === 'đêm') && h < 12) h += 12;
      return { raw: m[0], kind: 'time', value: h, hour: h, ...(mi !== undefined ? { minute: mi } : {}) };
    },
  },
  // Số thứ tự: "thứ 5", "lần 2", "bước 3", "mục 1"
  {
    re: new RegExp(String.raw`${B}(?:thứ|lần|bước|mục)\s+(\d{1,2})${E}`, 'giu'),
    read: (m) => ({ raw: m[0], kind: 'ordinal', value: Number(m[1]) }),
  },
  // Số thứ tự đầu dòng: "1. …", "2) …"
  {
    re: /(?<=^|\n)[ \t]*(\d{1,2})[.)](?=\s)/gu,
    read: (m) => ({ raw: m[0].trim(), kind: 'ordinal', value: Number(m[1]) }),
  },
  // "ngày 15" (chỉ có ngày)
  {
    re: new RegExp(String.raw`${B}(?:ngày|mùng|mồng)\s+(\d{1,2})${E}(?!\s*(?:ngày|việc|người|lần|tuần|tháng|năm|giờ|phút))`, 'giu'),
    read: (m) => {
      const d = Number(m[1]);
      return d >= 1 && d <= 31 ? { raw: m[0], kind: 'date', value: d, day: d } : null;
    },
  },
  // a/b không có ngữ cảnh: ngày/tháng, hoặc "4/6 việc"
  {
    re: /(?<![\d/.,-])(\d{1,3})\/(\d{1,3})(?![\d/])/gu,
    read: (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (validDayMonth(a, b)) return { raw: m[0], kind: 'date', value: a, day: a, month: b, ambiguous: true };
      return [
        { raw: m[1] as string, kind: 'number', value: a },
        { raw: m[2] as string, kind: 'number', value: b },
      ];
    },
  },
  // Mọi con số còn lại, kèm đơn vị và phần trăm nếu có: "20.000.000", "1,5 tỷ", "20 triệu", "50%", "20tr"
  {
    re: new RegExp(String.raw`${B}(${NUM})(?:\s?(%|phần trăm)|\s?(k|K|tr)${E}|\s+(nghìn|ngàn|triệu|tỷ|tỉ)${E})?(?![\p{L}\p{N}_])`, 'gu'),
    read: (m) => {
      const base = parseNumeral(m[1] as string);
      if (!Number.isFinite(base)) return null;
      const unit = (m[3] ?? m[4] ?? '').toLowerCase();
      const scale = unit ? (UNIT_SCALE[unit] ?? 1) : 1;
      return { raw: m[0].trim(), kind: 'number', value: Math.round(base * scale * 1e6) / 1e6, ...(m[2] ? { percent: true } : {}) };
    },
  },
];

/**
 * Trích mọi số viết bằng chữ số trong một đoạn văn, theo thứ tự xuất hiện: số thường (kể cả 20.000.000 và 1,5),
 * ngày, giờ và số thứ tự. Chữ số dính liền chữ cái (s3, M2, mã định danh) không được coi là số liệu.
 */
export function extractNumbers(text: string): NumberToken[] {
  let masked = text.normalize('NFC');
  const found: { at: number; token: NumberToken }[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    const spans: [number, number][] = [];
    for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const out = rule.read(m);
      // Mẫu khớp nhưng không hợp lệ (ví dụ 32/13/2026): để nguyên cho mẫu sau đọc như số thường.
      if (out === null && rule !== RULES[0]) continue;
      spans.push([m.index, m.index + m[0].length]);
      if (out === null) continue;
      for (const [i, token] of (Array.isArray(out) ? out : [out]).entries()) found.push({ at: m.index + i / 10, token });
    }
    // Che bằng khoảng trắng cùng độ dài để giữ nguyên vị trí.
    for (const [from, to] of spans) masked = masked.slice(0, from) + ' '.repeat(to - from) + masked.slice(to);
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.token);
}

// ───────────────────────── Tập số được phép ─────────────────────────

export type NumberFacts = {
  /** mọi giá trị số có trong dữ liệu, kể cả số phần tử của từng mảng */
  values: Set<number>;
  dates: { day?: number; month?: number; year?: number }[];
  times: { hour: number; minute?: number }[];
};

export function emptyNumberFacts(): NumberFacts {
  return { values: new Set(), dates: [], times: [] };
}

function addToken(facts: NumberFacts, t: NumberToken): void {
  if (t.kind === 'number' || t.kind === 'ordinal') {
    facts.values.add(t.value);
    return;
  }
  if (t.kind === 'date') {
    facts.dates.push({ day: t.day, month: t.month, year: t.year });
    return;
  }
  if (t.hour !== undefined) facts.times.push({ hour: t.hour, minute: t.minute });
}

/** Nạp số từ một đoạn văn (câu người dùng, dòng "hôm nay là…") vào tập được phép. */
export function addFactsFromText(facts: NumberFacts, text: string): NumberFacts {
  for (const t of extractNumbers(text)) addToken(facts, t);
  return facts;
}

function walk(value: unknown, facts: NumberFacts, depth: number): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) facts.values.add(Math.abs(value));
    return;
  }
  if (typeof value === 'bigint') {
    facts.values.add(Number(value < 0n ? -value : value));
    return;
  }
  if (typeof value === 'string') {
    addFactsFromText(facts, value);
    return;
  }
  if (Array.isArray(value)) {
    // Số phần tử của một danh sách là số đếm hợp lệ ("có 2 việc quá hạn" khi danh sách có 2 dòng).
    facts.values.add(value.length);
    for (const v of value) walk(v, facts, depth + 1);
    return;
  }
  if (typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) walk(v, facts, depth + 1);
}

/**
 * Tập số có trong các kết quả tool: mọi giá trị số, mọi số viết trong chuỗi, số phần tử của từng mảng,
 * và ngày giờ (thời điểm ISO được đổi sang giờ Việt Nam). Khoá của object và UUID không tính.
 */
export function numbersFromToolResults(results: readonly unknown[]): NumberFacts {
  const facts = emptyNumberFacts();
  for (const r of results) walk(r, facts, 0);
  return facts;
}

const dateMatches = (t: NumberToken, f: NumberFacts['dates'][number]) =>
  (t.day === undefined || t.day === f.day) && (t.month === undefined || t.month === f.month) && (t.year === undefined || t.year === f.year);

function isKnown(t: NumberToken, facts: NumberFacts): boolean {
  switch (t.kind) {
    case 'ordinal':
      return true;
    case 'number': {
      if (facts.values.has(t.value)) return true;
      // "67%" khi kết quả tool ghi tỉ lệ 0.6667
      if (t.percent) for (const v of facts.values) if (v > 0 && v <= 1 && Math.abs(v * 100 - t.value) < 0.5) return true;
      return false;
    }
    case 'date': {
      if (facts.dates.some((f) => dateMatches(t, f))) return true;
      // "4/6 việc": không phải ngày, nhưng cả hai số đều có trong kết quả tool
      return t.ambiguous === true && t.day !== undefined && t.month !== undefined && facts.values.has(t.day) && facts.values.has(t.month);
    }
    case 'time':
      return facts.times.some((f) => f.hour === t.hour && (t.minute === undefined || (f.minute ?? 0) === t.minute));
  }
}

export type CheckNumbersOptions = {
  /**
   * Số được phép ngoài kết quả tool: giá trị số, hoặc đoạn văn để trích số (câu của chính người dùng,
   * dòng ngày hôm nay). Trợ lý nhắc lại số người dùng vừa nói không phải là bịa.
   */
  allowed?: readonly (number | string)[];
};

/**
 * Đối chiếu mọi số trong câu trả lời với kết quả tool. Trả danh sách số lạ (nguyên văn, không trùng);
 * rỗng nghĩa là đạt. Cho phép: số thứ tự; ngày và giờ có trong kết quả tool hoặc trong `allowed` (ngày hôm nay).
 */
export function checkNumbers(reply: string, toolResults: readonly unknown[], opts: CheckNumbersOptions = {}): string[] {
  const tokens = extractNumbers(reply);
  if (tokens.length === 0) return [];
  const facts = numbersFromToolResults(toolResults);
  for (const a of opts.allowed ?? []) {
    if (typeof a === 'number') facts.values.add(Math.abs(a));
    else addFactsFromText(facts, a);
  }
  const unknown: string[] = [];
  for (const t of tokens) if (!isKnown(t, facts) && !unknown.includes(t.raw)) unknown.push(t.raw);
  return unknown;
}

// ───────────────────────── Mẫu văn bản dựng thẳng từ số liệu ─────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** Phần số liệu của `Overview` (@mihato/domain) mà mẫu cần; nhận cả kết quả tool `get_overview`. */
export type OverviewNumbers = {
  running: number;
  overdue: number;
  dueToday: number;
  dueTomorrow: number;
  awaitingMyDecision?: number;
};

/**
 * Tóm tắt tình hình dựng thẳng từ số liệu, không qua LLM (SPEC 6.7): dùng khi câu của model vẫn có số lạ sau
 * một lần sinh lại. Không quá ba câu, mỗi câu mở bằng số liệu. Số 0 được viết thành lời ("không có việc nào").
 */
export function fallbackOverviewText(overview: OverviewNumbers, title = 'Chủ tịch'): string {
  const due = (n: number) => (n > 0 ? `có ${n} việc đến hạn` : 'không có việc nào đến hạn');
  const running = overview.running > 0 ? `hiện có ${overview.running} quy trình đang chạy` : 'hiện không có quy trình nào đang chạy';
  const overdue = overview.overdue > 0 ? ` và ${overview.overdue} việc quá hạn` : ', không có việc nào quá hạn';
  const parts = [`Dạ thưa ${title}, ${running}${overdue}.`, `Hôm nay ${due(overview.dueToday)}, ngày mai ${due(overview.dueTomorrow)}.`];
  if (overview.awaitingMyDecision !== undefined) {
    parts.push(overview.awaitingMyDecision > 0 ? `Có ${overview.awaitingMyDecision} việc đang chờ ${title} quyết.` : `Không có việc nào đang chờ ${title} quyết.`);
  }
  return parts.join(' ');
}

/** Đọc số liệu tổng quan từ một kết quả tool bất kỳ; null nếu không đúng dạng. */
export function readOverviewNumbers(value: unknown): OverviewNumbers | null {
  const o = isRecord(value) && isRecord(value.overview) ? value.overview : value;
  if (!isRecord(o)) return null;
  const [running, overdue, dueToday, dueTomorrow] = [int(o.running), int(o.overdue), int(o.dueToday), int(o.dueTomorrow)];
  if (running === null || overdue === null || dueToday === null || dueTomorrow === null) return null;
  const mine = int(o.awaitingMyDecision);
  return { running, overdue, dueToday, dueTomorrow, ...(mine !== null ? { awaitingMyDecision: mine } : {}) };
}

/** Tóm tắt một lượt chạy dựng thẳng từ kết quả `get_run`; null nếu kết quả không có số việc xong và tổng số việc. */
export function fallbackRunText(value: unknown, title = 'Chủ tịch'): string | null {
  const run = isRecord(value) && isRecord(value.run) ? value.run : value;
  if (!isRecord(run)) return null;
  // Máy chủ trả `done` và `total` ngay ở lượt chạy; dạng cũ để trong `progress`.
  const progress = isRecord(run.progress) ? run.progress : run;
  const [done, total] = [int(progress.done), int(progress.total)];
  if (done === null || total === null) return null;
  const steps = Array.isArray(run.steps) ? run.steps.filter(isRecord) : null;
  const name = typeof run.title === 'string' && run.title ? `đợt “${run.title}”` : 'đợt việc này';
  let out = `Dạ thưa ${title}, ${name} có ${done} trên ${total} việc đã xong.`;
  if (steps) {
    const overdue = steps.filter((s) => s.isOverdue === true).length;
    out += overdue > 0 ? ` Có ${overdue} việc quá hạn.` : ' Không có việc nào quá hạn.';
  }
  return `${out} Chi tiết có trên màn hình Tiến độ.`;
}

/**
 * Chọn câu thay thế khi chốt chặn số liệu vẫn thấy số lạ sau một lần sinh lại: ưu tiên `get_overview` gần nhất,
 * rồi `get_run` gần nhất, cuối cùng là câu mẫu mời xem màn hình. Không bao giờ dùng chữ của LLM.
 */
export function fallbackFromToolResults(calls: readonly { name: string; result: unknown }[], title = 'Chủ tịch'): string {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i] as { name: string; result: unknown };
    const payload = isRecord(call.result) && 'result' in call.result ? call.result.result : call.result;
    if (call.name === 'get_overview') {
      const numbers = readOverviewNumbers(payload);
      if (numbers) return fallbackOverviewText(numbers, title);
    }
    if (call.name === 'get_run') {
      const text = fallbackRunText(payload, title);
      if (text) return text;
    }
  }
  return ASSISTANT_PHRASES.guardFallback(title);
}

// ───────────────────────── Văn phong ─────────────────────────

/** Chữ viết tắt có dấu chấm nhưng không kết thúc câu. */
const NON_TERMINAL = new Set(['TP', 'Tp', 'TS', 'ThS', 'GS', 'PGS', 'BS', 'KS', 'TT', 'TX', 'Q', 'P']);

/** Tách câu: kết thúc bằng . ! ? … (theo sau là khoảng trắng hoặc hết đoạn) hoặc xuống dòng. */
export function splitSentences(text: string): string[] {
  const s = text.normalize('NFC');
  const out: string[] = [];
  let start = 0;
  const re = /[.!?…]+["”’»)\]]*(?=\s|$)|\n+/gu;
  for (const m of s.matchAll(re)) {
    const end = m.index + m[0].length;
    if (m[0] === '.') {
      const before = /([\p{L}\p{N}]+)$/u.exec(s.slice(start, m.index))?.[1] ?? '';
      if (NON_TERMINAL.has(before) || (/^\p{Lu}$/u.test(before) && end < s.length)) continue;
    }
    const sentence = s.slice(start, end).trim();
    if (/[\p{L}\p{N}]/u.test(sentence)) out.push(sentence);
    start = end;
  }
  const tail = s.slice(start).trim();
  if (/[\p{L}\p{N}]/u.test(tail)) out.push(tail);
  return out;
}

export type StyleReport = {
  sentences: number;
  questions: number;
  /** từ vay mượn bị cấm (SPEC 7.5), lấy từ @mihato/i18n */
  banned: string[];
  emoji: boolean;
  /** 'too_many_sentences' | 'too_many_questions' | 'banned_words' | 'emoji' */
  violations: string[];
  ok: boolean;
};

export const STYLE_MAX_SENTENCES = 3;
export const STYLE_MAX_QUESTIONS = 1;

/**
 * Kiểm văn phong của một lượt trả lời (SPEC 6.6): không quá ba câu, không quá một câu hỏi, không từ cấm,
 * không biểu tượng cảm xúc. Chỉ để đo và ghi nhật ký (bằng số đếm); không chặn câu trả lời.
 */
export function checkStyle(reply: string, opts: { maxSentences?: number; maxQuestions?: number } = {}): StyleReport {
  const sentences = splitSentences(reply);
  const questions = sentences.filter((s) => /\?["”’»)\]]*$/u.test(s)).length;
  const banned = findBannedWords(reply);
  const emoji = /\p{Extended_Pictographic}/u.test(reply);
  const violations: string[] = [];
  if (sentences.length > (opts.maxSentences ?? STYLE_MAX_SENTENCES)) violations.push('too_many_sentences');
  if (questions > (opts.maxQuestions ?? STYLE_MAX_QUESTIONS)) violations.push('too_many_questions');
  if (banned.length > 0) violations.push('banned_words');
  if (emoji) violations.push('emoji');
  return { sentences: sentences.length, questions, banned, emoji, violations, ok: violations.length === 0 };
}
