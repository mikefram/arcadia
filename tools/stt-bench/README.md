# stt-bench: đo nhận dạng giọng nói (S1-06)

Chạy bộ ghi âm qua Deepgram Nova-3 `vi` (có và không `keyterm`), Nova-2 và Vbee; tính WER, tỉ lệ sai tên người và tên đơn vị, sai số tiền và ngày SAU chuẩn hoá, độ trễ chốt, số lần cắt ngang câu sớm, phút âm thanh và chi phí ước tính (SPEC 6.2.1, 13.6). Kết quả ghi vào `docs/benchmarks/stt-2026.md`. Công cụ chỉ báo "đạt / không đạt ngưỡng đề xuất" (sai tên người và sai số tiền không quá 5%, **[MỤC TIÊU]**); Mike chọn nhà cung cấp.

**Chưa gọi nhà cung cấp thật lần nào.** Kiểm thử dùng bản giả và máy chủ WebSocket cục bộ. Số đo của `--providers fake` chỉ chứng minh công cụ đúng, KHÔNG phải số đo thật.

## Ghi âm bộ dữ liệu thật

1. Ít nhất 5 người từ 60 tuổi, giọng miền Bắc, mỗi người **ký phiếu đồng ý bằng văn bản** cho bài đo STT (SPEC 13.6), ghi rõ hạn xoá bản ghi. Mỗi người đọc và nói tự do khoảng 40 câu lấy từ kịch bản vàng: giao việc, hỏi tình hình, "đi thúc", có tên người, tên phòng, số tiền, ngày tháng.
2. Mỗi câu một tệp **WAV PCM16, 16 kHz, đơn kênh** (đổi bằng `ffmpeg -i vào.m4a -ar 16000 -ac 1 -c:a pcm_s16le ra.wav`) hoặc PCM thô (`.pcm`, `.raw`), chừa 0,3 đến 0,5 giây im lặng ở cuối.
3. Đặt bộ ghi âm và `manifest.json` ở `recordings/stt-2026/`. Thư mục `recordings/` đã nằm trong `.gitignore`: **không đưa bản ghi vào repo, và xoá sau khi đo xong** (hoặc theo hạn trong phiếu).
4. Người nói chỉ ghi bằng mã ẩn danh (`S01`, `S02`…); manifest từ chối tên thật vì báo cáo đi vào repo.

## Manifest

```json
{
  "now": "2026-10-03T09:00:00+07:00",
  "items": [
    {
      "id": "s01-007",
      "file": "s01-007.wav",
      "speaker": "S01",
      "age": 64,
      "region": "Bắc",
      "reference": "duyệt đề nghị tạm ứng hai chục triệu cho chị Phương trước thứ Tư ngày bảy tháng mười",
      "entities": { "people": ["Phương"], "units": [], "amountsVnd": [20000000], "dates": ["2026-10-07"] }
    }
  ]
}
```

- `file` tính từ thư mục chứa manifest. `reference` là câu chuẩn bằng chữ (số viết bằng chữ như người nói đọc).
- `people`, `units`: tên đúng như được NÓI. `amountsVnd`: VND nguyên. `dates`: `YYYY-MM-DD`. Không có thì `[]` hoặc bỏ khoá.
- `now`: ngày giả định khi các câu được nói, chọn sao cho "ngày bảy tháng mười", "thứ Tư tuần sau"… ra đúng `dates` (cờ `--now` ghi đè).
- `fake` (tuỳ chọn, `{ "final": "…" }`): bản ghi sẵn cho cấu hình `fake`; bỏ trống thì `fake` nghe đúng 100%.
- Lúc chạy, công cụ chấm chính câu chuẩn như thể STT nghe đúng và cảnh báo (chỉ nêu id, không nêu nội dung) chỗ nào `entities` không khớp. Sửa trước khi chạy thật.

## Chạy

```bash
# thử công cụ với ba tệp giả: không tốn tiền, không cần mạng
pnpm --filter @mihato/stt-bench bench -- --manifest tools/stt-bench/fixtures/manifest.json --providers fake
pnpm stt-bench --manifest tools/stt-bench/fixtures/manifest.json --providers fake      # cách ngắn

# chạy thật: cần CẢ --real VÀ khoá trong môi trường hoặc .env (DEEPGRAM_API_KEY, VBEE_APP_ID, VBEE_TOKEN)
pnpm stt-bench --manifest recordings/stt-2026/manifest.json --real --max-minutes 330 --concurrency 4 \
  --providers deepgram-nova3,deepgram-nova3-keyterm,deepgram-nova2,vbee \
  --utterance-end-ms 1000,1300,1500 --out docs/benchmarks/stt-2026.md
```

- Không có `--out` thì in báo cáo ra màn hình và **không ghi tệp nào**. Có `--out` thì ghi `.md` kèm `.json` chi tiết cạnh bên (từng câu, kèm độ tin cậy cả câu để chọn ngưỡng tin cậy ở SPEC 6.6; câu sai để nghe lại). Bản giả không ghi đè báo cáo thật đã có (trừ `--force`).
- Cấu hình thật thiếu cờ hoặc khoá thì bị bỏ qua kèm lý do. Lượt chạy thật in cảnh báo tốn tiền, phút âm thanh và chi phí dự kiến, chặn nếu vượt `--max-minutes` (mặc định 30; mỗi câu còn gửi thêm đuôi im lặng chờ báo hết câu), rồi hỏi xác nhận (hoặc `--yes`).
- `--utterance-end-ms a,b,c` quét ngưỡng báo hết câu (SPEC 6.2); với Vbee là `speechCompleteTimeoutMs` (500 đến 3000). Độ trễ chỉ đáng tin khi `--speed 1` (mặc định khi chạy thật). `--concurrency N` chạy N câu song song, không làm méo độ trễ.
- `keyterm` là tên người và đơn vị của CẢ manifest, không riêng từng câu (riêng từng câu là gian lận). Nhật ký (stderr) chỉ có đếm và mã, không có khoá hay văn bản câu nói.
- Mọi tuỳ chọn: `pnpm stt-bench --help`. Cách tính và giả định (cắt sớm, độ trễ, tách tiền và ngày) nằm cuối mỗi báo cáo.

## Điều chưa kiểm chứng

- Deepgram và Vbee thật chưa được gọi lần nào. Adapter Vbee tạm ở `src/vbee-stt.ts` theo tài liệu streaming-api đọc qua công cụ tóm tắt: **đối chiếu bản gốc trước khi chạy `--real`**. Nova-2 và Vbee chưa có giá trong SPEC nên cột chi phí để trống.
- Bộ tách tiền và ngày (`src/extract.ts`) là phép xấp xỉ theo luật, thay cho bước Claude chọn cụm rồi gọi tool; lint manifest ở trên là cách kiểm nó với từng câu chuẩn.

## Kiểm

```bash
pnpm --filter @mihato/stt-bench test
pnpm --filter @mihato/stt-bench typecheck
npx eslint tools/stt-bench
pnpm --filter @mihato/stt-bench fixtures     # sinh lại ba tệp WAV giả (tất định; test so từng byte)
```
