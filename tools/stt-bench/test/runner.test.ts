/**
 * Kiểm đường chạy của runner bằng đồng hồ ảo: độ trễ, đuôi im lặng, cắt sớm, lỗi, tốc độ phát, song song.
 * Không có mạng, không có hẹn giờ thật: thời gian ảo chỉ trôi khi runner ngủ hoặc nhà cung cấp giả hẹn giờ.
 */
import type { SttOpenOptions, SttProvider, SttSession } from '@mihato/providers';
import { describe, expect, it } from 'vitest';
import { TAIL_MARGIN_MS } from '../src/configs';
import { loadManifest } from '../src/manifest';
import { loadItems, mapPool, maxBytesFor, runBench, runPass, safeCode, type PassOptions } from '../src/runner';
import { configFor, FIXTURE_MANIFEST, makeItem, makeLoaded, SETTINGS, TimedStt, VirtualClock, type TimedSttBehavior } from './helpers';

const NOW = new Date('2026-10-03T09:00:00+07:00');
const FILE_BYTES = 64_000; // 2 giây
const FRAME = 3200; // 100 ms

/** Chạy một lượt với một câu 2 giây, hết tiếng ở 1600 ms, trên đồng hồ ảo. */
async function runOne(behavior: TimedSttBehavior, over: Partial<PassOptions> = {}, loaded = makeLoaded(2000, 1600)) {
  const clock = new VirtualClock();
  const provider = new TimedStt(clock, behavior);
  const result = await clock.drive(
    runPass({
      config: configFor(provider),
      utteranceEndMs: 1300,
      items: [loaded],
      keyterms: [],
      settings: SETTINGS,
      score: { now: NOW },
      clock,
      ...over,
    }),
  );
  return { clock, provider, outcome: result.outcomes[0]!, result };
}

/** Nhà cung cấp chốt `finalAfter` ms sau khung cuối của tệp và báo hết câu `endAfter` ms sau khung cuối. */
const lateFinisher = (finalAfter: number, endAfter: number, text = 'đi thúc anh Tuấn'): TimedSttBehavior => ({
  onAudio(api) {
    if (api.bytes() !== FILE_BYTES) return;
    api.later(finalAfter, () => api.emit({ type: 'final', text, confidence: 0.9 }));
    api.later(endAfter, () => api.emit({ type: 'utteranceEnd' }));
  },
});

