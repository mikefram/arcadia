/**
 * Âm thanh cho bài đo STT: đọc WAV PCM16 mono 16 kHz hoặc PCM thô, cắt thành khung 20–100 ms để phát vào
 * `SttSession.sendAudio` (SPEC 6.2: app gửi PCM 16-bit, 16 kHz, đơn kênh), và tìm điểm hết tiếng nói.
 * Mọi hàm ở đây là hàm thuần trên byte; riêng `loadAudioFile` đọc tệp.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
/** 16.000 mẫu mỗi giây × 2 byte ÷ 1000 */
export const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;
export const MIN_CHUNK_MS = 20;
export const MAX_CHUNK_MS = 100;

export class AudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioError';
  }
}

export const pcmDurationMs = (byteLength: number): number => byteLength / BYTES_PER_MS;

/** Số byte của một khung `chunkMs` mili giây (luôn chẵn: không cắt đôi một mẫu). */
export function frameBytes(chunkMs: number): number {
  if (!Number.isInteger(chunkMs) || chunkMs < MIN_CHUNK_MS || chunkMs > MAX_CHUNK_MS) {
    throw new RangeError(`Khung âm thanh phải là số nguyên mili giây trong khoảng ${MIN_CHUNK_MS} đến ${MAX_CHUNK_MS}, nhận ${chunkMs}`);
  }
  return chunkMs * BYTES_PER_MS;
}

export const chunkCount = (byteLength: number, chunkMs: number): number => Math.ceil(byteLength / frameBytes(chunkMs));

/** Cắt PCM thành các khung (không sao chép dữ liệu). Khung cuối có thể ngắn hơn. */
export function chunkPcm(pcm: Uint8Array, chunkMs: number): Uint8Array[] {
  const size = frameBytes(chunkMs);
  const out: Uint8Array[] = [];
  for (let at = 0; at < pcm.byteLength; at += size) out.push(pcm.subarray(at, Math.min(at + size, pcm.byteLength)));
  return out;
}

/** Khung im lặng tuyệt đối, dùng làm "đuôi" để nhà cung cấp có cơ hội báo hết câu (UtteranceEnd). */
export const silenceChunk = (chunkMs: number): Uint8Array => new Uint8Array(frameBytes(chunkMs));

// ───────────────────────── WAV ─────────────────────────

const ascii = (data: Uint8Array, at: number, len: number) => String.fromCharCode(...data.subarray(at, at + len));

/**
 * Đọc tệp WAV và trả phần dữ liệu PCM. Kiểm tiêu đề kỹ vì sai định dạng âm thanh làm hỏng số đo mà không báo lỗi:
 * chỉ nhận PCM không nén, 16 kHz, đơn kênh, 16-bit. Chịu được khối phụ (LIST…), khối lẻ byte và `data` khai báo sai kích thước.
 */
export function parseWav(data: Uint8Array): Uint8Array {
  if (data.byteLength < 12 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WAVE') {
    throw new AudioError('không phải tệp WAV (thiếu tiêu đề RIFF/WAVE)');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let format: { tag: number; channels: number; sampleRate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const id = ascii(data, offset, 4);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (declared < 16 || body + 16 > data.byteLength) throw new AudioError('khối fmt của WAV bị cắt cụt');
      let tag = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: định dạng thật nằm ở 2 byte đầu của GUID con.
      if (tag === 0xfffe && declared >= 40 && body + 26 <= data.byteLength) tag = view.getUint16(body + 24, true);
      format = { tag, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!format) throw new AudioError('khối data đứng trước khối fmt trong WAV');
      if (format.tag !== 1) throw new AudioError(`WAV phải là PCM không nén (định dạng 1); tệp có định dạng ${format.tag}`);
      if (format.sampleRate !== SAMPLE_RATE || format.channels !== 1 || format.bits !== 16) {
        throw new AudioError(
          `WAV phải là 16 kHz, đơn kênh, 16-bit; tệp có ${format.sampleRate} Hz, ${format.channels} kênh, ${format.bits}-bit. ` +
            'Đổi bằng: ffmpeg -i vào.m4a -ar 16000 -ac 1 -c:a pcm_s16le ra.wav',
        );
      }
      // `data` khai báo quá lớn (ghi dở, ghi luồng) thì lấy phần còn lại của tệp.
      const length = declared > data.byteLength - body ? data.byteLength - body : declared;
      return checkPcm(data.subarray(body, body + length));
    }
    offset = body + declared + (declared % 2);
  }
  throw new AudioError(format ? 'WAV không có khối data' : 'WAV không có khối fmt');
}

