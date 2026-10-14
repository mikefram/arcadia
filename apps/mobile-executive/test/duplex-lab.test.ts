import { describe, expect, it } from 'vitest';
import { SpeechGate } from '../src/duplex/gate';
import { PASS_MARGIN_DB, PROMPT_AFTER_MS, buildReport, type LabPoint, type ReportInput } from '../src/duplex/lab';
import { pickDuplexAudio } from '../src/duplex/native-core';
import { percentile, summarize } from '../src/duplex/stats';
import type { DuplexAudioNative, DuplexStartResult } from '../src/duplex/types';

describe('thống kê', () => {
  it('phân vị nội suy tuyến tính như numpy', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 50)).toBe(3);
    expect(percentile(sorted, 90)).toBeCloseTo(4.6, 10);
    expect(percentile(sorted, 100)).toBe(5);
    expect(percentile([-50, -40], 25)).toBeCloseTo(-47.5, 10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  it('tóm tắt bỏ giá trị không hữu hạn và không đổi dãy gốc', () => {
    const values = [-30, Number.NaN, -50, Number.NEGATIVE_INFINITY, -40];
    const stats = summarize(values);
    expect(stats).toEqual({ n: 3, p50: -40, p90: -32, p95: -31, max: -30 });
    expect(values).toHaveLength(5);
    expect(summarize([])).toBeNull();
    expect(summarize([Number.NaN])).toBeNull();
  });
});

describe('cổng nhận ra tiếng nói', () => {
  const gate = () => new SpeechGate({ thresholdDb: -40, attackFrames: 3, releaseFrames: 4 });

  it('chỉ báo bắt đầu khi đủ số khung liên tiếp vượt ngưỡng; tiếng động ngắn bị bỏ qua', () => {
    const noise = gate();
    expect([-30, -30, -60, -30, -30].map((db) => noise.push(db))).toEqual([null, null, null, null, null]);
    expect(noise.speaking).toBe(false);
    const voice = gate();
    expect([-30, -30, -30].map((db) => voice.push(db))).toEqual([null, null, 'start']);
    expect(voice.speaking).toBe(true);
  });

  it('đang nói thì mức dao động ngay dưới ngưỡng không làm cổng đóng; chỉ đóng khi thấp hơn ngưỡng 3 dB đủ lâu', () => {
    const g = gate();
    for (const db of [-30, -30, -30]) g.push(db);
    // -41 thấp hơn ngưỡng (-40) nhưng chưa thấp hơn ngưỡng trừ 3 dB (-43): vẫn đang nói
    expect([-41, -41, -41, -41, -41].map((db) => g.push(db))).toEqual([null, null, null, null, null]);
    expect(g.speaking).toBe(true);
    expect([-50, -50, -50, -50].map((db) => g.push(db))).toEqual([null, null, null, 'end']);
    expect(g.speaking).toBe(false);
  });

  it('một khung ồn xen giữa chuỗi im lặng làm đếm lại từ đầu', () => {
    const g = gate();
    for (const db of [-30, -30, -30]) g.push(db);
    expect([-50, -50, -50, -30, -50, -50, -50].map((db) => g.push(db))).toEqual([null, null, null, null, null, null, null]);
    expect(g.push(-50)).toBe('end');
  });

  it('reset đưa cổng về trạng thái đóng', () => {
    const g = gate();
    for (const db of [-30, -30, -30]) g.push(db);
    g.reset();
    expect(g.speaking).toBe(false);
    expect(g.push(-30)).toBeNull();
  });
});

