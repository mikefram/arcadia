# Kịch bản vàng (SPEC 13.2)

Quy trình "Đón đoàn nhà đầu tư thăm KCN": sáu việc, mốc đích Thứ Năm 15/10/2026. Đây là bài kiểm chấp nhận của cả dự án.

| Tầng | Tệp | Kiểm gì |
| --- | --- | --- |
| Engine thuần | `packages/workflow-engine/test/golden.test.ts` | 12 bước, nhánh C (leo thang), người khởi chạy là Chủ tịch; không cần CSDL |
| API + CSDL + worker | `apps/api/test/golden.test.ts` | Biến thể A (mốc M1, không AI) qua API thật, PostgreSQL thật, worker thật với `FakePush`, đồng hồ giả |
| Cổng xác nhận AI | `packages/backend/test/proposals.test.ts`, `apps/api/test/gate.test.ts` | Mười điều ở SPEC 13.3 và các nhánh B1 đến B3 |

Chạy: `pnpm db:up && NODE_ENV=test pnpm db:migrate && pnpm -w test`.

Chưa có (cần máy thật hoặc nhà cung cấp thật, xem `docs/DECISIONS.md`): biến thể B đầu cuối bằng giọng nói trên app,
luồng Maestro của hai app, thông báo đẩy trên máy thật.
