/**
 * Chuỗi của màn Sổ văn bản (/so-van-ban) và hai thẻ nhanh ở Tổng quan, ở apps/web-admin/src/features/documents
 * (docs/DECISIONS.md, 06/10/2026).
 *
 * Cách gọi: "sổ" (sổ văn bản đến, văn bản đi, chỉ thị), "số" (số văn bản do hệ thống cấp), "trích yếu" (nội dung tóm tắt).
 * Biến đặt trong ngoặc nhọn và thay bằng fmt(). Riêng các dấu hiệu của mẫu số ({seq}, {seq:4}, {yyyy}, {yy}) là chữ người dùng
 * thấy và gõ vào ô Mẫu số, nên chúng được ghi nguyên văn và KHÔNG đưa qua fmt().
 */
export const adminDocuments = {
  /** Người chỉ có quyền đổi cài đặt tổ chức: cấu hình được sổ nhưng không xem nội dung văn bản. */
  configOnly: 'Bạn chỉ có quyền cấu hình sổ, không có quyền xem nội dung các văn bản trong sổ.',
  title: 'Sổ văn bản',
  description: 'Số, ngày và trích yếu của văn bản đến, văn bản đi và chỉ thị. Số do hệ thống tự cấp khi khởi chạy quy trình, không ai phải tự đánh.',
  registerLabel: 'Chọn sổ',
  caption: 'Bảng các văn bản trong {sổ}',
  loadFailed: 'Chưa tải được các sổ văn bản.',

  filters: 'Lọc văn bản trong sổ',
  year: 'Năm',
  allYears: 'Tất cả các năm',
  search: 'Tìm theo số hoặc trích yếu',
  searchPlaceholder: 'Gõ số hoặc trích yếu',
  clearFilters: 'Bỏ lọc',

  /** Lọc thêm theo giá trị các cột của sổ, áp dụng cho bảng và cả tệp CSV xuất ra */
  filter: {
    place: 'Nơi gửi, nơi nhận',
    placePlaceholder: 'Gõ tên cơ quan',
    type: 'Loại văn bản',
    allTypes: 'Tất cả các loại',
    urgency: 'Mức khẩn',
    allUrgency: 'Mọi mức khẩn',
    secrecy: 'Mức mật',
    allSecrecy: 'Mọi mức mật',
    from: 'Từ ngày',
    to: 'Đến ngày',
    group: 'Lọc theo cột của sổ',
  },

  /** Xuất sổ ra tệp CSV mở được bằng Excel */
  export: {
    button: 'Xuất CSV',
    exporting: 'Đang xuất…',
    fileName: 'so-van-ban',
    done: 'Đã xuất {n} văn bản ra tệp CSV.',
    empty: 'Không có văn bản nào để xuất.',
    capped: 'Chỉ xuất {n} văn bản đầu tiên. Hãy thu hẹp bộ lọc để xuất phần còn lại.',
    failed: 'Chưa xuất được tệp CSV.',
  },

  /** dòng thông tin dưới các thẻ chọn sổ */
  info: {
    direction: 'Loại: {loại}',
    pattern: 'Mẫu số: {mẫu}',
    next: 'Số kế tiếp: {số}',
    count: '{n} văn bản',
    code: 'Mã sổ: {mã}',
    reset: {
      yearly: 'Đánh lại từ 1 mỗi năm',
      never: 'Không đánh lại số',
    },
  },

  colNumber: 'Số',
  colDate: 'Ngày cấp',
  colSubject: 'Trích yếu',
  colCreatedBy: 'Người tạo',
  colState: 'Tình trạng',
  noSubject: 'Chưa có trích yếu',
  noValue: 'Chưa có',
  yes: 'Có',
  no: 'Không',
  openRun: 'Mở lượt chạy: {tên}',
  colFiles: 'Tài liệu',
  filesButton: 'Tài liệu',
  filesButtonFor: 'Xem tài liệu của văn bản số {số}',
  filesTitle: 'Tài liệu của văn bản số {số}',
  filesDescription: 'Xem ngay trên web hoặc tải xuống. Thêm tài liệu khi lượt chạy còn đang chạy.',
  filesLoadFailed: 'Chưa tải được danh sách tài liệu.',

  direction: {
    incoming: 'Văn bản đến',
    outgoing: 'Văn bản đi',
    internal: 'Chỉ thị và nội bộ',
  },

  /** Tình trạng xử lý của lượt chạy gắn với dòng sổ */
  runState: {
    draft: 'Chưa gửi',
    running: 'Đang xử lý',
    completed: 'Đã hoàn tất',
    cancelled: 'Đã huỷ',
    failed: 'Lỗi hệ thống',
  },

  emptyTitle: 'Chưa có văn bản nào trong sổ này',
  emptyBody: 'Khi một quy trình có ô cấp số được khởi chạy, số và trích yếu sẽ tự vào sổ.',
  emptyFilteredTitle: 'Không có văn bản nào khớp',
  emptyFilteredBody: 'Thử gõ số hoặc từ khoá ngắn hơn, hoặc chọn “Tất cả các năm”.',

  /** Chưa có sổ nào */
  noRegisters: {
    title: 'Chưa có sổ nào',
    bodyAdmin: 'Sổ ghi lại số, ngày và trích yếu của từng văn bản. Nên có ba sổ dưới đây. Sổ cũng tự được tạo khi xuất bản một quy trình dùng ô cấp số của sổ đó.',
    bodyReader: 'Khi người quản trị tạo sổ, sổ sẽ hiện ở đây.',
    recommendedLabel: 'Sổ nên tạo',
    createRecommended: 'Tạo {tên}',
    createCustom: 'Tạo sổ khác',
  },

  /** Ba sổ nên có: mã và mẫu số ghi trong mã (register-form.ts), chữ ở đây */
  recommended: {
    VBDEN: {
      name: 'Sổ văn bản đến',
      hint: 'Vào sổ mọi văn bản gửi đến.',
      columns: ['Nơi gửi', 'Số, ký hiệu', 'Ngày văn bản', 'Loại văn bản', 'Mức khẩn', 'Mức mật', 'Hạn xử lý', 'Người chủ trì'],
    },
    VBDI: {
      name: 'Sổ văn bản đi',
      hint: 'Cấp số cho mọi văn bản phát hành.',
      columns: ['Nơi nhận', 'Loại văn bản', 'Mức khẩn', 'Mức mật', 'Người ký', 'Số lượng bản', 'Ngày ban hành'],
    },
    CHITHI: {
      name: 'Sổ chỉ thị',
      hint: 'Cấp số cho chỉ thị của Chủ tịch.',
      columns: ['Tiêu đề', 'Mức khẩn', 'Hạn hoàn thành'],
    },
  },

  /** Gợi ý ở ô tên lượt chạy khi biểu mẫu có ô trích yếu hoặc tiêu đề (màn Khởi chạy) */
  autoTitleHint: 'Có thể để trống: hệ thống lấy trích yếu hoặc tiêu đề ở biểu mẫu làm tên lượt chạy.',

  /** Xuất danh sách lượt chạy ra tệp CSV (màn Lượt chạy), theo bộ lọc đang chọn */
  runsExport: {
    button: 'Xuất CSV',
    exporting: 'Đang xuất…',
    fileName: 'luot-chay',
    done: 'Đã xuất {n} lượt chạy ra tệp CSV.',
    empty: 'Không có lượt chạy nào để xuất.',
    capped: 'Chỉ xuất {n} lượt chạy đầu tiên. Hãy thu hẹp bộ lọc để xuất phần còn lại.',
    failed: 'Chưa xuất được tệp CSV.',
    colTitle: 'Tên lượt chạy',
    colTemplate: 'Quy trình',
    colState: 'Tình trạng',
    colProgress: 'Việc đã xong',
    colTarget: 'Hạn hoàn thành',
    colInitiator: 'Người khởi chạy',
    colStarted: 'Bắt đầu',
    colCompleted: 'Hoàn tất',
    adhoc: 'Việc giao riêng',
  },

  /** Hộp thoại tạo và sửa sổ */
  config: {
    button: 'Cấu hình sổ',
    buttonFor: 'Cấu hình sổ: {sổ}',
    add: 'Thêm sổ',
    titleCreate: 'Thêm sổ văn bản',
    titleEdit: 'Cấu hình {sổ}',
    introCreate: 'Đặt mã, tên và cách đánh số. Sau đó, ô cấp số của biểu mẫu chỉ cần chọn mã sổ này.',
    introEdit: 'Đổi tên, mẫu số hoặc các cột hiển thị. Số đã cấp giữ nguyên; mẫu số mới chỉ áp dụng cho số cấp từ nay.',
    code: 'Mã sổ',
    codeHint: 'Bắt đầu bằng chữ cái, tối đa 32 ký tự gồm chữ, số và dấu gạch nối. Không đổi được sau khi tạo.',
    codePlaceholder: 'Ví dụ: VBDEN',
    codeRequired: 'Xin nhập mã sổ.',
    codeInvalid: 'Mã sổ phải bắt đầu bằng chữ cái và chỉ gồm chữ, số, dấu gạch nối hoặc gạch dưới (tối đa 32 ký tự).',
    codeTaken: 'Đã có sổ mang mã này. Chọn mã khác, hoặc mở sổ đó để sửa.',
    name: 'Tên sổ',
    namePlaceholder: 'Ví dụ: Sổ văn bản đến',
    nameRequired: 'Xin nhập tên sổ.',
    nameTooLong: 'Tên sổ dài tối đa 200 ký tự.',
    direction: 'Loại sổ',
    pattern: 'Mẫu số',
    patternHint: 'Phần còn lại của mẫu được giữ nguyên, ví dụ “{seq}/VRG-VP” cho văn bản đi hoặc “{seq:4}” cho số đến.',
    patternPlaceholder: '{seq}/VB-{yyyy}',
    patternInvalid: 'Mẫu số cần có {seq} hoặc {seq:4} (số thứ tự) và dài tối đa 100 ký tự. Chỉ dùng thêm {yyyy} hoặc {yy}; không có dấu ngoặc nhọn nào khác.',
    tokens: 'Chèn vào mẫu số',
    token: {
      seq: 'Số thứ tự',
      seq4: 'Số thứ tự đủ 4 chữ số',
      yyyy: 'Năm 4 chữ số',
      yy: 'Năm 2 chữ số',
    },
    insertToken: 'Chèn {dấu}: {nghĩa}',
    previewLabel: 'Xem trước',
    previewFirst: 'Số đầu tiên của năm {năm}',
    previewLater: 'Số thứ {thứ}',
    previewNext: 'Số kế tiếp hiện tại của sổ',
    previewNone: 'Nhập mẫu số hợp lệ để xem trước.',
    reset: 'Đánh lại số từ 1 vào đầu mỗi năm',
    resetHint: 'Tắt nếu muốn số tăng liên tục, không quay về 1 khi sang năm mới.',
    columns: 'Cột hiển thị',
    columnsHint: 'Mỗi cột lấy giá trị từ một ô của biểu mẫu khởi chạy và hiện thêm ở bảng. Tối đa 12 cột.',
    columnsNone: 'Chưa có cột nào. Bảng chỉ hiện số, ngày, trích yếu, người tạo và tình trạng.',
    columnKey: 'Khoá ô',
    columnKeyPlaceholder: 'Ví dụ: noiGui',
    columnKeyOf: 'Khoá ô của cột {số}',
    columnLabel: 'Tên cột',
    columnLabelPlaceholder: 'Ví dụ: Nơi gửi',
    columnLabelOf: 'Tên của cột {số}',
    columnKeyInvalid: 'Khoá ô bắt đầu bằng chữ cái và chỉ gồm chữ, số hoặc dấu gạch dưới.',
    columnKeyDuplicate: 'Khoá ô này đã có ở cột khác.',
    columnLabelRequired: 'Xin nhập tên cột.',
    columnLabelTooLong: 'Tên cột dài tối đa 100 ký tự.',
    addColumn: 'Thêm cột',
    removeColumn: 'Bỏ cột {số}',
    submitCreate: 'Tạo sổ',
    submitEdit: 'Lưu thay đổi',
    created: 'Đã tạo {sổ}.',
    saved: 'Đã lưu cấu hình {sổ}.',
  },

  /** Thẻ nhanh ở Tổng quan, dành cho người có quy trình thuộc nhóm tương ứng mà mình được khởi chạy */
  quickStart: {
    label: 'Việc nhanh',
    directive: {
      title: 'Ra chỉ thị',
      body: 'Soạn chỉ thị, cấp số và giao cho Giám đốc phân công.',
    },
    incoming: {
      title: 'Vào sổ văn bản đến',
      body: 'Ghi văn bản mới nhận vào sổ, lấy số đến và chuyển cho người xử lý.',
    },
    /** chữ chỉ trình đọc màn hình nghe thêm sau nút “Bắt đầu”, để biết nút của thẻ nào, quy trình nào */
    start: ' {việc}: {quy trình}',
    startOne: 'Bắt đầu',
    more: 'Còn {n} quy trình nữa',
  },
} as const;
