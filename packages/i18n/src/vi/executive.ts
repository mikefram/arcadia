import { fmt } from '../fmt';

/**
 * Chuỗi của app Chủ tịch (SPEC 7), nhóm theo màn hình M0 đến M7, M3 và M3b.
 *
 * Quy tắc viết (SPEC 7.2, 7.5, 7.6) và là [GIẢ ĐỊNH] cho tới khi Chủ tịch hoặc Chánh văn phòng duyệt từng câu:
 * - Trợ lý tự xưng "trợ lý", gọi người dùng bằng chức danh. Cách gọi cấu hình được theo từng người,
 *   nên mọi câu dùng biến `{danh xưng}` (mặc định "Chủ tịch") thay vì viết cứng. `{danh xưng}` không đứng đầu câu.
 * - Lỗi nhận về phía hệ thống và luôn có bước tiếp theo. Không có câu nào nói người dùng sai.
 * - Hai nút xác nhận là "Đồng ý gửi" và "Không gửi"; duyệt là "Đồng ý" và "Chưa đồng ý". Không dùng "Hủy", "Từ chối".
 * - Không có gì tự biến mất: kết quả nằm yên tới khi bấm "Đã rõ".
 * - Mọi nút có chữ. Nhãn `a11y` là chữ đọc cho VoiceOver và TalkBack.
 *
 * Biến trong mẫu điền bằng `fmtExecutive()`: {danh xưng}, {n}, {người}, {việc}, {lượt}, {hạn}, {giờ}, {ngày}…
 */

/** Cách gọi mặc định khi người dùng chưa cấu hình. */
export const DEFAULT_ADDRESS = 'Chủ tịch';

/** Điền mẫu của app Chủ tịch, tự thêm `{danh xưng}`. */
export function fmtExecutive(template: string, vars: Record<string, string | number> = {}, address: string = DEFAULT_ADDRESS): string {
  return fmt(template, { 'danh xưng': address, ...vars });
}

