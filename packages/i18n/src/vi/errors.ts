import type { ErrorCode } from '@mihato/domain';

/**
 * Mỗi mã lỗi của API (SPEC 10.1) một câu tiếng Việt cho từng nhóm người dùng. App không bao giờ hiện `detail`
 * của máy chủ; app tra `code` ở đây. `satisfies Record<ErrorCode, string>` làm thiếu mã thành lỗi kiểu, và CI kiểm lại.
 *
 * - `staff`: app nhân viên. Ngắn, nói rõ việc cần làm tiếp.
 * - `executive`: app Chủ tịch (SPEC 7.2 điều 8, 7.5). Lỗi luôn nhận về phía hệ thống, không bao giờ nói người dùng sai,
 *   luôn có bước tiếp theo. Dùng biến `{danh xưng}` (mặc định "Chủ tịch").
 * - `admin`: web quản trị. Nói đủ để Văn phòng và quản trị hệ thống tự xử lý.
 *
 * [GIẢ ĐỊNH] mọi câu chờ Chủ tịch hoặc Chánh văn phòng duyệt (SPEC 7.5).
 */
const EXECUTIVE_FALLBACK = 'Dạ, hệ thống chưa làm được việc này. Xin {danh xưng} thử lại, hoặc bấm Nhờ Văn phòng.';
const EXECUTIVE_ASSISTANT_RESTING = 'Trợ lý tạm nghỉ. Tiến độ và Việc cần quyết vẫn dùng bình thường.';

