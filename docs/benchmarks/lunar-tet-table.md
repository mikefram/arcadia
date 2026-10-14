# Bảng ngày Tết do mã tính (2020–2035)

> **Bảng này do mã tính, CHƯA đối chiếu lịch chính thức, cần Văn phòng xác nhận.**
> Claude Code không điền bảng từ trí nhớ (SPEC 13.4). Mọi ô dưới đây là đầu ra của
> `packages/domain/src/lunar` (thuật toán thiên văn của Hồ Ngọc Đức, múi giờ UTC+7), sinh ngày 03/10/2026.

## Cách dùng bảng

1. Văn phòng hoặc Mike so từng dòng với lịch chính thức (lịch Nhà nước, lịch bloc đã in), rồi đổi cột cuối thành "đã khớp" hoặc ghi ngày đúng.
2. Dòng nào lệch thì báo lại. Không sửa bảng cho khớp mà không sửa mã.
3. Sau khi đối chiếu xong, các dòng đã khớp được chép thành bảng vector trong `packages/domain/test/lunar.test.ts`.
   Hiện test chỉ dùng một điểm kiểm chứng đã xác minh trong SPEC (dòng 2027) cùng các tính chất: khứ hồi dương → âm → dương
   trên mọi ngày 2020–2035, tháng âm 29 hoặc 30 ngày, năm âm 12 hoặc 13 tháng.

Lịch âm chỉ dùng để hiển thị ngày âm và gợi ý ngày nghỉ. Không dùng để tính hạn (SPEC 4.5).

## Bảng

| Năm dương | Năm âm | Mùng 1 Tết (UTC+7) | Ngày liền trước | Giỗ Tổ Hùng Vương (10/3 âm) | Tháng nhuận của năm âm | Số ngày của năm âm | Tính theo UTC+8 | Văn phòng đã đối chiếu |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2020 | Canh Tý | Thứ Bảy 25/01/2020 | 30 tháng Chạp | Thứ Năm 02/04/2020 | nhuận tháng 4 | 384 | trùng | chưa |
| 2021 | Tân Sửu | Thứ Sáu 12/02/2021 | 30 tháng Chạp | Thứ Tư 21/04/2021 | không | 354 | trùng | chưa |
| 2022 | Nhâm Dần | Thứ Ba 01/02/2022 | 29 tháng Chạp | Chủ Nhật 10/04/2022 | không | 355 | trùng | chưa |
| 2023 | Quý Mão | Chủ Nhật 22/01/2023 | 30 tháng Chạp | Thứ Bảy 29/04/2023 | nhuận tháng 2 | 384 | trùng | chưa |
| 2024 | Giáp Thìn | Thứ Bảy 10/02/2024 | 30 tháng Chạp | Thứ Năm 18/04/2024 | không | 354 | trùng | chưa |
| 2025 | Ất Tỵ | Thứ Tư 29/01/2025 | 29 tháng Chạp | Thứ Hai 07/04/2025 | nhuận tháng 6 | 384 | trùng | chưa |
| 2026 | Bính Ngọ | Thứ Ba 17/02/2026 | 29 tháng Chạp | Chủ Nhật 26/04/2026 | không | 354 | trùng | chưa |
| 2027 | Đinh Mùi | Thứ Bảy 06/02/2027 | 29 tháng Chạp | Thứ Sáu 16/04/2027 | không | 354 | trùng | mùng 1 Tết khớp điểm kiểm chứng trong SPEC; các ô khác chưa |
| 2028 | Mậu Thân | Thứ Tư 26/01/2028 | 29 tháng Chạp | Thứ Ba 04/04/2028 | nhuận tháng 5 | 384 | trùng | chưa |
| 2029 | Kỷ Dậu | Thứ Ba 13/02/2029 | 29 tháng Chạp | Thứ Hai 23/04/2029 | không | 354 | trùng | chưa |
| 2030 | Canh Tuất | Thứ Bảy 02/02/2030 | 29 tháng Chạp | Thứ Sáu 12/04/2030 | không | 355 | **KHÁC: 03/02/2030** | chưa |
| 2031 | Tân Hợi | Thứ Năm 23/01/2031 | 29 tháng Chạp | Thứ Ba 01/04/2031 | nhuận tháng 3 | 384 | trùng | chưa |
| 2032 | Nhâm Tý | Thứ Tư 11/02/2032 | 29 tháng Chạp | Thứ Hai 19/04/2032 | không | 355 | trùng | chưa |
| 2033 | Quý Sửu | Thứ Hai 31/01/2033 | 30 tháng Chạp | Thứ Bảy 09/04/2033 | nhuận tháng 11 | 384 | trùng | chưa |
| 2034 | Giáp Dần | Chủ Nhật 19/02/2034 | 30 tháng Chạp | Thứ Sáu 28/04/2034 | không | 354 | trùng | chưa |
| 2035 | Ất Mão | Thứ Năm 08/02/2035 | 30 tháng Chạp | Thứ Ba 17/04/2035 | không | 354 | trùng | chưa |

## Ghi chú

- **Năm 2030 cần xem kỹ.** Theo mã, mùng 1 Tết tính bằng UTC+7 là 02/02/2030, còn tính bằng UTC+8 là 03/02/2030
  (điểm Sóc rơi vào giờ cuối của ngày theo giờ Việt Nam). Đây là năm duy nhất trong 2020–2035 mà hai múi giờ cho ngày khác nhau.
  Lịch in theo múi giờ khác có thể ghi lệch một ngày. Có test riêng ghim rằng hàm công khai dùng UTC+7
  (`packages/domain/test/lunar.test.ts`, "năm UTC+7 và UTC+8 lệch nhau").
- **Năm 2033** mã tính ra nhuận tháng 11. Đây là ca hiếm của phép tính tháng nhuận, nên đối chiếu cả tháng nhuận chứ không chỉ ngày Tết.
- Cột "Năm âm" (can chi) suy từ số năm bằng công thức chu kỳ 60, không lấy từ phép tính thiên văn.
- Cột "Ngày liền trước" là ngày cuối tháng Chạp của năm âm trước đó: 30, hoặc 29 khi tháng Chạp thiếu.
  Hàm `fixedHolidaySuggestions(year)` gợi ý nghỉ Tết từ ngày này tới mùng 5 **[GIẢ ĐỊNH]**; số ngày nghỉ thật do
  `office_admin` nhập theo thông báo của Chính phủ từng năm.
- Điểm kiểm chứng duy nhất đã có trong SPEC: mùng 1 Tết Đinh Mùi là Thứ Bảy 06/02/2027.
