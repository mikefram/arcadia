/* global http, output, API_URL, DEMO_PASSWORD, PHASE */
// `http`, `output` và các biến môi trường là biến toàn cục do Maestro cung cấp khi chạy script.
// Luồng 05: đếm tin "nhắc" mà anh Tuấn đã nhận (kind = nudge). PHASE=truoc ghi số đếm; PHASE=sau so với số đã ghi:
// Chủ tịch bấm Hoàn tác thì người nhận KHÔNG nhận tin nào (SPEC 6.5 điều 8, 10.6). Đọc tin bằng chính tài khoản web của
// anh Tuấn (tuan@demo.mihato.local, mật khẩu chung của dữ liệu mẫu). CHƯA CHẠY.
function cookieValue(setCookie, name) {
  var text = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie || '');
  var match = new RegExp('(?:^|[;,\\s])' + name + '=([^;,\\s]+)').exec(text);
  return match ? match[1] : null;
}

var email = 'tuan@demo.mihato.local';
var loginRes = http.post(API_URL + '/v1/auth/login', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: email, password: DEMO_PASSWORD }),
});
if (!loginRes.ok) throw new Error('Đăng nhập tài khoản anh Tuấn không thành: ' + loginRes.status);
var setCookie = loginRes.headers['set-cookie'] || loginRes.headers['Set-Cookie'];
var cookie = 'mihato_session=' + cookieValue(setCookie, 'mihato_session') + '; mihato_csrf=' + cookieValue(setCookie, 'mihato_csrf');
var res = http.get(API_URL + '/v1/notifications?limit=100', { headers: { Cookie: cookie } });
if (!res.ok) throw new Error('/v1/notifications: ' + res.status);
var items = JSON.parse(res.body).items || [];
var count = items.filter(function (n) {
  return n.kind === 'nudge';
}).length;

if (PHASE === 'truoc') {
  output.nhacTruoc = count;
} else {
  if (output.nhacTruoc === undefined) throw new Error('Chưa chạy bước PHASE=truoc');
  if (count !== output.nhacTruoc) throw new Error('Anh Tuấn nhận thêm ' + (count - output.nhacTruoc) + ' tin nhắc dù đã Hoàn tác');
}
