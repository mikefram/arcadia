/* global output */
// `output` là biến toàn cục do Maestro cung cấp khi chạy script.
// Luồng 02: chọn một ngày chắc chắn không rơi vào cuối tuần để lưới ngày S4 cho chọn (ngày nghỉ bị làm mờ).
// Lấy Thứ Tư đầu tiên của tháng sau; nếu đúng ngày lễ của tổ chức thì đổi sang ngày khác khi chạy.
// CHƯA CHẠY.
var d = new Date();
d.setDate(1);
d.setMonth(d.getMonth() + 1);
while (d.getDay() !== 3) d.setDate(d.getDate() + 1);
var pad = function (n) {
  return (n < 10 ? '0' : '') + n;
};
output.workday = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
