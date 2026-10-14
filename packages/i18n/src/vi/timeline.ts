import type { EngineEventType, NudgeReply, RunChange, RunOutcome } from '@mihato/domain';

/**
 * Câu của dòng thời gian trên web và hai app: một câu cho mỗi loại sự kiện engine (`EngineEventType`)
 * và mỗi loại thay đổi dẫn xuất (`RunChange['type']`). `satisfies` làm thiếu loại thành lỗi kiểu.
 *
 * Biến: {người} người thao tác (với `step.activated` là người nhận), {người nhận} người được giao hoặc được nhắc,
 * {người ủy quyền} người gốc khi làm thay, {việc}, {lượt}, {hạn}, {từ}, {đến}, {lý do}, {trả lời}, {nội dung}.
 * Tên người điền theo SPEC 7.5: lần đầu "chị Nguyễn Thu Lan", sau đó "chị Lan".
 * Không dùng "từ chối": duyệt là "đồng ý" hoặc "chưa đồng ý".
 */

type ChangeOf<T extends RunChange['type']> = Extract<RunChange, { type: T }>;

export const timeline = {
  /** Một câu cho mỗi sự kiện gốc (một dòng `run_events`). */
  event: {
    StartRun: '{người} khởi chạy lượt ‘{lượt}’',
    AssignStep: '{người} giao ‘{việc}’ cho {người nhận}',
    UnassignStep: '{người} thu lại ‘{việc}’ để giao người khác',
    AcceptStep: '{người} đã nhận ‘{việc}’',
    CompleteStep: '{người} báo hoàn thành ‘{việc}’',
    ApproveStep: '{người} đồng ý ‘{việc}’',
    RejectStep: '{người} chưa đồng ý ‘{việc}’',
    RequestExtension: '{người} xin thêm thời gian cho ‘{việc}’, đề nghị hạn mới {hạn}',
    DeclineExtension: '{người} chưa duyệt yêu cầu thêm thời gian của ‘{việc}’',
    ExtendDue: '{người} đổi hạn ‘{việc}’ sang {hạn}',
    Reassign: '{người} giao lại ‘{việc}’ cho {người nhận}',
    SkipStep: '{người} cho bỏ qua ‘{việc}’',
    CancelRun: '{người} hủy lượt ‘{lượt}’',
    TimerFired: 'Đến mốc nhắc tự động của ‘{việc}’',
    NudgeSent: '{người} đi thúc {người nhận} về ‘{việc}’',
    ReportBlocked: '{người} báo vướng ở ‘{việc}’',
    AddNote: '{người} ghi chú',
  } satisfies Record<EngineEventType, string>,

  /** Một câu chung cho mỗi loại thay đổi dẫn xuất. Câu chi tiết hơn theo từng giá trị nằm ở `detail`. */
  change: {
    'run.started': 'Lượt chạy bắt đầu',
    'run.completed': 'Lượt chạy kết thúc',
    'run.cancelled': 'Lượt chạy đã hủy. Lý do: {lý do}',
    'step.activated': 'Giao ‘{việc}’ cho {người}, hạn {hạn}',
    'step.state': '‘{việc}’ chuyển từ “{từ}” sang “{đến}”',
    'step.assignee': 'Đổi người nhận ‘{việc}’ từ {từ} sang {đến}',
    'step.due': 'Đổi hạn ‘{việc}’ từ {từ} sang {đến}',
    'step.blocked': '‘{việc}’ đang vướng: {lý do}',
    'extension.requested': '{người} xin thêm thời gian cho ‘{việc}’ đến {hạn}. Lý do: {lý do}',
    'extension.decided': 'Đã có quyết định về yêu cầu thêm thời gian của ‘{việc}’',
    'approval.decided': '{người} đã quyết ‘{việc}’',
    'nudge.sent': '{người} nhắc {người nhận} về ‘{việc}’',
    'nudge.replied': '{người} trả lời lời nhắc về ‘{việc}’: {trả lời}',
    'reminder.sent': 'Đã nhắc tự động về ‘{việc}’',
    'reminder.suppressed': 'Bỏ qua một lần nhắc tự động về ‘{việc}’: {lý do}',
    note: 'Ghi chú: {nội dung}',
  } satisfies Record<RunChange['type'], string>,

  /** Câu theo từng giá trị của thay đổi, dùng khi cần nói rõ hơn câu chung. */
  detail: {
    runCompleted: {
      success: 'Lượt chạy hoàn tất',
      rejected: 'Lượt chạy kết thúc vì chưa được đồng ý',
    } satisfies Record<RunOutcome, string>,
    stepActivated: {
      assigned: 'Giao ‘{việc}’ cho {người}, hạn {hạn}',
      assignedNoDue: 'Giao ‘{việc}’ cho {người}',
      onBehalfOf: 'Giao ‘{việc}’ cho {người}, thay mặt {người ủy quyền}, hạn {hạn}',
      unassigned: '‘{việc}’ đã tới lượt nhưng chưa có người nhận',
    },
    stepAssignee: {
      changed: 'Đổi người nhận ‘{việc}’ từ {từ} sang {đến}',
      assigned: 'Giao ‘{việc}’ cho {đến}',
      cleared: 'Thu lại ‘{việc}’ từ {từ}',
      onBehalfOf: 'Giao ‘{việc}’ cho {đến}, thay mặt {người ủy quyền}',
    },
    stepDue: {
      set: 'Đặt hạn ‘{việc}’: {đến}',
      changed: 'Đổi hạn ‘{việc}’ từ {từ} sang {đến}',
    },
    extensionDecided: {
      approved: 'Đã duyệt thêm thời gian cho ‘{việc}’',
      declined: 'Chưa duyệt thêm thời gian cho ‘{việc}’',
    } satisfies Record<ChangeOf<'extension.decided'>['decision'], string>,
    approvalDecided: {
      approved: '{người} đồng ý ‘{việc}’',
      rejected: '{người} chưa đồng ý ‘{việc}’',
    } satisfies Record<ChangeOf<'approval.decided'>['decision'], string>,
    nudgeReplied: {
      done: '{người} trả lời lời nhắc về ‘{việc}’: đã xong',
      need_time: '{người} trả lời lời nhắc về ‘{việc}’: cần thêm thời gian',
      blocked: '{người} trả lời lời nhắc về ‘{việc}’: đang vướng, cần hỗ trợ',
    } satisfies Record<NudgeReply, string>,
    reminderSent: {
      reminder: 'Đã nhắc tự động: ‘{việc}’ sắp đến hạn',
      overdue: 'Đã nhắc tự động: ‘{việc}’ quá hạn',
      escalation: 'Đã báo cấp trên: ‘{việc}’ đang quá hạn',
      wait: 'Đã hết thời gian chờ của ‘{việc}’',
    },
    reminderSuppressed: {
      not_open: 'Không nhắc ‘{việc}’ vì việc không còn mở',
      already_reminded_today: 'Không nhắc thêm ‘{việc}’ vì hôm nay đã nhắc một lần',
      recently_nudged: 'Không nhắc tự động ‘{việc}’ vì vừa được đi thúc',
      no_recipient: 'Không nhắc được ‘{việc}’ vì chưa có người nhận',
    } satisfies Record<ChangeOf<'reminder.suppressed'>['why'], string>,
  },

  /** Người thao tác khi không phải một người dùng bình thường. */
  actor: {
    system: 'Hệ thống',
    ai: 'Trợ lý AI, do {người} đồng ý',
    onBehalfOf: '{người} thay mặt {người ủy quyền}',
    unknown: 'Không rõ',
  },

  /** Dòng nhỏ kèm lời nhắc do AI soạn (SPEC 4.7, 6.8). */
  aiDrafted: 'do Trợ lý AI soạn',
} as const;
