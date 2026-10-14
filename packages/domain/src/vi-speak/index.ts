/**
 * Chuẩn hoá trước khi đọc (SPEC 6.4.1 điều 5): đổi số, tiền, ngày, giờ và viết tắt thành chữ đọc được
 * trước khi gửi cho TTS. Không phó mặc cho TTS đọc số. Mọi hàm ở đây là hàm thuần.
 *
 * Cách đọc theo thói quen miền Bắc: "nghìn" (không "ngàn"), "linh" (không "lẻ"), "hai mươi tư", "mùng".
 * [GIẢ ĐỊNH] cần nghe thử cùng giọng đọc được chọn (SPEC 6.4.1 điều 6).
 */
import { expandAbbrev } from '../vi-normalize';

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'] as const;
/** Chỉ số theo getUTCDay(): 0 = Chủ Nhật. */
const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'] as const;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const BILLION = 1_000_000_000n;

// ───────────────────────── Số ─────────────────────────

/** Hai chữ số 10..99: "mười lăm", "hai mươi mốt", "hai mươi tư", "ba mươi". */
function readTens(tens: number, units: number): string {
  if (tens === 1) {
    if (units === 0) return 'mười';
    return `mười ${units === 5 ? 'lăm' : DIGITS[units]}`;
  }
  const head = `${DIGITS[tens]} mươi`;
  if (units === 0) return head;
  if (units === 1) return `${head} mốt`;
  if (units === 4) return `${head} tư`;
  if (units === 5) return `${head} lăm`;
  return `${head} ${DIGITS[units]}`;
}

/** Nhóm ba chữ số 1..999. `full` = đọc đủ hàng trăm ("không trăm linh một") khi nhóm không đứng đầu số. */
function readTriple(n: number, full: boolean): string {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  const parts: string[] = [];
  const hasHundreds = h > 0 || full;
  if (hasHundreds) parts.push(`${DIGITS[h]} trăm`);
  if (t === 0) {
    if (u > 0) parts.push(hasHundreds ? `linh ${DIGITS[u]}` : (DIGITS[u] as string));
  } else {
    parts.push(readTens(t, u));
  }
  return parts.join(' ');
}

/** Số dưới một tỷ, lớn hơn 0. `full` = nhóm đầu cũng đọc đủ hàng trăm (khi đứng sau "tỷ"). */
function readBelowBillion(n: number, full: boolean): string {
  const groups: [number, string][] = [
    [Math.floor(n / 1_000_000), 'triệu'],
    [Math.floor((n % 1_000_000) / 1000), 'nghìn'],
    [n % 1000, ''],
  ];
  const parts: string[] = [];
  let leading = !full;
  for (const [value, unit] of groups) {
    if (value === 0) continue;
    const words = readTriple(value, !leading);
    parts.push(unit ? `${words} ${unit}` : words);
    leading = false;
  }
  return parts.join(' ');
}

function readInteger(n: bigint): string {
  if (n === 0n) return 'không';
  if (n < BILLION) return readBelowBillion(Number(n), false);
  const high = n / BILLION;
  const low = Number(n % BILLION);
  const head = `${readInteger(high)} tỷ`;
  return low === 0 ? head : `${head} ${readBelowBillion(low, true)}`;
}

const readDigits = (digits: string) =>
  digits
    .split('')
    .map((d) => DIGITS[Number(d)] as string)
    .join(' ');

/** Phần thập phân: một hoặc hai chữ số không bắt đầu bằng 0 thì đọc như số, còn lại đọc từng chữ số. */
function readFraction(digits: string): string {
  return digits.length <= 2 && !digits.startsWith('0') ? readInteger(BigInt(digits)) : readDigits(digits);
}

/**
 * Đọc số thành chữ đúng chính tả: 15 → "mười lăm", 21 → "hai mươi mốt", 105 → "một trăm linh năm",
 * 1001 → "một nghìn không trăm linh một". Số âm thêm "âm"; số thập phân đọc "phẩy".
 */
