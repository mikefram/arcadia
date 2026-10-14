import { describe, expect, it } from 'vitest';
import { LevelMeter, pcm16Rms, toLevel } from '../src/scribe/level';

/** PCM 16-bit little-endian từ các mẫu số nguyên. */
function pcm(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
}

const sine = (amplitude: number, n = 960) => pcm(Array.from({ length: n }, (_, i) => Math.round(Math.sin((2 * Math.PI * i * 440) / 16_000) * amplitude * 0x7fff)));

describe('mức âm của một khung PCM', () => {
  it('im lặng là 0, toàn thang là 1, sóng sin biên độ 0,5 có RMS khoảng 0,354', () => {
    expect(pcm16Rms(pcm(new Array(960).fill(0)))).toBe(0);
    expect(pcm16Rms(pcm(new Array(960).fill(-32768)))).toBe(1);
    expect(pcm16Rms(sine(0.5))).toBeCloseTo(0.3536, 2);
  });

  it('khung rỗng và khung có byte lẻ không lỗi; đọc đúng khi khối là khung nhìn lệch vị trí', () => {
    expect(pcm16Rms(new Uint8Array(0))).toBe(0);
    expect(pcm16Rms(new Uint8Array([0x00, 0x40, 0x7f]))).toBeCloseTo(0.5, 5);
    const backing = new Uint8Array([9, 9, 0x00, 0x40, 0x00, 0xc0, 9]);
    expect(pcm16Rms(new Uint8Array(backing.buffer, 2, 4))).toBeCloseTo(0.5, 5);
  });

  it('toLevel: dưới ngưỡng ồn nền là 0, tăng dần, tiếng nói thường ở giữa thang, tiếng rất to chạm 1', () => {
    expect(toLevel(0)).toBe(0);
    expect(toLevel(0.004)).toBe(0);
    expect(toLevel(Number.NaN)).toBe(0);
    const levels = [0.01, 0.03, 0.06, 0.1, 0.2].map(toLevel);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
    expect(toLevel(0.03)).toBeGreaterThan(0.3);
    expect(toLevel(0.03)).toBeLessThan(0.6);
    expect(toLevel(0.5)).toBe(1);
  });
});

describe('kho mức âm cho màn hình', () => {
  function meter() {
    let t = 0;
    const m = new LevelMeter(() => t, 100);
    const seen: number[] = [];
    m.subscribe(() => seen.push(m.getSnapshot()));
    return { m, seen, at: (ms: number) => void (t = ms) };
  }

  it('báo cho màn hình tối đa mỗi 100 ms, lấy đỉnh của khoảng đó', () => {
    const { m, seen, at } = meter();
    at(100);
    m.push(sine(0.05));
    at(130);
    m.push(sine(0.4));
    at(160);
    m.push(sine(0.02));
    expect(seen).toHaveLength(1);
    at(210);
    m.push(sine(0.02));
    expect(seen).toHaveLength(2);
    // khoảng thứ hai có đỉnh là khung 0,4 (đã giữ lại từ trước) nên mức báo ở lần hai cao hơn lần một
    expect(seen[1]).toBeGreaterThan(seen[0] as number);
  });

  it('lên nhanh, xuống từ từ: sau tiếng to rồi im lặng, mức giảm dần qua vài lần báo rồi về 0', () => {
    const { m, seen, at } = meter();
    at(100);
    m.push(sine(0.5));
    const loud = m.getSnapshot();
    expect(loud).toBeGreaterThan(0.8);
    const quiet = pcm(new Array(960).fill(0));
    for (let i = 1; i <= 12; i++) {
      at(100 + i * 100);
      m.push(quiet);
    }
    expect(seen.slice(0, 3)).toEqual(expect.arrayContaining([loud]));
    expect(seen[1]).toBeLessThan(loud);
    expect(seen[1]).toBeGreaterThan(0);
    expect(m.getSnapshot()).toBe(0);
  });

  it('reset đưa thanh về 0 ngay, báo màn hình đúng một lần, và gọi lại không báo thừa', () => {
    const { m, seen, at } = meter();
    at(100);
    m.push(sine(0.3));
    const before = seen.length;
    m.reset();
    expect(m.getSnapshot()).toBe(0);
    expect(seen.length).toBe(before + 1);
    m.reset();
    expect(seen.length).toBe(before + 1);
  });

  it('huỷ đăng ký thì không nhận báo nữa', () => {
    let t = 0;
    const m = new LevelMeter(() => t, 100);
    let calls = 0;
    const off = m.subscribe(() => calls++);
    t = 100;
    m.push(sine(0.3));
    off();
    t = 300;
    m.push(sine(0.5));
    expect(calls).toBe(1);
  });
});
