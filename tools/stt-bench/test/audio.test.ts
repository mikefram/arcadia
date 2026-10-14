import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AudioError,
  chunkCount,
  chunkPcm,
  detectSpeechEndMs,
  encodeWav,
  frameBytes,
  loadAudioFile,
  parseRawPcm,
  parseWav,
  pcmDurationMs,
  silenceChunk,
} from '../src/audio';
import { FIXTURES_DIR } from './helpers';

// ───────────────────────── Dựng WAV tuỳ ý để thử tiêu đề sai ─────────────────────────

type WavSpec = {
  tag?: number;
  channels?: number;
  rate?: number;
  bits?: number;
  data?: Uint8Array;
  /** ghi đè kích thước khai báo của khối data */
  dataSize?: number;
  /** các khối chèn trước data: [id, nội dung] */
  before?: [string, Uint8Array][];
  after?: [string, Uint8Array][];
  /** thay khối fmt bằng bản EXTENSIBLE với định dạng con này */
  extensibleSub?: number;
  omitFmt?: boolean;
  omitData?: boolean;
  dataFirst?: boolean;
};

function chunk(id: string, body: Uint8Array, declared = body.byteLength): Uint8Array {
  const pad = body.byteLength % 2;
  const out = new Uint8Array(8 + body.byteLength + pad);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  view.setUint32(4, declared, true);
  out.set(body, 8);
  return out;
}

function fmtBody(s: WavSpec): Uint8Array {
  const ext = s.extensibleSub !== undefined;
  const body = new Uint8Array(ext ? 40 : 16);
  const v = new DataView(body.buffer);
  v.setUint16(0, ext ? 0xfffe : (s.tag ?? 1), true);
  v.setUint16(2, s.channels ?? 1, true);
  v.setUint32(4, s.rate ?? 16000, true);
  v.setUint32(8, (s.rate ?? 16000) * 2, true);
  v.setUint16(12, 2, true);
  v.setUint16(14, s.bits ?? 16, true);
  if (ext) {
    v.setUint16(16, 22, true);
    v.setUint16(18, s.bits ?? 16, true);
    v.setUint32(20, 4, true);
    v.setUint16(24, s.extensibleSub as number, true);
  }
  return body;
}