export function numberToWords(n: number | bigint): string {
  if (typeof n === 'bigint') return n < 0n ? `âm ${readInteger(-n)}` : readInteger(n);
  if (!Number.isFinite(n)) throw new RangeError('Số không hợp lệ');
  if (n < 0) return `âm ${numberToWords(-n)}`;
  if (Number.isInteger(n)) {
    if (!Number.isSafeInteger(n)) throw new RangeError('Số quá lớn, dùng bigint');
    return readInteger(BigInt(n));
  }
  const fixed = n.toFixed(6).replace(/0+$/, '');
  const [int, frac] = fixed.split('.') as [string, string | undefined];
  return frac ? `${readInteger(BigInt(int))} phẩy ${readFraction(frac)}` : readInteger(BigInt(int));
}

function toBigInt(vnd: number | bigint): bigint {
  if (typeof vnd === 'bigint') return vnd;
  if (!Number.isSafeInteger(vnd)) throw new RangeError('Tiền phải là số nguyên VND');
  return BigInt(vnd);
}

const groupDots = (n: bigint) => (n < 0n ? '-' : '') + String(n < 0n ? -n : n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** 20000000 → "hai mươi triệu đồng". */
export function moneyToWords(vnd: number | bigint): string {
  return `${numberToWords(toBigInt(vnd))} đồng`;
}

/** Tiền viết hai lần (SPEC 7.5): 20000000 → "20.000.000 đồng (hai mươi triệu đồng)". */
export function moneyTwice(vnd: number | bigint): string {
  const n = toBigInt(vnd);
  return `${groupDots(n)} đồng (${moneyToWords(n)})`;
}

// ───────────────────────── Ngày ─────────────────────────

/** Ngày trong tháng: 1 đến 10 đọc kèm "mùng". [GIẢ ĐỊNH] theo cách đọc miền Bắc. */
const dayWords = (d: number) => (d <= 10 ? `mùng ${numberToWords(d)}` : numberToWords(d));
/** Tháng 4 đọc "tháng tư". */
const monthWords = (m: number) => (m === 4 ? 'tư' : numberToWords(m));

function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * "Thứ Năm, ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu".
 * `date` là Date hoặc chuỗi thời điểm ISO (lấy ngày theo giờ Việt Nam), hoặc chuỗi ngày 'YYYY-MM-DD'.
 */
export function dateToWords(date: Date | string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  let y: number;
  let m: number;
  let d: number;
  const plain = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim()) : null;
  if (plain) {
    y = Number(plain[1]);
    m = Number(plain[2]);
    d = Number(plain[3]);
    if (!isRealDate(y, m, d)) throw new RangeError('Ngày không hợp lệ');
  } else {
    const ms = date instanceof Date ? date.getTime() : Date.parse(date);
    if (Number.isNaN(ms)) throw new RangeError('Ngày không hợp lệ');
    const local = new Date(ms + VN_OFFSET_MS);
    y = local.getUTCFullYear();
    m = local.getUTCMonth() + 1;
    d = local.getUTCDate();
  }
  let out = `ngày ${dayWords(d)} tháng ${monthWords(m)}`;
  if (opts.year !== false) out += ` năm ${numberToWords(y)}`;
  if (opts.weekday !== false) out = `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${out}`;
  return out;
}

// ───────────────────────── Văn bản để đọc ─────────────────────────

/**
 * Cách đọc tên riêng và chữ cái, khớp nguyên từ và PHÂN BIỆT hoa thường ("AI" khác "ai").
 * [GIẢ ĐỊNH] chờ nghe thử với giọng thật; tổ chức ghi đè qua `opts.pronunciations`.
 */
export const DEFAULT_PRONUNCIATIONS: Readonly<Record<string, string>> = {
  MIHATO: 'Mi ha tô',
  VRG: 'Vê Rờ Gờ',
  AI: 'ây ai',
};

