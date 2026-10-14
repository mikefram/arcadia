# MIHATO Điều hành

Nền tảng nội bộ điều hành quy trình và giao việc bằng AI cho MIHATO và VRG.
Đặc tả: [docs/SPEC.md](docs/SPEC.md). Luật dự án cho Claude Code: [CLAUDE.md](CLAUDE.md). Quyết định và câu hỏi mở: [docs/DECISIONS.md](docs/DECISIONS.md).

## Chạy trên máy phát triển

Cần Node 22 trở lên, pnpm, Docker.

```bash
pnpm install
pnpm db:up          # PostgreSQL 16 ở cổng 5455, tạo ba vai trò CSDL và hai CSDL mihato_dev, mihato_test
pnpm db:migrate     # bảng, RLS, quyền, trigger, view
pnpm db:seed        # dữ liệu mẫu SPEC 15.4 và ba lượt chạy mẫu; in tài khoản và mật khẩu mẫu
pnpm dev            # api :3100, worker, web quản trị :5273 (mọi nhà cung cấp là bản giả)
```

Mở http://localhost:5273 và đăng nhập bằng một tài khoản mẫu, ví dụ `vanphong@demo.mihato.local` (Văn phòng),
`thietke@demo.mihato.local` (người vẽ quy trình), `it@demo.mihato.local` (quản trị hệ thống), `lan@demo.mihato.local` (nhân viên).