describe('runPass: đuôi im lặng và độ trễ chốt', () => {
  it('gửi khung im lặng cho tới khi nhà cung cấp báo hết câu, đo độ trễ tới sự kiện cuối', async () => {
    const { provider, outcome } = await runOne(lateFinisher(400, 1250));
    // final lúc 2400, utteranceEnd lúc 3250; khung chứa tiếng nói cuối (khung 15) gửi lúc 1600
    expect(outcome.scored.latencyMs).toBe(3250 - 1600);
    expect(outcome.hypothesis).toBe('đi thúc anh Tuấn');
    expect(outcome.scored.status).toBe('ok');
    expect(outcome.finals).toBe(1);
    // đuôi: các khung lúc 2100 … 3200, tức 12 khung; khung lúc 3300 thấy đã chốt nên không gửi
    expect(outcome.tailMs).toBe(1200);
    expect(outcome.scored.bytesSent).toBe(FILE_BYTES + 12 * FRAME);
    expect(provider.sessions[0]).toMatchObject({ bytes: FILE_BYTES + 12 * FRAME, closed: true });
    expect(outcome.scored.earlyUtteranceEnds).toBe(0);
    expect(outcome.scored.earlyFinals).toBe(0);
    expect(outcome.closeTimedOut).toBe(false);
  });

  it('đo từ khung chứa tiếng nói cuối, không phải từ hết tệp', async () => {
    // final tới ngay khi hết tệp (lúc 2000): từ lúc hết tiếng (1600) là 400 ms, không phải 0
    const { outcome } = await runOne(lateFinisher(0, 100));
    expect(outcome.scored.latencyMs).toBe(2100 - 1600);
  });

  it('endMode close: không gửi đuôi, đóng ngay khi hết tệp', async () => {
    const { provider, outcome } = await runOne(
      { onClose: (api) => api.emit({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 }) },
      { settings: { ...SETTINGS, endMode: 'close' } },
    );
    expect(provider.sessions[0]?.bytes).toBe(FILE_BYTES);
    expect(outcome.tailMs).toBe(0);
    expect(outcome.scored.latencyMs).toBe(2000 - 1600);
    expect(outcome.hypothesis).toBe('đi thúc anh Tuấn');
  });

  it('nhà cung cấp không bao giờ báo hết câu: gửi đủ đuôi tối đa rồi đóng, chưa có kết quả', async () => {
    const { outcome } = await runOne({});
    const tailFrames = Math.floor((1300 + TAIL_MARGIN_MS) / 100);
    expect(tailFrames).toBe(28);
    expect(outcome.scored.bytesSent).toBe(FILE_BYTES + tailFrames * FRAME);
    expect(outcome.scored.bytesSent).toBe(maxBytesFor(FILE_BYTES, 1300, SETTINGS));
    expect(outcome.scored.status).toBe('no_result');
    expect(outcome.hypothesis).toBe('');
    expect(outcome.scored.latencyMs).toBeNull();
  });

  it('tốc độ gấp đôi: khung đến mỗi 50 ms thật, độ trễ tính theo đồng hồ thật', async () => {
    const { outcome } = await runOne(lateFinisher(400, 1250), { settings: { ...SETTINGS, speed: 2 } });
    // khung 15 gửi lúc 800; khung cuối lúc 1000; final lúc 1400, utteranceEnd lúc 2250
    expect(outcome.scored.latencyMs).toBe(2250 - 800);
    // đuôi: khung lúc 1050 … 2200 mỗi 50 ms là 24 khung
    expect(outcome.scored.bytesSent).toBe(FILE_BYTES + 24 * FRAME);
  });

  it('tốc độ tối đa: không chờ, thời gian ảo không trôi', async () => {
    const { clock, outcome } = await runOne(
      { onClose: (api) => api.emit({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 }) },
      { settings: { ...SETTINGS, speed: Infinity, endMode: 'close' } },
    );
    expect(clock.now()).toBe(0);
    expect(outcome.scored.latencyMs).toBe(0);
    expect(outcome.scored.bytesSent).toBe(FILE_BYTES);
  });

  it('điểm hết tiếng chỉnh được: speechEnd audio lấy hết tệp', async () => {
    const { outcome } = await runOne(lateFinisher(400, 1250), { settings: { ...SETTINGS, speechEnd: 'audio' } });
    // khung cuối (19) gửi lúc 2000
    expect(outcome.scored.latencyMs).toBe(3250 - 2000);
  });

  it('không dò được tiếng nói (cả tệp im lặng) thì lấy hết tệp', async () => {
    const { outcome } = await runOne(lateFinisher(400, 1250), {}, makeLoaded(2000, null));
    expect(outcome.scored.latencyMs).toBe(3250 - 2000);
  });

  it('chấm trên kết quả chốt: lỗi tên được ghi nhận', async () => {
    const item = makeItem({ entities: { people: ['Tuấn'], amountsVnd: [], dates: [] } });
    const { outcome } = await runOne(lateFinisher(400, 1250, 'đi thúc anh Tú'), {}, makeLoaded(2000, 1600, item));
    expect(outcome.scored.score.names[0]?.verdict).toBe('missing');
    expect(outcome.scored.score.wer.substitutions).toBe(1);
  });
});

