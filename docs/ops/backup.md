# Sao lưu và khôi phục

Mục tiêu SPEC 12.5 **[MỤC TIÊU]**: bản đầy đủ mỗi ngày, giữ 14 ngày, mã hoá, đặt khác máy chủ; RPO 15 phút, RTO 4 giờ; thử khôi phục lên máy sạch mỗi quý, có biên bản. Viết ngày 07/10/2026, **chưa lần nào chạy thật**: `backup.sh` mới chạy với `docker` giả để kiểm logic bash (trạng thái, mã hoá, giữ ngày, thất bại khi thiếu nơi đặt khác máy); `restore.sh` mới kiểm cú pháp.

## Hiện có và chưa có

| Điều | Trạng thái |
| --- | --- |
| `pg_dump` định dạng custom, hằng ngày, kèm kiểm danh mục `pg_restore --list` | Có (`deploy/scripts/backup.sh`) |
| Sao lưu thư mục tệp đính kèm cùng mốc giờ | Có |
| Mã hoá age hoặc gpg; từ chối sao lưu bản rõ nếu chưa có khoá | Có |
| Giữ 14 ngày (cục bộ, và rclone ở nơi đặt khác) | Có |
| Đẩy sang nơi khác máy chủ (rclone hoặc rsync); thiếu thì trạng thái là THẤT BẠI và có cảnh báo | Có, **chờ Mike chọn nơi (Q9)** |
| Tệp trạng thái `status.json` và cảnh báo (`ops-alert`) | Có |
| Sao lưu CSDL dày hơn trong ngày (`--db-only`, mỗi 4 giờ) | Có, tuỳ chọn (`mihato-backup-db.timer`) |
| **WAL liên tục, khôi phục theo thời điểm, RPO 15 phút** | **Chưa có.** RPO thực tế là 24 giờ (hoặc 4 giờ khi bật timer 4 giờ). Cần bật `archive_mode` cộng công cụ (pgBackRest hoặc WAL-G) và một nơi đặt ngoài máy chủ: làm sau khi Mike chọn nơi đặt (Q9). Ghi vào DECISIONS để không tưởng đã đạt 15 phút |
| Sao lưu tệp bằng kho đối tượng S3 | Chưa (kho tệp là volume cục bộ, tạm thời; docs/DECISIONS.md, 06/10/2026) |
| Diễn tập khôi phục lên máy sạch, đo RPO/RTO, biên bản | **Chưa làm: phải làm trước khi nhập dữ liệu thật** (SPEC 12.7 điều 3) |

Không sao lưu: tệp môi trường `/etc/mihato/production.env` (chứa khoá; giữ ở kho mật khẩu công ty, xem `docs/security/secrets.md`), chứng chỉ Caddy (xin lại tự động), ảnh Docker (có ở registry).

## Cấu hình một lần

1. Sinh cặp khoá age ở **máy khác**: `age-keygen -o mihato-backup.key`; dán dòng `Public key: age1...` vào `AGE_RECIPIENT` trong `/etc/mihato/production.env`. **Khoá riêng không để trên máy chủ**: cất ở kho mật khẩu của công ty, kèm người dự phòng (mất khoá riêng là mất toàn bộ bản sao lưu). Cài `age` trên máy chủ (`apt install age`).
2. Nơi đặt khác máy chủ (Q9): `BACKUP_RCLONE_REMOTE=remote:bucket/duong-dan` (rclone đã `rclone config`) hoặc `BACKUP_RSYNC_TARGET=user@host:/duong-dan` (khoá ssh của người chạy timer, nên là tài khoản chỉ ghi thêm, không xoá). Chưa chọn thì sao lưu vẫn tạo bản cục bộ nhưng trạng thái là thất bại để không ai tưởng đã an toàn; chỉ đặt `BACKUP_REQUIRE_OFFSITE=false` khi Mike chấp nhận tạm thời bằng văn bản.
3. Bật timer: `sudo cp deploy/systemd/mihato-backup*.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now mihato-backup.timer` (thêm `mihato-backup-db.timer` nếu muốn bản CSDL mỗi 4 giờ). Hoặc cron: `0 2 * * * /opt/mihato/deploy/scripts/backup.sh`.
4. Chạy tay lần đầu: `sudo deploy/scripts/backup.sh`, rồi `cat /var/backups/mihato/status.json` phải có `"ok":true,"encrypted":true,"offsite":true`.

