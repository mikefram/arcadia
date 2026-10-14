const t0 = Date.now();

/**
 * Ghi vết thời gian của luồng trò chuyện, chỉ ở bản thử (`__DEV__`; ở bản phát hành hàm không làm gì).
 * Chỉ ghi tên sự kiện và trạng thái, KHÔNG ghi câu nói hay câu trả lời (CLAUDE.md luật 6). Đọc qua Metro khi thử trên máy thật.
 * Test chạy bằng Node không có `__DEV__`, nên kiểm `typeof` trước.
 */
export function devTrace(message: string): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  console.log(`[trợ lý +${String(Date.now() - t0).padStart(7)}ms] ${message}`);
}
