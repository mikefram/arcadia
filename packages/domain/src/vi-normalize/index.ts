/**
 * Chuẩn hoá tiếng Việt bằng mã, không để LLM tự làm (SPEC 6.6, 6.8). Mọi hàm ở đây là hàm thuần.
 *
 * - Chữ: `stripDiacritics`, `normalizeText`.
 * - Số và tiền nói miệng: `parseNumber`, `parseMoney`.
 * - Ngày nói miệng: `resolveDate` (tool `resolve_date`).
 * - Viết tắt: `expandAbbrev`.
 * - Tìm người theo cách gọi: `matchPerson` (không bao giờ chọn thay người dùng khi trùng tên).
 * - Xác nhận bằng giọng với tập câu đóng: `normalizeVoiceCommand`, `matchVoiceConfirm`.
 * - Che dữ liệu cá nhân trước mọi lệnh gọi ra ngoài: `redact`.
 */
import { VOICE_CONFIRM_PHRASES, VOICE_REJECT_PHRASES } from '../api/proposals';
import type { WorkCalendar } from '../engine';
import { formatLunar } from '../lunar';

// ───────────────────────── Chữ ─────────────────────────

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Bỏ dấu tiếng Việt, giữ nguyên hoa thường: "Nguyễn Thị Đào" → "Nguyen Thi Dao". Nhận cả NFC và NFD. */
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/** Chuẩn hoá để so sánh: Unicode dựng sẵn (NFC), chữ thường, gọn khoảng trắng. Giữ dấu. */
export function normalizeText(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const hasDiacritics = (token: string) => stripDiacritics(token) !== token;

// ───────────────────────── Số và tiền ─────────────────────────

type NumToken =
  | { t: 'digit'; v: number; word: boolean }
  /** `kind`: 'ten' là "mười" (đúng 10), 'tens' là "mươi" (hàng chục), 'either' khi gõ không dấu */
  | { t: 'ten'; kind: 'ten' | 'tens' | 'either' }
  | { t: 'chuc' }
  | { t: 'tram' }
  | { t: 'scale'; v: number }
  | { t: 'linh' }
  | { t: 'ruoi' }
  | { t: 'currency' }
  | { t: 'chan' };

const digit = (v: number): NumToken => ({ t: 'digit', v, word: true });

/** Từ có dấu. Dạng không dấu được suy ra bên dưới và chỉ khớp với tiếng gõ không dấu. */
const NUMBER_WORDS: Record<string, NumToken> = {
  không: digit(0),
  một: digit(1),
  mốt: digit(1),
  hai: digit(2),
  ba: digit(3),
  bốn: digit(4),
  tư: digit(4),
  năm: digit(5),
  lăm: digit(5),
  nhăm: digit(5),
  sáu: digit(6),
  bảy: digit(7),
  bẩy: digit(7),
  tám: digit(8),
  chín: digit(9),
  mười: { t: 'ten', kind: 'ten' },
  mươi: { t: 'ten', kind: 'tens' },
  chục: { t: 'chuc' },
  trăm: { t: 'tram' },
  nghìn: { t: 'scale', v: 1e3 },
  ngàn: { t: 'scale', v: 1e3 },
  ngìn: { t: 'scale', v: 1e3 },
  k: { t: 'scale', v: 1e3 },
  triệu: { t: 'scale', v: 1e6 },
  tr: { t: 'scale', v: 1e6 },
  tỷ: { t: 'scale', v: 1e9 },
  tỉ: { t: 'scale', v: 1e9 },
  linh: { t: 'linh' },
  lẻ: { t: 'linh' },
  rưỡi: { t: 'ruoi' },
  rưởi: { t: 'ruoi' },
  đồng: { t: 'currency' },
  đ: { t: 'currency' },
  vnđ: { t: 'currency' },
  vnd: { t: 'currency' },
  chẵn: { t: 'chan' },
};

const NUMBER_WORDS_PLAIN: Record<string, NumToken> = (() => {
  const out: Record<string, NumToken> = {};
  for (const [word, tok] of Object.entries(NUMBER_WORDS)) {
    const plain = stripDiacritics(word);
    // "mười" và "mươi" trùng nhau khi bỏ dấu: phân biệt bằng vị trí.
    out[plain] = tok.t === 'ten' ? { t: 'ten', kind: 'either' } : tok;
  }
  return out;
})();

function lookupNumberWord(token: string): NumToken | undefined {
  const exact = NUMBER_WORDS[token];
  if (exact) return exact;
  return hasDiacritics(token) ? undefined : NUMBER_WORDS_PLAIN[token];
}

/** "20", "1.500", "20.000.000", "1,5", "1.5", "1.234,5". Nhóm ba chữ số sau dấu là dấu ngăn nghìn. */
function parseNumeral(tok: string): number | null {
  if (/^\d+$/.test(tok)) return Number(tok);
  if (/^\d{1,3}(\.\d{3})+$/.test(tok)) return Number(tok.replace(/\./g, ''));
  if (/^\d{1,3}(,\d{3})+$/.test(tok)) return Number(tok.replace(/,/g, ''));
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(tok)) return Number(tok.replace(/\./g, '').replace(',', '.'));
  if (/^\d+[.,]\d+$/.test(tok)) return Number(tok.replace(',', '.'));
  return null;
}