describe('chọn mô-đun gốc', () => {
  const module = { start: async () => undefined } as unknown as DuplexAudioNative;

  it('iOS có mô-đun thì dùng; Android và web luôn là null và không nạp thử', () => {
    expect(pickDuplexAudio('ios', () => module)).toBe(module);
    let loads = 0;
    for (const os of ['android', 'web', 'windows']) {
      expect(
        pickDuplexAudio(os, () => {
          loads += 1;
          return module;
        }),
      ).toBeNull();
    }
    expect(loads).toBe(0);
  });

  it('bản dựng không có mô-đun (Expo Go) hoặc nạp lỗi thì null, không ném lỗi', () => {
    expect(pickDuplexAudio('ios', () => null)).toBeNull();
    expect(pickDuplexAudio('ios', () => undefined)).toBeNull();
    expect(
      pickDuplexAudio('ios', () => {
        throw new Error('Cannot find native module');
      }),
    ).toBeNull();
  });
});

// --- báo cáo -------------------------------------------------------------------------------------------------------

const START: DuplexStartResult = { inputSampleRate: 24_000, inputChannels: 1, voiceProcessing: true, route: 'Speaker / MicrophoneBuiltIn' };
const CONFIG = { voiceProcessing: true, voiceChatMode: true };

/** `count` khung cách nhau 50 ms từ `from`; `mic` là hàm của số thứ tự khung. */
function frames(from: number, count: number, mic: (index: number) => number, ref = -120): LabPoint[] {
  return Array.from({ length: count }, (_, i) => ({ t: from + i * 50, micDb: mic(i), refDb: ref }));
}

/** Tiếng vọng nhấp nhô quanh -50 dB: giữa -50, mức cao thường gặp -48. */
const echoLevel = (i: number) => [-52, -50, -48, -50, -49, -51][i % 6] as number;

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  const promptT = 3_000;
  return {
    config: CONFIG,
    start: START,
    silence: frames(0, 100, () => -60),
    echo: frames(5_000, 200, echoLevel, -25),
    // trước lời nhắc chỉ có tiếng vọng; từ giây thứ 3,4 người nói chen vào ở -30 dB
    talk: frames(0, 200, (i) => (i * 50 >= promptT + 400 ? -30 : echoLevel(i)), -25),
    promptT,
    arrivals: Array.from({ length: 101 }, (_, i) => i * 50),
    pcmBytes: 160_000,
    ...overrides,
  };
}

