/**
 * Từ vay mượn tiếng Anh bị cấm trong chuỗi giao diện (SPEC 7.5, CLAUDE.md luật 7).
 * Có từ tiếng Việt thì dùng từ tiếng Việt: việc, hạn, tiến độ, thông báo, trợ lý, gửi.
 *
 * Ngoại lệ duy nhất: chữ "AI" trong nhãn "Trợ lý AI", giữ lại để người dùng biết rõ đang nói với máy (SPEC 6.8, 11.7).
 * Chữ "AI" viết hoa đứng ở chỗ khác bị coi là từ cấm. Chữ "ai" tiếng Việt (ai đang chậm?) thì không.
 */
export const BANNED_WORDS = [
  // nêu đích danh ở SPEC 7.5 và 7.8
  'task',
  'tasks',
  'deadline',
  'deadlines',
  'dashboard',
  'ok',
  'okay',
  'oke',
  'submit',
  'cancel',
  'error',
  'errors',
  'notification',
  'notifications',
  'reject',
  'rejected',
  'late',
  'overdue',
  'hi',
  'hello',
  'sure',
  // cùng loại: tên chức năng và nút bấm đã có từ tiếng Việt
  'approve',
  'approved',
  'pending',
  'done',
  'todo',
  'undo',
  'confirm',
  'retry',
  'loading',
  'login',
  'logout',
  'password',
  'setting',
  'settings',
  'home',
  'back',
  'next',
  'save',
  'send',
  'delete',
  'update',
  'upload',
  'download',
  'file',
  'link',
  'click',
  'tap',
  'online',
  'offline',
  'feedback',
  'report',
  'team',
  'user',
  'workflow',
  'checklist',
  'check',
  'list',
  'warning',
  'success',
  'failed',
  'sorry',
  'please',
  'thanks',
  'bye',
  'chat',
] as const;

export type BannedWord = (typeof BANNED_WORDS)[number];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Khớp nguyên từ, không phân biệt hoa thường. Ranh giới từ tính cả chữ có dấu tiếng Việt. */
const BANNED_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...BANNED_WORDS].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');

/** "AI" viết hoa, nguyên từ. Chỉ hợp lệ khi đứng ngay sau "Trợ lý" (không phân biệt hoa thường). */
const UPPER_AI_RE = /(?<![\p{L}\p{N}_])AI(?![\p{L}\p{N}_])/gu;
const ASSISTANT_PREFIX = 'trợ lý ';

/**
 * Tìm từ cấm trong một chuỗi. Trả danh sách không trùng, theo thứ tự xuất hiện; rỗng nghĩa là sạch.
 * Từ cấm trả về ở dạng chữ thường; riêng "AI" đứng sai chỗ trả về là "AI".
 */
export function findBannedWords(text: string): string[] {
  const s = text.normalize('NFC');
  const hits: { at: number; word: string }[] = [];
  for (const m of s.matchAll(BANNED_RE)) hits.push({ at: m.index, word: m[0].toLowerCase() });
  for (const m of s.matchAll(UPPER_AI_RE)) {
    const before = s.slice(Math.max(0, m.index - ASSISTANT_PREFIX.length), m.index).toLowerCase();
    if (before !== ASSISTANT_PREFIX) hits.push({ at: m.index, word: 'AI' });
  }
  hits.sort((a, b) => a.at - b.at);
  return [...new Set(hits.map((h) => h.word))];
}
