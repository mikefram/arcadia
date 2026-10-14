import type { NotificationKind } from '@mihato/domain';

/**
 * Chữ của thông báo do máy chủ dựng (SPEC 4.6, 8.3, 10.9). Mỗi loại ở `NOTIFICATION_KINDS` có tiêu đề và thân.
 *
 * Biến: {việc} tên việc, {lượt} tên lượt chạy, {n} số lượng hoặc số ngày, {người} người liên quan,
 * {người gửi} danh tính người gửi (với đi thúc là tên chung, ví dụ "Văn phòng Chủ tịch"), {hạn} hạn viết đủ.
 *
 * Thông báo đẩy đi qua Expo, Google và Apple (SPEC 11.5), nên mẫu KHÔNG chứa số tiền, lý do, ghi chú hay
 * lời nhắc; những thứ đó chỉ hiện trong ứng dụng sau khi mở. Tiêu đề không chứa tên người, trừ danh tính người gửi lời nhắc.
 * Thông báo cho app Chủ tịch (bốn loại cuối) ngắn và không có tên việc.
 */
export const notifications: Record<NotificationKind, { title: string; body: string }> = {
  assigned: { title: 'Việc mới: {việc}', body: 'Hạn: {hạn}. Người giao: {người gửi}.' },
  unassigned: { title: 'Cần giao người: {việc}', body: 'Việc này chưa có người nhận. Thuộc lượt ‘{lượt}’.' },
  approval_needed: { title: 'Cần duyệt: {việc}', body: 'Thuộc lượt ‘{lượt}’. Mở để xem và quyết định.' },
  reassigned: { title: 'Đã chuyển việc: {việc}', body: 'Việc này đã chuyển sang {người}. Không cần làm tiếp.' },
  accepted: { title: 'Đã có người nhận: {việc}', body: '{người} đã nhận việc. Hạn: {hạn}.' },
  completed: { title: 'Đã hoàn thành: {việc}', body: '{người} báo hoàn thành. Thuộc lượt ‘{lượt}’.' },
  rejected: { title: 'Chưa được đồng ý: {việc}', body: '{người} chưa đồng ý. Mở để xem lý do.' },
  extension_requested: { title: 'Xin thêm thời gian: {việc}', body: '{người} đề nghị hạn mới: {hạn}. Mở để duyệt.' },
  extension_approved: { title: 'Đã duyệt gia hạn: {việc}', body: 'Hạn mới: {hạn}.' },
  extension_declined: { title: 'Chưa duyệt gia hạn: {việc}', body: 'Hạn vẫn là {hạn}. Mở để xem ý kiến.' },
  due_changed: { title: 'Đã đổi hạn: {việc}', body: 'Hạn mới: {hạn}.' },
  run_cancelled: { title: 'Lượt đã huỷ: {lượt}', body: 'Các việc thuộc lượt này không cần làm tiếp.' },
  run_completed: { title: 'Lượt đã hoàn tất: {lượt}', body: 'Mọi việc của lượt này đã xong.' },
  reminder_due_tomorrow: { title: 'Ngày mai đến hạn: {việc}', body: 'Hạn: {hạn}.' },
  reminder_due_today: { title: 'Hôm nay đến hạn: {việc}', body: 'Hạn: {hạn}.' },
  reminder: { title: 'Nhắc việc: {việc}', body: 'Hạn: {hạn}.' },
  overdue: { title: 'Đã quá hạn {n} ngày: {việc}', body: 'Hạn: {hạn}. Xin báo hoàn thành hoặc xin thêm thời gian.' },
  escalation: { title: 'Việc trong nhóm quá hạn {n} ngày: {việc}', body: 'Người nhận: {người}. Hạn: {hạn}.' },
  nudge: { title: '{người gửi} nhắc: {việc}', body: 'Mở để xem lời nhắc và trả lời nhanh.' },
  nudge_reply: { title: 'Đã có trả lời lời nhắc: {việc}', body: '{người} đã trả lời. Mở để xem.' },
  /** Bình luận theo việc (docs/DECISIONS.md, 07/10/2026 điểm a): tiêu đề chỉ nêu tên việc, tuyệt đối không có nội dung hay tên người viết. */
  comment_new: { title: 'Có bình luận mới ở việc {việc}', body: 'Thuộc lượt ‘{lượt}’. Mở để đọc.' },
  blocked: { title: 'Báo vướng: {việc}', body: '{người} đang vướng, cần hỗ trợ. Mở để xem lý do.' },
  briefing: { title: 'Báo cáo đầu ngày đã sẵn sàng', body: 'Chạm để nghe hoặc đọc.' },
  approval: { title: 'Có {n} việc cần Chủ tịch quyết', body: 'Chạm để xem.' },
  'proposal.office': { title: 'Văn phòng có {n} đề xuất xin Chủ tịch xem', body: 'Chạm để xem.' },
  'proposal.failed': { title: 'Có {n} việc trợ lý chưa làm được', body: 'Chạm để xem lý do.' },
  system: { title: 'Thông báo từ hệ thống', body: 'Mở ứng dụng để xem.' },
};

/** Các biến được phép dùng trong mẫu thông báo; test kiểm không có biến lạ. */
export const NOTIFICATION_VARIABLES = ['việc', 'lượt', 'n', 'người', 'người gửi', 'hạn'] as const;
