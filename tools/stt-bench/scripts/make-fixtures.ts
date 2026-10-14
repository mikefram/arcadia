/**
 * Sinh ba tệp âm thanh GIẢ cho `fixtures/` (WAV PCM16, 16 kHz, đơn kênh, vài giây): sóng sin xen đoạn ồn nhẹ và im lặng.
 * Nội dung âm thanh không quan trọng vì cấu hình `fake` đọc bản ghi sẵn trong manifest; tệp chỉ cần đúng định dạng và
 * có độ dài, điểm hết tiếng nói rõ ràng (đoạn cuối im lặng) để thử đường phát khung, đo độ trễ và dò hết tiếng.
 * Tất định: chạy lại ra đúng từng byte (test so với tệp đã nộp). Chạy: `pnpm --filter @mihato/stt-bench fixtures`.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE, encodeWav } from '../src/audio';

type Segment = { ms: number; kind: 'silence' | 'noise' | 'tone'; freq?: number; amp?: number };

/** Bộ sinh số giả ngẫu nhiên tuyến tính đồng dư, chỉ dùng số nguyên nên giống hệt trên mọi máy. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 16;
  };
}

function render(segments: readonly Segment[], seed: number): Uint8Array {
  const rand = lcg(seed);
  const samples: number[] = [];
  for (const seg of segments) {
    const n = Math.round((seg.ms * SAMPLE_RATE) / 1000);
    const fade = Math.round(SAMPLE_RATE / 100); // 10 ms vào và ra, để không có tiếng bụp
    for (let i = 0; i < n; i++) {
      if (seg.kind === 'silence') samples.push(0);
      else if (seg.kind === 'noise') samples.push((rand() % (2 * (seg.amp ?? 100) + 1)) - (seg.amp ?? 100));
      else {
        const edge = Math.min(1, i / fade, (n - 1 - i) / fade);
        samples.push(Math.round((seg.amp ?? 6000) * edge * Math.sin((2 * Math.PI * (seg.freq ?? 200) * i) / SAMPLE_RATE)));
      }
    }
  }
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, Math.max(-32768, Math.min(32767, s)), true));
  return pcm;
}

export type FixtureFile = { name: string; wav: Uint8Array };

/** Ba câu mẫu: một câu liền, một câu có quãng nghỉ ngắn giữa chừng, một câu có quãng nghỉ dài giữa chừng. Mọi mốc chia hết 20 ms. */
export function generateFixtures(): FixtureFile[] {
  return [
    {
      name: '01-tinh-hinh-don-doan.wav',
      // 2,0 giây; hết tiếng ở 1600 ms
      wav: encodeWav(
        render(
          [
            { ms: 300, kind: 'noise', amp: 120 },
            { ms: 1300, kind: 'tone', freq: 220 },
            { ms: 400, kind: 'noise', amp: 120 },
          ],
          1,
        ),
      ),
    },
    {
      name: '02-di-thuc-anh-tuan.wav',
      // 2,5 giây; nghỉ 300 ms giữa chừng; hết tiếng ở 2200 ms
      wav: encodeWav(
        render(
          [
            { ms: 200, kind: 'noise', amp: 120 },
            { ms: 1400, kind: 'tone', freq: 180 },
            { ms: 300, kind: 'noise', amp: 120 },
            { ms: 300, kind: 'tone', freq: 260 },
            { ms: 300, kind: 'noise', amp: 120 },
          ],
          2,
        ),
      ),
    },
    {
      name: '03-duyet-tam-ung.wav',
      // 3,0 giây; nghỉ 500 ms giữa chừng (đủ làm utterance_end_ms nhỏ cắt sớm trên máy thật); hết tiếng ở 2400 ms
      wav: encodeWav(
        render(
          [
            { ms: 200, kind: 'noise', amp: 120 },
            { ms: 800, kind: 'tone', freq: 200 },
            { ms: 500, kind: 'silence' },
            { ms: 900, kind: 'tone', freq: 240 },
            { ms: 200, kind: 'noise', amp: 120 },
            { ms: 400, kind: 'silence' },
          ],
          3,
        ),
      ),
    },
  ];
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const dir = join(import.meta.dirname, '..', 'fixtures');
  for (const f of generateFixtures()) {
    writeFileSync(join(dir, f.name), f.wav);
    console.log(`${f.name}: ${f.wav.byteLength} byte`);
  }
}
