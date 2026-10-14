/* global http, output, API_URL, ADMIN_EMAIL, ADMIN_PASSWORD */
// `http`, `output` và các biến môi trường là biến toàn cục do Maestro cung cấp khi chạy script.
// Luồng 05: sau khi app đồng bộ, kiểm ở máy chủ rằng mỗi việc của Lan vừa báo xong có ĐÚNG MỘT sự kiện CompleteStep
// trong dòng thời gian của lượt chạy (SPEC 8.6 điều 3). Dùng tài khoản Văn phòng (xem được mọi lượt chạy).
// CHƯA CHẠY.
function cookieValue(setCookie, name) {
  var text = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie || '');
  var match = new RegExp('(?:^|[;,\\s])' + name + '=([^;,\\s]+)').exec(text);
  return match ? match[1] : null;
}

var loginRes = http.post(API_URL + '/v1/auth/login', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
if (!loginRes.ok) throw new Error('Đăng nhập Văn phòng không thành: ' + loginRes.status);
var setCookie = loginRes.headers['set-cookie'] || loginRes.headers['Set-Cookie'];
var cookie = 'mihato_session=' + cookieValue(setCookie, 'mihato_session') + '; mihato_csrf=' + cookieValue(setCookie, 'mihato_csrf');
var get = function (path) {
  var res = http.get(API_URL + path, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(path + ': ' + res.status);
  return JSON.parse(res.body);
};

var lan = get('/v1/people?q=' + encodeURIComponent('Nguyễn Thu Lan')).items[0];
if (!lan) throw new Error('Không thấy người dùng mẫu Nguyễn Thu Lan');
var done = get('/v1/steps?assignee=' + lan.id + '&bucket=done&sort=-completedAt&limit=2').items;
if (done.length < 2) throw new Error('Chưa đủ hai việc đã xong');

done.forEach(function (step) {
  var events = get('/v1/runs/' + step.runId + '/events?limit=200').items;
  var completes = events.filter(function (e) {
    return e.type === 'CompleteStep' && e.stepId === step.id;
  });
  if (completes.length !== 1) throw new Error('Việc ' + step.id + ' có ' + completes.length + ' sự kiện CompleteStep, cần đúng 1');
});
output.verified = done.length;
