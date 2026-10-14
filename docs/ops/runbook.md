# Runbook vận hành production

Một tổ chức (VRG), một máy chủ Linux chạy `docker compose` (docs/DECISIONS.md, 07/10/2026). Viết ngày 07/10/2026; **chưa lần nào chạy trên máy thật**: mọi lệnh dưới đây là thiết kế đã kiểm cú pháp, chưa kiểm thực tế. Lần chạy đầu phải ghi lại chỗ sai vào mục "Nhật ký diễn tập" cuối tệp này.

Những chỗ **chờ Mike** (chưa có câu trả lời, đang làm theo giả định, mọi thứ tham số hoá bằng biến môi trường): máy chủ đặt ở đâu (Q9), nơi đặt bản sao lưu khác máy chủ (Q9), người trực và kênh nhận cảnh báo (Q10), tên miền, tài khoản GitHub chứa ảnh.

Tệp liên quan: `deploy/compose.production.yml`, `deploy/Caddyfile`, `deploy/production.env.example`, `deploy/scripts/*.sh`, `deploy/ops/ops-alert.mjs`, `docs/ops/backup.md`, `docs/ops/incident.md`, `docs/security/secrets.md`.

## 1. Kiến trúc

| Dịch vụ | Vai trò | Cổng ra ngoài | Ghi chú |
| --- | --- | --- | --- |
| `web` (Caddy) | TLS tự động, web quản trị tĩnh, chuyển tiếp `/v1`, `/scribe/ws`, `/healthz`, `/readyz` | 80, 443 | Điểm vào duy nhất. `/internal/*` trả 404 |
| `api` | REST và SSE | không | **Một bản duy nhất** (kho tệp là volume cục bộ) |
| `worker` | effects, timers, bản tin sáng, dọn dẹp | không | Cùng volume tệp với api |
| `scribe` | WebSocket trợ lý | không | Không có đường tới CSDL; chỉ gọi `/internal/v1/*` của api |
| `postgres` | PostgreSQL 16 | không | Mạng `db` nội bộ, không ra Internet |
| `migrate` | một lần mỗi lần triển khai | không | Chỉ `db:migrate`, không bao giờ seed |
| `ops-alert` | cảnh báo SPEC 12.4 bằng truy vấn SQL | không | Webhook hoặc Telegram |

Máy chủ: Ubuntu LTS, 4 vCPU, 8 GB RAM, 100 GB SSD (SPEC 12.2, chưa đo). `ufw` chỉ mở 22, 80, 443. Docker tự khởi động cùng máy; mọi dịch vụ `restart: unless-stopped`.

Kiểm sức khoẻ (SPEC 12.4): **`/healthz`** (tiến trình api còn sống) dùng cho Docker healthcheck; **`/readyz`** (CSDL và nhịp tim worker, 503 khi worker mất nhịp 2 phút) dùng cho giám sát và cảnh báo, KHÔNG dùng cho healthcheck hay bộ cân bằng tải vì worker chết sẽ kéo api khỏi vòng phục vụ. Worker có healthcheck riêng (`deploy/ops/worker-health.mjs`, đọc `worker_heartbeats`).

## 2. Chuẩn bị máy chủ (một lần)

```bash
# 1. Docker và ufw (Ubuntu): https://docs.docker.com/engine/install/ubuntu/
sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable

# 2. Mã nguồn (chỉ cần thư mục deploy/ và docs/; ảnh lấy từ registry)
sudo git clone <địa-chỉ-repo> /opt/mihato && cd /opt/mihato

# 3. Tệp môi trường NGOÀI repo, chủ root, quyền 600
sudo install -d -m 700 /etc/mihato
sudo install -m 600 deploy/production.env.example /etc/mihato/production.env
sudo nano /etc/mihato/production.env      # điền theo chú thích trong tệp
```

Sinh khoá (mỗi khoá một lệnh riêng; không dùng lại giữa các khoá):

```bash
openssl rand -hex 24                         # mật khẩu CSDL (4 cái: POSTGRES, APP_OWNER, APP_USER, APP_SCAN)
openssl rand -base64 48                      # AUTH_SECRET; chạy lại cho INTERNAL_SERVICE_TOKEN
openssl ecparam -genkey -name prime256v1 | openssl pkcs8 -topk8 -nocrypt | awk 'NF {printf "%s\\n", $0}'   # SCRIBE_JWT_PRIVATE_KEY (đặt trong cặp nháy đơn)
age-keygen -o ~/mihato-backup.key            # KHOÁ RIÊNG sao lưu: cất vào kho mật khẩu của công ty rồi XOÁ khỏi máy chủ; dán dòng "Public key" vào AGE_RECIPIENT
```

