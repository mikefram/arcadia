# Tự triển khai không gián đoạn

Mục tiêu: đưa mã mới lên máy chủ **không cần gõ lệnh** và **không làm gián đoạn** hệ thống này lẫn các ứng dụng khác trên cùng máy chủ.

## Luồng

```
gộp PR vào main ──► CI chạy (kiểm kiểu, test, migration, ảnh Docker)
                    └─ xanh ──► workflow "deploy"
                                 1. dựng và đẩy ảnh gắn tag sha-<7 ký tự> lên GHCR
                                 2. SSH vào máy chủ: deploy.sh sha-<7 ký tự>
                                     sao lưu ─► migrate (bản cũ vẫn phục vụ) ─► cuốn chiếu api, worker, scribe, web
                                     kiểm /readyz ─► hỏng thì TỰ hoàn lại bản trước
                                 3. kiểm ngoài: GET <PUBLIC_URL>/readyz
```

CI đỏ thì không triển khai. Muốn triển khai lại một tag đã có hoặc hoàn lại bản cũ: GitHub, Actions, **deploy**, Run workflow, chọn `deploy` hoặc `rollback` và nhập tag.

## Cách đổi bản không gián đoạn (cuốn chiếu)

Với từng dịch vụ (api, worker, scribe, web) theo thứ tự đó, `deploy/scripts/lib.sh` (`rollout_service`):

1. chạy bản **mới song song** với bản cũ (cùng tên mạng, nên người dùng vào bản nào cũng được);
2. chờ bản mới **khoẻ** (healthcheck);
3. mới tắt bản cũ (`SIGTERM`, chờ tối đa 40 giây cho việc đang chạy xong);
4. bản mới **không khoẻ** thì gỡ bản mới, bản cũ vẫn phục vụ nguyên vẹn và lần triển khai báo lỗi.

Các lớp bảo vệ khác:

| Rủi ro | Cách chặn |
| --- | --- |
| Migration làm bản cũ hỏng trong lúc hai bản chạy song song | `deploy/ci/migration-guard.mjs` (CI đỏ khi migration mới bỏ cột/bảng, đổi tên, đổi kiểu, `NOT NULL` không `DEFAULT`). Chia việc làm hai bản phát hành: thêm trước, bỏ sau (SPEC 12.3). Có lý do chắc chắn thì thêm dòng `-- zero-downtime: approved <lý do>` |
| Migration chờ khoá làm treo mọi truy vấn | `PGOPTIONS=-c lock_timeout=10s` ở dịch vụ `migrate`: không lấy được khoá thì thất bại ngay, bản cũ vẫn chạy |
| Yêu cầu gặp container cũ đúng lúc tắt | Caddy trong ảnh web thử lại tới 10 giây sang bản mới (`lb_try_duration`) |
| Hai lần triển khai giẫm nhau | khoá `flock` trên máy chủ, cộng `concurrency` ở workflow |
| Máy chủ thiếu bộ nhớ để chạy song song | `deploy.sh` dừng TRƯỚC khi đụng vào gì nếu bộ nhớ trống dưới 1 GB (`MIHATO_MIN_FREE_MEM_MB`), nên không ép bộ nhớ của ứng dụng khác |
| Triển khai làm khởi động lại CSDL | `postgres` chỉ được `up --no-recreate`: triển khai không bao giờ tạo lại nó |
| Triển khai đụng ứng dụng khác | chỉ thao tác trong dự án compose `mihato`; không động tới `edge-caddy`, mạng `edge`, ảnh hay container của dự án khác; không `prune` |

## Điều KHÔNG được bảo đảm (nói thẳng)

- **Kết nối dài bị ngắt một lần lúc đổi bản**: luồng sự kiện SSE của web quản trị và phiên giọng nói (WebSocket) của Scribe. Trình duyệt và app tự nối lại sau vài giây; phiên nói đang dở có thể phải nói lại. Trang web, API và việc ghi dữ liệu thì không gián đoạn.
- **Migration thu hẹp** (bỏ cột, đổi tên) làm bản cũ hỏng: guard chặn ở CI, nhưng nếu đã đánh dấu `approved` thì người viết chịu trách nhiệm.
- **Máy chủ hoặc Docker khởi động lại**, mất điện, đứt mạng: đây là một máy chủ duy nhất, không có dự phòng. Triển khai không cứu được loại sự cố này.
- **Hoàn lại sau migration có thu hẹp** không đi bằng rollback ảnh mà phải khôi phục sao lưu (runbook).

