/**
 * Lịch âm Việt Nam (SPEC 4.5, 7.5): tính theo thuật toán thiên văn của Hồ Ngọc Đức,
 * múi giờ UTC+7. Mọi hàm ở đây là hàm thuần: không đọc đồng hồ, không I/O.
 *
 * Lịch âm CHỈ dùng để hiển thị ngày âm cho Chủ tịch và để gợi ý ngày nghỉ lễ.
 * Không dùng để tính hạn. Kết quả phải được Văn phòng đối chiếu với lịch chính thức
 * trước khi dùng thật (SPEC 13.4; bảng ở docs/benchmarks/lunar-tet-table.md).
 */

/** Múi giờ của lịch âm Việt Nam (giờ). Lịch Trung Quốc dùng 8, nên có năm lệch nhau một ngày hoặc một tháng. */
export const VN_LUNAR_TIME_ZONE = 7;

export type LunarDate = {
  day: number;
  month: number;
  year: number;
  /** true khi là tháng nhuận (tháng lặp lại số của tháng trước nó) */
  leap: boolean;
};

export type SolarDate = { year: number; month: number; day: number };

export type HolidaySuggestion = {
  /** ngày dương 'YYYY-MM-DD' */
  day: string;
  name: string;
  kind: 'public';
  /** ngày âm viết đủ khi ngày lễ tính theo âm lịch, ngược lại null */
  lunarLabel: string | null;
};

const VN_OFFSET_MS = VN_LUNAR_TIME_ZONE * 60 * 60 * 1000;
/** Độ dài trung bình một tháng giao hội (ngày). */
const SYNODIC_MONTH = 29.530588853;
/** Số ngày Julius của một điểm Sóc gốc (01/01/1900), mốc đếm k. */
const NEW_MOON_EPOCH = 2415021.076998695;

// ───────────────────────── Số ngày Julius ─────────────────────────

/** Đổi ngày dương (lịch Gregory, trước 15/10/1582 là lịch Julius) sang số ngày Julius. */
function jdFromDate(day: number, month: number, year: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  let jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  if (jd < 2299161) {
    jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
  }
  return jd;
}

/** Đổi số ngày Julius sang ngày dương. */
function jdToDate(jd: number): SolarDate {
  let b: number;
  let c: number;
  if (jd > 2299160) {
    const a = jd + 32044;
    b = Math.floor((4 * a + 3) / 146097);
    c = a - Math.floor((b * 146097) / 4);
  } else {
    b = 0;
    c = jd + 32082;
  }
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: b * 100 + d - 4800 + Math.floor(m / 10),
  };
}

// ───────────────────────── Thiên văn: điểm Sóc và kinh độ Mặt Trời ─────────────────────────

/** Thời điểm Sóc (trăng non) thứ k kể từ 01/01/1900, tính bằng số ngày Julius (giờ UTC). */
function newMoon(k: number): number {
  const T = k / 1236.85; // thế kỷ Julius tính từ 1900-01-00.5
  const T2 = T * T;
  const T3 = T2 * T;
  const dr = Math.PI / 180;
  let jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
  jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr); // Sóc trung bình
  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3; // dị thường trung bình của Mặt Trời
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3; // dị thường trung bình của Mặt Trăng
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3; // đối số vĩ độ của Mặt Trăng
  let c1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
  c1 = c1 - 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(dr * 2 * Mpr);
  c1 -= 0.0004 * Math.sin(dr * 3 * Mpr);
  c1 = c1 + 0.0104 * Math.sin(dr * 2 * F) - 0.0051 * Math.sin(dr * (M + Mpr));
  c1 = c1 - 0.0074 * Math.sin(dr * (M - Mpr)) + 0.0004 * Math.sin(dr * (2 * F + M));
  c1 = c1 - 0.0004 * Math.sin(dr * (2 * F - M)) - 0.0006 * Math.sin(dr * (2 * F + Mpr));
  c1 = c1 + 0.001 * Math.sin(dr * (2 * F - Mpr)) + 0.0005 * Math.sin(dr * (2 * Mpr + M));
  const deltaT =
    T < -11
      ? 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3
      : -0.000278 + 0.000265 * T + 0.000262 * T2;
  return jd1 + c1 - deltaT;
}

