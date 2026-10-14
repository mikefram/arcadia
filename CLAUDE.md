# CLAUDE.md

## Dự án
Hệ thống điều hành quy trình và giao việc bằng AI, nội bộ MIHATO và VRG (không thương mại).
Gồm web quản trị, app cho Chủ tịch/Giám đốc/Phó giám đốc, app nhân viên.
Trọng tâm là module quy trình và phân việc. AI Scribe tiếng Việt chỉ đọc và đề xuất.
Đặc tả đầy đủ: docs/SPEC.md. Quyết định đã đổi và câu hỏi chờ Mike: docs/DECISIONS.md.

## Lệnh
pnpm install | pnpm -w build | pnpm -w test | pnpm -w lint | pnpm -w typecheck
pnpm db:up && pnpm db:migrate && pnpm db:seed   (PostgreSQL ở cổng 5455, dữ liệu mẫu SPEC 15.4)
pnpm dev            (api :3100, worker, web-admin :5273, toàn bộ nhà cung cấp là bản giả)
pnpm dev:all        (thêm scribe :3200)
docker compose --profile app up --build   (cả hệ thống trong container với các bản giả)
pnpm evals          (gọi Claude thật, tốn tiền, có trần ngân sách; chỉ chạy khi được bảo)

## Luật không được phá
1. Mọi bảng nghiệp vụ có org_id và RLS FORCE. Chỉ app_scan được BYPASSRLS, và chỉ trên timers, effects.
2. packages/workflow-engine là hàm thuần: không Date.now, Math.random, mạng, CSDL.
3. AI không có đường ghi. scribe chỉ gọi /internal/v1/*. Mọi thay đổi do AI đi qua proposals
   và cổng xác nhận ở server (SPEC 6.5). Câu xác nhận do server dựng, không lấy chữ của LLM.
4. Tiền là số nguyên VND (bigint). Giờ lưu UTC, hiển thị Asia/Ho_Chi_Minh. ID là UUID v7.
5. Cấm any. Schema Zod trong packages/domain là nguồn của mọi kiểu.
6. Nhật ký, dấu vết và báo lỗi không chứa tên người, tên việc, số tiền, câu nói.
7. Chuỗi giao diện chỉ nằm ở packages/i18n; không dùng từ vay mượn bị cấm (SPEC 7.5).
8. App Chủ tịch: cỡ chữ thân 20 sp, mục tiêu chạm từ 56 dp, nút micro 96 dp (SPEC 7.3). Không tự đổi.
9. Migration chỉ tiến. Không sửa migration đã áp dụng.
10. CI không gọi nhà cung cấp trả phí. Dùng FakeStt, FakeTts, FakeLlm, FakePush.
11. Không đổi điều gắn nhãn [QUYẾT ĐỊNH] khi chưa hỏi Mike. Mọi thay đổi ghi vào docs/DECISIONS.md.

## Bản đồ đọc SPEC
Engine và dữ liệu: 4, 5 | AI Scribe: 6 | App Chủ tịch: 7 | App nhân viên: 8
Dashboard: 9 | API và thông báo đẩy: 10 | Bảo mật và pháp lý: 11
Triển khai và chi phí: 12 | Kiểm thử: 13 | Lộ trình: 14 | Câu hỏi chờ Mike: 16

## Bản đồ mã
packages/domain          Zod, enum, hợp đồng API (src/contract.ts là bảng route duy nhất), bảng quyền,
                         lịch làm việc, lịch âm, chuẩn hoá tiếng Việt, mẫu lời nhắc
packages/workflow-engine createRun, advance, validate, simulate, replay: thuần, không I/O
packages/backend         lớp CSDL dùng chung của api và worker: giao dịch có org_id, chạy advance() trong
                         giao dịch, dựng StepView, xác thực, đề xuất, thông báo, script migrate và seed;
                         tệp đính kèm (storage.ts, services/files.ts), sổ văn bản và cấp số (services/registers.ts),
                         xuất tệp tổng hợp Word và PDF (services/compile.ts, doc-render.ts, doc-render-pdf.ts; phông ở assets/fonts),
                         thư viện quy trình mẫu (services/presets.ts)
packages/api-client      client có kiểu, suy ra từ bảng route (không có bước sinh mã)
packages/providers       SttProvider, LlmProvider, TtsProvider, PushProvider và các bản giả
packages/ai-tools        định nghĩa tool, prompt, bộ đánh giá
packages/i18n            chuỗi tiếng Việt (vi.admin, vi.staff, vi.executive), định dạng ngày và tiền, từ cấm
packages/ui-tokens       màu, cỡ chữ, khoảng cách cho hồ sơ senior và standard
apps/api | apps/worker | apps/scribe | apps/web-admin | apps/mobile-staff | apps/mobile-executive
db/migrations (SQL chỉ tiến) | db/seed | e2e/golden | tools

## Quy ước mã
- Thêm endpoint: thêm một dòng vào packages/domain/src/contract.ts rồi cài handler ở apps/api. Client tự có kiểu.
- Mọi thay đổi trạng thái việc đi qua advance(); không ghi thẳng vào step_runs.
- Gói nội bộ xuất thẳng mã TypeScript (exports trỏ vào src), không có bước build riêng.
- Import tương đối không kèm đuôi tệp. TypeScript 6, module ESNext, moduleResolution Bundler.
- Test cần CSDL dùng mihato_test ở cổng 5455; mỗi test tạo tổ chức riêng (SPEC 13.1).

## Dữ liệu mẫu và kịch bản vàng
Seed: pnpm db:seed (SPEC 15.4), cộng kịch bản văn thư và chỉ thị theo đề cương VRG (packages/backend/src/seed/vrg.ts):
Chủ tịch ra chỉ thị, Giám đốc nhận, Phó giám đốc và các trưởng phòng thực hiện, Văn phòng làm văn thư. Ba quy trình mẫu
nằm ở db/seed/templates/presets/*.json (Chỉ thị, Văn bản đến, Văn bản đi). Kịch bản vàng: e2e/golden (SPEC 13.2).
Đăng nhập web mẫu sau khi seed: vanphong@demo.mihato.local (office_admin), it@demo.mihato.local (it_admin),
thietke@demo.mihato.local (process_designer); mật khẩu in ra khi chạy seed, chỉ ở môi trường phát triển.