export type SpeakOptions = {
  /** bổ sung hoặc ghi đè từ điển viết tắt (không phân biệt hoa thường); giá trị rỗng là tắt mục đó */
  abbreviations?: Record<string, string>;
  /** bổ sung hoặc ghi đè cách đọc tên riêng (phân biệt hoa thường); giá trị rỗng là tắt mục đó */
  pronunciations?: Record<string, string>;
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function applyPronunciations(text: string, dict: Record<string, string>): string {
  const entries = Object.entries(dict).filter(([k, v]) => k !== '' && v !== '');
  if (entries.length === 0) return text;
  const map = new Map(entries);
  const keys = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${keys.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return text.replace(re, (found) => map.get(found) ?? found);
}

/** "20.000.000" → 20000000n; chỉ nhận số nguyên viết liền hoặc ngăn nghìn bằng dấu chấm. */
function parseGrouped(raw: string): bigint | null {
  if (/^\d{1,3}(\.\d{3})+$/.test(raw)) return BigInt(raw.replace(/\./g, ''));
  if (/^\d+$/.test(raw)) return BigInt(raw);
  return null;
}

/** Đọc một con số viết bằng chữ số: "20.000.000", "1,5", "1.5", "007", "15". */
function readNumeral(raw: string): string {
  const grouped = /^\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : null;
  const intText = grouped ?? (/^\d+$/.test(raw) ? raw : null);
  if (intText !== null) {
    // Số có số 0 đứng đầu (mã, số phút "05") hoặc quá dài thì đọc từng chữ số.
    if ((intText.length > 1 && intText.startsWith('0')) || intText.length > 15) return readDigits(intText);
    return readInteger(BigInt(intText));
  }
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)[,.](\d+)$/.exec(raw);
  if (m) {
    const int = parseGrouped(m[1] as string);
    if (int !== null) return `${readInteger(int)} phẩy ${readFraction(m[2] as string)}`;
  }
  return raw;
}

const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?`;
const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;

function hourWords(h: number, mi: number, withPeriod: boolean): string {
  const minute = mi === 0 ? '' : ` ${mi < 10 ? `không ${DIGITS[mi]}` : readTens(Math.floor(mi / 10), mi % 10)}`;
  if (!withPeriod) return `${numberToWords(h)} giờ${minute}`;
  const period = h < 11 ? 'sáng' : h < 13 ? 'trưa' : h < 18 ? 'chiều' : 'tối';
  const h12 = h > 12 ? h - 12 : h;
  return `${numberToWords(h12)} giờ${minute} ${period}`;
}

/**
 * Đổi một đoạn văn thành chữ đọc được trước khi gửi TTS: mở viết tắt và tên riêng, đổi tiền, ngày, giờ,
 * phần trăm và mọi con số thành chữ. Ví dụ "20.000.000 đồng" → "hai mươi triệu đồng",
 * "15/10/2026" → "ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu", "07:30" → "bảy giờ ba mươi sáng".
 * Tiền viết hai lần ("20.000.000 đồng (hai mươi triệu đồng)") chỉ đọc một lần.
 */
export function toSpeakable(text: string, opts: SpeakOptions = {}): string {
  let s = text.normalize('NFC');

  // 1. Viết tắt và tên riêng. "AI" được đọc theo từ điển tên riêng nên không để từ điển viết tắt đụng vào.
  s = applyPronunciations(s, { ...DEFAULT_PRONUNCIATIONS, ...opts.pronunciations });
  s = expandAbbrev(s, opts.abbreviations ?? {});

  // 2. Tiền viết hai lần: chỉ giữ phần chữ.
  s = s.replace(/(\d{1,3}(?:\.\d{3})+|\d+) đồng(?: \(([^()]+ đồng)\)|, ([^,.;()]+ đồng))/gu, (all, num: string, inParens?: string, afterComma?: string) => {
    const value = parseGrouped(num);
    const words = inParens ?? afterComma;
    return value !== null && words !== undefined && words === moneyToWords(value) ? words : all;
  });

  // 3. Ngày.
  s = s.replace(
    new RegExp(String.raw`${NOT_WORD_BEFORE}(ngày |Ngày |mùng |Mùng |mồng |Mồng )(\d{1,2}) tháng (\d{1,2})(?: năm (\d{4}))?${NOT_WORD_AFTER}`, 'gu'),
    (all, pre: string, dRaw: string, mRaw: string, yRaw?: string) => {
      const d = Number(dRaw);
      const m = Number(mRaw);
      if (d < 1 || d > 31 || m < 1 || m > 12) return all;
      const day = /^ngày /i.test(pre) ? `${pre}${dayWords(d)}` : `${pre}${numberToWords(d)}`;
      return `${day} tháng ${monthWords(m)}${yRaw ? ` năm ${numberToWords(Number(yRaw))}` : ''}`;
    },
  );
  s = s.replace(new RegExp(String.raw`${NOT_WORD_BEFORE}tháng (\d{1,2}) năm (\d{4})${NOT_WORD_AFTER}`, 'gu'), (all, mRaw: string, yRaw: string) => {
    const m = Number(mRaw);
    return m >= 1 && m <= 12 ? `tháng ${monthWords(m)} năm ${numberToWords(Number(yRaw))}` : all;
  });
  s = s.replace(/(ngày |Ngày )?(?<![\d/.-])(\d{1,2})([/-])(\d{1,2})\3(\d{4})(?![\d/-])/gu, (all, pre: string | undefined, dRaw: string, _sep: string, mRaw: string, yRaw: string) => {
    const d = Number(dRaw);
    const m = Number(mRaw);
    const y = Number(yRaw);
    if (!isRealDate(y, m, d)) return all;
    return `${pre ?? 'ngày '}${dayWords(d)} tháng ${monthWords(m)} năm ${numberToWords(y)}`;
  });
  s = s.replace(/(ngày |Ngày )?(?<![\d/.-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/gu, (all, pre: string | undefined, yRaw: string, mRaw: string, dRaw: string) => {
    const d = Number(dRaw);
    const m = Number(mRaw);
    const y = Number(yRaw);
    if (!isRealDate(y, m, d)) return all;
    return `${pre ?? 'ngày '}${dayWords(d)} tháng ${monthWords(m)} năm ${numberToWords(y)}`;
  });
  s = s.replace(/(ngày |Ngày |hạn:? |Hạn:? )(\d{1,2})\/(\d{1,2})(?![\d/])/gu, (all, pre: string, dRaw: string, mRaw: string) => {
    const d = Number(dRaw);
    const m = Number(mRaw);
    if (d < 1 || d > 31 || m < 1 || m > 12) return all;
    const lead = /^ngày /i.test(pre) ? pre : `${pre}ngày `;
    return `${lead}${dayWords(d)} tháng ${monthWords(m)}`;
  });

  // 4. Giờ: "07:30" → "bảy giờ ba mươi sáng"; "9h30" → "chín giờ ba mươi".
  s = s.replace(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/gu, (all, hRaw: string, mRaw: string, offset: number, whole: string) => {
    const h = Number(hRaw);
    const mi = Number(mRaw);
    if (h > 23 || mi > 59) return all;
    const periodFollows = /^ (?:sáng|trưa|chiều|tối|đêm)/u.test(whole.slice(offset + all.length));
    return hourWords(h, mi, !periodFollows);
  });
  s = s.replace(new RegExp(String.raw`${NOT_WORD_BEFORE}(\d{1,2})h(\d{2})?${NOT_WORD_AFTER}`, 'gu'), (all, hRaw: string, mRaw?: string) => {
    const h = Number(hRaw);
    const mi = mRaw ? Number(mRaw) : 0;
    return h > 23 || mi > 59 ? all : hourWords(h, mi, false);
  });

  // 5. Phần trăm, đơn vị tiền viết tắt, phân số.
  s = s.replace(new RegExp(String.raw`(${NUM})\s?%`, 'gu'), (_all, num: string) => `${readNumeral(num)} phần trăm`);
  s = s.replace(new RegExp(String.raw`(${NUM})\s?(?:đ|VNĐ|VND|vnđ|vnd)${NOT_WORD_AFTER}`, 'gu'), (_all, num: string) => `${readNumeral(num)} đồng`);
  s = s.replace(new RegExp(String.raw`${NOT_WORD_BEFORE}(${NUM})\s?(k|K|tr)${NOT_WORD_AFTER}`, 'gu'), (_all, num: string, unit: string) => {
    return `${readNumeral(num)} ${unit === 'tr' ? 'triệu' : 'nghìn'}`;
  });
  s = s.replace(new RegExp(String.raw`${NOT_WORD_BEFORE}(\d+)/(\d+)${NOT_WORD_AFTER}(?!/)`, 'gu'), (_all, a: string, b: string) => `${readNumeral(a)} trên ${readNumeral(b)}`);

  // 6. Mọi con số còn lại.
  s = s.replace(new RegExp(String.raw`${NOT_WORD_BEFORE}(?:${NUM})${NOT_WORD_AFTER}`, 'gu'), (num) => readNumeral(num));

  // 7. Ký hiệu và khoảng trắng.
  return s
    .replace(/\s*&\s*/g, ' và ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

// ───────────────────────── Tách đoạn cho TTS ─────────────────────────

/** Chữ viết tắt có dấu chấm nhưng không kết thúc câu. */
const NON_TERMINAL = new Set(['TP', 'Tp', 'TS', 'ThS', 'GS', 'PGS', 'BS', 'KS', 'TT', 'TX', 'Q', 'P']);

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?…]+["”’»)\]]*(?=\s|$)|\n+/gu;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (m[0] === '.') {
      const before = /([\p{L}\p{N}]+)$/u.exec(text.slice(start, m.index))?.[1] ?? '';
      if (NON_TERMINAL.has(before) || (/^\p{Lu}$/u.test(before) && end < text.length)) continue;
    }
    const sentence = text.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Ghép các mẩu liên tiếp thành đoạn không quá `limit` ký tự. Mẩu dài hơn `limit` giữ nguyên để tầng dưới cắt tiếp. */
function pack(parts: string[], limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const part of parts) {
    if (!part) continue;
    if (!cur) cur = part;
    else if (cur.length + 1 + part.length <= limit) cur += ` ${part}`;
    else {
      out.push(cur);
      cur = part;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Cắt một câu quá dài: trước hết theo dấu phẩy, chấm phẩy, hai chấm; rồi theo khoảng trắng; cuối cùng cắt cứng. */
function breakLong(sentence: string, limit: number): string[] {
  const clauses = sentence.split(/(?<=[,;:–—])\s+/u);
  const out: string[] = [];
  for (const clause of pack(clauses, limit)) {
    if (clause.length <= limit) {
      out.push(clause);
      continue;
    }
    for (const piece of pack(clause.split(/\s+/u), limit)) {
      if (piece.length <= limit) out.push(piece);
      else for (let i = 0; i < piece.length; i += limit) out.push(piece.slice(i, i + limit));
    }
  }
  return out;
}

/**
 * Tách văn bản theo câu thành các đoạn không quá `max` ký tự để gọi TTS tuần tự (SPEC 6.4.1 điều 3).
 * Các câu ngắn liền nhau được gộp vào một đoạn; câu dài hơn `max` được cắt ở dấu phẩy hoặc khoảng trắng.
 */
export function splitForTts(text: string, max = 300): string[] {
  const limit = Math.max(1, Math.floor(max));
  const clean = text
    .normalize('NFC')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
  if (!clean) return [];
  const pieces: string[] = [];
  for (const sentence of splitSentences(clean)) {
    if (sentence.length <= limit) pieces.push(sentence);
    else pieces.push(...breakLong(sentence, limit));
  }
  return pack(pieces, limit);
}
