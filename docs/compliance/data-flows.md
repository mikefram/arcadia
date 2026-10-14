# Dữ liệu gửi ra nhà cung cấp ngoài

Bảng này sinh từ SPEC 11.5 và là đầu vào để pháp chế lập hồ sơ xử lý dữ liệu. **Không phải tư vấn pháp lý.**
Thêm nhà cung cấp mới thì thêm một dòng ở đây và ở SPEC 11.5. Trạng thái trong mã ghi ở cột cuối.

| Nhà cung cấp | Nhận gì | Không nhận | Điều chưa biết | Trong mã |
| --- | --- | --- | --- | --- |
| Deepgram (STT) | Âm thanh trong lúc người dùng giữ mic | Âm thanh lúc mic tắt | Thời hạn lưu, nơi xử lý, điều khoản cho tổ chức nhà nước | `packages/providers/src/stt.ts`; mặc định `STT_PROVIDER=fake`; khi bật luôn gửi `mip_opt_out=true` |
| Anthropic (LLM) | Chữ của câu nói và kết quả tool tối thiểu: tên người, tên việc, hạn, trạng thái | Số điện thoại, email, số căn cước, lương, tệp đính kèm, nội dung biểu mẫu tự do | Có xin được chế độ không lưu dữ liệu (ZDR) không | `packages/providers/src/llm.ts`; mặc định `LLM_PROVIDER=fake`; `redact()` chạy trước mọi lệnh gọi |
| Vbee (TTS) | Chữ của câu trả lời, tối đa 300 ký tự mỗi lần; bản tin sáng ở chế độ batch | Dữ liệu ngoài câu trả lời | Nơi đặt máy chủ, giá, bản quyền giọng | `packages/providers/src/tts.ts`; mặc định `TTS_PROVIDER=fake` |
| Expo, Google (FCM), Apple (APNs) | Tên việc, mã, id, liên kết sâu | Nội dung việc, số tiền, tên người nhận | Nơi đặt máy chủ của Expo | `packages/providers/src/push.ts`; mặc định `PUSH_PROVIDER=fake` |
| Resend (thư điện tử) | Địa chỉ email, họ tên và xưng hô người nhận, tên tổ chức, đường dẫn đặt mật khẩu dùng một lần (72 giờ) | Mọi dữ liệu việc, số tiền, số điện thoại | Nơi đặt máy chủ (Resend ở Hoa Kỳ), thời hạn Resend lưu nội dung thư | `packages/providers/src/email.ts`; cấu hình theo tổ chức ở web quản trị (khoá mã hoá trong CSDL), biến môi trường chỉ là dự phòng, mặc định bản giả; chỉ gửi thư kích hoạt tài khoản |

Tên người và tên việc đi ra Anthropic, tên việc đi ra Expo: đây là dữ liệu cá nhân của nhân viên và dữ liệu nghiệp vụ
của tổ chức. Ba câu hỏi pháp lý ở SPEC 11.6 (Q2) **chặn việc đưa dữ liệu thật của VRG vào hệ thống**.

Công tắc AI theo tổ chức (`organizations.settings.ai`, SPEC 11.7) được kiểm ở máy chủ trước mỗi lệnh gọi nhà cung cấp.