export const errors = {
  staff: {
    unauthenticated: 'Phiên làm việc đã hết. Xin mở khoá lại để tiếp tục.',
    invalid_credentials: 'Mã PIN hoặc mật khẩu chưa khớp. Xin nhập lại.',
    device_revoked: 'Thiết bị này đã được thu hồi. Xin liên hệ Văn phòng để kích hoạt lại.',
    token_expired: 'Phiên làm việc vừa hết hạn. Ứng dụng đang kết nối lại, xin thử lại sau giây lát.',
    forbidden: 'Tài khoản chưa được cấp quyền làm việc này. Nếu cần, xin liên hệ Văn phòng.',
    step_up_required: 'Việc này cần xác nhận bằng vân tay, khuôn mặt hoặc mã PIN. Xin xác nhận rồi làm lại.',
    mfa_required: 'Tài khoản này cần bật xác thực hai bước trên trang quản trị trước khi dùng tiếp.',
    csrf_invalid: 'Phiên làm việc không còn hợp lệ. Xin tải lại trang rồi làm lại.',
    not_found: 'Không tìm thấy nội dung này. Có thể việc đã được chuyển cho người khác.',
    state_conflict: 'Việc này vừa thay đổi: đã xong, đã đổi người, hoặc lượt đã hủy. Xin tải lại để xem tình trạng mới.',
    request_in_progress: 'Yêu cầu trước đang được xử lý. Xin chờ một chút.',
    nudge_throttled: 'Chưa nhắc được việc này lúc này, để tránh làm phiền người nhận. Xin thử lại vào ngày làm việc sau.',
    proposal_not_pending: 'Đề xuất này đã được xử lý trước đó. Xin tải lại danh sách.',
    undo_window_closed: 'Đã quá thời gian hoàn tác, nội dung đã được gửi đi.',
    proposal_expired: 'Đề xuất để quá lâu nên đã hết hiệu lực. Xin tạo lại.',
    precondition_failed: 'Nội dung đã được sửa ở nơi khác trong lúc đang mở. Xin tải lại rồi làm lại.',
    input_invalid: 'Thông tin gửi lên chưa hợp lệ. Xin xem lại các ô được đánh dấu.',
    template_invalid: 'Mẫu quy trình còn điểm chưa đúng nên chưa dùng được. Xin báo Văn phòng.',
    batch_not_allowed: 'Có mục cần xác nhận riêng. Xin xác nhận từng mục một.',
    idempotency_key_reuse: 'Hệ thống nhận trùng một yêu cầu. Xin làm lại thao tác.',
    idempotency_key_required: 'Yêu cầu chưa đủ thông tin để chống gửi trùng. Xin cập nhật ứng dụng rồi làm lại.',
    account_locked: 'Tài khoản tạm khoá vì nhập chưa khớp nhiều lần. Xin thử lại sau ít phút, hoặc liên hệ Văn phòng.',
    app_update_required: 'Bản ứng dụng này đã cũ. Xin cập nhật bản mới để dùng tiếp.',
    rate_limited: 'Hệ thống đang nhận quá nhiều yêu cầu. Xin chờ một chút rồi thử lại.',
    quota_exceeded: 'Trợ lý đã hết lượt dùng trong hôm nay. Các chức năng khác vẫn dùng bình thường.',
    ai_disabled: 'Trợ lý AI đang tắt. Các chức năng khác vẫn dùng bình thường.',
    internal_error: 'Hệ thống gặp trục trặc. Xin thử lại sau ít phút.',
  } satisfies Record<ErrorCode, string>,

  executive: {
    unauthenticated: 'Dạ, phiên làm việc đã hết. Xin {danh xưng} mở khoá lại.',
    invalid_credentials: 'Dạ, mã PIN chưa khớp. Xin {danh xưng} nhập lại, hoặc bấm Nhờ Văn phòng.',
    device_revoked: 'Dạ, máy này đã được thu hồi quyền dùng. Xin {danh xưng} bấm Nhờ Văn phòng để được cấp lại.',
    token_expired: 'Dạ, hệ thống đang kết nối lại. Xin {danh xưng} chờ một chút rồi thử lại.',
    forbidden: 'Dạ, việc này chưa nằm trong phần quyền của tài khoản. Xin {danh xưng} bấm Nhờ Văn phòng.',
    step_up_required: 'Dạ, việc này cần xác nhận bằng vân tay, khuôn mặt hoặc mã PIN. Xin {danh xưng} xác nhận rồi làm lại.',
    mfa_required: EXECUTIVE_FALLBACK,
    csrf_invalid: EXECUTIVE_FALLBACK,
    not_found: 'Dạ, hệ thống không tìm thấy nội dung này. Xin {danh xưng} quay lại màn hình trước, hoặc bấm Nhờ Văn phòng.',
    state_conflict: 'Dạ, việc này vừa có thay đổi. Xin {danh xưng} xem lại tình trạng mới.',
    request_in_progress: 'Dạ, hệ thống đang xử lý. Xin {danh xưng} chờ một chút.',
    nudge_throttled: 'Dạ, việc này vừa được nhắc gần đây nên hệ thống chưa gửi thêm, để tránh làm phiền. Xin {danh xưng} nhắc lại vào ngày làm việc sau.',
    proposal_not_pending: 'Dạ, đề xuất này đã được xử lý rồi. Xin {danh xưng} xem lại danh sách.',
    undo_window_closed: 'Dạ, đã quá thời gian hoàn tác nên nội dung đã được gửi. Nếu cần, xin {danh xưng} bấm Nhờ Văn phòng.',
    proposal_expired: 'Dạ, đề xuất để lâu nên đã hết hiệu lực. Xin {danh xưng} nói lại với trợ lý để soạn lại.',
    precondition_failed: 'Dạ, nội dung vừa được cập nhật ở nơi khác. Xin {danh xưng} xem lại bản mới.',
    input_invalid: 'Dạ, hệ thống chưa nhận đủ thông tin. Xin {danh xưng} xem lại, hoặc bấm Nhờ Văn phòng.',
    template_invalid: 'Dạ, mẫu quy trình này chưa dùng được. Xin {danh xưng} bấm Nhờ Văn phòng.',
    batch_not_allowed: 'Dạ, trong danh sách có việc cần xác nhận riêng. Xin {danh xưng} xem từng việc một.',
    idempotency_key_reuse: EXECUTIVE_FALLBACK,
    idempotency_key_required: EXECUTIVE_FALLBACK,
    account_locked: 'Dạ, hệ thống tạm khoá để giữ an toàn sau nhiều lần nhập mã chưa khớp. Xin {danh xưng} chờ ít phút, hoặc bấm Nhờ Văn phòng.',
    app_update_required: 'Dạ, ứng dụng cần được cập nhật bản mới. Xin {danh xưng} bấm Nhờ Văn phòng để được hỗ trợ.',
    rate_limited: 'Dạ, hệ thống đang bận. Xin {danh xưng} chờ một chút rồi thử lại.',
    quota_exceeded: EXECUTIVE_ASSISTANT_RESTING,
    ai_disabled: EXECUTIVE_ASSISTANT_RESTING,
    internal_error: EXECUTIVE_FALLBACK,
  } satisfies Record<ErrorCode, string>,

  admin: {
    unauthenticated: 'Chưa đăng nhập hoặc phiên đã hết. Xin đăng nhập lại.',
    invalid_credentials: 'Thư điện tử, mật khẩu hoặc mã xác thực chưa đúng.',
    device_revoked: 'Thiết bị đã bị thu hồi.',
    token_expired: 'Phiên đăng nhập đã hết hạn. Xin đăng nhập lại.',
    forbidden: 'Vai trò hiện tại không có quyền làm việc này.',
    step_up_required: 'Thao tác này cần mã nâng quyền còn hiệu lực.',
    mfa_required: 'Tài khoản này phải bật xác thực hai bước trước khi dùng tiếp. Xin bật ở màn hiện ra.',
    csrf_invalid: 'Mã chống giả mạo yêu cầu không hợp lệ. Xin tải lại trang rồi làm lại.',
    not_found: 'Không tìm thấy, hoặc nằm ngoài tầm nhìn của tài khoản.',
    state_conflict: 'Việc hoặc lượt chạy không còn ở trạng thái cho phép thao tác này. Xin tải lại để xem trạng thái hiện tại.',
    request_in_progress: 'Yêu cầu cùng khoá đang được xử lý. Xin chờ.',
    nudge_throttled: 'Chưa gửi được lời nhắc vì quy tắc chống làm phiền. Xem giờ được nhắc lại ở chi tiết việc.',
    proposal_not_pending: 'Đề xuất đã được xử lý trước đó: đã đồng ý, không gửi, hoàn tác hoặc chưa thực hiện được.',
    undo_window_closed: 'Đã quá thời gian hoàn tác, hiệu lực đã chạy.',
    proposal_expired: 'Đề xuất đã hết hạn.',
    precondition_failed: 'Bản nháp đã được người khác lưu trước. Xin tải bản mới rồi sửa tiếp.',
    input_invalid: 'Dữ liệu chưa hợp lệ. Xem chi tiết ở từng ô.',
    template_invalid: 'Mẫu quy trình còn lỗi kiểm tra nên chưa xuất bản được. Xem danh sách lỗi bên dưới.',
    batch_not_allowed: 'Lô đề xuất có mục mức 2. Mục mức 2 phải xác nhận riêng từng mục.',
    idempotency_key_reuse: 'Khoá chống lặp đã dùng cho một yêu cầu khác nội dung.',
    idempotency_key_required: 'Yêu cầu ghi thiếu khoá chống lặp.',
    account_locked: 'Tài khoản tạm khoá do đăng nhập chưa đúng nhiều lần. Thử lại sau ít phút, hoặc nhờ quản trị hệ thống mở khoá.',
    app_update_required: 'Bản ứng dụng thấp hơn mức tối thiểu của tổ chức. Xin cập nhật.',
    rate_limited: 'Quá nhiều yêu cầu. Xin chờ rồi thử lại.',
    quota_exceeded: 'Đã hết hạn mức gọi trợ lý trong ngày.',
    ai_disabled: 'Trợ lý AI đang tắt theo cấu hình của tổ chức.',
    internal_error: 'Hệ thống gặp trục trặc. Xin thử lại; nếu vẫn còn, báo quản trị hệ thống kèm mã yêu cầu.',
  } satisfies Record<ErrorCode, string>,
} as const;
