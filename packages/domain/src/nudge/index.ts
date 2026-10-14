/**
 * Ma trận xưng hô và mẫu lời nhắc của đi thúc (SPEC 4.7). Hàm thuần.
 *
 * Mẫu là dữ liệu cấu hình theo tổ chức (`organizations.settings.nudgeTemplates`), không viết cứng trong prompt.
 * Lời nhắc do máy chủ soạn từ mẫu, không lấy chữ của LLM (SPEC 6.5 điều 3).
 */
import { DEFAULT_NUDGE_TEMPLATES, type NudgeTemplates } from '../api/org';
import type { DirectoryUser } from '../engine';
import { HONORIFIC_LABEL, type Role } from '../enums';

export type NudgeRelation = 'down' | 'peer' | 'up';

/** Thứ bậc vai trò: chairman > director > deputy > còn lại. */
const ROLE_RANK: Partial<Record<Role, number>> = { chairman: 3, director: 2, deputy: 1 };

const rankOf = (user: DirectoryUser) => user.roles.reduce((max, r) => Math.max(max, ROLE_RANK[r.role] ?? 0), 0);

/** `ancestorId` có nằm trên chuỗi cấp trên (managerId) của `user` không. Có chặn vòng lặp do dữ liệu sai. */
function isAbove(ancestorId: string, user: DirectoryUser, byId: Map<string, DirectoryUser>): boolean {
  const seen = new Set<string>([user.id]);
  let cur = user.managerId;
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = byId.get(cur)?.managerId ?? null;
  }
  return false;
}

/**
 * Quan hệ giữa người gửi và người nhận lời nhắc, để chọn mẫu xưng hô:
 * 'down' gửi cấp dưới, 'peer' ngang cấp, 'up' gửi cấp trên.
 *
 * Thứ tự xét:
 * 1. Chuỗi `managerId`: người nhận nằm dưới người gửi → 'down'; người gửi nằm dưới người nhận → 'up'.
 * 2. Thứ bậc vai trò chairman > director > deputy > còn lại.
 * 3. Người gửi là `office_admin` nhắc thay Văn phòng Chủ tịch: coi như 'down'; người nhận là điều hành
 *    thì đã ra 'up' ở bước 2.
 * 4. Còn lại là 'peer'. Không tìm thấy người gửi hoặc người nhận trong danh bạ cũng là 'peer'.
 */
export function relationOf(senderId: string, recipientId: string, users: DirectoryUser[]): NudgeRelation {
  const byId = new Map(users.map((u) => [u.id, u]));
  const sender = byId.get(senderId);
  const recipient = byId.get(recipientId);
  if (!sender || !recipient || senderId === recipientId) return 'peer';

  if (isAbove(senderId, recipient, byId)) return 'down';
  if (isAbove(recipientId, sender, byId)) return 'up';

  const senderRank = rankOf(sender);
  const recipientRank = rankOf(recipient);
  if (senderRank > recipientRank) return 'down';
  if (senderRank < recipientRank) return 'up';

  if (senderRank === 0 && sender.roles.some((r) => r.role === 'office_admin')) return 'down';
  return 'peer';
}

/** Mẫu lời nhắc theo quan hệ; thiếu cấu hình của tổ chức thì dùng mẫu mặc định ở SPEC 4.7. */
export function nudgeTemplateFor(relation: NudgeRelation, templates: NudgeTemplates = DEFAULT_NUDGE_TEMPLATES): string {
  return templates[relation];
}

export type NudgeVars = {
  /** mã lưu ở CSDL ('chi') hoặc chữ hiển thị ("chị"); null với tài khoản không có xưng hô */
  honorific: string | null;
  givenName: string;
  stepTitle: string;
  /** số ngày làm việc đã trễ; 0 nghĩa là vừa đến hạn */
  lateDays: number;
};

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function honorificLabel(honorific: string | null): string {
  if (!honorific) return '';
  const key = honorific.trim().toLowerCase();
  return (HONORIFIC_LABEL as Record<string, string>)[key] ?? key;
}

/**
 * Điền mẫu lời nhắc: `{honorific}`, `{Honorific}` (viết hoa chữ đầu), `{tên}`, `{việc}`, `{n}`.
 * - Người không có xưng hô: bỏ chỗ trống cho gọn; `{Honorific}` đứng đầu câu được thay bằng "Xin"
 *   để câu vẫn lịch sự ("Xin cho biết khi nào hoàn thành.").
 * - `lateDays` bằng 0: "đã quá hạn {n} ngày" thành "đã đến hạn".
 */
export function renderNudge(template: string, vars: NudgeVars): string {
  const label = honorificLabel(vars.honorific);
  const late = Number.isFinite(vars.lateDays) ? Math.max(0, Math.floor(vars.lateDays)) : 0;
  const givenName = vars.givenName.normalize('NFC').trim();
  const stepTitle = vars.stepTitle.normalize('NFC').trim();

  let out = template.normalize('NFC');

  if (late === 0) {
    out = out.replace(/(?:(?:đã|đang) )?(?:quá hạn|chậm|trễ) \{n\} ngày(?: làm việc)?/giu, (all) => (/^\p{Lu}/u.test(all) ? 'Đã đến hạn' : 'đã đến hạn'));
  }
  out = out.replace(/\{n\}/g, String(late));

  if (label) {
    out = out.replace(/\{honorific\}/g, label).replace(/\{Honorific\}/g, capitalize(label));
  } else {
    out = out
      // {Honorific} mở đầu lời nhắc hoặc mở đầu một câu: thay bằng "Xin".
      .replace(/(^|[.!?…]\s+)\{Honorific\}(?=\s+\p{Ll})/gu, '$1Xin')
      .replace(/\{Honorific\}/g, '')
      .replace(/\{honorific\}/g, '');
  }
  if (!givenName) out = out.replace(/\{tên\}/g, '');

  // Dọn chỗ trống do bỏ xưng hô, làm khi tên người và tên việc còn là chỗ giữ chỗ để không đụng vào chữ của người dùng:
  // khoảng trắng kép, khoảng trắng trước dấu câu, chữ thường đầu câu.
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.:;!?…])/g, '$1')
    .trim();
  if (!label) {
    out = out.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_all, lead: string, ch: string) => lead + ch.toUpperCase());
  }

  return out.replace(/\{tên\}/g, () => givenName).replace(/\{việc\}/g, () => stepTitle);
}

/**
 * Soạn lời nhắc cho một việc: xác định quan hệ, chọn mẫu của tổ chức rồi điền.
 * Trả cả `tone` để lưu vào đề xuất (`propose_nudge.tone`).
 */
export function composeNudge(input: {
  senderId: string;
  recipientId: string;
  users: DirectoryUser[];
  recipient: Pick<NudgeVars, 'honorific' | 'givenName'>;
  stepTitle: string;
  lateDays: number;
  templates?: NudgeTemplates;
  /** ép giọng (tham số `tone` của tool); bỏ trống thì suy từ danh bạ */
  tone?: NudgeRelation;
}): { tone: NudgeRelation; message: string } {
  const tone = input.tone ?? relationOf(input.senderId, input.recipientId, input.users);
  const message = renderNudge(nudgeTemplateFor(tone, input.templates), {
    honorific: input.recipient.honorific,
    givenName: input.recipient.givenName,
    stepTitle: input.stepTitle,
    lateDays: input.lateDays,
  });
  return { tone, message };
}