function wav(s: WavSpec = {}): Uint8Array {
  const data = s.data ?? new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  const parts: Uint8Array[] = [];
  const fmt = s.omitFmt ? [] : [chunk('fmt ', fmtBody(s))];
  const dat = s.omitData ? [] : [chunk('data', data, s.dataSize)];
  const extra = (list: [string, Uint8Array][] | undefined) => (list ?? []).map(([id, body]) => chunk(id, body));
  parts.push(...(s.dataFirst ? [...dat, ...fmt] : [...fmt, ...extra(s.before), ...dat, ...extra(s.after)]));
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(12 + size);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 4 + size, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const DATA = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

describe('parseWav: tệp hợp lệ', () => {
  const ok: [string, Uint8Array, number][] = [
    ['WAV chuẩn do encodeWav ghi', encodeWav(DATA), 8],
    ['WAV dựng tay', wav(), 8],
    ['có khối LIST (lẻ byte, có byte đệm) trước data', wav({ before: [['LIST', new Uint8Array([1, 2, 3])]] }), 8],
    ['có khối phụ sau data', wav({ after: [['LIST', new Uint8Array([9, 9, 9, 9])]] }), 8],
    ['data khai báo lớn hơn tệp (ghi dở): lấy phần còn lại', wav({ dataSize: 1_000_000 }), 8],
    ['data khai báo 0xFFFFFFFF (ghi luồng): lấy phần còn lại', wav({ dataSize: 0xffffffff }), 8],
    ['WAVE_FORMAT_EXTENSIBLE với định dạng con PCM', wav({ extensibleSub: 1 }), 8],
    ['data dài hơn: 2 giây', encodeWav(new Uint8Array(64000)), 64000],
  ];
  it.each(ok)('%s', (_name, bytes, length) => {
    expect(parseWav(bytes).byteLength).toBe(length);
  });

  it('trả đúng nội dung PCM, không cắt xén', () => {
    expect([...parseWav(encodeWav(DATA))]).toEqual([...DATA]);
  });
});

describe('parseWav: tệp sai bị báo rõ', () => {
  const bad: [string, Uint8Array, RegExp][] = [
    ['tệp rỗng', new Uint8Array(0), /không phải tệp WAV/],
    ['quá ngắn', new Uint8Array(8), /không phải tệp WAV/],
    ['tiêu đề RIFX (big-endian)', (() => { const b = wav(); b.set([0x52, 0x49, 0x46, 0x58], 0); return b; })(), /không phải tệp WAV/],
    ['không có WAVE', (() => { const b = wav(); b.set([0x41, 0x56, 0x49, 0x20], 8); return b; })(), /không phải tệp WAV/],
    ['byte ngẫu nhiên', new Uint8Array(100).fill(7), /không phải tệp WAV/],
    ['thiếu khối fmt và data', wav({ omitFmt: true, omitData: true }), /không có khối fmt/],
    ['thiếu khối data', wav({ omitData: true }), /không có khối data/],
    ['data đứng trước fmt', wav({ dataFirst: true }), /data đứng trước/],
    ['44,1 kHz', wav({ rate: 44100 }), /44100 Hz/],
    ['8 kHz', wav({ rate: 8000 }), /8000 Hz/],
    ['48 kHz', wav({ rate: 48000 }), /48000 Hz/],
    ['hai kênh', wav({ channels: 2 }), /2 kênh/],
    ['bốn kênh', wav({ channels: 4 }), /4 kênh/],
    ['8-bit', wav({ bits: 8 }), /8-bit/],
    ['24-bit', wav({ bits: 24 }), /24-bit/],
    ['32-bit', wav({ bits: 32 }), /32-bit/],
    ['dấu phẩy động (định dạng 3)', wav({ tag: 3 }), /PCM không nén.*định dạng 3/],
    ['A-law (định dạng 6)', wav({ tag: 6 }), /định dạng 6/],
    ['µ-law (định dạng 7)', wav({ tag: 7 }), /định dạng 7/],
    ['EXTENSIBLE với định dạng con dấu phẩy động', wav({ extensibleSub: 3 }), /định dạng 3/],
    ['độ dài dữ liệu lẻ', wav({ data: new Uint8Array([1, 0, 2]) }), /độ dài lẻ/],
    ['data rỗng', wav({ data: new Uint8Array(0) }), /không có dữ liệu/],
    ['khối fmt bị cắt cụt', wav().subarray(0, 30), /fmt.*cắt cụt/],
  ];
  it.each(bad)('%s', (_name, bytes, message) => {
    expect(() => parseWav(bytes)).toThrowError(AudioError);
    expect(() => parseWav(bytes)).toThrowError(message);
  });

  it('thông báo sai định dạng gợi ý lệnh ffmpeg để đổi', () => {
    expect(() => parseWav(wav({ rate: 44100, channels: 2 }))).toThrowError(/ffmpeg -i vào\.m4a -ar 16000 -ac 1 -c:a pcm_s16le/);
  });
});

describe('parseRawPcm', () => {
  it('nhận PCM độ dài chẵn', () => {
    expect(parseRawPcm(new Uint8Array(6400)).byteLength).toBe(6400);
  });
  it('từ chối độ dài lẻ', () => {
    expect(() => parseRawPcm(new Uint8Array(3))).toThrowError(/độ dài lẻ/);
  });
  it('từ chối rỗng', () => {
    expect(() => parseRawPcm(new Uint8Array(0))).toThrowError(/không có dữ liệu/);
  });
});

describe('khung âm thanh', () => {
  it.each([
    [20, 640],
    [25, 800],
    [50, 1600],
    [80, 2560],
    [100, 3200],
  ])('khung %i ms là %i byte', (ms, bytes) => {
    expect(frameBytes(ms)).toBe(bytes);
    expect(frameBytes(ms) % 2).toBe(0);
  });

  it.each([19, 101, 0, -20, 33.3, Number.NaN, Number.POSITIVE_INFINITY])('khung %s ms bị từ chối', (ms) => {
    expect(() => frameBytes(ms)).toThrowError(RangeError);
  });

  it('cắt đúng số khung và khung cuối ngắn hơn', () => {
    const pcm = new Uint8Array(6402).map((_, i) => i % 251);
    const chunks = chunkPcm(pcm, 100);
    expect(chunks.map((c) => c.byteLength)).toEqual([3200, 3200, 2]);
    expect(chunkCount(pcm.byteLength, 100)).toBe(3);
  });

  it('ghép lại các khung ra đúng PCM gốc', () => {
    const pcm = new Uint8Array(10_000).map((_, i) => (i * 7) % 256);
    for (const ms of [20, 40, 60, 100]) {
      const joined = new Uint8Array(pcm.byteLength);
      let at = 0;
      for (const c of chunkPcm(pcm, ms)) {
        joined.set(c, at);
        at += c.byteLength;
      }
      expect(at).toBe(pcm.byteLength);
      expect(joined).toEqual(pcm);
    }
  });

  it('mọi khung có độ dài chẵn (không cắt đôi một mẫu)', () => {
    for (const c of chunkPcm(new Uint8Array(12_346), 20)) expect(c.byteLength % 2).toBe(0);
  });

  it('PCM rỗng cho danh sách rỗng', () => {
    expect(chunkPcm(new Uint8Array(0), 100)).toEqual([]);
    expect(chunkCount(0, 100)).toBe(0);
  });

  it.each([
    [64_000, 100, 20],
    [64_000, 20, 100],
    [64_001, 100, 21],
    [3200, 100, 1],
    [3202, 100, 2],
  ])('chunkCount(%i byte, %i ms) = %i', (bytes, ms, expected) => {
    expect(chunkCount(bytes, ms)).toBe(expected);
  });

  it('khung im lặng toàn số không và đúng cỡ', () => {
    const s = silenceChunk(60);
    expect(s.byteLength).toBe(1920);
    expect(s.every((b) => b === 0)).toBe(true);
  });

  it('pcmDurationMs: 32 byte là 1 mili giây', () => {
    expect(pcmDurationMs(32)).toBe(1);
    expect(pcmDurationMs(64_000)).toBe(2000);
  });
});

describe('encodeWav', () => {
  it('ghi tiêu đề 44 byte đúng chuẩn', () => {
    const pcm = new Uint8Array(100);
    const w = encodeWav(pcm);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...w.subarray(8, 16))).toBe('WAVEfmt ');
    expect(v.getUint32(4, true)).toBe(36 + 100);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(String.fromCharCode(...w.subarray(36, 40))).toBe('data');
    expect(v.getUint32(40, true)).toBe(100);
    expect(w.byteLength).toBe(144);
  });
});

