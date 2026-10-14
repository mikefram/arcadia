# Quản lý khoá và bí mật

Viết ngày 07/10/2026 (rà soát config-20). SPEC 11.4: khoá ở biến môi trường hoặc bộ quản lý bí mật, xoay 90 ngày **[MỤC TIÊU]**; SPEC 10.7.1: service token xoay 90 ngày. **Cột "Người giữ" chờ Mike điền**: chưa có người được chỉ định. Không điền tên người vào tệp này nếu repo công khai; tệp này nằm trong repo riêng của công ty.

Nguyên tắc:

1. Bí mật thật chỉ nằm ở hai nơi: **tệp môi trường trên máy chủ** (`/etc/mihato/production.env`, chủ root, quyền 600, ngoài repo) và **kho mật khẩu của công ty** (bản dự phòng, có kiểm soát truy cập và nhật ký). Không bao giờ: repo, chat, email, ảnh chụp màn hình, ticket, nhật ký, biến CI trừ khi liệt kê dưới đây.
2. Mỗi khoá sinh riêng, ngẫu nhiên (lệnh ở `docs/ops/runbook.md`, mục 2). Không dùng lại giữa các khoá hay giữa staging và production (staging có khoá riêng, hạn mức thấp).
3. Ứng dụng từ chối khởi động ở production nếu `AUTH_SECRET` hoặc `INTERNAL_SERVICE_TOKEN` ngắn hơn 32 ký tự, chứa `dev-`, `change-me`, hay hai khoá trùng nhau; từ chối mật khẩu CSDL đuôi `_dev` (`packages/backend/src/env-check.ts`).
4. Mỗi dịch vụ chỉ nhận khoá nó cần (`deploy/compose.production.yml`): scribe không có địa chỉ CSDL; api không có `app_owner` và `app_scan`; chỉ container `migrate` có `app_owner`.

## Bảng khoá

Cột "Xoay gần nhất" điền ngày thật mỗi lần xoay. Hạn xoay = 90 ngày sau ngày đó (đặt nhắc lịch cho người giữ).

| Khoá | Dùng để | Nơi lưu (ngoài kho mật khẩu) | Người giữ chính | Dự phòng | Xoay gần nhất | Chu kỳ |
| --- | --- | --- | --- | --- | --- | --- |
| `POSTGRES_PASSWORD` | superuser CSDL (sao lưu, khôi phục, điều tra) | `production.env` | (chờ Mike) | (chờ Mike) | (chưa) | 90 ngày |
| `APP_OWNER_PASSWORD` | `app_owner`: chỉ chạy migration | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `APP_USER_PASSWORD` | `app_user`: api, worker, ops-alert (chịu RLS) | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `APP_SCAN_PASSWORD` | `app_scan`: worker, ops-alert (BYPASSRLS, chỉ timers, effects) | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `AUTH_SECRET` | ký access token, mfaToken, stepUpToken (HS256) | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `INTERNAL_SERVICE_TOKEN` | scribe gọi `/internal/v1/*` của api (SPEC 10.7.1) | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `SCRIBE_JWT_PRIVATE_KEY` | ký token phiên trợ lý (ES256); scribe tự lấy khoá công khai qua JWKS | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| Khoá riêng age (sao lưu) | giải mã bản sao lưu | **chỉ** kho mật khẩu công ty, KHÔNG ở máy chủ | (chờ Mike) | (chờ Mike, bắt buộc có dự phòng) | (chưa) | khi có người rời, hoặc 1 năm |
| Khoá truy cập nơi đặt bản sao (`rclone`, ssh) | đẩy bản sao lưu | máy chủ, tài khoản chỉ ghi thêm | (chờ Mike) | | (chưa) | 90 ngày |
| `ANTHROPIC_API_KEY` | gọi Claude (scribe) | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `DEEPGRAM_API_KEY` | STT (scribe) | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `VBEE_APP_ID`, `VBEE_TOKEN` | TTS (scribe) | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `EXPO_ACCESS_TOKEN` | gửi thông báo đẩy (worker), nếu bật bảo mật nâng cao ở Expo | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| Khoá API Resend của tổ chức | gửi thư kích hoạt tài khoản (worker) | CSDL, bảng `org_email_settings`, mã hoá AES-256-GCM; nhập ở web quản trị (Cài đặt → Gửi thư), chỉ ghi | quản trị `org.settings` | | (chưa) | 90 ngày; **khoá đã dán vào cuộc trò chuyện ngày 12/10/2026 phải thu hồi và cấp lại ở resend.com trước khi dùng** |
| `SECRETS_ENCRYPTION_KEY` | khoá mã hoá bí mật lưu trong CSDL (api ghi, worker giải mã); trống thì dẫn xuất từ `AUTH_SECRET` | `production.env` | (chờ Mike) | | (chưa) | khi đổi thì mọi khoá API đã lưu không giải được, nhập lại ở web quản trị |
| `RESEND_API_KEY`, `EMAIL_FROM` (tuỳ chọn) | cấu hình thư DỰ PHÒNG khi tổ chức chưa đặt ở web quản trị | `production.env` | (chờ Mike) | | (chưa) | 90 ngày |
| `ALERT_WEBHOOK_URL`, `ALERT_TELEGRAM_BOT_TOKEN` | gửi cảnh báo cho người trực | `production.env` | (chờ Mike) | | (chưa) | khi đổi người trực |
| Chứng chỉ TLS của Caddy | HTTPS | volume `mihato_caddy_data` (Caddy tự xoay) | không có người giữ: tự động | | tự động | tự động, theo dõi cảnh báo `tls_expiry` |
| Tài khoản Apple Developer, Google Play, Expo (EAS), upload keystore Android | phát hành app | `docs/ops/mobile-release.md` | (chờ Mike) | | | theo chính sách của nhà cung cấp |
| Tài khoản GitHub, token GHCR | phát hành ảnh | GitHub (xác thực hai yếu tố bắt buộc) | (chờ Mike) | | | |
| Mật khẩu web của người dùng | đăng nhập web | CSDL (Argon2id); TOTP bắt buộc cho `it_admin`, `office_admin`, `process_designer` | từng người | | do người dùng | |