Ghi người giữ và ngày tạo từng khoá vào bảng ở `docs/security/secrets.md` ngay hôm đó.

DNS: bản ghi `A` (và `AAAA` nếu có) của `DOMAIN` trỏ về máy chủ **trước** khi chạy lần đầu, nếu không Caddy không xin được chứng chỉ (Let's Encrypt giới hạn số lần thử sai).

Mọi lệnh `deploy/scripts/*.sh` chạy bằng `sudo` (hoặc root): đọc tệp môi trường quyền 600 của root, ghi `/var/lib/mihato` (nhớ bản đang chạy để hoàn lại) và `/var/backups/mihato`.

Sao lưu theo lịch: `sudo cp deploy/systemd/mihato-backup.* /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now mihato-backup.timer` (xem `docs/ops/backup.md`).

## 3. Khởi động lần đầu

```bash
cd /opt/mihato
deploy/scripts/check-env.sh v1.0.0          # kiểm tệp môi trường (không in giá trị bí mật)
deploy/scripts/deploy.sh v1.0.0             # kéo ảnh, check-env, migrate MỘT lần, up -d, chờ /readyz
```

Tạo tổ chức và quản trị viên đầu tiên (KHÔNG chạy `db:seed` ở production: nó tự từ chối và sẽ không bao giờ tạo dữ liệu mẫu ở đây):

```bash
cd /opt/mihato
export TAG=v1.0.0
docker compose --env-file /etc/mihato/production.env -f deploy/compose.production.yml run --rm --no-deps \
  -e ORG_CODE=vrg -e ORG_NAME="<tên tổ chức>" -e ADMIN_EMAIL=<email> -e ADMIN_FULL_NAME="<họ và tên>" \
  api node --import tsx packages/backend/scripts/bootstrap-org.ts
```

Lệnh in **một lần** đường dẫn đặt mật khẩu (dùng một lần, hết hạn sau 72 giờ). Chuyển cho quản trị viên qua kênh riêng. Mất đường dẫn: chạy lại với `--reissue-link`. Chạy lại cùng `ORG_CODE` không tạo trùng. Quản trị viên (`it_admin`) phải bật TOTP ở lần đăng nhập đầu (`ENFORCE_MFA` bật ở production); sau đó tạo người dùng, đơn vị, nạp ba quy trình mẫu từ thư viện mẫu và cấu hình tổ chức trên web.

Kiểm khói sau lần đầu (ghi kết quả vào nhật ký diễn tập):

```bash
curl -fsS https://$DOMAIN/healthz && curl -fsS https://$DOMAIN/readyz     # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/internal/v1/jwks   # phải là 404
curl -sI https://$DOMAIN/ | grep -i -E 'strict-transport|content-security|x-frame'
cd /opt/mihato && TAG=$(cat /var/lib/mihato/current-tag) docker compose --env-file /etc/mihato/production.env -f deploy/compose.production.yml ps
```

Sau đó: mở web, đăng nhập, bật TOTP; tạo một người thử, kích hoạt app trên máy thật (cần `eas.json` và bản dựng, ngoài phạm vi tài liệu này); chạy một lượt quy trình; tắt thử worker (mục 7) để xem cảnh báo đến người trực.

## 4. Nâng cấp

> **Thường không cần làm gì**: gộp PR vào `main`, CI xanh thì workflow `deploy` tự triển khai không gián đoạn (docs/ops/auto-deploy.md). Phần dưới là cách làm tay, vẫn dùng cùng `deploy.sh`.

Mục tiêu SPEC 12.7 điều 2: **một lệnh**, hoàn lại bản trước trong 15 phút.

```bash
git tag v1.0.1 && git push --tags            # release.yml dựng và đẩy hai ảnh lên GHCR
# trên máy chủ:
cd /opt/mihato && git pull --ff-only
deploy/scripts/deploy.sh v1.0.1
```

`deploy.sh` làm theo thứ tự: kiểm tệp môi trường (quyền 600), kéo ảnh, chạy `check-env`, **sao lưu CSDL** (bỏ qua ở lần đầu; `SKIP_BACKUP=1` chỉ khi diễn tập), `migrate` đúng một lần (khoá tư vấn chặn hai bản chạy song song), `up -d`, chờ `/healthz` rồi `/readyz`, ghi `current-tag` và `previous-tag` ở `/var/lib/mihato`. Lỗi ở bước nào thì dừng, in bản trước và lệnh hoàn lại.

**Quy tắc migration (SPEC 12.3, bắt buộc): mở rộng rồi thu hẹp.** Một bản phát hành chỉ được THÊM (cột, bảng, chỉ mục, cột có mặc định). Bỏ cột, bỏ bảng, đổi kiểu, thêm ràng buộc chặt hơn chỉ ở bản phát hành SAU, khi chắc chắn không còn cần hoàn lại về bản trước nữa. Lý do: hoàn lại chỉ đổi ảnh, không đổi CSDL; ảnh cũ phải chạy được trên CSDL mới. Trước khi gắn tag, người duyệt PR kiểm từng migration mới theo câu hỏi: "bản api trước chạy được trên schema này không?". Migration không tự lùi (CLAUDE.md luật 9: chỉ tiến).

## 5. Hoàn lại

```bash
deploy/scripts/rollback.sh            # về bản ngay trước (previous-tag); hoặc rollback.sh v1.0.0
```

Chỉ đổi ảnh `api`, `worker`, `scribe`, `web`, `ops-alert`; không migrate, không đụng CSDL. Dùng khi bản mới lỗi mà migration của nó chỉ mở rộng.

**Không dùng rollback.sh** khi: bản mới có migration thu hẹp, hoặc migration/ứng dụng đã làm hỏng dữ liệu. Khi đó khôi phục sao lưu mới nhất trước lần triển khai (backup.sh --db-only đã chạy trước migrate): xem `docs/ops/backup.md`, mục "Khôi phục thật". Dữ liệu ghi giữa lúc sao lưu và lúc khôi phục sẽ mất; báo người dùng.

Diễn tập hoàn lại trên staging (hoặc trên máy thật trước khi nhập dữ liệu thật): deploy bản N, deploy bản N+1, rollback, đo tổng thời gian (mục tiêu dưới 15 phút), ghi vào nhật ký diễn tập.

## 6. Xoay khoá mỗi 90 ngày

Bảng người giữ, nơi lưu, ngày xoay gần nhất: `docs/security/secrets.md`. Quy trình từng loại khoá cũng ở đó. Tóm tắt thứ tự: báo trước 1 ngày; sinh khoá mới; cập nhật `/etc/mihato/production.env`; `deploy/scripts/check-env.sh <tag>`; `docker compose ... up -d api worker scribe` (phiên trợ lý đang mở rớt vài giây); kiểm `/readyz`; ghi ngày xoay.

## 7. Cảnh báo SPEC 12.4 và cách xử lý

`ops-alert` kiểm mỗi 60 giây, gửi khi điều kiện kéo dài đủ lâu, nhắc lại mỗi 6 giờ, gửi "ĐÃ XỬ LÝ" khi hết. Xem điều kiện hiện tại: `docker compose ... exec ops-alert node deploy/ops/ops-alert.mjs --once`.

| Cảnh báo | Ngưỡng | Làm gì |
| --- | --- | --- |
| `effects_dead` | có effect `dead` trong 10 phút | Web quản trị, Hệ thống, tab Effects: xem loại effect và mã lỗi, sửa nguyên nhân (thường là push hoặc nhà cung cấp lỗi), bấm **Thử lại**. `dedupe_key` giữ nguyên nên không gửi trùng. Cảnh báo tự hết khi không còn effect `dead` |
| `effects_lag`, `timers_lag` | đến hạn mà chưa chạy quá 5 phút | Thường là worker chậm hoặc chết: kiểm `worker_heartbeat`, `docker compose ... logs --tail=100 worker`, CSDL quá tải (`docker stats`). Khởi động lại: `docker compose ... restart worker`. Nhắc việc trễ là mất uy tín của hệ thống: báo Văn phòng nếu trễ trên 30 phút |
| `worker_heartbeat` | mất nhịp 2 phút | `docker compose ... ps worker`, `logs worker`; `restart worker`. Nếu worker khởi động rồi chết ngay: thường là cấu hình (nhà cung cấp push, biến môi trường) hoặc CSDL; log nêu tên biến, không nêu giá trị. Sau khi sống lại, effect `processing` kẹt được nhả sau tối đa 10 phút |
| `push_failures` | trên 20% thông báo lỗi trong 1 giờ (từ 10 thông báo) | Kiểm trạng thái Expo (status.expo.dev), token `EXPO_ACCESS_TOKEN`, thiết bị `DeviceNotRegistered` (người đã gỡ app). Thông báo trong app vẫn hiện; chỉ đẩy ra ngoài lỗi |
| `disk_usage` | ổ trên 80% | `docker system df`; `docker image prune -a` (ảnh cũ); nhật ký container đã xoay (50 MB × 5 mỗi dịch vụ); kho tệp `/data/files` và `pgdata` lớn dần là bình thường: mở rộng ổ trước khi đạt 90%. Không xoá tay trong `pgdata` hay `files` |
| `tls_expiry` | chứng chỉ còn dưới 14 ngày | Caddy tự gia hạn từ 30 ngày trước hạn; còn dưới 14 ngày nghĩa là đang gia hạn hỏng: `docker compose ... logs web`; kiểm DNS còn trỏ đúng, cổng 80 mở (thử thách HTTP-01), `ACME_EMAIL` đúng, chưa đụng giới hạn của Let's Encrypt |
| `backup` | lần sao lưu gần nhất thất bại, hoặc cũ quá 26 giờ, hoặc chưa có | `cat /var/backups/mihato/status.json` (trường `error`); `journalctl -u mihato-backup`; chạy tay `deploy/scripts/backup.sh`. Lỗi thường gặp: ổ đầy, chưa cấu hình `AGE_RECIPIENT` hoặc nơi đặt bản sao khác máy chủ (`BACKUP_RCLONE_REMOTE` hoặc `BACKUP_RSYNC_TARGET`), mất kết nối tới nơi đặt |

Chưa có (ghi rõ để không tưởng đã có): độ trễ p50 và p95 theo tuyến API, tỷ lệ lỗi theo nhà cung cấp, số token LLM theo ngày, số kết nối WebSocket và SSE, độ trễ bốn chặng của một lượt trợ lý (xem `docs/DECISIONS.md`). Ngân sách LLM 80% và 100% đã có trong ứng dụng (thông báo cho `it_admin`). Cảnh báo đến người trực qua email chưa làm (cần máy chủ SMTP): dùng webhook hoặc Telegram. Cần **một probe ngoài máy chủ** gọi `https://$DOMAIN/readyz` mỗi phút (UptimeRobot, Better Stack hoặc tương đương): `ops-alert` chạy cùng máy nên không báo được khi cả máy chết.

Bắt thử từng cảnh báo một lần trước khi nhập dữ liệu thật (SPEC 12.7 điều 4), ghi kết quả vào nhật ký diễn tập: `docker compose ... stop worker` (sau 2 phút phải có `worker_heartbeat`); tạo một effect lỗi liên tục cho tới `dead`; đặt `PUSH_PROVIDER` sai trên staging; tạm đổi `BACKUP_DIR` rỗng.

## 8. Sự cố

Quy trình, phân loại, mẫu biên bản: `docs/ops/incident.md`. Việc đầu tiên khi nghi lộ khoá: `docs/security/secrets.md`, mục "Khi nghi lộ khoá".

## 9. Lệnh hay dùng

Đặt bí danh cho đỡ gõ: `alias dc='cd /opt/mihato && TAG=$(cat /var/lib/mihato/current-tag) docker compose --env-file /etc/mihato/production.env -f deploy/compose.production.yml'`.

```bash
dc ps                                   # trạng thái và health
dc logs --tail=200 -f api worker        # nhật ký (JSON; chỉ id, tuyến, mã, thời gian; không nội dung nghiệp vụ)
dc restart worker
dc exec postgres psql -U postgres -d mihato          # superuser: bỏ qua RLS, CHỈ để điều tra, không sửa dữ liệu nghiệp vụ
dc exec ops-alert node deploy/ops/ops-alert.mjs --once
```

Mất TOTP của một quản trị viên: hiện chưa có đường đặt lại trên giao diện (rà soát auth-3). Ngoại lệ, chỉ it_admin còn lại hoặc người giữ khoá hạ tầng làm, ghi vào biên bản sự cố: `dc exec postgres psql -U postgres -d mihato -c "update users set totp_enabled=false, totp_secret=null where email='<email>'"` rồi người đó đăng nhập và bật lại TOTP.

## 10. Nhật ký diễn tập

Điền mỗi lần: ngày, người làm, việc, kết quả, chỗ runbook sai.

| Ngày | Việc | Kết quả | Sửa runbook |
| --- | --- | --- | --- |
| (chưa có) | Triển khai lần đầu | | |
| (chưa có) | Deploy rồi rollback, đo thời gian | | |
| (chưa có) | Bắt thử 7 cảnh báo | | |
| (chưa có) | Khôi phục sao lưu lên máy sạch, đo RPO và RTO | | |
