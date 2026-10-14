/**
 * Tách số tiền và ngày ra khỏi câu nói, rồi chuẩn hoá bằng chính mã của hệ thống (`parseMoney`, `resolveDate`
 * ở @mihato/domain/vi-normalize, SPEC 6.6). Hai hàm đó nhận MỘT cụm từ, không nhận cả câu; trong sản phẩm, Claude
 * chọn cụm rồi gọi tool. Bài đo không được gọi Claude nên dùng bộ tách theo luật dưới đây.
 *
 * Bộ tách là phép xấp xỉ, dùng GIỐNG HỆT cho câu chuẩn và cho kết quả STT, nên lệch nếu có sẽ lệch cho mọi nhà cung cấp.
 * `lintEntities` (metrics.ts) chạy nó trên câu chuẩn để báo manifest nào mà bộ tách không đọc nổi, TRƯỚC khi tốn tiền.
 *
 * Luật chính:
 *  - Tiền: cụm số dài nhất mà `parseMoney` đọc được, có đơn vị (nghìn, triệu, tỷ, k, tr, đồng…) hoặc là số lớn có dấu
 *    ngăn nghìn; bỏ số dưới 1.000 đồng ("hai đồng chí") và năm đọc bằng chữ ("năm hai nghìn không trăm hai mươi sáu").
 *  - Ngày: đoạn liên tiếp gồm từ chỉ ngày (ngày, tháng, thứ, mai…), số, và từ đệm (này, sau, tới…). Cụm phải chứa MỌI
 *    chữ số/số đọc bằng chữ của đoạn, để "thứ Tư ngày sáu tháng mười" (sai thứ) không tụt về "thứ Tư" rồi vô tình đúng.
 */
import { DEFAULT_CALENDAR, type WorkCalendar } from '@mihato/domain';
import { parseMoney, resolveDate, stripDiacritics } from '@mihato/domain/vi-normalize';

const TOKEN_RE = /\d+(?:[.,/-]\d+)*|\p{L}[\p{L}\p{M}]*/gu;

/** Tách thành tiếng và số (giữ nguyên "20.000.000", "7/10", "2026-10-07"); chữ thường, Unicode dựng sẵn. */
export function tokenize(text: string): string[] {
  return text.normalize('NFC').toLowerCase().match(TOKEN_RE) ?? [];
}

// ───────────────────────── Tiền ─────────────────────────

const MONEY_UNITS = new Set(['nghìn', 'ngàn', 'ngìn', 'k', 'triệu', 'tr', 'tỷ', 'tỉ', 'đồng', 'đ', 'vnđ', 'vnd', 'nghin', 'ngan', 'trieu', 'ty', 'dong']);

const NUMBER_WORDS = ['không', 'một', 'mốt', 'hai', 'ba', 'bốn', 'tư', 'năm', 'lăm', 'nhăm', 'sáu', 'bảy', 'bẩy', 'tám', 'chín', 'mười', 'mươi', 'chục', 'trăm', 'linh', 'lẻ', 'rưỡi', 'rưởi'];
const MONEY_NUMBER_WORDS = new Set([...NUMBER_WORDS, ...NUMBER_WORDS.map(stripDiacritics)]);

const MAX_MONEY_TOKENS = 14;
/** Dưới mức này không coi là tiền (tránh "hai đồng chí" thành 2 đồng). */
export const MIN_MONEY_VND = 1000;

const isDigits = (t: string) => /^\d/.test(t);

/** Số lớn tự đủ nghĩa tiền: có dấu ngăn nghìn ("20.000.000") hoặc từ 5 chữ số; trừ dãy bắt đầu bằng 0 (số điện thoại). */
function isLargeNumeral(t: string): boolean {
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) return true;
  return /^\d{5,}$/.test(t) && !/^0\d{8,}$/.test(t);
}

function looksLikeMoney(tokens: string[]): boolean {
  const hasUnit = tokens.some((t) => MONEY_UNITS.has(t));
  if (hasUnit) return tokens.some((t) => !MONEY_UNITS.has(t) && (MONEY_NUMBER_WORDS.has(t) || isDigits(t)));
  return tokens.length === 1 && isLargeNumeral(tokens[0] as string);
}