// ───────────────────────── Hết tiếng nói ─────────────────────────

/** PCM từ các đoạn: [ms, biên độ]; biên độ 0 là im lặng; sóng vuông nên RMS đúng bằng biên độ. */
function square(...segments: [number, number][]): Uint8Array {
  const total = segments.reduce((n, [ms]) => n + ms * 16, 0);
  const pcm = new Uint8Array(total * 2);
  const view = new DataView(pcm.buffer);
  let at = 0;
  for (const [ms, amp] of segments) {
    for (let i = 0; i < ms * 16; i++) view.setInt16((at + i) * 2, i % 2 === 0 ? amp : -amp, true);
    at += ms * 16;
  }
  return pcm;
}

describe('detectSpeechEndMs', () => {
  const cases: [string, Uint8Array, number | null][] = [
    ['rỗng', new Uint8Array(0), null],
    ['toàn im lặng', square([1000, 0]), null],
    ['ồn nền dưới ngưỡng (RMS 100)', square([1000, 100]), null],
    ['tiếng 1 giây rồi im 1 giây', square([1000, 5000], [1000, 0]), 1000],
    ['im 500 ms rồi tiếng 500 ms', square([500, 0], [500, 5000]), 1000],
    ['chỉ có tiếng', square([1500, 5000]), 1500],
    ['hai đoạn tiếng cách nhau 300 ms rồi im', square([400, 5000], [300, 0], [200, 5000], [600, 0]), 900],
    ['đoạn cuối là ồn nền nhẹ', square([800, 5000], [200, 100]), 800],
    ['tiếng nhỏ nhưng trên ngưỡng tuyệt đối (RMS 400)', square([600, 400], [400, 0]), 600],
    ['tiếng nhỏ dưới ngưỡng tuyệt đối (RMS 150)', square([600, 150], [400, 0]), null],
    ['đoạn nhỏ sau đoạn to bị coi là ồn (dưới 10% mức to)', square([500, 10000], [500, 500], [500, 0]), 500],
    ['đoạn vừa sau đoạn to còn tính là tiếng (trên 10% mức to)', square([500, 10000], [500, 1500], [500, 0]), 1000],
    ['đoạn ngắn 10 ms không đủ một khung: kẹp theo độ dài', square([10, 5000]), 10],
    ['khung cuối lẻ', square([1030, 5000]), 1030],
    ['tiếng ở mọi khung, dài 3 giây', square([3000, 3000]), 3000],
  ];
  it.each(cases)('%s', (_name, pcm, expected) => {
    expect(detectSpeechEndMs(pcm)).toBe(expected);
  });

  it('khung và ngưỡng chỉnh được', () => {
    const pcm = square([500, 1000], [500, 0]);
    expect(detectSpeechEndMs(pcm, { frameMs: 100 })).toBe(500);
    expect(detectSpeechEndMs(pcm, { floorRms: 1500 })).toBeNull();
    expect(detectSpeechEndMs(pcm, { relative: 0.9 })).toBe(500);
  });

  it('đọc được PCM nằm ở địa chỉ lẻ trong bộ đệm', () => {
    const inner = square([400, 5000], [400, 0]);
    const padded = new Uint8Array(inner.byteLength + 1);
    padded.set(inner, 1);
    expect(detectSpeechEndMs(padded.subarray(1))).toBe(400);
  });

  it('ba tệp mẫu có điểm hết tiếng như đã thiết kế', () => {
    expect(detectSpeechEndMs(loadAudioFile(join(FIXTURES_DIR, '01-tinh-hinh-don-doan.wav')))).toBe(1600);
    expect(detectSpeechEndMs(loadAudioFile(join(FIXTURES_DIR, '02-di-thuc-anh-tuan.wav')))).toBe(2200);
    expect(detectSpeechEndMs(loadAudioFile(join(FIXTURES_DIR, '03-duyet-tam-ung.wav')))).toBe(2400);
  });
});

