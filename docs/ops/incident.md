# Sự cố: phân loại, xử lý, biên bản

Viết ngày 07/10/2026. Người trực và kênh liên lạc: **chờ Mike (Q10)**; điền vào bảng liên hệ bên dưới trước khi vào chạy thật.

## Liên hệ (điền)

| Vai | Người | Điện thoại | Ghi chú |
| --- | --- | --- | --- |
| Người trực chính | (chờ Mike) | | nhận cảnh báo ops-alert |
| Người trực dự phòng | (chờ Mike) | | |
| Người giữ khoá hạ tầng | (chờ Mike) | | `docs/security/secrets.md` |
| Đầu mối bảo vệ dữ liệu của VRG (`dataContact`) | (chờ VRG) | | nhận thông báo khi có lộ dữ liệu cá nhân |
| Đại diện pháp chế | (chờ Mike) | | SPEC 11.6 |

## Mức độ

| Mức | Dấu hiệu | Thời gian bắt đầu xử lý |
| --- | --- | --- |
| 1 (nặng) | Hệ thống ngừng với mọi người dùng; nghi lộ khoá hoặc dữ liệu; mất dữ liệu | Ngay, bất kể giờ |
| 2 | Một chức năng chính hỏng (không giao được việc, không nhắc việc, trợ lý không nghe); cảnh báo `worker_heartbeat`, `effects_dead`, `backup` kéo dài | Trong 1 giờ làm việc |
| 3 | Chậm, lỗi lẻ tẻ, một nhà cung cấp lỗi mà có đường dự phòng (nhập chữ thay giọng nói) | Trong ngày làm việc |

## Việc đầu tiên

1. Ghi giờ phát hiện và người phát hiện. Mở biên bản (mẫu cuối tệp).
2. `dc ps`, `dc logs --tail=200 api worker scribe web`, `curl -fsS https://$DOMAIN/readyz`.
3. Phân loại theo bảng mức độ; mức 1 thì báo đại diện VRG ngay.
4. Có thay đổi gần đây không? Nếu vừa triển khai: `deploy/scripts/rollback.sh` (mục Hoàn lại ở runbook) thường nhanh nhất.

## Kịch bản thường gặp

| Triệu chứng | Nguyên nhân hay gặp | Xử lý |
| --- | --- | --- |
| Không vào được web, trình duyệt báo chứng chỉ | DNS đổi, cổng 80/443 bị chặn, Caddy gia hạn hỏng | `dc logs web`; kiểm DNS và ufw; chứng chỉ nằm ở volume `mihato_caddy_data` (đừng xoá) |
| Web vào được, mọi API lỗi 502 | api chết hoặc đang khởi động | `dc ps api`, `dc logs api`: thường là cấu hình (log nêu tên biến sai) hoặc CSDL |
| API lỗi 500 đồng loạt sau nâng cấp | migration hoặc mã mới lỗi | rollback.sh nếu migration chỉ mở rộng; nếu không, khôi phục sao lưu |
| Việc không được nhắc, thông báo không đến | worker chết hoặc chậm | cảnh báo `worker_heartbeat` / `effects_lag`; `dc restart worker`; xem log; kiểm `effects` dead |
| Trợ lý (giọng nói) không phản hồi | scribe chết, nhà cung cấp STT, LLM hoặc TTS lỗi, hết ngân sách | `dc logs scribe`; kiểm trạng thái nhà cung cấp; người dùng vẫn nhập chữ được; hết ngân sách do `it_admin` quyết (hệ thống không tự cắt) |
| Ổ đĩa đầy | ảnh cũ, nhật ký, kho tệp | cảnh báo `disk_usage`; `docker image prune -a`; mở rộng ổ |
| Sao lưu thất bại | ổ đầy, mất kết nối nơi đặt, thiếu khoá | cảnh báo `backup`; xem `status.json` |
| Nghi một thiết bị hoặc tài khoản bị chiếm | mất điện thoại, lộ mật khẩu | web quản trị: vô hiệu hoá người dùng hoặc thu hồi thiết bị; kiểm `audit_log` |
| Nghi lộ khoá hạ tầng hoặc khoá nhà cung cấp | lộ qua chat, ảnh chụp, repo | `docs/security/secrets.md`, mục "Khi nghi lộ khoá": **xoay ngay**, rồi điều tra |

## Lộ dữ liệu cá nhân

Nghị định 13/2023/NĐ-CP (SPEC 11.6, chờ pháp chế xác nhận thời hạn): thông báo cơ quan có thẩm quyền trong thời hạn quy định (mục tiêu nội bộ: 72 giờ) và người bị ảnh hưởng. Giữ nguyên chứng cứ (nhật ký container, `audit_log`, ảnh chụp trạng thái), không xoá để "dọn". Diễn tập kịch bản "lộ khoá Anthropic" và "mất điện thoại của Chủ tịch" là điều kiện của cổng pháp lý trước pilot VRG (SPEC 11.9): **chưa diễn tập**.

## Sau sự cố

Trong 5 ngày làm việc: họp rút kinh nghiệm không quy lỗi, sửa runbook, thêm kiểm tra hay cảnh báo nếu phát hiện từ người dùng chứ không từ ops-alert.

## Mẫu biên bản sự cố

```
Mã: INC-AAAAMMDD-n         Mức: 1 / 2 / 3
Phát hiện lúc (giờ VN):    bởi:                 cách phát hiện: cảnh báo / người dùng / tự kiểm
Bắt đầu xử lý lúc:         người xử lý:
Ảnh hưởng: ai, từ lúc nào, đến lúc nào, có mất dữ liệu không (khoảng thời gian)
Nguyên nhân gốc:
Đã làm (theo thứ tự, kèm giờ):
Đã thông báo ai, lúc nào:
Khắc phục xong lúc:
Việc phòng ngừa (người, hạn):
Có liên quan dữ liệu cá nhân / khoá bị lộ: có / không (nếu có: đã xoay khoá nào, đã báo ai)
```
