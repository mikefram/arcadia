import { describe, expect, it } from 'vitest';
import { AudioAssembler, MAX_AUDIO_BYTES } from '../src/scribe/audio-assembler';
import { Downsampler, FRAME_SAMPLES, Pcm16Framer, PcmFramer, firstChannel, floatToPcm16, pcm16ToFloat } from '../src/scribe/pcm';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('ghép âm thanh câu trả lời (các khung nhị phân giữa audio.start và audio.end)', () => {
  it('nối các khung theo đúng thứ tự nhận thành một khối mp3', () => {
    const a = new AudioAssembler();
    a.start('t1');
    a.push(bytes(0xff, 0xfb, 1));
    a.push(bytes(2, 3));
    a.push(bytes(4));
    expect(a.end('t1')).toEqual({ turnId: 't1', format: 'mp3', bytes: bytes(0xff, 0xfb, 1, 2, 3, 4) });
    // Trả ra rồi thì quên: âm thanh không được giữ lại.
    expect(a.collecting).toBe(false);
    expect(a.end('t1')).toBeNull();
  });

  it('khung tới ngoài cặp audio.start và audio.end bị bỏ', () => {
    const a = new AudioAssembler();
    a.push(bytes(9, 9));
    a.start('t1');
    a.push(bytes(1));
    expect(a.end('t1')?.bytes).toEqual(bytes(1));
    a.push(bytes(7));
    a.start('t2');
    expect(a.end('t2')).toBeNull();
  });

  it('bị ngắt lời: reset bỏ phần đang gom; audio.end của lượt khác không trả gì', () => {
    const a = new AudioAssembler();
    a.start('t1');
    a.push(bytes(1, 2));
    a.reset();
    expect(a.end('t1')).toBeNull();
    a.start('t2');
    a.push(bytes(3));
    expect(a.end('t1')).toBeNull();
    expect(a.end('t2')?.bytes).toEqual(bytes(3));
  });

  it('chép khối ra vùng nhớ riêng: bộ đệm của WebSocket bị ghi đè cũng không hỏng âm thanh', () => {
    const a = new AudioAssembler();
    const shared = bytes(1, 2, 3);
    a.start('t1');
    a.push(shared);
    shared.fill(0);
    expect(a.end('t1')?.bytes).toEqual(bytes(1, 2, 3));
  });

  it('vượt trần kích thước thì bỏ cả câu (app chỉ hiện chữ), không ăn hết bộ nhớ', () => {
    const a = new AudioAssembler();
    a.start('t1');
    a.push(new Uint8Array(MAX_AUDIO_BYTES));
    a.push(bytes(1));
    expect(a.end('t1')).toBeNull();
  });
});

describe('PCM gửi lên máy chủ: 16 kHz, 16-bit, little-endian, khung 20 đến 100 ms', () => {
  it('đổi mẫu số thực sang PCM 16-bit little-endian, cắt ngọn khi vượt biên', () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    const view = new DataView(out.buffer);
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
  });

  it('hạ mẫu 48 kHz về 16 kHz: cứ ba mẫu lấy trung bình thành một', () => {
    const d = new Downsampler(48_000);
    const out = d.process(new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6, 0.9, 0, 0]));
    expect([...out].map((v) => Math.round(v * 100) / 100)).toEqual([0.3, -0.6, 0.3]);
  });

  it('hạ mẫu 44.1 kHz về 16 kHz: một giây vào cho ra đúng khoảng 16.000 mẫu dù chia thành nhiều khối lẻ', () => {
    const d = new Downsampler(44_100);
    let total = 0;
    for (let i = 0; i < 44_100; i += 128) total += d.process(new Float32Array(Math.min(128, 44_100 - i))).length;
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(1);
  });

  it('máy thu sẵn ở 16 kHz thì giữ nguyên', () => {
    const d = new Downsampler(16_000);
    expect([...d.process(new Float32Array([0.25, -0.5]))]).toEqual([0.25, -0.5]);
  });

  it('gom thành khung 60 ms (960 mẫu, 1.920 byte); phần lẻ giữ lại và gửi nốt khi dừng thu', () => {
    const framer = new PcmFramer();
    expect(framer.push(new Float32Array(500))).toEqual([]);
    const frames = framer.push(new Float32Array(1500));
    expect(frames.map((f) => f.byteLength)).toEqual([FRAME_SAMPLES * 2, FRAME_SAMPLES * 2]);
    // 20 đến 100 ms ở 16 kHz là 640 đến 3.200 byte
    for (const f of frames) expect(f.byteLength).toBeGreaterThanOrEqual(640);
    for (const f of frames) expect(f.byteLength).toBeLessThanOrEqual(3200);
    expect(framer.flush()?.byteLength).toBe(80 * 2);
    expect(framer.flush()).toBeNull();
  });
});

describe('PCM 16-bit máy đưa sẵn ở 16 kHz (thu trên iOS và Android)', () => {
  const ramp = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, i) => (from + i) % 251);

  it('cắt khung 1.920 byte và giữ nguyên từng byte; phần lẻ gửi nốt khi dừng thu', () => {
    const framer = new Pcm16Framer();
    const input = ramp(5000);
    const frames = [...framer.push(input.slice(0, 1000)), ...framer.push(input.slice(1000, 3500)), ...framer.push(input.slice(3500))];
    expect(frames.map((f) => f.byteLength)).toEqual([1920, 1920]);
    const tail = framer.flush();
    expect(tail?.byteLength).toBe(5000 - 3840);
    const joined = new Uint8Array(5000);
    joined.set(frames[0] as Uint8Array, 0);
    joined.set(frames[1] as Uint8Array, 1920);
    joined.set(tail as Uint8Array, 3840);
    expect(joined).toEqual(input);
    expect(framer.flush()).toBeNull();
  });

  it('mỗi khung nằm trong vùng nhớ riêng, không dùng chung bộ đệm với khối đầu vào', () => {
    const framer = new Pcm16Framer();
    const input = ramp(3840);
    const [frame] = framer.push(input);
    expect(frame?.buffer).not.toBe(input.buffer);
    expect(frame?.byteOffset).toBe(0);
    expect(frame?.buffer.byteLength).toBe(1920);
    input.fill(0);
    expect(frame?.[5]).toBe(5);
  });

  it('byte lẻ ở cuối bị cắt khi flush (một mẫu là hai byte); khung có số byte lẻ bị từ chối', () => {
    const framer = new Pcm16Framer();
    framer.push(ramp(7));
    expect(framer.flush()?.byteLength).toBe(6);
    expect(() => new Pcm16Framer(1921)).toThrow(RangeError);
    expect(() => new Pcm16Framer(0)).toThrow(RangeError);
  });

  it('đọc little-endian ra mẫu số thực, bỏ byte lẻ; khối là một khung nhìn lệch vị trí vẫn đúng', () => {
    const buffer = new Uint8Array([9, 9, 0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f, 5]);
    const view = new Uint8Array(buffer.buffer, 2, 7);
    expect([...pcm16ToFloat(view)]).toEqual([0.5, -0.5, 32767 / 32768]);
  });

  it('nhiều kênh xen kẽ: lấy kênh đầu; đơn kênh trả nguyên', () => {
    expect([...firstChannel(new Float32Array([1, -1, 2, -2, 3, -3]), 2)]).toEqual([1, 2, 3]);
    const mono = new Float32Array([1, 2]);
    expect(firstChannel(mono, 1)).toBe(mono);
  });
});