## Thiết lập MỘT lần (một lệnh, chạy ngay trên máy chủ)

Không cần máy tính cá nhân và không cần gộp PR trước. SSH vào máy chủ (root) rồi chạy **một** lệnh:

```
cd ~/virtual-asisstant && git fetch -q origin && REF=origin/claude/sweet-davinci-o5ren6 \
  bash <(git show origin/claude/sweet-davinci-o5ren6:deploy/scripts/setup-ci-deploy.sh)
```

(Sau khi PR đã gộp: `cd ~/virtual-asisstant && git pull && bash deploy/scripts/setup-ci-deploy.sh`.)

Script làm toàn bộ phía máy chủ:

1. chép cửa vào khoá cứng tới `/usr/local/sbin/mihato-remote-deploy` (thuộc root, nằm ngoài thư mục repo);
2. **tạo khoá SSH cho CI ngay trên máy chủ** và cho phép nó CHỈ chạy cửa vào đó (`restrict` + lệnh bắt buộc: không shell, không chuyển cổng);
3. lấy dấu máy chủ (`known_hosts`) và dò địa chỉ để CI SSH tới;
4. kiểm máy chủ đã sẵn sàng (quyền tệp môi trường, mã hoá sao lưu, `compose.edge.yml`, đăng nhập GHCR, `flock`, thư mục triển khai sạch, `PermitRootLogin`) và nói rõ mục nào cần sửa;
5. tự kiểm đường SSH đầu-cuối (khoá vào được, lệnh tuỳ ý bị từ chối);
6. đưa cho bạn 3 secret GitHub, rồi **xoá khoá riêng khỏi máy chủ**.

Phần việc còn lại duy nhất là đưa 3 secret lên GitHub (khoá riêng chỉ hiện một lần, nên sao chép ngay):

- **Dán tay** (mặc định): script in sẵn tên và giá trị `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_SSH_KEY`. Mở link nó in ra (repo, Settings, Secrets and variables, Actions), bấm New repository secret, dán từng cái. Tab Variables: `PUBLIC_URL` (script in giá trị).
- **Hoàn toàn tự động**: cài `gh` trên máy chủ rồi chạy lệnh trên với thêm `GH_TOKEN=<token GitHub quyền repo>` ở đầu lệnh: script tự đặt 3 secret và biến, không in khoá ra màn hình. Token chỉ dùng trong lần chạy đó.

Chạy lại script khi nào cũng được: nó **xoay khoá** (khoá cũ bị gỡ) và in lại secret. Thu hồi hẳn: thêm `--revoke` (rồi xoá 3 secret ở GitHub).

Tuỳ chọn: Settings, Environments, tạo `production`, bật Required reviewers nếu muốn một nút duyệt tay trước mỗi lần triển khai.

Sau đó **gộp PR**; CI xanh thì workflow `deploy` tự chạy. **Lần đầu nên mở Actions để xem.** Từ lần sau không cần làm gì ngoài gộp PR.

## Kiểm thử

- `bash deploy/ci/test-rollout.sh`: logic cuốn chiếu với Docker giả (CI chạy mỗi lần).
- `node --test deploy/ci/migration-guard.test.mjs`: bộ chặn migration.
- `sudo bash deploy/ci/test-setup-ci-deploy.sh`: kiểm đầu-cuối bằng `sshd` thật (setup một lệnh, khoá CI chỉ chạy được deploy/rollback/ping, chỉ tiến tới trên main, từ chối thư mục bẩn, xoay khoá, thu hồi). Cần root và `sshd`, chưa nằm trong CI.
- Chưa kiểm trên Docker thật trong môi trường phát triển: lần đầu chạy thật cần theo dõi (xem docs/DECISIONS.md, 12/10/2026).