describe('runPass: độ tin cậy cả câu', () => {
  const twoFinals: TimedSttBehavior = {
    onAudio(api) {
      if (api.bytes() !== FILE_BYTES) return;
      api.emit({ type: 'final', text: 'đi thúc', confidence: 0.8 });
      api.emit({ type: 'final', text: 'anh Tuấn', confidence: 0.6 });
      api.emit({ type: 'utteranceEnd' });
    },
  };

  it('trung bình các final theo độ dài chữ, như scribe', async () => {
    const { outcome } = await runOne(twoFinals);
    // (0,8 × 7 + 0,6 × 8) / 15 = 0,6933…
    expect(outcome.confidence).toBe(0.693);
    expect(outcome.hypothesis).toBe('đi thúc anh Tuấn');
  });

  it('một final thì bằng chính nó', async () => {
    const { outcome } = await runOne({
      onAudio(api) {
        if (api.bytes() === FILE_BYTES) {
          api.emit({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.91 });
          api.emit({ type: 'utteranceEnd' });
        }
      },
    });
    expect(outcome.confidence).toBe(0.91);
  });

  it('không có kết quả hoặc phiên lỗi thì null', async () => {
    expect((await runOne({})).outcome.confidence).toBeNull();
    const failed = await runOne({
      onAudio(api) {
        if (api.bytes() === 3 * FRAME) {
          api.emit({ type: 'final', text: 'đi', confidence: 0.9 });
          api.emit({ type: 'error', code: 'stt_socket_error', retryable: true });
        }
      },
    });
    expect(failed.outcome.confidence).toBeNull();
  });
});

describe('runPass: cắt ngang câu sớm (mô phỏng scribe chốt lượt ở utteranceEnd)', () => {
  it('utteranceEnd giữa câu: ngừng gửi âm thanh, đếm một lần cắt, kết quả bị cụt', async () => {
    const { outcome } = await runOne({
      onAudio(api) {
        if (api.bytes() === 8 * FRAME) {
          api.emit({ type: 'final', text: 'đi thúc', confidence: 0.9 });
          api.emit({ type: 'utteranceEnd' });
        }
      },
    });
    expect(outcome.scored.earlyUtteranceEnds).toBe(1);
    expect(outcome.scored.earlyFinals).toBe(1);
    expect(outcome.scored.bytesSent).toBe(8 * FRAME);
    expect(outcome.tailMs).toBe(0);
    expect(outcome.hypothesis).toBe('đi thúc');
    // không bao giờ gửi tới khung chứa hết tiếng nói nên không có mốc để đo độ trễ
    expect(outcome.scored.latencyMs).toBeNull();
    // phần sau của câu mất đi: hai tiếng bị xoá
    expect(outcome.scored.score.wer).toMatchObject({ deletions: 2, substitutions: 0, errors: 2 });
  });

  it('utteranceEnd tới sau khi nói xong nhưng trước hết tệp: không phải cắt sớm', async () => {
    const loaded = makeLoaded(2000, 1000);
    const { outcome } = await runOne(
      {
        onAudio(api) {
          if (api.bytes() === 15 * FRAME) {
            api.emit({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 });
            api.emit({ type: 'utteranceEnd' });
          }
        },
      },
      {},
      loaded,
    );
    expect(outcome.scored.earlyUtteranceEnds).toBe(0);
    // final tới khi âm thanh chưa hết: tính là final giữa câu, không phải lỗi
    expect(outcome.scored.earlyFinals).toBe(1);
    expect(outcome.scored.bytesSent).toBe(15 * FRAME);
    expect(outcome.scored.latencyMs).toBe(1500 - 1000);
  });

  it('cùng ca nhưng tắt dò tiếng nói: lấy hết tệp làm hết tiếng nên là cắt sớm', async () => {
    const { outcome } = await runOne(
      {
        onAudio(api) {
          if (api.bytes() === 15 * FRAME) {
            api.emit({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 });
            api.emit({ type: 'utteranceEnd' });
          }
        },
      },
      { settings: { ...SETTINGS, speechEnd: 'audio' } },
      makeLoaded(2000, 1000),
    );
    expect(outcome.scored.earlyUtteranceEnds).toBe(1);
    expect(outcome.scored.latencyMs).toBeNull();
  });

  it('utteranceEnd đúng ở khung chứa hết tiếng: không phải cắt sớm', async () => {
    const { outcome } = await runOne({
      onAudio(api) {
        if (api.bytes() === 16 * FRAME) {
          api.emit({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 });
          api.emit({ type: 'utteranceEnd' });
        }
      },
    });
    expect(outcome.scored.earlyUtteranceEnds).toBe(0);
    expect(outcome.scored.latencyMs).toBe(0);
  });

  it('nhà cung cấp chốt cả câu rồi báo hết ở khung cuối: chuẩn, không cắt', async () => {
    const { outcome } = await runOne({
      onAudio(api) {
        if (api.bytes() === FILE_BYTES) {
          api.emit({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 });
          api.emit({ type: 'utteranceEnd' });
        }
      },
    });
    expect(outcome.scored.earlyUtteranceEnds).toBe(0);
    expect(outcome.scored.earlyFinals).toBe(0);
    expect(outcome.tailMs).toBe(0);
    expect(outcome.scored.latencyMs).toBe(2000 - 1600);
  });
});