Hoặc chạy cả bộ trong Docker (vẫn là bản giả; không cần cài Node, mở http://localhost:5273):

```bash
docker compose --profile app up --build                  # postgres, migrate (chỉ migration), api :3100, worker, scribe :3200, web quản trị :5273; CSDL trống
docker compose --profile app --profile demo up --build   # thêm service `seed`: dữ liệu mẫu SPEC 15.4 (chỉ máy phát triển)
```

Hai app di động (Expo, bản dựng phát triển):

```bash
pnpm db:seed -- --links                       # in đường dẫn kích hoạt thiết bị cho từng người mẫu
pnpm --filter @mihato/mobile-staff dev        # app nhân viên
pnpm --filter @mihato/mobile-executive dev    # app Chủ tịch, Giám đốc, Phó giám đốc
pnpm dev:all                                  # thêm dịch vụ scribe :3200 cho trợ lý
```

### Thử app Chủ tịch

Cần api và CSDL đang chạy (`pnpm dev`; thêm `pnpm dev:all` nếu muốn dùng Trợ lý) và đường dẫn kích hoạt của Chủ tịch từ
`pnpm db:seed -- --links` (dùng một lần, hết hạn sau 72 giờ, ghi vào `db/seed/activation-links.txt`, dòng "chairman").

- **Trình duyệt (nhanh nhất, nói được bằng micro):** `pnpm --filter @mihato/mobile-executive web`, mở http://localhost:8081, dán
  đường dẫn vào ô mã rồi đặt PIN 6 số. Đã kiểm bằng trình duyệt thường (có CORS), kích hoạt và vào được Trang chủ.
- **Máy ảo iOS hoặc Android, điện thoại thật:** `pnpm --filter @mihato/mobile-executive ios` hoặc `android` (cần Xcode hoặc Android
  Studio), hoặc `pnpm --filter @mihato/mobile-executive dev` rồi quét mã QR bằng Expo Go (cùng mạng Wi-Fi; phải là bản Expo Go
  hỗ trợ SDK 57. Theo thông báo của Expo ngày 03/09/2026, Expo Go trên iPhone bắt buộc đăng nhập cùng một tài khoản Expo trong terminal
  (`npx expo login`) và trong app Expo Go; Android tải đúng bản SDK ở https://expo.dev/go). Điện thoại thật không gọi được `localhost`: trong `.env` đổi `PUBLIC_API_URL` và `PUBLIC_SCRIBE_WS_URL` sang địa chỉ
  máy tính trong mạng nội bộ (máy ảo Android: `10.0.2.2`), chạy lại api và scribe, rồi lấy lại đường dẫn bằng `pnpm db:seed -- --links`.
  Expo Go không mở được đường dẫn `mihato-exec://`: dán đường dẫn hoặc quét mã QR ngay trong màn kích hoạt. **Chưa chạy lần nào trên
  máy ảo hay máy thật**; bản đóng gói iOS và Android đã biên dịch được (`expo export`).
- **Micro trên iOS và Android** dùng `AudioStream` của expo-audio (đề xuất cho Q15, **chưa thử trên máy thật**): bấm micro, cho phép dùng
  micro, rồi nói. Báo "máy này chưa thu âm được" nghĩa là bản Expo Go của máy chưa có `AudioStream` (cần SDK 56 trở lên);
  app vẫn gõ chữ được. Muốn trợ lý nghe hiểu giọng thật, đặt `STT_PROVIDER=deepgram` (kèm `DEEPGRAM_API_KEY`) trong `.env` rồi chạy lại
  scribe. Với `STT_PROVIDER=fake` mỗi lượt nói "nghe" câu kế tiếp trong `FAKE_STT_SCRIPT` bất kể bạn nói gì (để trống thì luôn báo nghe chưa rõ).
- **Chế độ trò chuyện** (mục **Trợ lý**, **chưa thử trên máy thật**): bấm micro MỘT lần, trợ lý nghe liên tục; khi bạn ngừng nói trợ lý tự trả
  lời, đọc xong thì tự nghe tiếp, như "voice mode" của Claude. Chip "Đang trò chuyện", dòng "Trợ lý đang nghe" và thanh mức âm cho thấy micro
  đang mở; nút micro luôn là nút dừng (chữ "Bấm để dừng trò chuyện"); **Đã nói xong** để không phải chờ chỗ ngừng; **Ngắt lời** khi trợ lý đang
  đọc. Tự dừng khi rời màn hình, khoá app, 45 giây không có tiếng, có sự cố, hoặc có đề xuất (màn xác nhận vẫn do bạn chạm; chế độ này không bao
  giờ xác nhận bằng giọng). Thử không tốn tiền: `STT_PROVIDER=fake`, `FAKE_STT_SCRIPT="tình hình đón đoàn Nhật|ai đang chậm"` và
  `FAKE_STT_AUTO_END_CHUNKS=25` (STT giả tự báo hết câu sau 1,5 giây âm thanh); với Deepgram thật, chỗ ngừng do `STT_UTTERANCE_END_MS` (1300 ms).
- **Tạo quy trình bằng trợ lý** (cần chạy scribe: `pnpm dev:all`): ở mục **Trợ lý**, nói hoặc gõ "Tạo quy trình mới tên là Họp hội đồng
  quản trị", rồi đọc từng bước, ví dụ "Bước 1: soạn tài liệu họp, anh Tuấn làm, hạn 3 ngày". Trợ lý đọc lại từng bước bằng câu do máy
  chủ dựng; nói "xong" thì trợ lý đọc lại cả quy trình và mời **Đồng ý tạo bản nháp**. Sau đó nói "Xuất bản quy trình Họp hội đồng quản trị
  và giao việc với tên Họp 15/10" để xuất bản và giao việc ngay. Trợ lý giả chỉ hiểu đúng cú pháp trên; Claude thật nói tự nhiên hơn nhưng chưa thử.

### Bản dựng thử trên iPhone (không dùng Expo Go)

Để thử ngắt lời trợ lý bằng giọng nói (docs/DECISIONS.md, "Ngắt lời bằng giọng nói"): cần mô-đun âm thanh gốc
`apps/mobile-executive/modules/duplex-audio`, mà Expo Go không nạp được. Cách dựng A: Xcode miễn phí cùng Apple ID thường.
**Chưa chạy lần nào** (lúc viết, máy dựng chưa có Xcode); mới kiểm được cấu hình (`expo prebuild`), phần Swift thuần và phần TypeScript.

Làm một lần:

1. Dọn ổ đĩa (Xcode cần nhiều chục GB), cài **Xcode** từ Mac App Store, mở một lần và đồng ý điều khoản, rồi
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` và `sudo xcodebuild -license accept`.
2. `brew install cocoapods` (Ruby của hệ thống đã cũ).
3. Xcode, Settings, Accounts: thêm Apple ID (tạo "Personal Team").
4. iPhone: Cài đặt, Quyền riêng tư và Bảo mật, bật **Chế độ nhà phát triển** (máy khởi động lại); cắm cáp, mở khoá, bấm Tin cậy.
5. Tuỳ chọn: ghi `APPLE_TEAM_ID=<mã đội>` vào `apps/mobile-executive/.env` để đội ký tự vào dự án Xcode mỗi lần sinh lại thư mục `ios`.
   Không ghi thì mở `ios/*.xcworkspace` một lần, chọn target, Signing & Capabilities, Team là Personal Team.

Dựng và chạy:

```bash
pnpm --filter @mihato/mobile-executive ios:device   # sinh thư mục ios (APP_VARIANT=dev), biên dịch, cài vào iPhone; lần đầu mất vài chục phút
pnpm --filter @mihato/mobile-executive dev:client   # máy chủ Metro cho bản dựng thử (lệnh `dev` vẫn mở Expo Go)
```

Cài xong, tin cậy nhà phát triển trên iPhone (Cài đặt, Cài đặt chung, VPN và quản lý thiết bị), mở app **MIHATO Điều hành (thử)**, nối vào
máy chủ Metro (cùng Wi-Fi), rồi **kích hoạt lại thiết bị**: đây là app khác Expo Go, có kho khoá và phiên riêng. Màn đo nằm ở
**Cài đặt**, **Đo khử tiếng vọng (bản thử)**; bản phát hành không có màn này (chỉ hiện khi `__DEV__`).

Bản thử khác bản phát hành (`app.config.ts`, `APP_VARIANT=dev`): mã gói `vn.mihato.dieuhanh.dev` (mã đã dùng với tài khoản miễn phí
không dùng lại được cho tài khoản của công ty); không có thông báo đẩy (Apple ID miễn phí không ký được quyền này); hồ sơ cấp phép **hết hạn
sau một tuần**, chạy lại `ios:device` để gia hạn. Android: chưa có mô-đun, `duplexAudio()` trả `null` và app giữ nút **Ngắt lời**.
`pnpm --filter @mihato/mobile-executive check:duplex-swift` kiểm phần Swift ngay trên Mac chỉ có Command Line Tools (kiểu và bộ đổi tần số);
không kiểm được khử vọng thật, phiên âm thanh iOS và lớp nối Expo.

### Dựng bản phát hành (EAS)

Cấu hình đã có, **chưa dựng lần nào** (chưa có tài khoản Expo, Apple, Google): mỗi app có `app.json`, `app.config.ts` và `eas.json`; lệnh `eas`
chạy từ thư mục của từng app. Bản `preview` và `production` **ghim máy chủ** vào lúc dựng: thiếu `MIHATO_API_BASE_URL` (https) hoặc
`EAS_PROJECT_ID` thì không dựng được, và app bỏ qua `api=` trong đường dẫn kích hoạt hay mã QR (bản phát triển vẫn nhận như trước).
Biểu tượng và màn khởi động hiện là **bản tạm** (không phải logo), sinh bằng `node apps/mobile-executive/scripts/gen-placeholder-assets.mjs`.
Kiểm cấu hình mà không dựng: `APP_VARIANT=production MIHATO_API_BASE_URL=https://… EAS_PROJECT_ID=… npx expo config --type public`
(chạy trong thư mục app). Từng bước (tài khoản, `eas init`, khoá APNs và FCM, TestFlight, Unlisted App Distribution, Google Play nội bộ),
ai làm gì và điều chưa kiểm: **docs/ops/mobile-release.md**.

## Kiểm tra

```bash
pnpm -w lint && pnpm -w typecheck
NODE_ENV=test pnpm db:migrate && pnpm -w test    # đơn vị, thuộc tính engine, tích hợp CSDL, kịch bản vàng
pnpm check:i18n                                  # từ vay mượn bị cấm, đủ chuỗi cho mọi mã lỗi
pnpm --filter @mihato/api openapi -- --check     # hợp đồng API khớp bản đã duyệt
pnpm db:reset --yes && pnpm db:migrate && pnpm db:seed # dữ liệu mẫu mới (reset đòi --yes, chỉ CSDL *_dev/*_test), rồi (api và web đang chạy):
pnpm --filter @mihato/web-admin e2e              # Playwright qua giao diện thật; cần psql và tài khoản mẫu it@, vanphong@
```

## Cấu trúc

| Thư mục | Vai trò |
| --- | --- |
| `packages/domain` | Schema Zod, hợp đồng API (`src/contract.ts`), bảng quyền, lịch làm việc, lịch âm, chuẩn hoá tiếng Việt |
| `packages/workflow-engine` | `createRun`, `advance`, `validate`, `simulate`, `replay`: hàm thuần, không I/O |
| `packages/backend` | Lớp CSDL dùng chung của api và worker: RLS, chạy `advance()` trong giao dịch, xác thực, đề xuất, thông báo |
| `packages/api-client` | Client có kiểu cho web và hai app, suy ra từ bảng route |
| `packages/providers` | `SttProvider`, `LlmClient`, `TtsProvider`, `PushProvider` và các bản giả |
| `packages/ai-tools` | Định nghĩa tool, prompt, chốt chặn số liệu, bộ đánh giá |
| `packages/i18n`, `packages/ui-tokens` | Chuỗi tiếng Việt và token giao diện (hồ sơ `senior`, `standard`) |
| `apps/api`, `apps/worker`, `apps/scribe` | REST và SSE; effects và timers; phiên giọng nói |
| `apps/web-admin` | Web quản trị: tổng quan, điều phối, trình thiết kế quy trình, người dùng, báo cáo |
| `apps/mobile-staff`, `apps/mobile-executive` | App nhân viên; app Chủ tịch (ưu tiên giọng nói, chữ lớn) |
| `db/migrations`, `db/seed` | Migration chỉ tiến; dữ liệu mẫu |

## Triển khai production

**Không dùng `docker-compose.yml` ở gốc repo cho máy thật** (nó là bản phát triển: mật khẩu `*_dev`, token dev, `vite dev`, không TLS, có profile `demo` nạp dữ liệu mẫu).
Máy chủ thật dùng `deploy/compose.production.yml`: một máy Linux chạy `docker compose` (docs/DECISIONS.md, 07/10/2026: VRG trước, một tổ chức).
Caddy là điểm vào duy nhất (TLS tự động, HSTS, CSP; `/internal/*` bị chặn); Postgres, api, worker, scribe không mở cổng; api và worker dùng chung volume kho tệp;
`migrate` chỉ chạy migration và **không bao giờ seed** (`db:seed` và `db:reset` tự từ chối ở production hoặc khi CSDL không có đuôi `_dev`/`_test`).

| Việc | Chỉ dẫn |
| --- | --- |
| Chuẩn bị máy, tệp môi trường, khởi động lần đầu, nâng cấp, hoàn lại, xử lý cảnh báo, sự cố | [docs/ops/runbook.md](docs/ops/runbook.md), [docs/ops/incident.md](docs/ops/incident.md) |
| Tạo tổ chức và quản trị viên đầu tiên (không qua seed) | `pnpm db:bootstrap` (ORG_CODE, ORG_NAME, ADMIN_EMAIL, ADMIN_FULL_NAME); chạy lại không tạo trùng. Xem runbook, mục 3 |
| Sao lưu, khôi phục, diễn tập khôi phục | [docs/ops/backup.md](docs/ops/backup.md); `deploy/scripts/backup.sh`, `restore.sh` |
| Khoá, người giữ, lịch xoay 90 ngày | [docs/security/secrets.md](docs/security/secrets.md) |
| Mẫu tệp môi trường (chép thành `/etc/mihato/production.env`, quyền 600) | [deploy/production.env.example](deploy/production.env.example) |
| Triển khai và hoàn lại bằng một lệnh | `deploy/scripts/deploy.sh <tag>`, `deploy/scripts/rollback.sh` |
| Kiểm cấu hình trước khi triển khai | `deploy/scripts/check-env.sh <tag>` hoặc `pnpm env:check` |
| Phát hành app di động | [docs/ops/mobile-release.md](docs/ops/mobile-release.md) |

Ảnh Docker dựng từ `Dockerfile` (đa tầng: `runtime` cho api, worker, scribe và script; `web` cho Caddy cùng web quản trị; `dev` chỉ cho compose local).
Đẩy tag `v*` thì `.github/workflows/release.yml` dựng và đẩy hai ảnh lên GHCR. CI (`ci.yml`) cũng dựng cả hai đích (không đẩy) và kiểm Caddyfile, compose, script.

Ở `NODE_ENV=production` tiến trình **không đọc `.env`** và từ chối khởi động, nêu rõ tên biến sai (không in giá trị), nếu:
`WEB_ORIGIN` hoặc `PUBLIC_API_URL` không phải `https://`, `PUBLIC_SCRIBE_WS_URL` thiếu hoặc không phải `wss://`;
`AUTH_SECRET` hoặc `INTERNAL_SERVICE_TOKEN` ngắn hơn 32 ký tự hoặc chứa `dev-` hay `change-me`; `DATABASE_URL*` còn mật khẩu `*_dev`;
`FILE_STORAGE_DIR` thiếu hoặc không ghi được; `SCRIBE_JWT_PRIVATE_KEY` (ES256, PKCS8 PEM) thiếu khi Scribe bật; nhà cung cấp `STT_PROVIDER`, `LLM_PROVIDER`,
`TTS_PROVIDER`, `PUSH_PROVIDER` là `fake` (kể cả để trống) mà không có `ALLOW_FAKE_PROVIDERS=true` (chỉ staging); thiếu khoá API của nhà cung cấp thật đã chọn.
Địa chỉ CSDL đọc lười theo vai trò: api chỉ cần `DATABASE_URL`, worker thêm `DATABASE_URL_SCAN`, migrate chỉ cần `DATABASE_URL_OWNER`.
Bắt buộc TOTP cho vai trò quản trị (`ENFORCE_MFA`) mặc định bật ở production, tắt ở phát triển. Danh sách đầy đủ: cuối `.env.example` và `deploy/production.env.example`.

## Điều chưa được kiểm chứng

Mã chạy với các bản giả. Chưa có lần nào gọi Deepgram, Claude, Vbee hay Expo thật; chưa chạy trên điện thoại thật;
chưa kiểm với người dùng từ 60 tuổi; lớp xác thực là lớp tạm (Q12). Chi tiết và các cổng còn mở ở `docs/DECISIONS.md`.
