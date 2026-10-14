/**
 * Kiểm chuỗi giao diện (CLAUDE.md luật 7; SPEC 7.5, 7.8, 10.1, 13.7). Chạy: `pnpm --filter @mihato/i18n check`.
 * Thoát mã khác 0 khi có chuỗi sai, để CI đỏ.
 *
 * Kiểm trên vi.common, vi.errors, vi.notifications, vi.staff, vi.executive, vi.timeline:
 * 1. không có từ vay mượn bị cấm (danh sách ở src/banned.ts);
 * 2. không có chuỗi rỗng, không có biểu tượng cảm xúc;
 * 3. mọi mã lỗi API có câu cho cả ba nhóm người dùng; mọi loại thông báo có tiêu đề và thân;
 * 4. biến trong ngoặc nhọn thuộc danh sách cho phép của từng kho (bắt lỗi gõ nhầm tên biến);
 * 5. app Chủ tịch không viết cứng "Chủ tịch" mà dùng biến {danh xưng}; không có nút "Hủy" hay "Từ chối".
 *
 * vi.admin do phần web quản trị tự kiểm.
 */
import { pathToFileURL } from 'node:url';
import { ERROR_CODE_LIST, NOTIFICATION_KINDS } from '@mihato/domain';
import { findBannedWords } from '../src/banned';
import { vi } from '../src/index';
import { NOTIFICATION_VARIABLES } from '../src/vi/notifications';

export type Problem = { path: string; problem: string };
export type StringEntry = { path: string; value: string };

/** Gom mọi chuỗi lá của một kho, kèm đường dẫn khoá. Giá trị không phải chuỗi, mảng hay đối tượng là sai. */
export function collectStrings(node: unknown, path: string, out: StringEntry[] = [], problems: Problem[] = []): StringEntry[] {
  if (typeof node === 'string') {
    out.push({ path, value: node });
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => collectStrings(item, `${path}[${i}]`, out, problems));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) collectStrings(value, `${path}.${key}`, out, problems);
  } else {
    problems.push({ path, problem: 'giá trị không phải chuỗi' });
  }
  return out;
}

/** Các kho được quét và biến được phép dùng trong từng kho. */
export const STORES = {
  common: ['n', 'tên', 'giờ'],
  errors: ['danh xưng'],
  notifications: [...NOTIFICATION_VARIABLES],
  staff: [
    'tên',
    'tổ chức',
    'n',
    'việc',
    'lượt',
    'người',
    'người gửi',
    'hạn',
    'hạn cũ',
    'hạn mới',
    'giờ',
    'ngày',
    'từ',
    'đến',
    'xong',
    'tổng',
    'tiền',
    'lý do',
    'trả lời',
    'trạng thái',
    'phiên bản',
  ],
  executive: [
    'danh xưng',
    'n',
    'việc',
    'lượt',
    'người',
    'người gửi',
    'người cũ',
    'người mới',
    'hạn',
    'hạn cũ',
    'hạn mới',
    'giờ',
    'ngày',
    'ngày âm',
    'từ',
    'đến',
    'xong',
    'tổng',
    'tiền',
    'lý do',
    'phạm vi',
    'tiến độ',
    'trạng thái',
    'phiên bản',
  ],
  timeline: ['người', 'người nhận', 'người ủy quyền', 'việc', 'lượt', 'hạn', 'từ', 'đến', 'lý do', 'trả lời', 'nội dung'],
  server: [
    'danh xưng', 'n', 'k', 'a', 'b', 'việc', 'lượt', 'mẫu', 'tên', 'người', 'Người', 'người cũ', 'người mới', 'hạn', 'hạn cũ', 'hạn mới',
    'ngày', 'ngày âm', 'ngày kế', 'Ngày kế', 'Từ lúc', 'tình trạng', 'ghi chú', 'nội dung', 'lý do', 'chi phí', 'ngân sách',
    'tổ chức', 'web',
  ],
} as const satisfies Partial<Record<keyof typeof vi, readonly string[]>>;