/** Kinh độ Mặt Trời (radian, 0 đến 2π) tại thời điểm số ngày Julius `jdn`. */
function sunLongitude(jdn: number): number {
  const T = (jdn - 2451545.0) / 36525; // thế kỷ Julius tính từ 2000-01-01 12:00 GMT
  const T2 = T * T;
  const dr = Math.PI / 180;
  const M = 357.5291 + 35999.0503 * T - 0.0001559 * T2 - 0.00000048 * T * T2; // dị thường trung bình
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2; // kinh độ trung bình
  let DL = (1.9146 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
  DL = DL + (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.00029 * Math.sin(dr * 3 * M);
  let L = (L0 + DL) * dr; // kinh độ thực
  L -= Math.PI * 2 * Math.floor(L / (Math.PI * 2));
  return L;
}

/** Cung 30 độ (0 đến 11) chứa Mặt Trời lúc nửa đêm đầu ngày `dayNumber` theo múi giờ. Trung khí rơi vào ranh giới cung. */
function sunLongitudeSector(dayNumber: number, timeZone: number): number {
  return Math.floor((sunLongitude(dayNumber - 0.5 - timeZone / 24) / Math.PI) * 6);
}

/** Ngày (số ngày Julius nguyên, theo múi giờ) chứa điểm Sóc thứ k: ngày mùng 1 của một tháng âm. */
function newMoonDay(k: number, timeZone: number): number {
  return Math.floor(newMoon(k) + 0.5 + timeZone / 24);
}

/** Ngày mùng 1 của tháng 11 âm lịch (tháng chứa Đông chí) trong năm dương `year`. */
function lunarMonth11(year: number, timeZone: number): number {
  const off = jdFromDate(31, 12, year) - 2415021;
  const k = Math.floor(off / SYNODIC_MONTH);
  let nm = newMoonDay(k, timeZone);
  // Điểm Sóc rơi sau Đông chí thì lùi lại một tháng.
  if (sunLongitudeSector(nm, timeZone) >= 9) nm = newMoonDay(k - 1, timeZone);
  return nm;
}

/** Vị trí tháng nhuận sau tháng 11 mở đầu `a11`: tháng đầu tiên không chứa trung khí. */
function leapMonthOffset(a11: number, timeZone: number): number {
  const k = Math.floor((a11 - NEW_MOON_EPOCH) / SYNODIC_MONTH + 0.5);
  let last: number;
  let i = 1; // bắt đầu từ tháng liền sau tháng 11
  let arc = sunLongitudeSector(newMoonDay(k + i, timeZone), timeZone);
  do {
    last = arc;
    i += 1;
    arc = sunLongitudeSector(newMoonDay(k + i, timeZone), timeZone);
  } while (arc !== last && i < 14);
  return i - 1;
}

// ───────────────────────── Đổi dương sang âm và ngược lại ─────────────────────────

function solarToLunarInZone(year: number, month: number, day: number, timeZone: number): LunarDate {
  const dayNumber = jdFromDate(day, month, year);
  const k = Math.floor((dayNumber - NEW_MOON_EPOCH) / SYNODIC_MONTH);
  let monthStart = newMoonDay(k + 1, timeZone);
  if (monthStart > dayNumber) monthStart = newMoonDay(k, timeZone);
  let a11 = lunarMonth11(year, timeZone);
  let b11 = a11;
  let lunarYear: number;
  if (a11 >= monthStart) {
    lunarYear = year;
    a11 = lunarMonth11(year - 1, timeZone);
  } else {
    lunarYear = year + 1;
    b11 = lunarMonth11(year + 1, timeZone);
  }
  const lunarDay = dayNumber - monthStart + 1;
  const diff = Math.floor((monthStart - a11) / 29);
  let leap = false;
  let lunarMonth = diff + 11;
  if (b11 - a11 > 365) {
    const leapDiff = leapMonthOffset(a11, timeZone);
    if (diff >= leapDiff) {
      lunarMonth = diff + 10;
      if (diff === leapDiff) leap = true;
    }
  }
  if (lunarMonth > 12) lunarMonth -= 12;
  if (lunarMonth >= 11 && diff < 4) lunarYear -= 1;
  return { day: lunarDay, month: lunarMonth, year: lunarYear, leap };
}

function lunarToSolarInZone(lunarDay: number, lunarMonth: number, lunarYear: number, leap: boolean, timeZone: number): SolarDate | null {
  let a11: number;
  let b11: number;
  if (lunarMonth < 11) {
    a11 = lunarMonth11(lunarYear - 1, timeZone);
    b11 = lunarMonth11(lunarYear, timeZone);
  } else {
    a11 = lunarMonth11(lunarYear, timeZone);
    b11 = lunarMonth11(lunarYear + 1, timeZone);
  }
  const k = Math.floor(0.5 + (a11 - NEW_MOON_EPOCH) / SYNODIC_MONTH);
  let off = lunarMonth - 11;
  if (off < 0) off += 12;
  if (b11 - a11 > 365) {
    const leapOff = leapMonthOffset(a11, timeZone);
    let leapMonth = leapOff - 2;
    if (leapMonth < 0) leapMonth += 12;
    if (leap && lunarMonth !== leapMonth) return null;
    if (leap || off >= leapOff) off += 1;
  } else if (leap) {
    return null;
  }
  const monthStart = newMoonDay(k + off, timeZone);
  return jdToDate(monthStart + lunarDay - 1);
}

function assertInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} không hợp lệ`);
  }
}

/** Đổi ngày dương sang ngày âm Việt Nam (UTC+7). */
export function solarToLunar(year: number, month: number, day: number): LunarDate {
  assertInt('Năm', year, 1800, 2199);
  assertInt('Tháng', month, 1, 12);
  assertInt('Ngày', day, 1, 31);
  const real = jdToDate(jdFromDate(day, month, year));
  if (real.day !== day || real.month !== month || real.year !== year) throw new RangeError('Ngày dương không tồn tại');
  return solarToLunarInZone(year, month, day, VN_LUNAR_TIME_ZONE);
}

/**
 * Đổi ngày âm Việt Nam sang ngày dương. Ném RangeError khi ngày âm không tồn tại:
 * tháng nhuận không có trong năm đó, hoặc ngày 30 của tháng chỉ có 29 ngày.
 */
export function lunarToSolar(lunarDay: number, lunarMonth: number, lunarYear: number, leap: boolean): SolarDate {
  assertInt('Năm âm', lunarYear, 1800, 2199);
  assertInt('Tháng âm', lunarMonth, 1, 12);
  assertInt('Ngày âm', lunarDay, 1, 30);
  const solar = lunarToSolarInZone(lunarDay, lunarMonth, lunarYear, leap, VN_LUNAR_TIME_ZONE);
  if (!solar) throw new RangeError('Năm âm này không có tháng nhuận đó');
  const back = solarToLunarInZone(solar.year, solar.month, solar.day, VN_LUNAR_TIME_ZONE);
  if (back.day !== lunarDay || back.month !== lunarMonth || back.year !== lunarYear || back.leap !== leap) {
    throw new RangeError('Ngày âm không tồn tại');
  }
  return solar;
}

// ───────────────────────── Hiển thị ─────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' từ ngày dương. */
export function solarDateKey(d: SolarDate): string {
  return `${String(d.year).padStart(4, '0')}-${p2(d.month)}-${p2(d.day)}`;
}

/** Tách ngày dương theo giờ Việt Nam từ Date, hoặc từ chuỗi 'YYYY-MM-DD' (hiểu là ngày lịch), hoặc chuỗi thời điểm ISO. */
function toSolarDate(date: Date | string): SolarDate {
  if (typeof date === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }
  const ms = date instanceof Date ? date.getTime() : Date.parse(date);
  if (Number.isNaN(ms)) throw new RangeError('Ngày không hợp lệ');
  const d = new Date(ms + VN_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Tên tháng âm: tháng 1 là "Giêng", tháng 12 là "Chạp", tháng nhuận ghi rõ "nhuận" (SPEC 7.5). */
export function lunarMonthName(month: number, leap: boolean): string {
  const base = month === 1 ? 'Giêng' : month === 12 ? 'Chạp' : String(month);
  return leap ? `${base} nhuận` : base;
}

/** "mùng 5 tháng 9 âm lịch" (ngày 1 đến 10), "ngày 15 tháng 8 âm lịch" (từ ngày 11). */
export function formatLunarDate(lunar: Pick<LunarDate, 'day' | 'month' | 'leap'>): string {
  const dayPart = lunar.day <= 10 ? `mùng ${lunar.day}` : `ngày ${lunar.day}`;
  return `${dayPart} tháng ${lunarMonthName(lunar.month, lunar.leap)} âm lịch`;
}

/**
 * Ngày âm viết đủ của một ngày dương, theo cách đọc ở SPEC 7.5.
 * `date` là Date (lấy ngày theo giờ Việt Nam), chuỗi 'YYYY-MM-DD', hoặc chuỗi thời điểm ISO.
 */
export function formatLunar(date: Date | string): string {
  const s = toSolarDate(date);
  return formatLunarDate(solarToLunar(s.year, s.month, s.day));
}

// ───────────────────────── Tết và gợi ý ngày lễ ─────────────────────────

/** Ngày dương của mùng 1 Tết Nguyên đán rơi trong năm dương lịch `year`. */
export function tetDate(year: number): SolarDate {
  return lunarToSolar(1, 1, year, false);
}

/**
 * Như `tetDate` nhưng theo múi giờ tuỳ chọn. Chỉ để kiểm thử và lập bảng đối chiếu:
 * năm nào UTC+7 và UTC+8 cho ngày khác nhau thì cần test riêng (SPEC 13.4).
 */
export function tetDateInTimeZone(year: number, timeZoneHours: number): SolarDate {
  const solar = lunarToSolarInZone(1, 1, year, false, timeZoneHours);
  if (!solar) throw new RangeError('Không tính được ngày Tết');
  return solar;
}

function addDays(d: SolarDate, n: number): SolarDate {
  return jdToDate(jdFromDate(d.day, d.month, d.year) + n);
}

function lunarLabelOf(d: SolarDate): string {
  return formatLunarDate(solarToLunarInZone(d.year, d.month, d.day, VN_LUNAR_TIME_ZONE));
}

/**
 * Gợi ý các ngày lễ cố định của năm dương `year` để Văn phòng xem rồi tự nhập (SPEC 4.5).
 * Hệ thống không tự áp các ngày này: ngày nghỉ thật, kể cả nghỉ bù, do `office_admin` nhập
 * theo thông báo của Chính phủ.
 *
 * [GIẢ ĐỊNH] Danh sách theo Bộ luật Lao động 2019, chưa đối chiếu văn bản.
 * [GIẢ ĐỊNH] Tết Nguyên đán gợi ý từ ngày cuối tháng Chạp (30, hoặc 29 khi tháng thiếu) tới mùng 5;
 * số ngày nghỉ thật mỗi năm theo thông báo. Quốc khánh chỉ gợi ý ngày 2/9; ngày liền kề do thông báo quyết định.
 */
export function fixedHolidaySuggestions(year: number): HolidaySuggestion[] {
  assertInt('Năm', year, 1801, 2198);
  const out: HolidaySuggestion[] = [];
  const solar = (month: number, day: number, name: string) => {
    out.push({ day: solarDateKey({ year, month, day }), name, kind: 'public', lunarLabel: null });
  };

  solar(1, 1, 'Tết Dương lịch');

  const tet = tetDate(year);
  const eve = addDays(tet, -1);
  const eveLunar = solarToLunarInZone(eve.year, eve.month, eve.day, VN_LUNAR_TIME_ZONE);
  out.push({
    day: solarDateKey(eve),
    name: `Tết Nguyên đán (${eveLunar.day} tháng Chạp)`,
    kind: 'public',
    lunarLabel: formatLunarDate(eveLunar),
  });
  for (let i = 0; i < 5; i += 1) {
    const d = addDays(tet, i);
    out.push({ day: solarDateKey(d), name: `Tết Nguyên đán (mùng ${i + 1} Tết)`, kind: 'public', lunarLabel: lunarLabelOf(d) });
  }

  const hungKings = lunarToSolar(10, 3, year, false);
  out.push({ day: solarDateKey(hungKings), name: 'Giỗ Tổ Hùng Vương', kind: 'public', lunarLabel: lunarLabelOf(hungKings) });

  solar(4, 30, 'Ngày Chiến thắng 30/4');
  solar(5, 1, 'Ngày Quốc tế Lao động 1/5');
  solar(9, 2, 'Quốc khánh 2/9');

  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
