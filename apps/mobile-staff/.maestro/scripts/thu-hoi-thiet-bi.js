/* global http, output, API_URL, ADMIN_EMAIL, ADMIN_PASSWORD, DEVICE_USER_NAME */
// `http`, `output` và các biến môi trường là biến toàn cục do Maestro cung cấp khi chạy script.
// Luồng 06: it_admin thu hồi mọi thiết bị đang dùng của một người (GET /v1/devices, POST /v1/devices/:id/revoke).
// CHƯA CHẠY. Cần chạy scripts/web-session.js trước trong cùng luồng nếu Maestro không cho nạp tệp khác;
// ở đây chép lại phần đăng nhập cho tự đủ.
function cookieValue(setCookie, name) {
  var text = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie || '');
  var match = new RegExp('(?:^|[;,\\s])' + name + '=([^;,\\s]+)').exec(text);
  return match ? match[1] : null;
}
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

var loginRes = http.post(API_URL + '/v1/auth/login', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
if (!loginRes.ok) throw new Error('Đăng nhập quản trị hệ thống không thành: ' + loginRes.status);
var setCookie = loginRes.headers['set-cookie'] || loginRes.headers['Set-Cookie'];
var csrf = cookieValue(setCookie, 'mihato_csrf');
var cookie = 'mihato_session=' + cookieValue(setCookie, 'mihato_session') + '; mihato_csrf=' + csrf;

var list = http.get(API_URL + '/v1/devices', { headers: { Cookie: cookie } });
if (!list.ok) throw new Error('Không lấy được danh sách thiết bị: ' + list.status);
var devices = JSON.parse(list.body).items.filter(function (d) {
  return d.userName === DEVICE_USER_NAME && d.revokedAt === null;
});
if (devices.length === 0) throw new Error('Không thấy thiết bị đang dùng của ' + DEVICE_USER_NAME);

devices.forEach(function (d) {
  var res = http.post(API_URL + '/v1/devices/' + d.id + '/revoke', {
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Idempotency-Key': uuid() },
  });
  if (!res.ok) throw new Error('Thu hồi thiết bị không thành: ' + res.status);
});
output.revoked = devices.length;