Mỗi lần chạy tạo: `mihato-db-<mốc>.dump.age`, `mihato-files-<mốc>.tar.gz.age`, `SHA256SUMS-<mốc>`, và cập nhật `status.json`. `pg_dump` chạy bằng superuser trong container (RLS FORCE chặn cả chủ bảng, chỉ superuser mới dump đủ).

## Diễn tập khôi phục (mỗi quý, và một lần trước khi nhập dữ liệu thật)

**Diễn tập trên máy đang chạy (an toàn, không đụng CSDL thật)**: khôi phục vào CSDL phụ `mihato_restore`:

```bash
cd /opt/mihato
deploy/scripts/restore.sh --db /var/backups/mihato/mihato-db-<mốc>.dump.age \
  --files /var/backups/mihato/mihato-files-<mốc>.tar.gz.age --age-identity /đường/dẫn/mihato-backup.key
```

Lệnh giải mã, kiểm tổng băm, tạo CSDL phụ, `pg_restore --exit-on-error --single-transaction`, in số dòng các bảng chính (đối chiếu với web quản trị hoặc CSDL thật) và số tệp giải ra `/var/lib/mihato/restore-drill-files` (số tệp trên đĩa phải lớn hơn hoặc bằng số dòng `files`; dư là tệp mồ côi, thiếu là lỗi). Xong: `dropdb` CSDL phụ như script nhắc.

**Diễn tập trên máy sạch (bắt buộc ít nhất một lần, đo RTO)**:

1. Máy mới cùng cấu hình; cài Docker; chép `deploy/`; tạo `/etc/mihato/production.env` từ kho mật khẩu (cùng mật khẩu CSDL, `AUTH_SECRET`, `INTERNAL_SERVICE_TOKEN`, `SCRIBE_JWT_PRIVATE_KEY`; **khác** nếu muốn đổi, miễn là nhất quán). Bấm giờ từ đây.
2. Kéo bản sao lưu về (từ nơi đặt khác máy chủ) cùng khoá riêng age.
3. `export TAG=<tag đang chạy>`; `docker compose ... up -d postgres` (init-roles tạo vai trò và CSDL rỗng).
4. `deploy/scripts/restore.sh --db ... --files ... --age-identity ... --replace-live --yes` (tạo lại CSDL `mihato` từ bản sao lưu và giải tệp vào volume).
5. `deploy/scripts/deploy.sh <tag>` (migrate nếu bản sao lưu cũ hơn, khởi động mọi dịch vụ), trỏ DNS về máy mới, đợi chứng chỉ.
6. Đăng nhập, mở một lượt chạy có tệp đính kèm, tải tệp về mở được; kiểm audit_log mới nhất khớp mốc sao lưu. Dừng giờ: RTO. Mốc sao lưu so với lúc "mất" máy cũ: RPO.
7. Lập biên bản (mẫu bên dưới) lưu cùng `docs/ops/runbook.md` mục Nhật ký diễn tập.

## Khôi phục thật (mất dữ liệu hoặc hỏng sau migrate)

1. Quyết định ở ai: người giữ quyền vận hành (docs/security/secrets.md) cộng đại diện VRG; ghi vào biên bản sự cố (`docs/ops/incident.md`).
2. `docker compose ... stop web api worker scribe ops-alert` (để CSDL không có kết nối).
3. Chọn bản sao lưu mới nhất còn tốt (trước sự cố). `restore.sh ... --replace-live --yes`.
4. `deploy/scripts/deploy.sh <tag>`; thông báo người dùng khoảng dữ liệu mất (từ mốc sao lưu tới lúc dừng).
5. Mọi thiết bị đã kích hoạt sau mốc sao lưu có thể mất phiên: cấp lại mã kích hoạt.

## Mẫu biên bản diễn tập khôi phục

```
Ngày:                 Người làm:                 Người chứng kiến:
Bản sao lưu dùng:     (tên tệp, mốc UTC)         Máy: (cấu hình, nhà cung cấp)
Giờ bắt đầu / xong:   RTO đo được:               Mục tiêu 4 giờ: đạt / không
Mốc dữ liệu mới nhất sau khôi phục:              RPO đo được:  (mục tiêu 15 phút; hiện kỳ vọng 24 giờ)
Số dòng: organizations / users / process_runs / files / audit_log (khớp bản gốc?)
Số tệp trên đĩa và số dòng files:                Tải được tệp mẫu: có / không
Đăng nhập, TOTP, một lượt chạy mở được:           có / không
Lỗi gặp và sửa runbook:
Kết luận:
```