export const executive = {
  /** Cách trợ lý gọi người dùng: mặc định theo vai trò, người dùng đổi được ở Cài đặt. */
  address: {
    default: DEFAULT_ADDRESS,
    byRole: { chairman: 'Chủ tịch', director: 'Giám đốc', deputy: 'Phó giám đốc' },
  },

  /** Nhãn cố định trên màn hình trợ lý (SPEC 6.8): ngoại lệ duy nhất được giữ chữ "AI". */
  assistantLabel: 'Trợ lý AI',

  /** Thanh điều hướng đáy và hai nút góc trên phải, có ở mọi màn hình (SPEC 7.4). */
  nav: {
    home: 'Trang chủ',
    assistant: 'Trợ lý',
    progress: 'Tiến độ',
    settings: 'Cài đặt',
    askOffice: 'Nhờ Văn phòng',
    back: 'Quay lại',
    understood: 'Đã rõ',
  },

  /** Nhờ Văn phòng: gọi thẳng Chánh văn phòng (SPEC 7.2 điều 10, 7.7). */
  office: {
    button: 'Nhờ Văn phòng',
    title: 'Gọi cho Văn phòng',
    body: 'Máy sẽ gọi điện cho Chánh văn phòng để được hỗ trợ.',
    call: 'Gọi ngay',
    notNow: 'Chưa gọi',
    noPhone: 'Dạ, hệ thống chưa có số điện thoại của Văn phòng. Xin {danh xưng} báo Văn phòng để bổ sung.',
    a11y: 'Nhờ Văn phòng. Gọi điện cho Chánh văn phòng.',
    phone: 'Số điện thoại Văn phòng: {n}',
    callFailed: 'Dạ, máy chưa gọi được. Xin {danh xưng} tự bấm số trên, hoặc thử lại.',
  },

  /** M0 Mở khoá. */
  unlock: {
    title: 'Xin {danh xưng} nhập mã PIN',
    hint: 'Mã gồm 6 chữ số',
    entered: 'Đã nhập {n} trên 6 số',
    useBiometric: 'Dùng vân tay hoặc khuôn mặt',
    biometricPrompt: 'Xin {danh xưng} xác nhận để mở khoá',
    deleteKey: 'Xoá một số',
    wrong: 'Dạ, mã PIN chưa khớp. Xin {danh xưng} nhập lại.',
    wrongWithHelp: 'Dạ, mã PIN vẫn chưa khớp. Xin {danh xưng} nhập lại, hoặc bấm Nhờ Văn phòng.',
    lockedOut: 'Dạ, hệ thống tạm khoá {n} phút để giữ an toàn. Xin {danh xưng} chờ, hoặc bấm Nhờ Văn phòng.',
    opening: 'Đang mở khoá, xin {danh xưng} chờ một chút.',
    a11yDigit: 'Số {n}',
    deleteShort: 'Xoá',
    attemptsLeft: 'Còn {n} lần nhập.',
    confirmTitle: 'Xin {danh xưng} nhập mã PIN để xác nhận',
    confirmSkip: 'Chưa xác nhận',
  },

  /** M1 Trang chủ. */
  home: {
    /** Khoá khớp với kết quả của `dayPart()`: sáng, trưa, chiều, tối. */
    greeting: {
      sáng: 'Chào buổi sáng, thưa {danh xưng}.',
      trưa: 'Chào buổi trưa, thưa {danh xưng}.',
      chiều: 'Chào buổi chiều, thưa {danh xưng}.',
      tối: 'Chào buổi tối, thưa {danh xưng}.',
    },
    today: 'Hôm nay là {ngày}',
    lunar: 'Âm lịch: {ngày âm}',
    officeGreeting: 'Lời chúc từ Văn phòng',
    briefing: {
      listen: 'Nghe báo cáo tổng hợp đầu ngày',
      read: 'Đọc báo cáo tổng hợp đầu ngày',
      stop: 'Dừng đọc',
      listenAgain: 'Nghe lại',
      playing: 'Trợ lý đang đọc báo cáo tổng hợp đầu ngày.',
      preparing: 'Đang chuẩn bị báo cáo, xin {danh xưng} chờ một chút.',
      builtAt: 'Báo cáo lúc {giờ}',
      notReady: 'Báo cáo tổng hợp đầu ngày chưa dựng được. Xin {danh xưng} thử lại sau ít phút.',
      finished: 'Đã đọc xong báo cáo tổng hợp đầu ngày.',
      sections: {
        open: 'Việc chưa xong',
        completed: 'Việc đã xong từ hôm qua',
        due: 'Việc dự kiến xong hôm nay',
      },
    },
    cards: {
      talk: 'Nói với trợ lý',
      talkHint: 'Hỏi tình hình, giao việc, đi thúc',
      progress: 'Xem tiến độ',
      progressHint: 'Các lượt đang chạy',
      decisions: 'Việc cần {danh xưng} quyết',
      decisionsCount: 'Có {n} việc đang chờ',
      decisionsNone: 'Hiện chưa có việc nào chờ quyết',
    },
    delegationBanner: 'Đang ủy quyền cho {người} đến ngày {ngày}',
    offline: 'Đang không có mạng. Số liệu lúc {giờ}.',
  },

  /** M2 Trợ lý: hội thoại bằng giọng nói, luôn có đường gõ chữ (SPEC 6.6, 6.10, 6.11). */
  assistant: {
    label: 'Trợ lý AI',
    acknowledge: 'Dạ, thưa {danh xưng}.',
    prompt: 'Xin {danh xưng} bấm nút micro để trò chuyện với trợ lý.',
    /**
     * Chế độ trò chuyện (docs/DECISIONS.md, 04/10/2026): bấm micro một lần, trợ lý nghe liên tục; {danh xưng} ngừng nói thì
     * trợ lý tự trả lời; đọc xong thì nghe tiếp, cho tới khi bấm dừng. Micro chỉ mở ở lúc "đang nghe" và màn hình luôn nói rõ.
     */
    voiceStart: 'Bấm để trò chuyện',
    voiceStop: 'Bấm để dừng trò chuyện',
    voiceChip: 'Đang trò chuyện',
    voiceIntro: 'Xin {danh xưng} cứ nói bình thường. Khi {danh xưng} ngừng nói, trợ lý sẽ trả lời.',
    voiceDone: 'Đã nói xong',
    voiceInterrupt: 'Ngắt lời',
    voiceIdle: 'Dạ, trợ lý đã ngừng nghe vì lâu chưa nghe thấy {danh xưng} nói. Bấm micro khi cần trò chuyện tiếp.',
    /** Máy chủ đóng phiên êm khi đang trò chuyện (ví dụ phiên chạm giới hạn thời gian): micro đã đóng, nói rõ để người dùng không hoang mang. */
    voiceEnded: 'Dạ, cuộc trò chuyện đã kết thúc. Bấm micro khi cần trò chuyện tiếp.',
    /** Khoảnh khắc ngắn giữa lúc bấm (hoặc giữa hai lượt) và lúc micro thật sự mở: không được báo "đang nghe" khi chưa nghe. */
    voiceOpening: 'Đang mở micro, xin {danh xưng} chờ một chút.',
    listening: 'Trợ lý đang nghe',
    heardTitle: 'Trợ lý nghe được',
    processing: 'Trợ lý đang xử lý, xin {danh xưng} chờ một chút.',
    processingShort: 'Trợ lý đang xử lý',
    waitSpoken: 'Dạ, xin {danh xưng} chờ một chút.',
    waitLonger: 'Xin chờ thêm một chút',
    unclear: 'Dạ, trợ lý nghe chưa rõ, xin {danh xưng} nhắc lại.',
    unclearTwice: 'Dạ, trợ lý vẫn nghe chưa rõ. Xin {danh xưng} gõ chữ, hoặc bấm Nhờ Văn phòng.',
    understood: 'Dạ, trợ lý hiểu như sau:',
    typeInstead: 'Gõ chữ',
    typePlaceholder: 'Gõ điều cần hỏi hoặc cần giao',
    speakInstead: 'Nói',
    sendTyped: 'Gửi',
    stopSpeaking: 'Dừng đọc',
    readAloud: 'Đọc lại',
    resting: 'Trợ lý tạm nghỉ.',
    restingBody: 'Tiến độ và Việc cần quyết vẫn dùng bình thường.',
    sttFailed: 'Dạ, trợ lý chưa nghe được. Xin {danh xưng} gõ chữ, hoặc bấm Thử lại.',
    retry: 'Thử lại',
    micDenied: 'Dạ, ứng dụng chưa được phép dùng micro. Xin {danh xưng} gõ chữ, hoặc bấm Nhờ Văn phòng để được bật giúp.',
    choosePerson: 'Dạ, {người} nào ạ?',
    choosePersonHint: 'Xin {danh xưng} chạm vào người cần chọn.',
    notSure: 'Dạ, trợ lý chưa chắc về điều này nên xin hỏi lại.',
    beyondAuthority: 'Dạ, việc này trợ lý không được làm thay. Xin {danh xưng} làm trực tiếp trên màn hình, hoặc bấm Nhờ Văn phòng.',
    noteSaved: 'Dạ, trợ lý đã ghi lại.',
    openReview: 'Xem lại đề xuất',
    openDecisions: 'Mở Việc cần quyết',
    openProgress: 'Mở Tiến độ',
    dailyLimit: 'Dạ, hôm nay trợ lý đã hết lượt. Tiến độ và Việc cần quyết vẫn dùng bình thường.',
    suggestionsTitle: 'Có thể hỏi trợ lý',
    suggestions: {
      status: 'Tình hình lượt ‘{lượt}’ thế nào?',
      late: 'Ai đang chậm?',
      decisions: 'Việc nào cần tôi quyết?',
      week: 'Tuần này có gì đến hạn?',
      person: '{người} đang giữ những việc gì?',
      nudge: 'Đi thúc các việc đang chậm',
    },
    a11yVoiceStart: 'Nút micro. Bấm để trò chuyện với trợ lý. Trợ lý nghe liên tục cho tới khi bấm dừng.',
    a11yVoiceStop: 'Nút dừng trò chuyện. Bấm để trợ lý ngừng nghe.',
    speaking: 'Trợ lý đang đọc',
    connecting: 'Đang mở trợ lý, xin {danh xưng} chờ một chút.',
    micUnsupported: 'Dạ, máy này chưa thu âm được. Xin {danh xưng} gõ chữ.',
    askedTitle: 'Câu vừa gửi',
    replyTitle: 'Trợ lý trả lời',
    textOnly: 'Trợ lý chưa đọc thành tiếng được. Câu trả lời hiện ở trên.',
    closeTyping: 'Đóng ô gõ chữ',
    typeLabel: 'Ô gõ điều cần hỏi hoặc cần giao',
    speakStop: 'Dừng nói',
    chooseOne: 'Xin {danh xưng} chạm vào mục cần chọn.',
    newQuestion: 'Hỏi câu khác',
  },

  /** Màn đồng ý lần đầu về micro và bản chép chữ (SPEC 6.8), chữ lớn, hiện trước lần dùng trợ lý đầu tiên. */
  consent: {
    title: 'Trước khi dùng trợ lý',
    intro: 'Xin {danh xưng} đọc mấy điều sau.',
    points: {
      machine: 'Trợ lý là máy, có nhãn Trợ lý AI. Trợ lý chỉ đọc số liệu và đề xuất; việc gì gửi đi cũng cần {danh xưng} đồng ý trước.',
      mic: 'Micro chỉ mở sau khi {danh xưng} bấm nút micro. Khi trò chuyện, trợ lý nghe liên tục cho tới khi {danh xưng} bấm dừng, hoặc lâu không nghe thấy gì, hoặc {danh xưng} rời màn hình. Màn hình luôn báo rõ lúc micro đang mở.',
      audio: 'Âm thanh không được lưu lại.',
      transcript: 'Bản chép chữ của cuộc trò chuyện được lưu {n} ngày để làm dấu vết.',
      erase: 'Trong Cài đặt có nút xoá lịch sử hội thoại. Dấu vết công việc thì vẫn được giữ.',
    },
    agree: 'Tôi đồng ý',
    later: 'Để sau',
    laterNote: 'Khi chưa đồng ý, Tiến độ và Việc cần quyết vẫn dùng bình thường. Trợ lý chưa mở.',
  },

  /** M3 Xem lại đề xuất: cổng xác nhận (SPEC 6.5, 4.7). Câu tóm tắt do máy chủ dựng. */
  review: {
    title: 'Xin {danh xưng} xem lại',
    understood: 'Dạ, trợ lý hiểu như sau:',
    countNudges: 'Có {n} lời nhắc đã soạn',
    source: { ai: 'do Trợ lý AI soạn', office: 'do Văn phòng trình' },
    item: {
      to: 'Gửi tới',
      step: 'Việc',
      late: 'Trễ {n} ngày làm việc',
      dueToday: 'Đến hạn hôm nay',
      message: 'Câu sẽ gửi',
      sender: 'Người nhận sẽ thấy lời nhắc từ {người gửi}',
      edit: 'Sửa câu này',
      editTitle: 'Sửa lời nhắc',
      editSpeak: 'Nói',
      editDone: 'Xong',
      drop: 'Bỏ lời nhắc này',
      dropped: 'Đã bỏ, sẽ không gửi',
      restore: 'Lấy lại lời nhắc này',
    },
    confirm: 'Đồng ý gửi',
    reject: 'Không gửi',
    voiceHint: 'Có thể bấm micro rồi nói “đồng ý” hoặc “không”.',
    voiceUnclear: 'Dạ, trợ lý chưa nghe rõ. Xin {danh xưng} nói “đồng ý” hoặc “không”, hoặc chạm vào nút.',
    allDropped: 'Mọi lời nhắc đã được bỏ. Không còn gì để gửi.',
    count: 'Có {n} mục cần xem',
    voiceButton: 'Nói để trả lời',
    voiceListening: 'Trợ lý đang nghe. Bấm lại để dừng.',
    a11yVoice: 'Nút micro. Bấm rồi nói đồng ý hoặc không.',
    sending: 'Đang gửi, xin {danh xưng} chờ một chút.',
    editLabel: 'Ô sửa lời nhắc',
    messageEmpty: 'Câu sẽ gửi chưa có chữ. Xin {danh xưng} gõ hoặc nói lời nhắc.',
    stepUpCancelled: 'Chưa xác nhận nên chưa thực hiện.',
    rejected: 'Đã rõ. Không gửi gì cả.',
    /** Giao việc mới bằng hội thoại (`propose_start_run`): bản xem trước lấy từ simulate(). */
    startRun: {
      title: 'Các việc sẽ giao',
      runName: 'Tên lượt: {lượt}',
      assignee: 'Người nhận: {người}',
      due: 'Hạn: {hạn}',
      duePassed: 'Hạn này đã qua. Xin {danh xưng} xem lại ngày.',
      unassigned: 'Chưa có người nhận',
      confirm: 'Đồng ý giao việc',
      reject: 'Không giao',
    },
    /** Soạn bản nháp quy trình bằng hội thoại (`propose_create_process`): mỗi bước một thẻ, bản nháp chưa giao việc cho ai. */
    createProcess: {
      title: 'Các bước của quy trình',
      assignee: 'Người phụ trách: {người}',
      confirm: 'Đồng ý tạo bản nháp',
      reject: 'Không tạo',
    },
    /** Xuất bản bản nháp (`propose_publish_process`). Chỉ xuất bản thì câu đầu màn hình đã nói đủ, không có tiêu đề riêng. */
    publishProcess: {
      confirm: 'Đồng ý xuất bản',
      reject: 'Không xuất bản',
    },
    /** Xuất bản và giao việc ngay: bản xem trước các việc dùng chung thẻ với `startRun` (người nhận, hạn). */
    publishAndAssign: {
      title: 'Các việc sẽ giao',
      confirm: 'Đồng ý xuất bản và giao việc',
      reject: 'Không xuất bản',
    },
    /** Giao một việc lẻ không thuộc quy trình (`propose_assign_task`): câu đầu màn hình đã nói đủ người nhận và hạn. */
    assignTask: {
      title: 'Việc sẽ giao',
      confirm: 'Đồng ý giao việc',
      reject: 'Không giao',
    },
    reassign: {
      title: 'Đổi người nhận',
      line: 'Chuyển ‘{việc}’ từ {người cũ} sang {người mới}',
      reason: 'Lý do: {lý do}',
      confirm: 'Đồng ý đổi người',
      reject: 'Không đổi',
    },
    extendDue: {
      title: 'Đổi hạn',
      line: 'Đổi hạn ‘{việc}’ từ {hạn cũ} sang {hạn mới}',
      reason: 'Lý do: {lý do}',
      confirm: 'Đồng ý đổi hạn',
      reject: 'Không đổi',
    },
    /** Mức 2: chạm từng mục, cần sinh trắc học hoặc PIN, không xác nhận bằng giọng, không có "Gửi ngay". */
    cancelRun: {
      title: 'Dừng hẳn một lượt',
      line: 'Dừng lượt ‘{lượt}’. Mọi việc chưa xong của lượt này sẽ thôi không làm.',
      reason: 'Lý do: {lý do}',
      stepUp: 'Việc này cần vân tay, khuôn mặt hoặc mã PIN. Không xác nhận bằng giọng nói.',
      acknowledge: 'Chạm vào đây để xác nhận đã xem mục này',
      acknowledged: 'Đã xem mục này',
      acknowledgeFirst: 'Xin {danh xưng} chạm vào từng mục ở trên trước khi đồng ý.',
      confirm: 'Đồng ý dừng lượt này',
      reject: 'Không dừng',
    },
    expired: 'Dạ, đề xuất để lâu nên đã hết hiệu lực. Xin {danh xưng} nói lại với trợ lý để soạn lại.',
    failedTitle: 'Việc trợ lý chưa làm được',
    failedReason: 'Lý do: {lý do}',
    failedReasons: {
      alreadyDone: 'Việc đã xong trước khi lời nhắc được gửi.',
      throttled: 'Việc vừa được nhắc gần đây nên chưa gửi thêm.',
      changed: 'Tình trạng của việc đã thay đổi.',
      noPermission: 'Tài khoản không còn quyền với việc này.',
      nameTaken: 'Đã có một quy trình trùng tên. Xin đặt lại tên.',
      notDraft: 'Bản nháp này đã được xuất bản hoặc không còn.',
      personGone: 'Có người trong đề xuất không còn dùng được.',
      notAppointed: 'Việc này thuộc quy trình, chỉ giao lại được cho người được bổ nhiệm hoặc người được ủy quyền.',
      templateNotUsable: 'Mẫu quy trình chưa dùng được. Xin nhờ Văn phòng xem lại.',
      other: 'Hệ thống chưa thực hiện được.',
    },
  },

  /** M3b Đã đồng ý: cửa hoàn tác 30 giây. Màn hình giữ nguyên, không tự đóng (SPEC 6.5 điều 8). */
  undo: {
    title: 'Đã đồng ý. Sẽ gửi sau {n} giây.',
    titleLevel2: 'Đã đồng ý. Sẽ thực hiện sau {n} giây.',
    countdown: 'Còn {n} giây',
    undo: 'Hoàn tác',
    sendNow: 'Gửi ngay',
    understood: 'Đã rõ',
    sent: 'Đã gửi.',
    sentCount: 'Đã gửi {n} lời nhắc.',
    done: 'Đã thực hiện.',
    /** Soạn quy trình bằng hội thoại: câu riêng cho từng việc đã thực hiện xong. */
    createdProcess: 'Đã tạo bản nháp quy trình.',
    publishedProcess: 'Đã xuất bản quy trình.',
    publishedAndAssigned: 'Đã xuất bản quy trình và giao việc.',
    assignedTask: 'Đã giao việc.',
    undone: 'Đã hoàn tác. Không gửi gì cả.',
    tooLate: 'Dạ, đã quá thời gian hoàn tác nên nội dung đã được gửi. Nếu cần, xin {danh xưng} bấm Nhờ Văn phòng.',
    a11yCountdown: 'Sẽ gửi sau {n} giây. Có nút Hoàn tác và nút Gửi ngay.',
    sending: 'Đã hết thời gian hoàn tác. Hệ thống đang gửi.',
    undoing: 'Đang hoàn tác, xin {danh xưng} chờ một chút.',
    sendingNow: 'Đang gửi ngay, xin {danh xưng} chờ một chút.',
  },

  /** M4 Tiến độ: danh sách lượt chạy. */
  progress: {
    title: 'Tiến độ',
    needToKnow: {
      title: 'Cần {danh xưng} biết',
      body: 'Có {n} việc quá hạn từ 3 ngày làm việc',
      open: 'Xem các việc này',
      /** Có tên lượt để phân biệt hai việc cùng tên ở hai lượt khác nhau. */
      lineInRun: '‘{việc}’ của {người}, lượt ‘{lượt}’: quá hạn {n} ngày làm việc',
      lineNoOneInRun: '‘{việc}’, lượt ‘{lượt}’, chưa có người nhận: quá hạn {n} ngày làm việc',
      more: 'Và {n} việc khác.',
      collapse: 'Thu gọn',
      line: '‘{việc}’ của {người}: quá hạn {n} ngày làm việc',
      lineNoOne: '‘{việc}’ chưa có người nhận: quá hạn {n} ngày làm việc',
    },
    card: {
      progress: '{xong} trên {tổng} việc đã xong',
      onTrack: 'Đúng tiến độ',
      late: 'Chậm {n} ngày làm việc',
      lateToday: 'Đang chậm',
      completed: 'Đã hoàn tất',
      cancelled: 'Đã dừng',
      target: 'Mốc đích: {ngày}',
      a11y: 'Lượt {lượt}. {tiến độ}. {trạng thái}. Chạm để xem chi tiết.',
    },
    groups: { running: 'Đang chạy', finished: 'Mới hoàn tất' },
    empty: 'Hiện chưa có lượt nào đang chạy.',
    refresh: 'Tải lại',
    updatedAt: 'Số liệu lúc {giờ}',
  },

  /** M5 Chi tiết lượt chạy: danh sách dọc các việc, không dùng sơ đồ. */
  runDetail: {
    stepsTitle: 'Các việc của lượt này',
    startedBy: 'Người khởi chạy: {người}',
    startedAt: 'Bắt đầu: {ngày}',
    target: 'Mốc đích: {ngày}',
    step: {
      assignee: 'Người nhận: {người}',
      unassigned: 'Chưa có người nhận',
      onBehalfOf: 'thay mặt {người}',
      due: 'Hạn: {hạn}',
      noDue: 'Chưa có hạn',
      late: 'Đã quá hạn {n} ngày làm việc',
      lateToday: 'Vừa quá hạn',
      dueToday: 'Đến hạn hôm nay',
      doneAt: 'Xong ngày {ngày}',
      blocked: 'Đang vướng: {lý do}',
      extensionPending: 'Đang xin đổi hạn sang {hạn}',
      a11y: 'Việc {việc}. Người nhận {người}. Hạn {hạn}. {trạng thái}.',
    },
    nudgeLate: 'Nhờ trợ lý đi thúc những việc chậm',
    /** Câu soạn sẵn đưa sang M2 khi bấm nút đi thúc. */
    nudgePrefill: 'Đi thúc các việc đang chậm của lượt ‘{lượt}’',
    noLate: 'Lượt này chưa có việc nào chậm.',
    assistantOff: 'Trợ lý đang tạm nghỉ. Xin {danh xưng} bấm Nhờ Văn phòng để nhắc giúp.',
  },

  /** M6 Việc cần quyết: mỗi lần một thẻ. Trợ lý không duyệt thay; người dùng tự bấm (SPEC 6.5). */
  decisions: {
    title: 'Việc cần {danh xưng} quyết',
    position: 'Việc {n} trên {tổng}',
    content: 'Nội dung',
    requester: 'Người đề nghị: {người}',
    run: 'Thuộc lượt: {lượt}',
    due: 'Hạn: {hạn}',
    /** {tiền} là chuỗi viết hai lần: "20.000.000 đồng (hai mươi triệu đồng)". */
    amount: 'Số tiền: {tiền}',
    approve: 'Đồng ý',
    reject: 'Chưa đồng ý',
    reasonTitle: 'Xin {danh xưng} cho biết lý do',
    reasons: {
      needInfo: 'Cần bổ sung thông tin',
      amount: 'Cần xem lại số tiền',
      timing: 'Chưa đúng thời điểm',
      discuss: 'Cần trao đổi trực tiếp',
    },
    reasonSpeak: 'Nói lý do',
    reasonType: 'Gõ lý do',
    reasonSend: 'Gửi lý do',
    stepUp: 'Việc này có số tiền. Xin {danh xưng} xác nhận bằng vân tay, khuôn mặt hoặc mã PIN.',
    approved: 'Đã đồng ý.',
    rejected: 'Đã ghi nhận là chưa đồng ý. Lý do đã gửi cho Văn phòng và người giao việc.',
    nextOne: 'Xem việc tiếp theo',
    empty: 'Hiện không có việc nào chờ quyết.',
    officeProposals: 'Đề xuất do Văn phòng trình',
    openProposal: 'Xem đề xuất',
    onBehalfOf: 'Đang ủy quyền cho {người}. Việc mới sẽ đến người được ủy quyền.',
    previousOne: 'Xem việc trước',
    aiProposals: 'Đề xuất do Trợ lý AI soạn',
    proposalHint: 'Xin {danh xưng} mở ra xem rồi quyết.',
    reasonLabel: 'Ô gõ lý do',
    understoodAll: 'Đã xem hết các việc chờ quyết.',
  },

  /** M7 Cài đặt. */
  settings: {
    title: 'Cài đặt',
    fontSize: {
      title: 'Cỡ chữ',
      large: 'Lớn',
      xlarge: 'Rất lớn',
      xxlarge: 'Cực lớn',
      sample: 'Chữ mẫu: Việc cần quyết hôm nay',
    },
    speechRate: {
      title: 'Tốc độ đọc',
      slow: 'Chậm',
      normal: 'Vừa',
      fast: 'Nhanh',
    },
    voice: {
      title: 'Giọng đọc',
      listen: 'Nghe thử',
      sample: 'Dạ, thưa {danh xưng}. Hôm nay có ba việc cần quyết.',
      device: 'Giọng của máy',
      current: 'Đang dùng',
      choose: 'Chọn giọng này',
    },
    briefingTime: {
      title: 'Giờ nhận báo cáo đầu ngày',
      value: 'Mỗi ngày làm việc lúc {giờ}',
      earlier: 'Sớm hơn 30 phút',
      later: 'Muộn hơn 30 phút',
    },
    sendSound: { title: 'Âm báo khi gửi xong', on: 'Bật', off: 'Tắt' },
    addressing: {
      title: 'Cách trợ lý gọi',
      current: 'Trợ lý đang gọi là: {danh xưng}',
      change: 'Đổi cách gọi',
    },
    clearHistory: {
      title: 'Xoá lịch sử hội thoại',
      body: 'Xoá các câu đã nói với trợ lý. Dấu vết công việc vẫn được giữ.',
      confirm: 'Đồng ý xoá',
      keep: 'Không xoá',
      done: 'Đã xoá lịch sử hội thoại.',
    },
    delegation: 'Ủy quyền cho Phó giám đốc',
    dataRequest: {
      title: 'Dữ liệu của tôi',
      open: 'Yêu cầu xoá dữ liệu hoặc thu hồi máy',
      onDeviceTitle: 'Trên máy này',
      onDevice: 'Đăng xuất ở mục Cài đặt sẽ xoá khỏi máy này phiên làm việc và dữ liệu đã tải, đồng thời thu hồi máy ở máy chủ khi có mạng. Mã PIN chỉ nằm trên máy và cũng bị xoá.',
      onServerTitle: 'Trên máy chủ',
      onServer: 'Dữ liệu công việc trên máy chủ do tổ chức quản lý. Muốn xem, sửa, xoá dữ liệu của mình hoặc rút lại sự đồng ý, xin bấm Nhờ Văn phòng. Văn phòng xử lý theo chính sách của tổ chức và báo lại thời gian xử lý.',
      lostTitle: 'Mất máy hoặc đổi máy',
      lost: 'Xin bấm Nhờ Văn phòng để thu hồi máy cũ ngay, rồi nhận mã kích hoạt cho máy mới.',
      policy: 'Xem chính sách quyền riêng tư',
      askOffice: 'Nhờ Văn phòng',
    },
    saved: 'Đã lưu.',
    version: 'Phiên bản {phiên bản}',
    lockNow: 'Khoá ứng dụng ngay',
    profile: {
      title: 'Kiểu hiển thị',
      senior: 'Chữ lớn, nút lớn',
      standard: 'Gọn hơn',
    },
    account: 'Tài khoản: {người}',
    signOut: {
      title: 'Đăng xuất',
      body: 'Đăng xuất sẽ xoá phiên làm việc trên máy này. Muốn dùng lại cần mã kích hoạt mới từ Văn phòng.',
      confirm: 'Đồng ý đăng xuất',
      keep: 'Không đăng xuất',
    },
    saveFailed: 'Dạ, hệ thống chưa lưu được. Xin {danh xưng} thử lại, hoặc bấm Nhờ Văn phòng.',
  },

  /**
   * Màn đo khử tiếng vọng: CHỈ có ở bản thử (`__DEV__`), không dành cho người dùng cuối (docs/DECISIONS.md, "Ngắt lời bằng giọng nói").
   * Người đọc là người làm máy: con số đi kèm tên chỉ tiêu, nên tên chỉ tiêu là chuỗi cố định và số được định dạng ở màn hình.
   */
  aecLab: {
    title: 'Đo khử tiếng vọng',
    entry: 'Đo khử tiếng vọng (bản thử)',
    entryNote: 'Chỉ có ở bản thử. Dùng để biết điện thoại này có nhận ra giọng nói chen vào lúc trợ lý đang đọc hay không.',
    unavailable: 'Bản này chưa có mô-đun âm thanh gốc nên chưa đo được. Hãy mở bằng bản dựng thử trên iPhone, không dùng Expo Go.',
    intro:
      'Phép đo gồm ba bước, khoảng một phút. Đặt điện thoại trên bàn, mở loa ngoài, âm lượng vừa phải như khi dùng trợ lý. Bước 1: giữ yên lặng. Bước 2: trợ lý đọc một đoạn, xin vẫn giữ yên lặng. Bước 3: trợ lý đọc lại; khi hiện dòng “Nói ngay”, hãy nói chen vào bằng giọng bình thường.',
    echoCancel: { title: 'Khử tiếng vọng của máy', on: 'Bật', off: 'Tắt (để so sánh)' },
    mode: { title: 'Chế độ âm thanh', voiceChat: 'Gọi thoại', normal: 'Thường' },
    start: 'Bắt đầu đo',
    stop: 'Dừng đo',
    phase: {
      starting: 'Đang mở micro và loa, xin chờ một chút.',
      silence: 'Bước 1 trên 3: giữ yên lặng.',
      echo: 'Bước 2 trên 3: trợ lý đang đọc, xin giữ yên lặng.',
      talk: 'Bước 3 trên 3: trợ lý đang đọc.',
      talkPrompt: 'Nói ngay: hãy nói chen vào.',
      done: 'Đã đo xong.',
    },
    live: {
      mic: 'Mức micro (dB)',
      speaker: 'Mức loa (dB)',
      frames: 'Số khung đã nhận',
      step: 'Thời gian của bước này (mili giây)',
      route: 'Đường âm thanh',
    },
    resultTitle: 'Kết quả',
    none: 'không có',
    config: { label: 'Cách đo', vpOn: 'khử vọng bật', vpOff: 'khử vọng tắt', voiceChat: 'gọi thoại', normal: 'thường' },
    rows: {
      format: 'Micro trả về (Hz, kênh)',
      cadence: 'Số khung nhận mỗi giây (đúng là 20)',
      silenceMid: 'Yên lặng: mức giữa (dB)',
      silenceHigh: 'Yên lặng: mức cao thường gặp (dB)',
      echoMid: 'Tiếng loa vọng vào micro: mức giữa (dB)',
      echoHigh: 'Tiếng loa vọng vào micro: mức cao thường gặp (dB)',
      echoPeak: 'Tiếng loa vọng vào micro: đỉnh (dB)',
      speaker: 'Mức phát ra loa (dB)',
      reduction: 'Micro nghe nhỏ hơn loa (dB)',
      speech: 'Giọng nói chen vào: mức cao (dB)',
      margin: 'Giọng nói hơn tiếng vọng (dB)',
      threshold: 'Ngưỡng nhận ra giọng (dB)',
      delay: 'Nhận ra giọng sau lời nhắc (mili giây)',
      falseTriggers: 'Nhận nhầm khi giữ yên lặng (lần)',
    },
    compare: 'Khử vọng giảm thêm so với khi tắt (dB)',
    verdict: {
      pass: 'Đạt: giọng nói chen vào nghe rõ hơn tiếng vọng và không nhận nhầm. Có thể làm tiếp.',
      unsure: 'Chưa chắc: giọng nói còn gần mức tiếng vọng. Cần đo thêm: chỉnh âm lượng, đổi chỗ đặt máy, hoặc đổi chế độ âm thanh.',
      fail: 'Chưa đạt: tiếng vọng lẫn với giọng nói. Chưa nên bật việc ngắt lời bằng giọng nói trên máy này.',
      incomplete: 'Chưa đủ dữ liệu để kết luận. Hãy đo lại và làm đủ ba bước.',
    },
    errors: {
      denied: 'Chưa có quyền dùng micro. Hãy cho phép micro trong phần cài đặt của iPhone rồi đo lại.',
      start: 'Không mở được micro và loa: {lý do}.',
      stopped: 'Hệ điều hành đã dừng âm thanh giữa chừng ({lý do}). Hãy đo lại.',
      play: 'Không phát được đoạn mẫu: {lý do}.',
      timeout: 'Bước phát kéo dài bất thường nên đã dừng. Hãy đo lại.',
      noFrames: 'Micro không gửi được âm thanh nào. Hãy kiểm tra quyền micro rồi đo lại.',
    },
  },

  /** Ủy quyền cho Phó giám đốc (SPEC 7.7): đổi quyền là mức 3, không làm qua trợ lý. */
  delegation: {
    title: 'Ủy quyền cho Phó giám đốc',
    intro: 'Trong thời gian ủy quyền, việc mới sẽ giao cho người được ủy quyền và ghi rõ là làm thay.',
    none: 'Hiện chưa ủy quyền cho ai.',
    banner: 'Đang ủy quyền cho {người} đến ngày {ngày}',
    choosePerson: 'Chọn người được ủy quyền',
    scopeTitle: 'Phạm vi',
    scope: { all: 'Mọi việc', process: 'Một quy trình', role: 'Một vai trò' },
    chooseProcess: 'Chọn quy trình',
    from: 'Từ ngày',
    to: 'Đến ngày',
    stepUp: 'Ủy quyền cần xác nhận bằng vân tay, khuôn mặt hoặc mã PIN.',
    summary: 'Ủy quyền cho {người}, phạm vi {phạm vi}, từ ngày {từ} đến ngày {đến}.',
    confirm: 'Đồng ý ủy quyền',
    reject: 'Không ủy quyền',
    created: 'Đã ủy quyền cho {người} đến ngày {ngày}.',
    end: 'Thu lại ủy quyền',
    endConfirm: 'Đồng ý thu lại',
    endKeep: 'Giữ nguyên',
    ended: 'Đã thu lại ủy quyền.',
    notViaAssistant: 'Dạ, ủy quyền không làm qua trợ lý. Xin {danh xưng} làm tại màn hình Cài đặt.',
    dayEarlier: 'Lùi 1 ngày',
    dayLater: 'Thêm 1 ngày',
    selected: 'Đã chọn',
    noCandidates: 'Chưa có người nào để ủy quyền. Xin {danh xưng} bấm Nhờ Văn phòng.',
    noProcess: 'Chưa có quy trình nào để chọn.',
    incoming: 'Đang nhận ủy quyền từ {người} đến ngày {ngày}',
    invalidRange: 'Ngày kết thúc cần sau ngày bắt đầu.',
    start: 'Lập ủy quyền mới',
    review: 'Xem lại trước khi đồng ý',
  },

  /** Trạng thái chung: đang tải, mất mạng (SPEC 6.11, 7.6). Trạng thái đang tải luôn có chữ. */
  status: {
    loading: 'Đang tải, xin {danh xưng} chờ một chút.',
    loadingSlow: 'Xin chờ thêm một chút',
    offline: 'Đang không có mạng. Số liệu lúc {giờ}.',
    offlineAction: 'Dạ, đang không có mạng nên chưa gửi được. Xin {danh xưng} thử lại khi có mạng.',
    retry: 'Thử lại',
    failed: 'Dạ, hệ thống chưa làm được việc này. Xin {danh xưng} thử lại, hoặc bấm Nhờ Văn phòng.',
    stepUpUnsupported: 'Dạ, máy này chưa xác nhận được bằng vân tay, khuôn mặt hay mã PIN. Việc này cần duyệt trên web. Xin {danh xưng} bấm Nhờ Văn phòng.',
  },

  /** M0 Kích hoạt lần đầu (SPEC 10.2, 11.2). Trước khi kích hoạt app chưa biết vai trò nên các câu này không dùng {danh xưng}. */
  activation: {
    title: 'Kích hoạt ứng dụng',
    intro: 'Xin mở đường dẫn hoặc quét mã QR do Văn phòng gửi. Cũng có thể dán mã vào ô bên dưới.',
    scanQr: 'Quét mã QR',
    scanHint: 'Xin đưa mã QR vào giữa khung hình.',
    cameraDenied: 'Dạ, ứng dụng chưa được phép dùng máy ảnh. Xin dán mã vào ô bên dưới, hoặc nhờ Văn phòng bật giúp.',
    enterCode: 'Dán mã kích hoạt',
    typeCode: 'Nhập mã bằng tay',
    codeLabel: 'Ô dán mã kích hoạt',
    codeHint: 'Mã nằm trong tin Văn phòng đã gửi.',
    continue: 'Tiếp tục',
    checking: 'Đang kiểm tra mã, xin chờ một chút.',
    codeInvalid: 'Dạ, mã kích hoạt chưa đúng hoặc đã hết hạn. Xin nhờ Văn phòng gửi mã mới.',
    needFullLink: 'Dạ, mã này chưa kèm địa chỉ máy chủ. Xin dán cả đường dẫn Văn phòng đã gửi, hoặc quét mã QR.',
    serverNotConfigured: 'Dạ, bản ứng dụng này chưa được cấu hình máy chủ nên chưa kích hoạt được. Xin nhờ Văn phòng cài lại bản đúng.',
    welcome: 'Kính chào {người}',
    pin: {
      title: 'Xin đặt mã PIN 6 số',
      confirmTitle: 'Xin nhập lại mã PIN',
      hint: 'Mã PIN dùng để mở khoá ứng dụng trên máy này.',
      mismatch: 'Dạ, hai lần nhập chưa khớp. Xin nhập lại từ đầu.',
      tooSimple: 'Dạ, mã này dễ đoán. Xin chọn mã khác, tránh sáu số giống nhau hoặc liền nhau.',
    },
    biometric: {
      title: 'Mở khoá bằng vân tay hoặc khuôn mặt',
      body: 'Bật để mở ứng dụng nhanh hơn. Mã PIN vẫn dùng được.',
      enable: 'Bật',
      skip: 'Để sau',
      unavailable: 'Máy này chưa cài vân tay hoặc khuôn mặt. Ứng dụng sẽ mở bằng mã PIN.',
    },
    push: {
      title: 'Nhận thông báo',
      body: 'Ứng dụng báo khi có báo cáo đầu ngày và khi có việc cần {danh xưng} quyết.',
      enable: 'Cho phép thông báo',
      skip: 'Để sau',
      retry: 'Thử lại',
      continueWithout: 'Vào Trang chủ, chưa bật thông báo',
      /** Kết quả khi bấm "Cho phép thông báo" mà chưa đăng ký được (apps/mobile-executive/src/push/sync.ts) */
      problem: {
        denied: 'Dạ, thông báo đang bị tắt trong phần cài đặt của máy. Muốn nhận tin, xin bật lại ở đó. Việc cần quyết vẫn hiện khi {danh xưng} mở ứng dụng.',
        noProject: 'Dạ, bản ứng dụng này chưa được cấu hình để nhận thông báo. Xin nhờ Văn phòng xử lý. Việc cần quyết vẫn hiện khi {danh xưng} mở ứng dụng.',
        failed: 'Dạ, chưa đăng ký nhận thông báo được, có thể do mất mạng. Xin bấm thử lại, hoặc vào Trang chủ, ứng dụng sẽ thử lại lần sau.',
      },
    },
    done: {
      title: 'Đã kích hoạt xong',
      body: 'Ứng dụng đã sẵn sàng.',
      start: 'Vào Trang chủ',
    },
    ended: {
      device_revoked: 'Dạ, máy này đã được thu hồi quyền dùng. Xin nhờ Văn phòng gửi mã kích hoạt mới.',
      pin_attempts: 'Dạ, mã PIN chưa khớp 5 lần nên ứng dụng đã xoá phiên trên máy để giữ an toàn. Xin nhờ Văn phòng gửi mã kích hoạt mới.',
      session_expired: 'Dạ, phiên làm việc trên máy này đã hết. Xin nhờ Văn phòng gửi mã kích hoạt mới.',
    },
  },

  /** Mở app mà không đọc được kho an toàn của máy (khoá bị vô hiệu sau khi cập nhật hệ điều hành, máy đang khoá). */
  startup: {
    title: 'Chưa mở được ứng dụng',
    body: 'Dạ, ứng dụng chưa đọc được thông tin đăng nhập đã lưu trên máy. Xin bấm thử lại. Nếu vẫn không được, xin kích hoạt lại bằng mã mới do Văn phòng gửi.',
    retry: 'Thử lại',
    reset: 'Kích hoạt lại',
    resetWarning: 'Kích hoạt lại sẽ xoá dữ liệu của ứng dụng trên máy này.',
  },

  /** Kênh thông báo đẩy trên Android (SPEC 10.9): tên hiện trong phần cài đặt của máy. */
  push: {
    channelWork: 'Báo cáo và việc cần quyết',
    channelWorkDescription: 'Báo cáo đầu ngày, việc cần quyết và đề xuất do Văn phòng trình.',
    channelNudge: 'Việc cần xem ngay',
    channelNudgeDescription: 'Việc tới lượt quyết và đề xuất chưa thực hiện được.',
  },
} as const;
