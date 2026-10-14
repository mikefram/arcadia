/**
 * PIN 6 số của app (SPEC 11.2). PIN KHÔNG gửi lên máy chủ: trên máy chỉ lưu băm có muối, trong kho an toàn.
 * Hàm băm (SHA-256 của expo-crypto) và nguồn ngẫu nhiên được truyền vào, không tự viết thuật toán.
 * PIN chỉ có một triệu khả năng nên băm không chống được dò vét cạn; lớp bảo vệ thật là kho an toàn của hệ điều hành
 * và việc xoá phiên sau 5 lần nhập chưa khớp.
 */
export const PIN_LENGTH = 6;
export const MAX_PIN_FAILURES = 5;

export type PinHasher = {
  /** muối ngẫu nhiên dạng hex */
  randomSalt(): string;
  /** SHA-256 dạng hex của một chuỗi */
  sha256Hex(text: string): Promise<string>;
};

export type PinRecord = { v: 1; salt: string; hash: string };

export function isPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/** Mã dễ đoán: sáu số giống nhau, hoặc sáu số liền nhau tăng hay giảm (123456, 987654). */
export function isWeakPin(pin: string): boolean {
  if (!isPinFormat(pin)) return true;
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const steps = digits.slice(1).map((d, i) => d - (digits[i] ?? 0));
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

export async function createPinRecord(pin: string, hasher: PinHasher): Promise<PinRecord> {
  const salt = hasher.randomSalt();
  return { v: 1, salt, hash: await hasher.sha256Hex(`${salt}:${pin}`) };
}

/** So sánh không dừng sớm, để thời gian chạy không lộ vị trí ký tự khác nhau. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPin(pin: string, record: PinRecord, hasher: PinHasher): Promise<boolean> {
  if (!isPinFormat(pin)) return false;
  return sameText(await hasher.sha256Hex(`${record.salt}:${pin}`), record.hash);
}

export function parsePinRecord(raw: string | null): PinRecord | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    return r.v === 1 && typeof r.salt === 'string' && typeof r.hash === 'string' ? { v: 1, salt: r.salt, hash: r.hash } : null;
  } catch {
    return null;
  }
}