describe('runPass: lỗi', () => {
  it('lỗi giữa phiên: câu tính như rỗng, ghi mã lỗi, ngừng gửi', async () => {
    const { outcome } = await runOne({
      onAudio(api) {
        if (api.bytes() === 3 * FRAME) api.emit({ type: 'error', code: 'stt_closed_1011', retryable: true });
      },
    });
    expect(outcome.scored.status).toBe('failed');
    expect(outcome.errorCode).toBe('stt_closed_1011');
    expect(outcome.hypothesis).toBe('');
    expect(outcome.scored.bytesSent).toBe(3 * FRAME);
    expect(outcome.scored.latencyMs).toBeNull();
    expect(outcome.scored.score.wer.deletions).toBe(4);
  });

  it('lỗi dù đã có final: vẫn tính là phiên lỗi, như scribe', async () => {
    const { outcome } = await runOne({
      onAudio(api) {
        if (api.bytes() === 5 * FRAME) {
          api.emit({ type: 'final', text: 'đi thúc', confidence: 0.9 });
          api.emit({ type: 'error', code: 'stt_socket_error', retryable: true });
        }
      },
    });
    expect(outcome.scored.status).toBe('failed');
    expect(outcome.hypothesis).toBe('');
  });

  it('không mở được phiên: câu lỗi, 0 byte, mã lỗi an toàn', async () => {
    const { outcome } = await runOne({
      onOpen() {
        throw new Error('stt_open_failed');
      },
    });
    expect(outcome.scored.status).toBe('failed');
    expect(outcome.errorCode).toBe('stt_open_failed');
    expect(outcome.scored.bytesSent).toBe(0);
    expect(outcome.finals).toBe(0);
  });

  it('thông điệp lỗi có địa chỉ hay khoá thì không lọt vào mã lỗi', async () => {
    const { outcome } = await runOne({
      onOpen() {
        throw new Error('connect wss://api.example.com/v1/listen?token=BI-MAT keyterm=Tuấn');
      },
    });
    expect(outcome.errorCode).toBe('stt_open_failed');
    expect(JSON.stringify(outcome)).not.toContain('BI-MAT');
  });

  it('sendAudio ném lỗi: phiên lỗi, vẫn đóng phiên', async () => {
    const clock = new VirtualClock();
    let closed = false;
    const provider: SttProvider = {
      async open(): Promise<SttSession> {
        return {
          sendAudio() {
            throw new Error('boom');
          },
          on() {},
          keepAlive() {},
          async close() {
            closed = true;
          },
        };
      },
    };
    const result = await clock.drive(runPass({ config: configFor(provider), utteranceEndMs: 1300, items: [makeLoaded(1000, 800)], keyterms: [], settings: SETTINGS, score: { now: NOW }, clock }));
    expect(result.outcomes[0]?.errorCode).toBe('stt_send_failed');
    expect(result.outcomes[0]?.scored.status).toBe('failed');
    expect(closed).toBe(true);
  });

  it('close() treo: đợi tối đa closeTimeoutMs rồi bỏ cuộc', async () => {
    const clock = new VirtualClock();
    const provider: SttProvider = {
      async open(): Promise<SttSession> {
        const finals: ((e: { type: 'final'; text: string; confidence: number }) => void)[] = [];
        return {
          sendAudio(chunk) {
            if (chunk.byteLength > 0) for (const cb of finals) cb({ type: 'final', text: 'đi thúc', confidence: 1 });
          },
          on(event, cb) {
            if (event === 'final') finals.push(cb as (e: { type: 'final'; text: string; confidence: number }) => void);
          },
          keepAlive() {},
          close: () => new Promise<void>(() => {}),
        };
      },
    };
    const result = await clock.drive(
      runPass({ config: configFor(provider), utteranceEndMs: 1300, items: [makeLoaded(1000, 800)], keyterms: [], settings: { ...SETTINGS, endMode: 'close', closeTimeoutMs: 5000 }, score: { now: NOW }, clock }),
    );
    expect(result.outcomes[0]?.closeTimedOut).toBe(true);
    expect(clock.now()).toBe(1000 + 5000);
  });
});