/** Số đứng ngay trước các từ này là số ngày, tháng, giờ, người…, không phải phần của số tiền ("hai chục triệu mười lăm tháng mười"). */
const NOT_MONEY_NEIGHBOURS = new Set(['tháng', 'ngày', 'giờ', 'phút', 'tuần', 'người', 'việc', 'lần']);

const isPlainNumberToken = (t: string) => !MONEY_UNITS.has(t) && (MONEY_NUMBER_WORDS.has(t) || isDigits(t));

/**
 * Cụm kết thúc ở một số trần (không phải đơn vị) mà dãy số đó còn kéo dài tới một từ như "tháng", "ngày", "giờ":
 * các số ấy thuộc về ngày hoặc giờ, nên không được cắt chúng vào số tiền.
 */
function endsInsideDatePart(tokens: string[], end: number): boolean {
  if (!isPlainNumberToken(tokens[end - 1] as string)) return false;
  let k = end;
  while (k < tokens.length && isPlainNumberToken(tokens[k] as string)) k += 1;
  return NOT_MONEY_NEIGHBOURS.has(tokens[k] ?? '');
}

/** Cụm đọc bằng chữ của một năm (1900–2100) bắt đầu từ `from`: trả chỉ số kết thúc (loại trừ) hoặc null. */
function yearEnd(tokens: string[], from: number): number | null {
  for (let j = Math.min(tokens.length, from + MAX_MONEY_TOKENS); j > from; j--) {
    const value = parseMoney(tokens.slice(from, j).join(' '));
    if (value !== null && value >= 1900 && value <= 2100) return j;
  }
  return null;
}

export type MoneySpan = { value: number; from: number; to: number };

/** Các số tiền (VND) trong câu, theo thứ tự xuất hiện, kèm khoảng tiếng [from, to) để bộ tách ngày tránh trùng. */
export function findMoney(tokens: string[]): MoneySpan[] {
  const out: MoneySpan[] = [];
  let i = 0;
  while (i < tokens.length) {
    // "năm hai nghìn không trăm hai mươi sáu" là năm 2026, không phải 52.026 đồng.
    if (tokens[i] === 'năm') {
      const end = yearEnd(tokens, i + 1);
      if (end !== null) {
        i = end;
        continue;
      }
    }
    let taken: MoneySpan | null = null;
    for (let j = Math.min(tokens.length, i + MAX_MONEY_TOKENS); j > i && !taken; j--) {
      const window = tokens.slice(i, j);
      if (!looksLikeMoney(window)) continue;
      if (endsInsideDatePart(tokens, j)) continue;
      const value = parseMoney(window.join(' '));
      if (value === null || value < MIN_MONEY_VND) continue;
      taken = { value, from: i, to: j };
    }
    if (taken) {
      out.push(taken);
      i = taken.to;
    } else i += 1;
  }
  return out;
}

export const extractMoney = (text: string): number[] => findMoney(tokenize(text)).map((s) => s.value);

// ───────────────────────── Ngày ─────────────────────────

/** Từ chỉ ngày: đủ để biết đây là cụm ngày. */
const DATE_ANCHORS = new Set(['ngày', 'tháng', 'thứ', 'hôm', 'mai', 'kia', 'nay', 'tuần', 'mùng', 'mồng', 'chủ nhật', 'ngày làm việc']);
/** Số đọc bằng chữ: PHẢI nằm trọn trong cụm, vì bỏ sót một số là đổi ngày. */
const DATE_NUMBER_WORDS = new Set(['không', 'một', 'mốt', 'hai', 'ba', 'bốn', 'tư', 'năm', 'lăm', 'nhăm', 'sáu', 'bảy', 'bẩy', 'tám', 'chín', 'mười', 'mươi', 'linh', 'lẻ', 'trăm', 'nghìn', 'ngàn']);
/** Từ đệm có thể đứng ở rìa cụm; bỏ đi được. */
const DATE_SOFT = new Set(['này', 'sau', 'tới', 'kế', 'tiếp', 'trước', 'vừa', 'rồi', 'qua', 'nữa', 'đầu', 'cuối', 'sáng', 'trưa', 'chiều', 'tối', 'đêm', 'âm', 'lịch']);
const NUMERIC_DATE = /^\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?$|^\d{4}-\d{1,2}-\d{1,2}$/;
/** Sau tiếng xưng hô, "Mai" là tên người ("chị Mai"), không phải "ngày mai". */
const HONORIFICS = new Set(['anh', 'chị', 'ông', 'bà', 'cô', 'chú', 'bác', 'cậu', 'dì', 'em', 'cháu', 'thầy']);
const NAME_LIKE_DATE_WORDS = new Set(['mai']);