function checkPcm(pcm: Uint8Array): Uint8Array {
  if (pcm.byteLength === 0) throw new AudioError('không có dữ liệu âm thanh');
  if (pcm.byteLength % BYTES_PER_SAMPLE !== 0) throw new AudioError('dữ liệu PCM có độ dài lẻ (không phải 16-bit)');
  return pcm;
}

/** PCM thô: 16-bit có dấu, little-endian, đơn kênh, 16 kHz (không có tiêu đề để kiểm, nên chỉ kiểm độ dài). */
export const parseRawPcm = (data: Uint8Array): Uint8Array => checkPcm(data);

/** Ghi PCM16 mono 16 kHz thành WAV (dùng cho tệp mẫu và test). */
export function encodeWav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  put(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  put(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** Đọc tệp âm thanh theo đuôi: .wav, hoặc PCM thô (.pcm, .raw, .s16le). */
export function loadAudioFile(path: string): Uint8Array {
  const ext = extname(path).toLowerCase();
  if (ext !== '.wav' && ext !== '.pcm' && ext !== '.raw' && ext !== '.s16le') {
    throw new AudioError(`định dạng "${ext || '(không đuôi)'}" chưa hỗ trợ; dùng WAV PCM16 16 kHz đơn kênh hoặc PCM thô (.pcm, .raw)`);
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new AudioError(`không đọc được tệp âm thanh ${path}`);
  }
  return ext === '.wav' ? parseWav(bytes) : parseRawPcm(bytes);
}

// ───────────────────────── Hết tiếng nói ─────────────────────────

export type SpeechEndOptions = {
  /** độ dài mỗi khung tính năng lượng, mili giây */
  frameMs?: number;
  /** năng lượng (RMS, thang int16) tối thiểu để coi là có tiếng; dưới mức này là im lặng/ồn nền */
  floorRms?: number;
  /** ngưỡng tương đối so với mức to của cả tệp (phân vị 95 của RMS các khung) */
  relative?: number;
};

/**
 * Thời điểm (mili giây từ đầu tệp) mà tiếng nói cuối cùng kết thúc, theo năng lượng từng khung. Dùng để đo độ trễ
 * "từ lúc ngừng nói" và để phân biệt UtteranceEnd tới sớm giữa câu với UtteranceEnd tới sau khi đã nói xong.
 * Trả null nếu cả tệp là im lặng. Đây là bộ phát hiện đơn giản, không phải VAD huấn luyện: tiếng ồn nền lớn làm lệch.
 */
export function detectSpeechEndMs(pcm: Uint8Array, opts: SpeechEndOptions = {}): number | null {
  const frameMs = opts.frameMs ?? 20;
  const floorRms = opts.floorRms ?? 200;
  const relative = opts.relative ?? 0.1;
  const samplesPerFrame = Math.max(1, Math.round(frameMs * (SAMPLE_RATE / 1000)));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % BYTES_PER_SAMPLE));
  const totalSamples = view.byteLength / BYTES_PER_SAMPLE;
  if (totalSamples === 0) return null;

  const rms: number[] = [];
  for (let start = 0; start < totalSamples; start += samplesPerFrame) {
    const end = Math.min(start + samplesPerFrame, totalSamples);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = view.getInt16(i * BYTES_PER_SAMPLE, true);
      sum += s * s;
    }
    rms.push(Math.sqrt(sum / (end - start)));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const loud = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] as number;
  if (loud < floorRms) return null;
  const threshold = Math.max(floorRms, relative * loud);
  for (let f = rms.length - 1; f >= 0; f--) {
    if ((rms[f] as number) >= threshold) return Math.min((f + 1) * frameMs, pcmDurationMs(totalSamples * BYTES_PER_SAMPLE));
  }
  return null;
}