describe('runPass: tham số truyền cho nhà cung cấp', () => {
  it('mở phiên với tiếng Việt, 16 kHz và utterance_end_ms của lượt chạy', async () => {
    const { provider } = await runOne({}, { utteranceEndMs: 1500 });
    expect(provider.sessions[0]?.options).toEqual({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1500 });
  });

  it('gửi keyterm của cả manifest khi cấu hình bật', async () => {
    const clock = new VirtualClock();
    const provider = new TimedStt(clock);
    await clock.drive(
      runPass({ config: configFor(provider, { sendKeyterms: true }), utteranceEndMs: 1300, items: [makeLoaded(500, 400)], keyterms: ['Tuấn', 'Phương'], settings: { ...SETTINGS, endMode: 'close' }, score: { now: NOW }, clock }),
    );
    expect(provider.sessions[0]?.options.keyterms).toEqual(['Tuấn', 'Phương']);
  });

  it('không gửi keyterm khi cấu hình tắt', async () => {
    const clock = new VirtualClock();
    const provider = new TimedStt(clock);
    await clock.drive(
      runPass({ config: configFor(provider, { sendKeyterms: false }), utteranceEndMs: 1300, items: [makeLoaded(500, 400)], keyterms: ['Tuấn', 'Phương'], settings: { ...SETTINGS, endMode: 'close' }, score: { now: NOW }, clock }),
    );
    expect(provider.sessions[0]?.options.keyterms).toEqual([]);
  });

  it('khung gửi đúng cỡ chunkMs', async () => {
    const clock = new VirtualClock();
    const provider = new TimedStt(clock);
    await clock.drive(
      runPass({ config: configFor(provider), utteranceEndMs: 1300, items: [makeLoaded(1000, 800)], keyterms: [], settings: { ...SETTINGS, chunkMs: 20, endMode: 'close' }, score: { now: NOW }, clock }),
    );
    expect(provider.sessions[0]).toMatchObject({ bytes: 32_000, chunks: 50 });
  });

  it('mỗi câu một phiên riêng', async () => {
    const clock = new VirtualClock();
    const provider = new TimedStt(clock);
    await clock.drive(
      runPass({ config: configFor(provider), utteranceEndMs: 1300, items: [makeLoaded(500, 400), makeLoaded(700, 600, makeItem({ id: 't2' }))], keyterms: [], settings: { ...SETTINGS, endMode: 'close' }, score: { now: NOW }, clock }),
    );
    expect(provider.sessions.map((s) => s.bytes)).toEqual([16_000, 22_400]);
  });
});