// ───────────────────────── Đọc tệp ─────────────────────────

describe('loadAudioFile', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'stt-bench-audio-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('đọc WAV mẫu', () => {
    expect(loadAudioFile(join(FIXTURES_DIR, '01-tinh-hinh-don-doan.wav')).byteLength).toBe(64_000);
    expect(loadAudioFile(join(FIXTURES_DIR, '02-di-thuc-anh-tuan.wav')).byteLength).toBe(80_000);
    expect(loadAudioFile(join(FIXTURES_DIR, '03-duyet-tam-ung.wav')).byteLength).toBe(96_000);
  });

  it.each(['.pcm', '.raw', '.s16le', '.PCM'])('đọc PCM thô đuôi %s', (ext) => {
    const dir = tmp();
    writeFileSync(join(dir, `a${ext}`), new Uint8Array(640));
    expect(loadAudioFile(join(dir, `a${ext}`)).byteLength).toBe(640);
  });

  it('đuôi .WAV viết hoa vẫn là WAV', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.WAV'), encodeWav(new Uint8Array(640)));
    expect(loadAudioFile(join(dir, 'a.WAV')).byteLength).toBe(640);
  });

  it.each(['.mp3', '.m4a', '.ogg', ''])('đuôi "%s" chưa hỗ trợ', (ext) => {
    expect(() => loadAudioFile(join(tmp(), `a${ext}`))).toThrowError(/chưa hỗ trợ/);
  });

  it('tệp không tồn tại', () => {
    expect(() => loadAudioFile(join(tmp(), 'khong-co.wav'))).toThrowError(/không đọc được tệp âm thanh/);
  });

  it('WAV sai định dạng báo lỗi của parseWav', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.wav'), wav({ rate: 44100 }));
    expect(() => loadAudioFile(join(dir, 'a.wav'))).toThrowError(/44100 Hz/);
  });

  it('PCM thô độ dài lẻ bị từ chối', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.pcm'), new Uint8Array(5));
    expect(() => loadAudioFile(join(dir, 'a.pcm'))).toThrowError(/độ dài lẻ/);
  });
});