Tên miền và DNS: người giữ tài khoản đăng ký tên miền là một điểm hỏng đơn lẻ (mất quyền = mất hệ thống): ghi ở đây khi có (chờ Mike).

## Quy trình xoay từng loại

Chung: báo trước người dùng 1 ngày nếu có gián đoạn; làm ngoài giờ cao điểm; ghi ngày xoay vào bảng trên; kiểm sau bằng `deploy/scripts/check-env.sh <tag>` rồi `/readyz`. Lệnh `dc` là bí danh ở `docs/ops/runbook.md`, mục 9.

| Khoá | Cách xoay | Ảnh hưởng |
| --- | --- | --- |
| `AUTH_SECRET` | Sinh mới, sửa `production.env`, `dc up -d api worker`. Token cũ hết hiệu lực | Access token (15 phút), mfaToken (5 phút), stepUpToken (60 giây) mất: người dùng web đang dùng bị yêu cầu đăng nhập lại nếu đúng lúc đó; phiên web là token mờ lưu băm trong CSDL nên **không** mất; thiết bị app tự làm mới bằng refresh token |
| `INTERNAL_SERVICE_TOKEN` | Sinh mới, sửa `production.env`, **`dc up -d api scribe worker` cùng một lệnh** (hai bên phải khớp) | Phiên trợ lý đang mở rớt vài giây rồi nối lại. Chưa có chế độ chấp nhận hai token (rà soát config-20, tuỳ chọn sau pilot) nên có khoảng lệch ngắn giữa hai dịch vụ |
| `SCRIBE_JWT_PRIVATE_KEY` | Sinh khoá EC mới, sửa `production.env`, `dc up -d api`. Scribe tải lại khoá công khai qua JWKS (mã `kid`) | Token phiên Scribe sống 120 giây nên chỉ ảnh hưởng lượt đang mở |
| Mật khẩu CSDL (`APP_*_PASSWORD`, `POSTGRES_PASSWORD`) | Đổi trong CSDL trước: `dc exec postgres psql -U postgres -c "ALTER ROLE app_user PASSWORD '<mới>'"`; sửa `production.env`; `dc up -d`. Mật khẩu chỉ dùng ký tự hex (không cần mã hoá URL). `POSTGRES_PASSWORD` chỉ dùng lúc khởi tạo volume trống: đổi ở đây không đổi mật khẩu thật, phải `ALTER ROLE postgres` | Dịch vụ khởi động lại vài giây |
| Khoá age (sao lưu) | Sinh cặp mới ở máy khác, sửa `AGE_RECIPIENT`; **giữ khoá riêng cũ** để đọc các bản sao lưu cũ (còn trong 14 ngày) | Không gián đoạn |
| Khoá nhà cung cấp (Anthropic, Deepgram, Vbee, Expo) | Tạo khoá mới ở bảng điều khiển nhà cung cấp, sửa `production.env`, `dc up -d scribe worker`, kiểm một lượt trợ lý và một thông báo đẩy, **rồi mới thu hồi khoá cũ** | Không gián đoạn nếu làm đúng thứ tự |

## Khi nghi lộ khoá

1. Xác định khoá nào và lộ ở đâu (repo? chat? máy bị xâm nhập?). Mở biên bản sự cố (`docs/ops/incident.md`).
2. **Xoay ngay**, không chờ điều tra xong: khoá nhà cung cấp trước (có thể tiêu tiền thật: Anthropic, Deepgram, Vbee), rồi `AUTH_SECRET`, `INTERNAL_SERVICE_TOKEN`, `SCRIBE_JWT_PRIVATE_KEY`, mật khẩu CSDL.
3. Nghi máy chủ bị xâm nhập: coi mọi khoá trong `production.env` là lộ; dựng máy mới từ bản sao lưu (docs/ops/backup.md), không "dọn" máy cũ.
4. Khoá nằm trong lịch sử Git: xoay trước, rồi mới nghĩ tới viết lại lịch sử (xoá khỏi lịch sử không thu hồi được khoá đã lộ). Gitleaks chạy ở CI (`.github/workflows/ci.yml`, job `secrets`); báo đỏ thì xoay khoá đó.
5. Kiểm hạn mức và hoá đơn của nhà cung cấp trong 24 giờ sau; kiểm `audit_log` để tìm truy cập bất thường.
6. Có thể lộ dữ liệu cá nhân thì theo mục "Lộ dữ liệu cá nhân" ở `docs/ops/incident.md`.

## Việc chưa làm

- Người giữ khoá và dự phòng (chờ Mike).
- Chế độ chấp nhận hai `INTERNAL_SERVICE_TOKEN` trong 24 giờ để xoay không gián đoạn (config-20, tuỳ chọn, sau pilot).
- Bộ quản lý bí mật chuyên dụng (Vault hoặc của nhà cung cấp hạ tầng); hiện dùng tệp môi trường có kiểm soát quyền.
- Mã hoá cột `totp_secret` và mã hoá ổ đĩa (rà soát data-5; phụ thuộc nhà cung cấp hạ tầng chưa chọn).