function tokenizeNumber(text: string): NumToken[] | null {
  const cleaned = normalizeText(text)
    .replace(/[“”"'‘’()]/g, ' ')
    .replace(/[.,;!?…]+$/g, '')
    .trim();
  if (!cleaned) return null;
  const out: NumToken[] = [];
  const re = /\d+(?:[.,]\d+)*|\p{L}+|\S/gu;
  for (const m of cleaned.matchAll(re)) {
    const raw = m[0];
    if (/^\d/.test(raw)) {
      const v = parseNumeral(raw);
      if (v === null) return null;
      out.push({ t: 'digit', v, word: false });
      continue;
    }
    const tok = lookupNumberWord(raw);
    if (!tok) return null;
    out.push(tok);
  }
  return out.length ? out : null;
}

const isSmallInt = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/**
 * Bộ đọc số tiếng Việt. Hiểu cả cách nói tắt: "hai lăm" (25), "hai chục" (20), "một trăm hai" (120),
 * "một triệu hai" (1.200.000), "rưỡi" (nửa của đơn vị liền trước).
 * `money`: cho phép "đồng" ở cuối và áp cách nói tiền "một triệu hai trăm" = 1.200.000.
 */
function evalNumber(tokens: NumToken[], money: boolean): number | null {
  const segments: { value: number; scale: number }[] = [];
  let group = 0;
  let hasGroup = false;
  let hundredsDone = false;
  let tensDone = false;
  let unitsDone = false;
  let exactMarker = false; // có "linh", "lẻ" hoặc "không trăm": người nói đang đọc đủ từng hàng
  let pending: { v: number; word: boolean; after: 'tram' | 'scale' | null } | null = null;
  let last: 'digit' | 'ten' | 'chuc' | 'tram' | 'scale' | 'linh' | 'ruoi' | null = null;
  let lastScale = 0;
  let extra = 0;
  let closed = false;
  let sawNumber = false;
  let currencySeen = false;
  let ended = false;

  for (const tok of tokens) {
    if (ended) return null;
    if (tok.t === 'chan') {
      if (!money || !sawNumber) return null;
      ended = true;
      continue;
    }
    if (currencySeen) return null;
    switch (tok.t) {
      case 'currency':
        if (!money || !sawNumber) return null;
        currencySeen = true;
        continue;
      case 'digit': {
        if (closed) return null;
        if (pending) {
          // "hai lăm", "ba tư", "hai mốt": hai chữ số liền nhau là hàng chục và hàng đơn vị.
          const ok = tok.word && pending.word && isSmallInt(pending.v, 2, 9) && isSmallInt(tok.v, 1, 9) && !tensDone && last !== 'linh';
          if (!ok) return null;
          group += pending.v * 10 + tok.v;
          pending = null;
          tensDone = true;
          unitsDone = true;
          hasGroup = true;
        } else {
          if (unitsDone) return null;
          if (!tok.word && (hasGroup || last === 'linh')) {
            // Chữ số sau "trăm": "2 trăm 50" là 250. Các kiểu trộn khác thì không đoán.
            if (last !== 'tram' || !isSmallInt(tok.v, 1, 99)) return null;
            if (tok.v >= 10) {
              group += tok.v;
              tensDone = true;
              unitsDone = true;
              last = 'digit';
              break;
            }
          }
          pending = { v: tok.v, word: tok.word, after: last === 'tram' ? 'tram' : last === 'scale' ? 'scale' : null };
        }
        last = 'digit';
        break;
      }
      case 'ten': {
        if (closed || tensDone || unitsDone) return null;
        if (pending) {
          if (tok.kind === 'ten' || !isSmallInt(pending.v, 1, 9)) return null;
          group += pending.v * 10;
          pending = null;
        } else {
          if (tok.kind === 'tens') return null;
          group += 10;
        }
        tensDone = true;
        hasGroup = true;
        last = 'ten';
        break;
      }
      case 'chuc': {
        if (closed || tensDone || unitsDone || !pending || !isSmallInt(pending.v, 1, 9)) return null;
        group += pending.v * 10;
        pending = null;
        tensDone = true;
        hasGroup = true;
        last = 'chuc';
        break;
      }
      case 'tram': {
        if (closed || hundredsDone || tensDone || unitsDone) return null;
        if (pending) {
          if (!isSmallInt(pending.v, 0, 9)) return null;
          if (pending.v === 0) exactMarker = true;
          group += pending.v * 100;
          pending = null;
        } else if (!sawNumber) {
          group += 100; // "trăm rưỡi", "trăm hai": ngầm hiểu "một trăm"
        } else {
          return null;
        }
        hundredsDone = true;
        hasGroup = true;
        last = 'tram';
        break;
      }
      case 'linh': {
        if (closed || pending || tensDone || unitsDone) return null;
        if (!hundredsDone && segments.length === 0) return null;
        tensDone = true;
        exactMarker = true;
        last = 'linh';
        break;
      }
      case 'ruoi': {
        if (closed) return null;
        if (pending) {
          if (pending.after) return null;
          group += pending.v + 0.5;
          pending = null;
          hasGroup = true;
        } else if (last === 'tram') {
          group += 50;
        } else if (last === 'chuc' || last === 'ten') {
          group += 5;
        } else if (last === 'scale') {
          extra += lastScale / 2;
        } else {
          return null;
        }
        tensDone = true;
        unitsDone = true;
        closed = true;
        last = 'ruoi';
        break;
      }
      case 'scale': {
        if (pending) {
          group += pending.v;
          pending = null;
          hasGroup = true;
        }
        let value = group;
        if (!hasGroup) {
          const prev = segments[segments.length - 1];
          if (!sawNumber) value = 1; // "triệu rưỡi", "nghìn hai": ngầm hiểu "một"
          else if (!(prev && prev.scale < tok.v)) return null;
        }
        // "hai trăm nghìn tỷ", "một nghìn rưỡi tỷ": đơn vị lớn hơn nhân cả phần đứng trước.
        while (segments.length > 0 && (segments[segments.length - 1] as { scale: number }).scale < tok.v) {
          const seg = segments.pop() as { value: number; scale: number };
          value += seg.value * seg.scale;
        }
        if (extra > 0 && lastScale < tok.v) {
          value += extra;
          extra = 0;
        }
        const top = segments[segments.length - 1];
        if (top && top.scale === tok.v) return null;
        segments.push({ value, scale: tok.v });
        group = 0;
        hasGroup = false;
        hundredsDone = false;
        tensDone = false;
        unitsDone = false;
        closed = false;
        exactMarker = false;
        last = 'scale';
        lastScale = tok.v;
        break;
      }
    }
    sawNumber = true;
  }

  if (!sawNumber) return null;

  let shorthand = false;
  if (pending) {
    const single = isSmallInt(pending.v, 1, 9);
    if (pending.after === 'tram' && single) {
      group += pending.v * 10; // "một trăm hai" = 120
      shorthand = true;
    } else if (pending.after === 'scale' && single && segments.length > 0) {
      extra += (pending.v * lastScale) / 10; // "một triệu hai" = 1.200.000
      shorthand = true;
    } else {
      group += pending.v;
    }
    hasGroup = true;
  }

  let total = extra;
  for (const seg of segments) total += seg.value * seg.scale;
  const lastSeg = segments[segments.length - 1];
  if (money && lastSeg && lastSeg.scale >= 1e6 && hasGroup && !shorthand && !exactMarker && group >= 1 && group < 1000) {
    // Cách nói tiền: "một triệu hai trăm" là 1.200.000, không phải 1.000.200. [GIẢ ĐỊNH] theo thói quen nói miền Bắc.
    total += group * (lastSeg.scale / 1000);
  } else {
    total += group;
  }
  return Number.isFinite(total) ? total : null;
}

/**
 * Đọc một số nói miệng hoặc viết bằng chữ số: "hai mươi lăm" → 25, "hai lăm" → 25, "một nghìn rưỡi" → 1500.
 * Cả câu phải là số; có tiếng lạ thì trả null (không đoán).
 */
export function parseNumber(text: string): number | null {
  const tokens = tokenizeNumber(text);
  if (!tokens) return null;
  const value = evalNumber(tokens, false);
  if (value === null) return null;
  return Number.isInteger(value) ? value : Math.round(value * 1000) / 1000;
}

/**
 * Đọc số tiền thành VND số nguyên: "hai chục triệu", "20 triệu", "hai mươi tr" → 20000000;
 * "hai trăm rưỡi nghìn" → 250000; "1,5 tỷ", "500k", "hai tỷ rưỡi". Không ra số nguyên không âm thì trả null.
 */
export function parseMoney(text: string): number | null {
  const tokens = tokenizeNumber(text);
  if (!tokens) return null;
  const value = evalNumber(tokens, true);
  if (value === null || value < 0) return null;
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > 1e-6 || !Number.isSafeInteger(rounded)) return null;
  return rounded;
}

// ───────────────────────── Ngày nói miệng ─────────────────────────

export type ResolvedDate = {
  /** ngày dương 'YYYY-MM-DD' theo giờ của lịch */
  date: string;
  /** "Thứ Hai" … "Chủ Nhật" */
  weekday: string;
  /** ngày âm viết đủ, ví dụ "mùng 6 tháng 9 âm lịch" */
  lunarLabel: string;
  /** theo tuần làm việc và bảng ngày nghỉ của tổ chức */
  isWorkingDay: boolean;
};

const DAY_MS = 86_400_000;
/** Chỉ số theo ISO: 1 = Thứ Hai … 7 = Chủ Nhật. */
const WEEKDAY_LABELS = ['', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật'] as const;

const dayIndex = (y: number, m: number, d: number): number | null => {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / DAY_MS);
};
const dayKey = (idx: number) => new Date(idx * DAY_MS).toISOString().slice(0, 10);
const ymdOf = (idx: number) => {
  const d = new Date(idx * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
/** 1970-01-01 là Thứ Năm (ISO 4). */
const isoWeekday = (idx: number) => ((((idx + 3) % 7) + 7) % 7) + 1;

/**
 * Ngày làm việc theo thứ, `cal.workdays` và `cal.holidays`. Cùng quy ước với module calendar:
 * `makeup_workday` biến ngày cuối tuần thành ngày làm; nếu một ngày có cả hai loại thì ngày nghỉ thắng.
 */
function isWorkingIdx(idx: number, cal: WorkCalendar): boolean {
  const key = dayKey(idx);
  let makeup = false;
  for (const h of cal.holidays) {
    if (h.day !== key) continue;
    if (h.kind === 'makeup_workday') makeup = true;
    else return false;
  }
  return makeup || cal.workdays.includes(isoWeekday(idx));
}

const WEEKDAY_WORDS: Record<string, number> = {
  hai: 1,
  ba: 2,
  tu: 3,
  nam: 4,
  sau: 5,
  sau6: 5,
  bay: 6,
  '2': 1,
  '3': 2,
  '4': 3,
  '5': 4,
  '6': 5,
  '7': 6,
};
const WD = '(?:thu (hai|ba|tu|nam|sau6|sau|bay|[2-7])|t([2-7])|(chu nhat|cn))';

function weekdayFromMatch(a: string | undefined, b: string | undefined, c: string | undefined): number {
  if (c) return 7;
  return WEEKDAY_WORDS[(a ?? b) as string] as number;
}

/** Số trong câu chỉ ngày: chữ số hoặc chữ ("15", "muoi lam"). */
function smallNumber(text: string): number | null {
  const v = parseNumber(text.replace(/sau6/g, 'sau'));
  return v !== null && Number.isInteger(v) ? v : null;
}

/** Ngày làm việc đầu tiên (dir = 1) hoặc cuối cùng (dir = −1) trong khoảng [from, to]. */
function edgeWorkingDay(from: number, to: number, dir: 1 | -1, cal: WorkCalendar): number | null {
  for (let i = dir === 1 ? from : to; i >= from && i <= to; i += dir) {
    if (isWorkingIdx(i, cal)) return i;
  }
  return null;
}

const monthRange = (y: number, m: number): [number, number] => {
  const first = Math.round(Date.UTC(y, m - 1, 1) / DAY_MS);
  const last = Math.round(Date.UTC(y, m, 0) / DAY_MS);
  return [first, last];
};

/** "nay" → 0, "sau"/"toi" → 1, "sau nua" → 2, "truoc"/"roi"/"vua roi"/"vua qua" → −1. */
function relativeOffset(word: string | undefined): number | null {
  if (!word || word === 'nay') return 0;
  if (word === 'sau' || word === 'toi' || word === 'ke tiep') return 1;
  if (word === 'sau nua' || word === 'toi nua') return 2;
  if (word === 'truoc' || word === 'roi' || word === 'vua roi' || word === 'vua qua') return -1;
  return null;
}
const REL = '(nay|sau nua|toi nua|sau|toi|ke tiep|truoc|vua roi|vua qua|roi)';

function resolveIndex(phrase: string, today: number, cal: WorkCalendar): number | null {
  const norm = normalizeText(phrase);
  // "tháng sáu" (tháng 6) và "tháng sau" (tháng tới) trùng nhau khi bỏ dấu: đánh dấu "sáu" trước khi bỏ dấu.
  let p = stripDiacritics(norm.replace(/(?<!\p{L})sáu(?!\p{L})/gu, 'sau6'))
    .replace(/[,;!?“”"'‘’()]/g, ' ')
    .replace(/\.+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!p || /\bam lich\b/.test(p)) return null;
  // Gõ hoàn toàn không dấu thì "thang sau" không phân biệt được tháng 6 với tháng tới: không đoán.
  if (!hasDiacritics(norm) && /\bthang sau\b/.test(p)) return null;

  // Bỏ giờ trong ngày và tiếng đệm: chỉ quan tâm ngày.
  p = p
    .replace(/\b(?:luc |vao luc )?\d{1,2}(?:h|:| gio ?)(?:\d{1,2})?(?: phut)?(?: ruoi)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 4; i += 1) {
    const next = p.replace(/^(?:vao|trong|den|cho den|truoc|han la|han|la|buoi|sang|trua|chieu|toi|dem) /, '');
    if (next === p) break;
    p = next;
  }
  if (!p) return null;

  const { y: curY, m: curM, d: curD } = ymdOf(today);
  const monday = today - (isoWeekday(today) - 1);
  let m: RegExpExecArray | null;

  // Ngày tương đối
  if (/^(?:hom nay|bua nay|nay)$/.test(p)) return today;
  if (/^(?:ngay mai|mai|hom sau)$/.test(p)) return today + 1;
  if (/^(?:ngay kia|kia)$/.test(p)) return today + (norm.includes('kìa') ? 3 : 2);
  if (/^(?:ngay mot|mot)$/.test(p) && !norm.includes('một')) return today + 2;
  if (/^(?:hom qua|qua)$/.test(p)) return today - 1;
  if (p === 'hom kia') return today - (norm.includes('kìa') ? 3 : 2);

  // "3 ngày nữa", "hai tuần nữa", "5 ngày làm việc nữa", "sau 3 ngày"
  m = /^(.+?) (ngay lam viec|ngay|hom|tuan) nua$/.exec(p) ?? /^sau (.+?) (ngay lam viec|ngay|hom|tuan)$/.exec(p);
  if (m) {
    const n = smallNumber(m[1] as string);
    if (n === null || n < 0 || n > 3660) return null;
    if (m[2] === 'tuan') return today + 7 * n;
    if (m[2] !== 'ngay lam viec') return today + n;
    let idx = today;
    let left = n;
    let guard = 0;
    while (left > 0) {
      idx += 1;
      if (isWorkingIdx(idx, cal)) left -= 1;
      guard += 1;
      if (guard > 36600) return null;
    }
    return idx;
  }

  // Thứ trong tuần
  m = new RegExp(`^${WD}(?: tuan ${REL}| ${REL})?$`).exec(p);
  if (m) {
    const wd = weekdayFromMatch(m[1], m[2], m[3]);
    const weekRel = m[4];
    const bareRel = m[5];
    if (weekRel) {
      const off = relativeOffset(weekRel);
      return off === null ? null : monday + 7 * off + (wd - 1);
    }
    const ahead = (wd - isoWeekday(today) + 7) % 7;
    const off = relativeOffset(bareRel);
    if (off === null) return null;
    if (off === 0) return today + ahead; // "thứ Năm", "thứ Năm này": lần gần nhất, tính cả hôm nay
    if (off > 0) return today + (ahead === 0 ? 7 : ahead) + 7 * (off - 1); // "thứ Hai tới": sau hôm nay
    return today - (((isoWeekday(today) - wd + 7) % 7) || 7); // "thứ Hai vừa rồi": trước hôm nay
  }

  // Đầu, cuối tuần, tháng, năm: lấy ngày làm việc đầu tiên hoặc cuối cùng của khoảng (SPEC 4.5)
  m = new RegExp(`^(dau|cuoi) (tuan|thang|nam)(?: ${REL})?$`).exec(p);
  if (m) {
    const dir = m[1] === 'dau' ? 1 : -1;
    const off = relativeOffset(m[3]);
    if (off === null) return null;
    if (m[2] === 'tuan') return edgeWorkingDay(monday + 7 * off, monday + 7 * off + 6, dir, cal);
    if (m[2] === 'thang') {
      const [from, to] = monthRange(curY, curM + off);
      return edgeWorkingDay(from, to, dir, cal);
    }
    const from = dayIndex(curY + off, 1, 1);
    const to = dayIndex(curY + off, 12, 31);
    return from === null || to === null ? null : edgeWorkingDay(from, to, dir, cal);
  }
  m = /^(dau|cuoi) thang (.+)$/.exec(p);
  if (m) {
    const month = smallNumber(m[2] as string);
    if (month === null || month < 1 || month > 12) return null;
    const year = month < curM ? curY + 1 : curY;
    const [from, to] = monthRange(year, month);
    return edgeWorkingDay(from, to, m[1] === 'dau' ? 1 : -1, cal);
  }

  // Ngày viết rõ. Có thứ đứng trước ("thứ Năm 15/10") thì thứ phải khớp, không khớp thì không đoán.
  let expectWeekday: number | null = null;
  m = new RegExp(`^${WD} (?=\\S)`).exec(p);
  if (m) {
    expectWeekday = weekdayFromMatch(m[1], m[2], m[3]);
    p = p.slice(m[0].length);
  }
  const explicit = resolveExplicit(p, today, curY, curM, curD);
  if (explicit === null) return null;
  if (expectWeekday !== null && isoWeekday(explicit) !== expectWeekday) return null;
  return explicit;
}

/** Ngày đầu tiên không trước hôm nay khi thiếu năm: năm nay, nếu đã qua thì năm sau. */
function nextOccurrence(day: number, month: number, today: number, curY: number): number | null {
  for (let y = curY; y <= curY + 8; y += 1) {
    const idx = dayIndex(y, month, day);
    if (idx !== null && idx >= today) return idx;
  }
  return null;
}

function resolveExplicit(p: string, today: number, curY: number, curM: number, curD: number): number | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(p);
  if (m) return dayIndex(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(?:ngay )?(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?$/.exec(p);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (m[3] === undefined) return nextOccurrence(d, mo, today, curY);
    const y = Number(m[3]);
    return dayIndex(m[3].length === 2 ? 2000 + y : y, mo, d);
  }

  m = /^(?:ngay )?(?:mung |mong )?(.+?) thang (.+?)(?: nam (.+))?$/.exec(p);
  if (m) {
    const d = smallNumber(m[1] as string);
    if (d === null) return null;
    const monthText = m[2] as string;
    const yearText = m[3];
    const monthRel = relativeOffset(monthText);
    if (monthRel !== null && monthText !== '') {
      if (yearText !== undefined) return null;
      const base = new Date(Date.UTC(curY, curM - 1 + monthRel, 1));
      return dayIndex(base.getUTCFullYear(), base.getUTCMonth() + 1, d);
    }
    const mo = smallNumber(monthText);
    if (mo === null) return null;
    if (yearText === undefined) return nextOccurrence(d, mo, today, curY);
    const yearRel = relativeOffset(yearText);
    if (yearRel !== null) return dayIndex(curY + yearRel, mo, d);
    const y = smallNumber(yearText);
    return y === null ? null : dayIndex(y, mo, d);
  }

  // Chỉ có ngày: "ngày 15", "mùng 5" → tháng này nếu chưa qua, không thì tháng sau.
  m = /^(?:ngay mung|ngay mong|ngay|mung|mong) (.+)$/.exec(p);
  if (m) {
    const d = smallNumber(m[1] as string);
    if (d === null || d < 1 || d > 31) return null;
    for (let i = d >= curD ? 0 : 1; i <= 12; i += 1) {
      const base = new Date(Date.UTC(curY, curM - 1 + i, 1));
      const idx = dayIndex(base.getUTCFullYear(), base.getUTCMonth() + 1, d);
      if (idx !== null) return idx;
    }
  }
  return null;
}

/**
 * Đổi cách nói ngày thành ngày cụ thể kèm thứ, ngày âm và cờ ngày làm việc (tool `resolve_date`).
 * Hiểu: "hôm nay", "ngày mai", "ngày kia", "thứ Năm tuần sau", "thứ hai tới", "cuối tuần này",
 * "đầu tháng sau", "mười lăm tháng mười", "15/10", "ngày 20 tháng sau", "3 ngày nữa"…
 * Câu mơ hồ ("tuần sau", "tháng sau") hoặc không hiểu thì trả null để trợ lý hỏi lại, không đoán.
 *
 * Quy ước [GIẢ ĐỊNH]:
 * - Tuần tính từ Thứ Hai đến Chủ Nhật. "Thứ Năm" trống không là Thứ Năm gần nhất, tính cả hôm nay.
 * - "Cuối tuần này", "cuối tháng" là ngày làm việc cuối cùng của khoảng đó; "đầu tuần", "đầu tháng" là ngày làm việc đầu tiên.
 * - Thiếu năm thì lấy lần gần nhất chưa qua ("15/1" nói vào tháng 10 là 15/1 năm sau).
 * - Ngày âm lịch không nhận làm đầu vào: lịch âm chỉ để hiển thị (SPEC 4.5).
 */
export function resolveDate(phrase: string, now: Date, cal: WorkCalendar): ResolvedDate | null {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) return null;
  const today = Math.floor((nowMs + cal.utcOffsetMinutes * 60_000) / DAY_MS);
  const idx = resolveIndex(phrase, today, cal);
  if (idx === null) return null;
  const date = dayKey(idx);
  const year = Number(date.slice(0, 4));
  if (year < 1900 || year > 2100) return null;
  return {
    date,
    weekday: WEEKDAY_LABELS[isoWeekday(idx)] as string,
    lunarLabel: formatLunar(date),
    isWorkingDay: isWorkingIdx(idx, cal),
  };
}

// ───────────────────────── Viết tắt ─────────────────────────

/**
 * Từ điển viết tắt mặc định. [GIẢ ĐỊNH] theo cách dùng trong văn phòng của MIHATO và VRG;
 * mỗi tổ chức bổ sung hoặc ghi đè qua tham số `extra` (khối "theo tổ chức" của lời nhắc, SPEC 6.6).
 * Chỉ đưa vào các chữ ít gây hiểu nhầm.
 */
export const DEFAULT_ABBREVIATIONS: Readonly<Record<string, string>> = {
  CT: 'chủ tịch',
  PCT: 'phó chủ tịch',
  HĐQT: 'hội đồng quản trị',
  HĐTV: 'hội đồng thành viên',
  BKS: 'ban kiểm soát',
  TGĐ: 'tổng giám đốc',
  PTGĐ: 'phó tổng giám đốc',
  GĐ: 'giám đốc',
  PGĐ: 'phó giám đốc',
  BGĐ: 'ban giám đốc',
  TP: 'trưởng phòng',
  PP: 'phó phòng',
  VP: 'văn phòng',
  CVP: 'chánh văn phòng',
  VPCT: 'văn phòng chủ tịch',
  KTT: 'kế toán trưởng',
  KD: 'kinh doanh',
  HCNS: 'hành chính nhân sự',
  TCKT: 'tài chính kế toán',
  CNTT: 'công nghệ thông tin',
  NV: 'nhân viên',
  CBNV: 'cán bộ nhân viên',
  QĐ: 'quyết định',
  KCN: 'khu công nghiệp',
  CCN: 'cụm công nghiệp',
  KCX: 'khu chế xuất',
  UBND: 'ủy ban nhân dân',
  TNHH: 'trách nhiệm hữu hạn',
  CTCP: 'công ty cổ phần',
  DN: 'doanh nghiệp',
  BHXH: 'bảo hiểm xã hội',
  GTGT: 'giá trị gia tăng',
  HCM: 'Hồ Chí Minh',
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "TP" đứng trước tên thành phố là "thành phố", không phải "trưởng phòng". */
const CITY_PREFIX =
  /(?<![\p{L}\p{N}_])TP\.?\s*(?=(?:HCM|Hồ Chí Minh|Hà Nội|Đà Nẵng|Hải Phòng|Cần Thơ|Huế|Thủ Đức|Biên Hòa|Vũng Tàu|Nha Trang|Đà Lạt)(?![\p{L}\p{N}]))/giu;

function buildAbbrevMatcher(dict: Record<string, string>): { re: RegExp; map: Map<string, string> } | null {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(dict)) {
    const k = key.normalize('NFC').trim().toUpperCase();
    if (k) map.set(k, value);
  }
  for (const [k, v] of map) if (v === '') map.delete(k);
  if (map.size === 0) return null;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  // Khớp nguyên từ; không đụng vào mã có gạch nối hoặc gạch chéo ("12/QĐ-CT", "CT-0012").
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?<![\\p{L}\\p{N}][-/])(?:${keys.join('|')})(?![\\p{L}\\p{N}_])(?![-/][\\p{L}\\p{N}])`, 'giu');
  return { re, map };
}

const DEFAULT_ABBREV_MATCHER = buildAbbrevMatcher(DEFAULT_ABBREVIATIONS);

/**
 * Mở viết tắt thành chữ đầy đủ: "PGĐ" → "phó giám đốc", "KCN" → "khu công nghiệp".
 * Khớp nguyên từ, không phân biệt hoa thường. `extra` bổ sung hoặc ghi đè từ điển mặc định;
 * giá trị rỗng nghĩa là tắt mục đó.
 */
export function expandAbbrev(text: string, extra: Record<string, string> = {}): string {
  const matcher = Object.keys(extra).length === 0 ? DEFAULT_ABBREV_MATCHER : buildAbbrevMatcher({ ...DEFAULT_ABBREVIATIONS, ...upperKeys(extra) });
  let out = text.normalize('NFC').replace(CITY_PREFIX, 'thành phố ');
  if (!matcher) return out;
  out = out.replace(matcher.re, (found) => matcher.map.get(found.toUpperCase()) ?? found);
  return out;
}

function upperKeys(dict: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dict)) out[k.normalize('NFC').trim().toUpperCase()] = v;
  return out;
}

// ───────────────────────── Tìm người ─────────────────────────

export type PersonCandidate = {
  id: string;
  fullName: string;
  givenName: string;
  /** mã lưu ở CSDL ('anh', 'chi', 'ong', 'ba', 'co', 'chu', 'bac') hoặc chữ có dấu ("chị") */
  honorific: string | null;
  unitName?: string | null;
};

export type PersonMatch = { id: string; score: number };

const HONORIFIC_WORDS = new Set(['anh', 'chị', 'ông', 'bà', 'cô', 'chú', 'bác']);
const HONORIFIC_PLAIN = new Set(['anh', 'chi', 'ong', 'ba', 'co', 'chu', 'bac']);
const FEMALE = new Set(['chi', 'ba', 'co']);
const MALE = new Set(['anh', 'ong', 'chu']);
/** Cách gọi của người lớn tuổi với người dưới: không cho biết xưng hô lưu trong hồ sơ. */
const NEUTRAL_ADDRESS = new Set(['em', 'cháu', 'chau', 'bạn', 'đồng chí']);
/** Tiếng đệm quanh tên đơn vị và chức vụ: không tính là tiếng lạc. */
const PERSON_FILLER = new Set(['phong', 'ban', 'bo', 'phan', 'ben', 'o', 'cua', 'to', 'doi', 'khoi', 'truong', 'pho', 'nhan', 'vien', 'giam', 'doc', 'tong']);

const wordsOf = (s: string) =>
  normalizeText(s)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(' ')
    .filter(Boolean);

/** Độ giống của một tiếng trong câu hỏi với một tiếng trong tên. */
function syllableSim(queryTok: string, nameTok: string): number {
  if (queryTok === nameTok) return 1;
  if (stripDiacritics(queryTok) !== stripDiacritics(nameTok)) return 0;
  // Gõ không dấu thì coi như gần khớp; có dấu mà khác dấu ("Lân" với "Lan") là tên khác, chỉ giữ làm ứng viên yếu.
  return hasDiacritics(queryTok) ? 0.6 : 0.9;
}

function queryHonorific(token: string): string | null {
  if (HONORIFIC_WORDS.has(token)) return stripDiacritics(token);
  if (!hasDiacritics(token) && HONORIFIC_PLAIN.has(token)) return token;
  return null;
}

function scorePerson(honorific: string | null, tokens: string[], person: PersonCandidate): number {
  const nameToks = wordsOf(person.fullName);
  let givenToks = wordsOf(person.givenName);
  if (givenToks.length === 0) givenToks = nameToks.slice(-1);
  if (givenToks.length === 0) return 0;
  const unitToks = person.unitName ? wordsOf(person.unitName).map(stripDiacritics) : [];

  // Các tiếng của họ tên không thuộc tên gọi (họ và tên đệm).
  const otherToks = [...nameToks];
  for (const g of givenToks) {
    const at = otherToks.lastIndexOf(g);
    if (at >= 0) otherToks.splice(at, 1);
  }

  const givenSim: number[] = givenToks.map(() => 0);
  const otherUsed = otherToks.map(() => false);
  let otherCount = 0;
  let otherSimSum = 0;
  let unitHits = 0;
  let stray = 0;
  let givenSeen = false;

  for (const qt of tokens) {
    let bestGiven = -1;
    let bestGivenSim = 0;
    givenToks.forEach((g, i) => {
      const s = syllableSim(qt, g);
      if (givenSim[i] === 0 && s > bestGivenSim) {
        bestGiven = i;
        bestGivenSim = s;
      }
    });
    if (bestGiven >= 0) {
      givenSim[bestGiven] = bestGivenSim;
      givenSeen = true;
      continue;
    }
    let bestOther = -1;
    let bestOtherSim = 0;
    // Tên gọi đứng cuối họ tên: họ và tên đệm phải được nói TRƯỚC tên gọi ("anh Lan" không phải "Lan Anh").
    if (!givenSeen) otherToks.forEach((o, i) => {
      const s = syllableSim(qt, o);
      if (!otherUsed[i] && s > bestOtherSim) {
        bestOther = i;
        bestOtherSim = s;
      }
    });
    if (bestOther >= 0) {
      otherUsed[bestOther] = true;
      otherCount += 1;
      otherSimSum += bestOtherSim;
      continue;
    }
    const plain = stripDiacritics(qt);
    if (unitToks.includes(plain)) {
      unitHits += 1;
      continue;
    }
    if (PERSON_FILLER.has(plain)) continue;
    stray += 1;
  }

  const lastGivenMatched = (givenSim[givenSim.length - 1] as number) > 0;
  let score: number;
  if (!lastGivenMatched) {
    // Chỉ khớp họ hoặc tên đệm: ứng viên yếu, để người dùng tự chọn.
    if (otherCount === 0 || stray > 0) return 0;
    score = 0.3 * (otherSimSum / otherCount);
  } else {
    const given = givenSim.reduce((a, b) => a + b, 0) / givenSim.length;
    score = given * (0.9 + (otherCount > 0 ? 0.1 * (otherSimSum / otherCount) : 0));
    if (unitHits > 0) score = Math.min(1, score + 0.05);
  }
  score *= 0.5 ** Math.min(stray, 2);

  if (honorific) {
    const own = person.honorific ? stripDiacritics(normalizeText(person.honorific)) : null;
    if (own === honorific) score = Math.min(1, score + 0.05);
    else if (own === null) score *= 0.85;
    else if ((FEMALE.has(own) && MALE.has(honorific)) || (MALE.has(own) && FEMALE.has(honorific))) score *= 0.5;
    else score *= 0.9;
  }
  return Math.round(score * 1000) / 1000;
}

/**
 * Tìm người theo cách gọi: "chị Lan", "anh Tuấn", "Lan kinh doanh", "Nguyễn Thu Lan", gõ không dấu cũng được.
 * Trả mọi ứng viên có điểm lớn hơn 0, xếp giảm dần; cùng điểm thì giữ thứ tự của `people`.
 * Hai người trùng tên được trả về CẢ HAI với cùng điểm: hàm không chọn thay người dùng (SPEC 13.4).
 */
export function matchPerson(query: string, people: PersonCandidate[]): PersonMatch[] {
  const tokens = wordsOf(expandAbbrev(query, { CT: '', TP: '', VP: '', HCM: '' }));
  if (tokens.length === 0) return [];

  // Tiếng đầu có thể là xưng hô ("chị Lan") hoặc là tên ("Chi Lan"): chấm cả hai cách hiểu, lấy điểm cao hơn.
  const readings: { honorific: string | null; tokens: string[] }[] = [{ honorific: null, tokens }];
  const first = tokens[0] as string;
  const two = tokens.slice(0, 2).join(' ');
  if (tokens.length >= 2) {
    const h = queryHonorific(first);
    if (h) readings.push({ honorific: h, tokens: tokens.slice(1) });
    else if (NEUTRAL_ADDRESS.has(first)) readings.push({ honorific: null, tokens: tokens.slice(1) });
    if (tokens.length >= 3 && NEUTRAL_ADDRESS.has(two)) readings.push({ honorific: null, tokens: tokens.slice(2) });
  }

  const scored = people.map((person, order) => {
    let best = 0;
    for (const r of readings) best = Math.max(best, scorePerson(r.honorific, r.tokens, person));
    return { id: person.id, score: best, order };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ id, score }) => ({ id, score }));
}

// ───────────────────────── Xác nhận bằng giọng (tập câu đóng) ─────────────────────────

/**
 * Chuẩn hoá câu lệnh giọng nói để so với tập câu đóng (SPEC 6.5 điều 10, 10.6):
 * chữ thường, bỏ dấu câu, bỏ "dạ" và "ạ". Giữ dấu tiếng Việt: "dong y" không phải "đồng ý".
 */
export function normalizeVoiceCommand(text: string): string {
  return normalizeText(text.normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' '))
    .split(' ')
    .filter((w) => w !== '' && w !== 'dạ' && w !== 'ạ')
    .join(' ');
}

/**
 * Chỉ nhận đúng tập câu đóng: "đồng ý", "gửi đi" → 'confirm'; "không", "thôi" → 'reject'.
 * Mọi câu khác ("ừ, cứ thế đi nhé") trả null: không xác nhận, trợ lý hỏi lại.
 */
export function matchVoiceConfirm(text: string): 'confirm' | 'reject' | null {
  const cmd = normalizeVoiceCommand(text);
  if ((VOICE_CONFIRM_PHRASES as readonly string[]).includes(cmd)) return 'confirm';
  if ((VOICE_REJECT_PHRASES as readonly string[]).includes(cmd)) return 'reject';
  return null;
}

// ───────────────────────── Che dữ liệu cá nhân ─────────────────────────

export const REDACTED = {
  email: '[thư điện tử]',
  nationalId: '[số căn cước]',
  phone: '[số điện thoại]',
} as const;

/** Đoạn không được đụng vào: UUID, ngày ISO kèm giờ, ngày dạng 15/10/2026. */
const PROTECTED_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<!\d)\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?!\d)|(?<!\d)\d{1,2}([-/.])\d{1,2}\1\d{4}(?!\d)/gi;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** Số căn cước 12 số: bắt đầu bằng 0 (mã tỉnh 001 đến 096), viết liền hoặc tách bốn nhóm ba số bằng dấu cách. */
const NATIONAL_ID_RE = /(?<![\p{L}\p{N}])(?<!\d[.,])0\d{2}(?:\d{9}| \d{3} \d{3} \d{3})(?!\d)(?![.,]\d)/gu;
/** Số điện thoại Việt Nam: 0 hoặc +84 hoặc 84, theo sau là 9 hoặc 10 chữ số, cho phép dấu cách, chấm, gạch, ngoặc. */
const PHONE_RE = /(?<![\p{L}\p{N}])(?<!\d[.,])(?:\(\+?84\)|\+84|84(?=[\s.-]?[235789])|\((?=0\d{1,3}\))0|0)(?:[\s.\-)]{0,2}\d){9,10}(?!\d)(?![.,]\d)/gu;

function redactPlain(text: string): string {
  return text.replace(EMAIL_RE, REDACTED.email).replace(NATIONAL_ID_RE, REDACTED.nationalId).replace(PHONE_RE, REDACTED.phone);
}

/**
 * Che số điện thoại, địa chỉ thư điện tử và số căn cước 12 số trước mọi lệnh gọi ra nhà cung cấp ngoài (SPEC 6.8).
 * Không đụng vào UUID, số tiền, ngày tháng.
 */
export function redact(text: string): string {
  const input = text.normalize('NFC');
  let out = '';
  let lastIndex = 0;
  for (const m of input.matchAll(PROTECTED_RE)) {
    const at = m.index;
    out += redactPlain(input.slice(lastIndex, at)) + m[0];
    lastIndex = at + m[0].length;
  }
  return out + redactPlain(input.slice(lastIndex));
}
