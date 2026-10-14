# duplex-audio

Mô-đun Expo nội bộ (iOS): **một** `AVAudioEngine` vừa thu micro vừa phát tiếng trợ lý, bật voice processing để hệ điều hành
trừ tiếng loa khỏi micro. Nền tảng của việc ngắt lời trợ lý bằng giọng nói (docs/DECISIONS.md, "Ngắt lời bằng giọng nói").

**Trạng thái (04/10/2026): đã viết, chưa chạy lần nào trên máy thật, chưa nối vào máy trạng thái của trợ lý.** Hôm nay chỉ màn
**Đo khử tiếng vọng** (`app/(app)/aec-lab.tsx`, chỉ hiện ở bản thử) dùng nó, để biết khử vọng có đủ tốt không trước khi làm tiếp.

## Vì sao tự viết, vì sao một engine

- Thu bằng `AudioStream` của expo-audio đặt phiên iOS ở chế độ chỉ thu, không khử vọng; không ngắt lời bằng giọng được.
- Thư viện `react-native-realtime-audio` thu và phát bằng hai engine riêng, voice processing chỉ ở engine thu: tiếng phát qua
  engine khác không có tín hiệu tham chiếu để khử (Apple, WWDC19 phiên 510, nói voice processing bật cho nút vào và nút ra của chính
  engine đó). Nó cũng kéo ONNX Runtime và một kho Maven ngoài vào bản dựng Android. Xem docs/DECISIONS.md.
- Vì vậy tiếng trợ lý PHẢI phát qua `playFile` của mô-đun này, không qua expo-audio.

## Cấu trúc

| Tệp | Việc |
| --- | --- |
| `ios/PcmFramePipeline.swift` | Mẫu số thực của micro (tần số nào cũng được) sang PCM 16-bit 16 kHz đơn kênh, cắt khung, đo mức dBFS. Không biết gì về phiên âm thanh nên chạy thử được trên Mac. |
| `ios/DuplexAudioEngine.swift` | Engine duy nhất, phiên `.playAndRecord`, voice processing, nút phát, mức tín hiệu ra loa, dừng khi bị cuộc gọi hay đổi tuyến. |
| `ios/DuplexAudioModule.swift` | Lớp nối Expo: `start`, `stop`, `playFile`, `stopPlayback`, `getRoute`; sự kiện `onFrame`, `onPlayback`, `onState`. |
| `check/` | `run.sh`: kiểm kiểu engine và chạy thử bộ đổi tần số bằng tín hiệu tổng hợp, chỉ cần Command Line Tools (`pnpm check:duplex-swift`). |
| `../../src/duplex/` | Phía JS: hợp đồng (`types.ts`), cổng nhận ra tiếng nói (`gate.ts`), thống kê, bộ điều phối phép đo (`lab.ts`). Có test bằng Node. |

## Chưa kiểm (cần iPhone thật)

- Khử vọng có hiệu quả không, với loa ngoài, tai nghe, Bluetooth; ngưỡng ở `src/duplex/lab.ts` là ước đoán.
- Phiên `.voiceChat` có làm tiếng trợ lý nhỏ đi không (âm lượng "cuộc gọi"); màn đo có công tắc đổi sang chế độ thường để so sánh.
- Định dạng `engine.start` với voice processing (có máy trả nhiều kênh); `PcmFramePipeline` chỉ lấy kênh đầu.
- Mở lại engine sau khi đổi tuyến hay có cuộc gọi: hôm nay chỉ dừng và báo, JS quyết có mở lại không.
- Android: chưa có. Giao diện JS đã tách để thêm bản Kotlin (`AudioRecord` nguồn `VOICE_COMMUNICATION`, `AcousticEchoCanceler`,
  `AudioTrack` dùng `USAGE_VOICE_COMMUNICATION`) mà không đổi mã TypeScript.
