/* global SECONDS */
// Maestro không có lệnh ngủ: chờ SECONDS giây bằng vòng lặp đồng hồ. Luồng 05 cần chờ quá 30 giây của cửa hoàn tác. CHƯA CHẠY.
var until = Date.now() + Number(SECONDS || 0) * 1000;
while (Date.now() < until) {
  // chờ
}