type Kind = 'anchor' | 'number' | 'soft' | 'other';
type Unit = { text: string; kind: Kind; numericDate: boolean };

function toUnits(tokens: string[], claimed: boolean[]): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i] as string;
    let text = t;
    let to = i + 1;
    if (t === 'chủ' && tokens[i + 1] === 'nhật') {
      text = 'chủ nhật';
      to = i + 2;
    } else if (t === 'ngày' && tokens[i + 1] === 'làm' && tokens[i + 2] === 'việc') {
      text = 'ngày làm việc';
      to = i + 3;
    }
    const numericDate = NUMERIC_DATE.test(text);
    let kind: Kind = 'other';
    if (DATE_ANCHORS.has(text) || numericDate) kind = 'anchor';
    else if (DATE_NUMBER_WORDS.has(text) || isDigits(text)) kind = 'number';
    else if (DATE_SOFT.has(text)) kind = 'soft';
    // Tiếng đã là tiền, hoặc là tên người đứng sau tiếng xưng hô: cắt đoạn ở đây.
    let broken = false;
    for (let k = i; k < to; k++) if (claimed[k]) broken = true;
    if (NAME_LIKE_DATE_WORDS.has(text) && HONORIFICS.has(tokens[i - 1] ?? '')) broken = true;
    units.push({ text, kind: broken ? 'other' : kind, numericDate: numericDate && !broken });
    i = to;
  }
  return units;
}

/** Các ngày (YYYY-MM-DD) trong câu theo mốc `now` và lịch làm việc, theo thứ tự xuất hiện. */
export function extractDates(text: string, now: Date, calendar: WorkCalendar = DEFAULT_CALENDAR): string[] {
  const tokens = tokenize(text);
  const claimed: boolean[] = tokens.map(() => false);
  for (const span of findMoney(tokens)) for (let k = span.from; k < span.to; k++) claimed[k] = true;
  const units = toUnits(tokens, claimed);

  const out: string[] = [];
  let i = 0;
  while (i < units.length) {
    if ((units[i] as Unit).kind === 'other') {
      i += 1;
      continue;
    }
    let end = i;
    while (end < units.length && (units[end] as Unit).kind !== 'other') end += 1;
    const run = units.slice(i, end);
    const date = resolveRun(run, now, calendar);
    if (date) out.push(date);
    i = end;
  }
  return out;
}

/** Một đơn vị đứng một mình vẫn đủ nghĩa là ngày, không thể nhầm với từ thường hay tên người. */
const isSelfSufficient = (u: Unit): boolean => u.numericDate || u.text === 'chủ nhật';

/**
 * Đọc một đoạn liên tiếp các từ chỉ ngày. Thử cụm dài nhất trước; mọi cụm thử đều phải chứa trọn các số của đoạn
 * (chỉ được bỏ từ chỉ ngày và từ đệm ở hai rìa), nên không thể "tụt" về một cụm ngắn hơn mà bỏ rơi số bị nghe sai.
 */
function resolveRun(run: Unit[], now: Date, calendar: WorkCalendar): string | null {
  if (!run.some((u) => u.kind === 'anchor')) return null;
  const numericIdx = run.flatMap((u, idx) => (u.kind === 'number' || u.numericDate ? [idx] : []));
  const mustStartBy = numericIdx.length > 0 ? (numericIdx[0] as number) : run.length - 1;
  const mustEndAt = numericIdx.length > 0 ? (numericIdx[numericIdx.length - 1] as number) : 0;
  for (let a = 0; a <= mustStartBy; a++) {
    for (let b = run.length - 1; b >= Math.max(a, mustEndAt); b--) {
      const window = run.slice(a, b + 1);
      if (!window.some((u) => u.kind === 'anchor')) continue;
      // Một chữ đơn lẻ ("mai", "nay") dễ là tên người hoặc từ thường; chỉ nhận cụm từ hai chữ trở lên, dạng số 7/10, hoặc "chủ nhật".
      if (window.length < 2 && !isSelfSufficient(window[0] as Unit)) continue;
      const resolved = resolveDate(window.map((u) => u.text).join(' '), now, calendar);
      if (resolved) return resolved.date;
    }
  }
  return null;
}