describe('báo cáo đo khử tiếng vọng', () => {
  it('đạt: giọng nói chen vào cao hơn tiếng vọng nhiều, nhận ra nhanh, không nhận nhầm', () => {
    const report = buildReport(input());
    expect(report.verdict).toBe('pass');
    expect(report.silence?.p50).toBe(-60);
    expect(report.echo?.p50).toBeCloseTo(-50, 5);
    expect(report.referenceP50).toBe(-25);
    expect(report.echoLossDb).toBeCloseTo(25, 5);
    expect(report.speechP90).toBe(-30);
    expect(report.marginDb).toBeGreaterThanOrEqual(PASS_MARGIN_DB);
    expect(report.marginDb).toBeCloseTo(-30 - (report.echo?.p95 ?? 0), 5);
    expect(report.falseTriggers).toBe(0);
    // ngưỡng = mức cao thường gặp của tiếng vọng + 6 dB
    expect(report.thresholdDb).toBeCloseTo((report.echo?.p95 ?? 0) + 6, 5);
    // người nói từ 400 ms sau lời nhắc; cổng cần 3 khung liên tiếp nên xác nhận ở khung thứ ba
    expect(report.triggerDelayMs).toBe(400 + 2 * 50);
    expect(report.counts).toEqual({ silence: 100, echo: 200, talk: 200 - 60 });
    expect(report.cadenceHz).toBeCloseTo(20, 5);
    expect(report.pcmBytes).toBe(160_000);
  });

  it('chỉ tính các khung lúc trợ lý đang đọc (loa im thì không tính vào tiếng vọng)', () => {
    const echo = [...frames(5_000, 40, () => -80, -120), ...frames(7_000, 200, echoLevel, -25)];
    const report = buildReport(input({ echo }));
    expect(report.counts.echo).toBe(200);
    expect(report.echo?.p50).toBeCloseTo(-50, 5);
  });

  it('chưa chắc: giọng nói chỉ cao hơn tiếng vọng 6 đến 10 dB', () => {
    const talk = frames(0, 200, (i) => (i * 50 >= PROMPT_AFTER_MS + 400 ? -41 : echoLevel(i)), -25);
    const report = buildReport(input({ talk }));
    expect(report.marginDb).toBeGreaterThanOrEqual(6);
    expect(report.marginDb).toBeLessThan(10);
    expect(report.verdict).toBe('unsure');
  });

  it('chưa đạt: giọng nói lẫn vào tiếng vọng, cổng không nhận ra', () => {
    const talk = frames(0, 200, (i) => (i * 50 >= PROMPT_AFTER_MS + 400 ? -47 : echoLevel(i)), -25);
    const report = buildReport(input({ talk }));
    expect(report.marginDb).toBeLessThan(6);
    expect(report.triggerDelayMs).toBeNull();
    expect(report.verdict).toBe('fail');
  });

  it('nhận nhầm tiếng loa khi người nghe im lặng thì không thể "đạt"', () => {
    // 4 khung liền nhau vọt lên -35 dB giữa lúc trợ lý đọc (2% số khung nên không kéo mức cao thường gặp)
    const echo = frames(5_000, 200, (i) => (i >= 100 && i < 104 ? -35 : echoLevel(i)), -25);
    const report = buildReport(input({ echo }));
    expect(report.falseTriggers).toBe(1);
    expect(report.verdict).toBe('unsure');
    // hai đợt (8 khung, 4% số khung): vẫn dưới 5% nên không kéo mức cao thường gặp, nhưng nhận nhầm hai lần là không chấp nhận được
    const twice = frames(5_000, 200, (i) => ((i >= 100 && i < 104) || (i >= 150 && i < 154) ? -35 : echoLevel(i)), -25);
    const worse = buildReport(input({ echo: twice }));
    expect(worse.falseTriggers).toBe(2);
    expect(worse.verdict).toBe('fail');
  });

  it('lời nhắc chưa tới hoặc thiếu khung thì chưa đủ dữ liệu, không kết luận bừa', () => {
    expect(buildReport(input({ promptT: null })).verdict).toBe('incomplete');
    // mới 10 khung sau lời nhắc (cần ít nhất 20)
    expect(buildReport(input({ talk: frames(0, 70, echoLevel, -25) })).verdict).toBe('incomplete');
    expect(buildReport(input({ silence: frames(0, 10, () => -60) })).verdict).toBe('incomplete');
    expect(buildReport(input({ echo: frames(5_000, 200, () => -50, -120) })).verdict).toBe('incomplete');
    const empty = buildReport(input({ silence: [], echo: [], talk: [], arrivals: [] }));
    expect(empty.verdict).toBe('incomplete');
    expect(empty.silence).toBeNull();
    expect(empty.cadenceHz).toBeNull();
    expect(empty.thresholdDb).toBeNull();
  });

  it('tiếng vọng lọt qua trước lời nhắc không bị tính là đã nhận ra giọng', () => {
    // cổng mở sẵn vì tiếng vọng to trước lời nhắc; giọng thật chỉ đến sau lời nhắc
    const talk = frames(0, 200, (i) => (i * 50 < PROMPT_AFTER_MS ? -30 : i * 50 >= PROMPT_AFTER_MS + 1_000 ? -30 : echoLevel(i)), -25);
    const report = buildReport(input({ talk }));
    expect(report.triggerDelayMs).toBe(1_000 + 2 * 50);
  });

  it('tốc độ nhận khung: nhận thiếu thì thấy ngay', () => {
    const slow = Array.from({ length: 51 }, (_, i) => i * 100);
    expect(buildReport(input({ arrivals: slow })).cadenceHz).toBeCloseTo(10, 5);
  });
});
