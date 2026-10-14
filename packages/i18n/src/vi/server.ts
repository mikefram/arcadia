/**
 * Câu chữ do MÁY CHỦ dựng (CLAUDE.md luật 3 và 7): câu xác nhận của đề xuất và lời báo cáo đầu ngày.
 * Đây là mẫu cố định; không có chữ nào của LLM được dùng làm câu xác nhận (SPEC 6.5 điều 3).
 * [GIẢ ĐỊNH] câu chữ chờ Chủ tịch hoặc Chánh văn phòng duyệt như các mẫu khác ở SPEC 7.5.
 */
export const server = {
  /** Mẫu câu xác nhận của từng tool đề xuất. Sửa mẫu thì test ảnh chụp ở packages/backend đổi theo. */
  proposals: {
    note: {
      withRun: 'Ghi chú vào lượt ‘{lượt}’: “{ghi chú}”.',
      noRun: 'Ghi chú: “{ghi chú}”.',
    },
    nudge: {
      summary: 'Gửi lời nhắc tới {người} về việc ‘{việc}’ của lượt ‘{lượt}’, {tình trạng}.',
      item: '{Người}: việc ‘{việc}’, {tình trạng}.',
      late: 'đã quá hạn {n} ngày làm việc',
      lateToday: 'đã quá hạn',
      notLate: 'chưa quá hạn',
    },
    startRun: {
      summary: 'Khởi chạy quy trình ‘{mẫu}’ với tên ‘{tên}’, gồm {n} việc.',
      pastDue: 'Có {k} việc đã qua hạn ngay lúc khởi chạy.',
      item: '‘{việc}’: {người}, {hạn}.',
      noAssignee: 'chưa xác định người nhận',
      due: 'hạn {ngày}',
      duePast: 'hạn {ngày} (đã qua)',
      noDue: 'chưa có hạn',
    },
    reassign: {
      summary: 'Chuyển việc ‘{việc}’ của lượt ‘{lượt}’ từ {người cũ} sang {người mới}.',
      unassigned: 'Giao việc ‘{việc}’ của lượt ‘{lượt}’ cho {người mới}.',
    },
    extendDue: {
      summary: 'Đổi hạn việc ‘{việc}’ của lượt ‘{lượt}’ từ {hạn cũ} sang {hạn mới}.',
      noDue: 'Đặt hạn việc ‘{việc}’ của lượt ‘{lượt}’ là {hạn mới}.',
      holder: 'Người đang giữ việc: {người}.',
    },
    cancelRun: {
      // App Chủ tịch không dùng chữ "hủy" trên nút và câu xác nhận (SPEC 7.5): nói rõ là dừng cái gì.
      summary: 'Dừng hẳn lượt ‘{lượt}’. {n} việc chưa xong của lượt này sẽ thôi không làm.',
    },
    /** Tạo bản nháp quy trình từ lời đọc từng bước (docs/DECISIONS.md, 04/10/2026). Mỗi bước là một câu để đọc lại và hiện thành thẻ. */
    createProcess: {
      summary: 'Tạo bản nháp quy trình ‘{tên}’ gồm {n} bước. Bản nháp chưa giao việc cho ai.',
      stepTask: 'Bước {n}: ‘{việc}’, {người} làm, hạn {k} ngày làm việc.',
      stepApproval: 'Bước {n}: ‘{việc}’, {người} duyệt, hạn {k} ngày làm việc.',
      parallel: 'Làm cùng lúc với bước trước.',
      initiator: 'người giao việc',
      /** Mô tả mặc định của bản nháp khi người dùng không nói gì, để người xem danh sách quy trình biết bản nháp này do trợ lý soạn. */
      defaultDescription: 'Soạn bằng cách trò chuyện với Trợ lý AI, {ngày}.',
    },
    /** Xuất bản bản nháp, có thể giao việc ngay. Dòng từng việc dùng lại mẫu `startRun.item`. */
    publishProcess: {
      summary: 'Xuất bản quy trình ‘{mẫu}’, phiên bản {k}, để có thể giao việc theo quy trình này.',
      summaryWithRun: 'Xuất bản quy trình ‘{mẫu}’, phiên bản {k}, và giao việc ngay với tên ‘{tên}’, gồm {n} việc.',
    },
    /** Giao một việc ngoài quy trình (docs/DECISIONS.md, 05/10/2026). Hạn dùng lại `startRun.due` và `startRun.duePast`. */
    assignTask: {
      summary: 'Giao việc ‘{việc}’ cho {người}, {hạn}.',
      note: 'Nội dung ghi kèm: “{nội dung}”.',
    },
    reason: 'Lý do ghi lại: “{lý do}”.',
    unknownPerson: 'người chưa rõ',
  },
  /** Nhãn trong mẫu một việc ẩn của việc ngoài quy trình; người dùng không thấy, nhưng vẫn là chữ nên nằm ở kho chuỗi chung. */
  adhoc: {
    dueLabel: 'Hạn xong',
  },
  /**
   * Mẫu câu của báo cáo tổng hợp đầu ngày (SPEC 6.7, đổi theo docs/DECISIONS.md 05/10/2026): ba phần là việc chưa xong,
   * việc đã xong từ hôm qua và việc dự kiến xong hôm nay. Mỗi phần mở bằng các câu số liệu rồi mới đến chi tiết.
   */
  briefing: {
    opening: 'Thưa {danh xưng}, báo cáo tổng hợp đầu ngày {ngày}, {ngày âm}.',
    open: {
      some: 'Hiện còn {n} việc chưa xong.',
      none: 'Hiện không còn việc nào chưa xong.',
      decisions: 'Có {n} việc cần {danh xưng} quyết.',
      overdue: 'Có {n} việc đang quá hạn.',
      unassigned: 'Có {n} việc chưa có người nhận.',
      decisionLine: 'Cần quyết: ‘{việc}’ của lượt ‘{lượt}’.',
      overdueLine: '{Người}: ‘{việc}’, đã quá hạn {k} ngày làm việc.',
      overdueLineToday: '{Người}: ‘{việc}’, vừa quá hạn.',
      overdueLineNoOne: '‘{việc}’ chưa có người nhận, đã quá hạn {k} ngày làm việc.',
    },
    due: {
      some: 'Dự kiến hôm nay có {n} việc hoàn thành.',
      none: 'Hôm nay chưa có việc nào đến hạn.',
      line: '‘{việc}’, {người}.',
    },
    completed: {
      some: '{Từ lúc} có {n} việc đã xong.',
      none: '{Từ lúc} chưa có việc nào xong.',
      line: '‘{việc}’, {người}.',
      run: 'Lượt ‘{lượt}’ đã hoàn tất.',
      sinceYesterday: 'từ hôm qua',
      sincePreviousWorkday: 'từ ngày làm việc trước',
    },
    more: 'Và {n} việc khác.',
    noAssignee: 'chưa có người nhận',
  },
  /** Cảnh báo ngân sách AI hằng tháng (SPEC 12.6): chỉ cảnh báo, không tự cắt trợ lý; Quản trị hệ thống quyết định. */
  aiBudget: {
    warn80: 'Chi phí trợ lý AI tháng này ước tính {chi phí} trên ngân sách {ngân sách}, đã đạt {n}%. Hệ thống không tự cắt trợ lý.',
    warn100: 'Chi phí trợ lý AI tháng này ước tính {chi phí} trên ngân sách {ngân sách}, đã vượt ngân sách. Hệ thống không tự cắt trợ lý; Quản trị hệ thống quyết định.',
  },
  /**
   * Thư kích hoạt tài khoản gửi khi thêm người dùng có email (và khi quản trị bấm "Gửi lại"). Thư là kênh riêng tới
   * đúng người nhận nên được ghi tên người; đường dẫn dùng một lần, hết hạn sau 72 giờ.
   */
  inviteEmail: {
    subject: '[{tổ chức}] Kích hoạt tài khoản của {tên}',
    greeting: 'Kính gửi {tên},',
    intro: 'Tài khoản của {tên} trên hệ thống điều hành công việc của {tổ chức} đã được tạo.',
    action: 'Để bắt đầu, xin đặt mật khẩu đăng nhập web bằng đường dẫn dưới đây (dùng được một lần, hết hạn lúc {hạn}):',
    button: 'Đặt mật khẩu',
    afterwards: 'Sau khi đặt mật khẩu, đăng nhập tại {web} bằng email này. Mã kích hoạt ứng dụng trên điện thoại do Văn phòng cấp riêng.',
    expired: 'Nếu đường dẫn đã hết hạn, xin báo Văn phòng để được gửi lại.',
    ignore: 'Nếu không phải {tên} được thêm vào hệ thống, xin bỏ qua thư này.',
    signature: 'Hệ thống điều hành công việc {tổ chức}',
  },
  deadEffect: 'Có một tác vụ hệ thống chưa thực hiện được sau nhiều lần thử. Xem ở màn Thông báo và nhật ký.',
} as const;