export type StoreName = keyof typeof STORES;
export const STORE_NAMES = Object.keys(STORES) as StoreName[];

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/** Kiểm một chuỗi: rỗng, từ cấm, biểu tượng cảm xúc, ngoặc nhọn lệch, biến lạ. */
export function checkString(entry: StringEntry, allowedVars: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  const { path, value } = entry;
  if (value.trim() === '') {
    problems.push({ path, problem: 'chuỗi rỗng' });
    return problems;
  }
  if (value !== value.trim()) problems.push({ path, problem: 'thừa khoảng trắng ở đầu hoặc cuối' });
  if (value !== value.normalize('NFC')) problems.push({ path, problem: 'chuỗi không ở dạng Unicode dựng sẵn (NFC)' });
  for (const word of findBannedWords(value)) problems.push({ path, problem: `có từ cấm “${word}”` });
  if (EMOJI_RE.test(value)) problems.push({ path, problem: 'có biểu tượng cảm xúc' });
  const withoutPlaceholders = value.replace(PLACEHOLDER_RE, '');
  if (/[{}]/.test(withoutPlaceholders)) problems.push({ path, problem: 'ngoặc nhọn không khớp' });
  for (const m of value.matchAll(PLACEHOLDER_RE)) {
    const name = m[1] as string;
    if (!allowedVars.includes(name)) problems.push({ path, problem: `biến lạ {${name}}` });
  }
  return problems;
}

export function runChecks(): Problem[] {
  const problems: Problem[] = [];

  for (const name of STORE_NAMES) {
    const entries = collectStrings(vi[name], name, [], problems);
    if (entries.length === 0) problems.push({ path: name, problem: 'kho chưa có chuỗi nào' });
    for (const entry of entries) problems.push(...checkString(entry, STORES[name]));
  }

  // Mỗi mã lỗi có câu cho từng nhóm người dùng (SPEC 10.1).
  for (const audience of ['staff', 'executive', 'admin'] as const) {
    const table: Record<string, string | undefined> = vi.errors[audience];
    for (const code of ERROR_CODE_LIST) {
      if (!table[code]?.trim()) problems.push({ path: `errors.${audience}.${code}`, problem: 'thiếu câu cho mã lỗi' });
    }
    for (const code of Object.keys(table)) {
      if (!(ERROR_CODE_LIST as string[]).includes(code)) problems.push({ path: `errors.${audience}.${code}`, problem: 'mã lỗi không có trong ERROR_CODES' });
    }
  }
  // {danh xưng} chỉ dành cho app Chủ tịch.
  for (const audience of ['staff', 'admin'] as const) {
    for (const entry of collectStrings(vi.errors[audience], `errors.${audience}`)) {
      if (entry.value.includes('{')) problems.push({ path: entry.path, problem: 'câu lỗi của nhóm này không dùng biến' });
    }
  }

  // Mỗi loại thông báo có tiêu đề và thân (SPEC 10.9).
  const notificationTable: Record<string, { title?: string; body?: string } | undefined> = vi.notifications;
  for (const kind of NOTIFICATION_KINDS) {
    const item = notificationTable[kind];
    if (!item?.title?.trim()) problems.push({ path: `notifications.${kind}.title`, problem: 'thiếu tiêu đề thông báo' });
    if (!item?.body?.trim()) problems.push({ path: `notifications.${kind}.body`, problem: 'thiếu thân thông báo' });
  }
  for (const kind of Object.keys(notificationTable)) {
    if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) problems.push({ path: `notifications.${kind}`, problem: 'loại thông báo không có trong NOTIFICATION_KINDS' });
  }

  // App Chủ tịch: cách gọi là biến, không viết cứng; không có nút "Hủy" hay "Từ chối" (SPEC 7.5).
  const executiveEntries = [
    ...collectStrings(vi.executive, 'executive').filter((e) => !e.path.startsWith('executive.address.')),
    ...collectStrings(vi.errors.executive, 'errors.executive'),
  ];
  for (const entry of executiveEntries) {
    if (entry.value.includes('Chủ tịch')) problems.push({ path: entry.path, problem: 'viết cứng “Chủ tịch”; dùng biến {danh xưng}' });
    if (/^(?:Hủy|Huỷ|Từ chối)$/u.test(entry.value)) problems.push({ path: entry.path, problem: 'nút “Hủy” hoặc “Từ chối” không dùng ở app Chủ tịch' });
  }

  return problems;
}

function main(): void {
  const problems = runChecks();
  let total = 0;
  for (const name of STORE_NAMES) total += collectStrings(vi[name], name).length;
  if (problems.length === 0) {
    console.log(`Chuỗi giao diện đạt: ${total} chuỗi ở ${STORE_NAMES.length} kho, ${ERROR_CODE_LIST.length} mã lỗi, ${NOTIFICATION_KINDS.length} loại thông báo.`);
    return;
  }
  console.error(`Chuỗi giao diện có ${problems.length} điểm chưa đạt:`);
  for (const p of problems) console.error(`  ${p.path}: ${p.problem}`);
  process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