describe('runPass: song song và tiến độ', () => {
  const items = Array.from({ length: 5 }, (_, i) => makeLoaded(1000, 900, makeItem({ id: `c${i + 1}` })));
  const close = (api: { emit: (e: { type: 'final'; text: string; confidence: number }) => void }) => api.emit({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 });

  it('tuần tự: tổng thời gian bằng tổng độ dài', async () => {
    const clock = new VirtualClock();
    const provider = new TimedStt(clock, { onClose: close });
    const result = await clock.drive(runPass({ config: configFor(provider), utteranceEndMs: 1300, items, keyterms: [], settings: { ...SETTINGS, endMode: 'close' }, score: { now: NOW }, clock }));
    expect(clock.now()).toBe(5000);
    expect(result.outcomes.map((o) => o.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('song song 3: hai đợt, giữ nguyên thứ tự kết quả', async () => {
    const clock = new VirtualClock();
    const provider = new TimedStt(clock, { onClose: close });
    const result = await clock.drive(runPass({ config: configFor(provider), utteranceEndMs: 1300, items, keyterms: [], settings: { ...SETTINGS, endMode: 'close', concurrency: 3 }, score: { now: NOW }, clock }));
    expect(clock.now()).toBe(2000);
    expect(result.outcomes.map((o) => o.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    // độ trễ mỗi câu không bị song song làm méo: vẫn tính trên đồng hồ của chính câu đó
    expect(result.outcomes.map((o) => o.scored.latencyMs)).toEqual([100, 100, 100, 100, 100]);
  });

  it('báo tiến độ đếm từ 1 tới tổng, không kèm nội dung', async () => {
    const clock = new VirtualClock();
    const seen: [number, number][] = [];
    await clock.drive(
      runPass({ config: configFor(new TimedStt(clock, { onClose: close })), utteranceEndMs: 1300, items, keyterms: [], settings: { ...SETTINGS, endMode: 'close' }, score: { now: NOW }, clock, onProgress: (d, t) => seen.push([d, t]) }),
    );
    expect(seen).toEqual([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  });
});

describe('runBench', () => {
  it('lần lượt từng cấu hình, từng giá trị utterance_end_ms', async () => {
    const clock = new VirtualClock();
    const a = new TimedStt(clock);
    const b = new TimedStt(clock);
    const order: string[] = [];
    const passes = await clock.drive(
      runBench({
        configs: [configFor(a, { id: 'deepgram-nova3', label: 'A' }), configFor(b, { id: 'deepgram-nova2', label: 'B' })],
        utteranceEndValues: [1000, 1500],
        items: [makeLoaded(500, 400)],
        keyterms: [],
        settings: { ...SETTINGS, endMode: 'close' },
        score: { now: NOW },
        clock,
        onPassStart: (c, ms) => order.push(`${c.label}@${ms}`),
      }),
    );
    expect(order).toEqual(['A@1000', 'A@1500', 'B@1000', 'B@1500']);
    expect(passes.map((p) => [p.configId, p.utteranceEndMs])).toEqual([
      ['deepgram-nova3', 1000],
      ['deepgram-nova3', 1500],
      ['deepgram-nova2', 1000],
      ['deepgram-nova2', 1500],
    ]);
    expect(a.sessions.map((s) => s.options.utteranceEndMs)).toEqual([1000, 1500]);
    expect(b.sessions.map((s) => s.options.utteranceEndMs)).toEqual([1000, 1500]);
  });
});

describe('mapPool', () => {
  it('giữ thứ tự kết quả và không vượt giới hạn song song', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
  it('giới hạn lớn hơn số phần tử', async () => {
    expect(await mapPool([1, 2], 10, async (n) => n + 1)).toEqual([2, 3]);
  });
  it('giới hạn 0 hoặc âm được coi là 1', async () => {
    expect(await mapPool([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
    expect(await mapPool([1, 2, 3], -4, async (n) => n)).toEqual([1, 2, 3]);
  });
  it('danh sách rỗng', async () => {
    expect(await mapPool([], 3, async (n) => n)).toEqual([]);
  });
  it('chỉ số được truyền đúng', async () => {
    expect(await mapPool(['a', 'b', 'c'], 2, async (v, i) => `${i}${v}`)).toEqual(['0a', '1b', '2c']);
  });
});

describe('safeCode', () => {
  const cases: [unknown, string][] = [
    ['stt_open_failed', 'stt_open_failed'],
    [new Error('stt_open_failed_unauthorized'), 'stt_open_failed_unauthorized'],
    ['stt_closed_1011', 'stt_closed_1011'],
    ['STT.CODE:42-x', 'STT.CODE:42-x'],
    ['có dấu', 'dự phòng'],
    ['có khoảng trắng', 'dự phòng'],
    ['wss://host/path?token=x', 'dự phòng'],
    ['', 'dự phòng'],
    [new Error(''), 'dự phòng'],
    [42, 'dự phòng'],
    [null, 'dự phòng'],
    [undefined, 'dự phòng'],
    [{ message: 'stt_x' }, 'dự phòng'],
    ['a'.repeat(65), 'dự phòng'],
    ['a'.repeat(64), 'a'.repeat(64)],
    ['token=BI-MAT', 'dự phòng'],
  ];
  it.each(cases)('%j', (value, expected) => {
    expect(safeCode(value, 'dự phòng')).toBe(expected);
  });
});

describe('maxBytesFor', () => {
  it('chế độ close: chỉ tệp', () => {
    expect(maxBytesFor(64_000, 1300, { ...SETTINGS, endMode: 'close' })).toBe(64_000);
  });
  it('chế độ utterance-end: tệp cộng đuôi tối đa', () => {
    expect(maxBytesFor(64_000, 1300, SETTINGS)).toBe(64_000 + 28 * 3200);
    expect(maxBytesFor(64_000, 1000, { ...SETTINGS, chunkMs: 50 })).toBe(64_000 + 50 * 1600);
  });
});

describe('loadItems', () => {
  it('nạp ba tệp mẫu kèm điểm hết tiếng', () => {
    const { manifest, baseDir } = loadManifest(FIXTURE_MANIFEST);
    const { items, problems } = loadItems(manifest, baseDir);
    expect(problems).toEqual([]);
    expect(items.map((i) => [i.item.id, i.pcm.byteLength, i.speechEndMs])).toEqual([
      ['fx-01', 64_000, 1600],
      ['fx-02', 80_000, 2200],
      ['fx-03', 96_000, 2400],
    ]);
  });

  it('tệp thiếu hoặc sai định dạng được báo kèm id, không chặn các tệp khác', () => {
    const { manifest, baseDir } = loadManifest(FIXTURE_MANIFEST);
    const broken = { ...manifest, items: [{ ...manifest.items[0]!, file: 'khong-co.wav' }, manifest.items[1]!, { ...manifest.items[2]!, file: 'manifest.json' }] };
    const { items, problems } = loadItems(broken, baseDir);
    expect(items.map((i) => i.item.id)).toEqual(['fx-02']);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^fx-01: không đọc được tệp âm thanh/);
    expect(problems[1]).toMatch(/^fx-03: chưa hỗ trợ|^fx-03: định dạng/);
  });
});

describe('SttOpenOptions', () => {
  it('kiểu mở phiên khớp giao diện providers', () => {
    const o: SttOpenOptions = { language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 };
    expect(o.language).toBe('vi');
  });
});
