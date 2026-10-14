import type { SttEvent, SttProvider } from '@mihato/providers';
import { describe, expect, it } from 'vitest';
import { chunkCount } from '../src/audio';
import { CONFIG_IDS, DEEPGRAM_NOVA3_USD_PER_MINUTE, keytermUsage, parseConfigIds, planRun, resolveConfigs, TAIL_MARGIN_MS, utteranceEndProblems, type BenchConfig, type ConfigId } from '../src/configs';
import { VBEE_MAX_SESSION_MS } from '../src/vbee-stt';
import { configFor, makeItem } from './helpers';

const KEY = { DEEPGRAM_API_KEY: 'khoa-bi-mat-deepgram', VBEE_APP_ID: 'app-bi-mat', VBEE_TOKEN: 'token-bi-mat' };

describe('parseConfigIds', () => {
  it('nhận danh sách, giữ thứ tự, bỏ trùng và khoảng trắng', () => {
    expect(parseConfigIds('deepgram-nova3, vbee ,deepgram-nova3,fake')).toEqual(['deepgram-nova3', 'vbee', 'fake']);
  });
  it('nhận đủ năm cấu hình', () => {
    expect(parseConfigIds(CONFIG_IDS.join(','))).toEqual([...CONFIG_IDS]);
  });
  it('bỏ phần tử rỗng', () => {
    expect(parseConfigIds(',fake,,')).toEqual(['fake']);
  });
  it('tên lạ bị từ chối và liệt kê các tên đúng', () => {
    expect(() => parseConfigIds('deepgram-nova4')).toThrowError(/Chọn trong: deepgram-nova3, deepgram-nova3-keyterm, deepgram-nova2, vbee, fake/);
  });
  it('rỗng bị từ chối', () => {
    expect(() => parseConfigIds('')).toThrowError(/trống/);
    expect(() => parseConfigIds(' , ')).toThrowError(/trống/);
  });
});

describe('resolveConfigs: chỉ chạy thật khi có --real VÀ khoá', () => {
  const real: ConfigId[] = ['deepgram-nova3', 'deepgram-nova3-keyterm', 'deepgram-nova2', 'vbee'];

  it('bản giả luôn chạy được, không cần cờ hay khoá', () => {
    const r = resolveConfigs(['fake'], { real: false, env: {} });
    expect(r.runnable.map((c) => c.id)).toEqual(['fake']);
    expect(r.skipped).toEqual([]);
  });

  it.each(real)('%s không có --real thì bị bỏ qua dù có khoá', (id) => {
    const r = resolveConfigs([id], { real: false, env: KEY });
    expect(r.runnable).toEqual([]);
    expect(r.skipped).toEqual([{ id, reason: expect.stringContaining('--real') }]);
  });

  it.each(['deepgram-nova3', 'deepgram-nova3-keyterm', 'deepgram-nova2'] as const)('%s có --real mà thiếu DEEPGRAM_API_KEY thì bị bỏ qua', (id) => {
    const r = resolveConfigs([id], { real: true, env: { VBEE_APP_ID: 'a', VBEE_TOKEN: 'b' } });
    expect(r.runnable).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/DEEPGRAM_API_KEY/);
  });

  it('khoá chỉ toàn khoảng trắng coi như thiếu', () => {
    expect(resolveConfigs(['deepgram-nova3'], { real: true, env: { DEEPGRAM_API_KEY: '   ' } }).runnable).toEqual([]);
    expect(resolveConfigs(['deepgram-nova3'], { real: true, env: { DEEPGRAM_API_KEY: '' } }).runnable).toEqual([]);
  });

  it.each([
    [{ VBEE_APP_ID: 'a' }, /VBEE_APP_ID hoặc VBEE_TOKEN/],
    [{ VBEE_TOKEN: 'b' }, /VBEE_APP_ID hoặc VBEE_TOKEN/],
    [{}, /VBEE_APP_ID hoặc VBEE_TOKEN/],
  ])('vbee cần cả hai biến: %j', (env, message) => {
    const r = resolveConfigs(['vbee'], { real: true, env });
    expect(r.runnable).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(message);
  });

  it('có --real và đủ khoá thì chạy được cả bốn cấu hình thật, giữ thứ tự', () => {
    const r = resolveConfigs([...real, 'fake'], { real: true, env: KEY });
    expect(r.runnable.map((c) => c.id)).toEqual([...real, 'fake']);
    expect(r.skipped).toEqual([]);
  });

  it('chọn lẫn: bản giả chạy, bản thật bị bỏ qua', () => {
    const r = resolveConfigs(['fake', 'deepgram-nova3'], { real: false, env: KEY });
    expect(r.runnable.map((c) => c.id)).toEqual(['fake']);
    expect(r.skipped.map((s) => s.id)).toEqual(['deepgram-nova3']);
  });

  it('lý do bỏ qua không bao giờ chứa giá trị của khoá', () => {
    const outputs = [resolveConfigs(real, { real: false, env: KEY }), resolveConfigs(real, { real: true, env: { DEEPGRAM_API_KEY: KEY.DEEPGRAM_API_KEY } })];
    for (const o of outputs) {
      const text = JSON.stringify(o.skipped);
      for (const secret of Object.values(KEY)) expect(text).not.toContain(secret);
    }
  });

  it('chọn cấu hình chưa chạm mạng và chưa dựng nhà cung cấp', () => {
    // Nếu dựng thật thì DeepgramStt sẽ ném lỗi vì khoá rỗng; ở đây chỉ chọn nên không ném.
    expect(() => resolveConfigs(real, { real: true, env: KEY })).not.toThrow();
  });

  it('nova-3 không keyterm: không gửi keyterm, giá 0,0077', () => {
    const c = resolveConfigs(['deepgram-nova3'], { real: true, env: KEY }).runnable[0]!;
    expect(c).toMatchObject({ real: true, sendKeyterms: false, usdPerMinute: DEEPGRAM_NOVA3_USD_PER_MINUTE, maxSessionMs: null });
    expect(DEEPGRAM_NOVA3_USD_PER_MINUTE).toBe(0.0077);
  });

  it('nova-3 có keyterm: gửi keyterm', () => {
    expect(resolveConfigs(['deepgram-nova3-keyterm'], { real: true, env: KEY }).runnable[0]).toMatchObject({ sendKeyterms: true, usdPerMinute: 0.0077 });
  });

  it('nova-2: không keyterm (chỉ Nova-3 hỗ trợ), chưa có giá trong SPEC', () => {
    expect(resolveConfigs(['deepgram-nova2'], { real: true, env: KEY }).runnable[0]).toMatchObject({ sendKeyterms: false, usdPerMinute: null });
  });

  it('vbee: không keyterm, chưa có giá, giới hạn phiên 90 giây', () => {
    expect(resolveConfigs(['vbee'], { real: true, env: KEY }).runnable[0]).toMatchObject({ sendKeyterms: false, usdPerMinute: null, maxSessionMs: VBEE_MAX_SESSION_MS });
    expect(VBEE_MAX_SESSION_MS).toBe(90_000);
  });

  it('fake: không thật, giá 0', () => {
    expect(resolveConfigs(['fake'], { real: false, env: {} }).runnable[0]).toMatchObject({ real: false, usdPerMinute: 0, sendKeyterms: false });
  });
});

describe('cấu hình fake: bản ghi sẵn từ manifest', () => {
  const fake = resolveConfigs(['fake'], { real: false, env: {} }).runnable[0]!;

  async function run(item: ReturnType<typeof makeItem>, chunks: number) {
    const session = await fake.createProvider({ item, audioBytes: chunks * 3200, chunkMs: 100 }).open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
    const events: SttEvent[] = [];
    for (const name of ['interim', 'final', 'utteranceEnd', 'error'] as const) session.on(name, (e) => events.push(e));
    const at: number[] = [];
    for (let i = 0; i < chunks; i++) {
      session.sendAudio(new Uint8Array(3200));
      at.push(events.length);
    }
    await session.close();
    return { events, at };
  }

  it('trả đúng câu ghi sẵn, báo hết câu ngay ở khung cuối chứ không sớm hơn', async () => {
    const { events, at } = await run(makeItem({ fake: { final: 'tinh hình', interim: ['tinh'], confidence: 0.77 } }), 5);
    expect(events).toEqual([
      { type: 'interim', text: 'tinh' },
      { type: 'final', text: 'tinh hình', confidence: 0.77 },
      { type: 'utteranceEnd' },
    ]);
    expect(at.slice(0, 4).every((n) => n <= 1)).toBe(true); // chỉ có kết quả tạm trước khung cuối
    expect(at[3]).toBe(1);
    expect(at[4]).toBe(3);
  });

  it('không ghi sẵn thì coi như nghe đúng hoàn toàn: kết quả bằng câu chuẩn', async () => {
    const { events } = await run(makeItem({ reference: 'đi thúc anh Tuấn' }), 3);
    expect(events).toContainEqual({ type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 });
  });

  it('ghi sẵn chuỗi rỗng là im lặng: không có final', async () => {
    const { events } = await run(makeItem({ fake: { final: '' } }), 3);
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });

  it('số khung báo hết câu khớp với cách runner cắt khung', () => {
    expect(chunkCount(64_000, 100)).toBe(20);
    expect(chunkCount(80_000, 100)).toBe(25);
  });
});

describe('planRun', () => {
  const items = [
    { id: 'a', audioBytes: 64_000 },
    { id: 'b', audioBytes: 80_000 },
    { id: 'c', audioBytes: 96_000 },
  ];
  const stub: SttProvider = {
    open: async () => {
      throw new Error('không dùng');
    },
  };
  const fake = configFor(stub);
  const real = (id: ConfigId, usdPerMinute: number | null, over: Partial<BenchConfig> = {}) => configFor(stub, { id, label: id, real: true, usdPerMinute, ...over });

  it('chế độ close: chỉ tính thời lượng tệp', () => {
    const p = planRun({ configs: [fake], utteranceEndValues: [1300], items, endMode: 'close' });
    expect(p.passes[0]?.minutes).toBeCloseTo(7.5 / 60, 12);
  });

  it('chế độ utterance-end: cộng đuôi tối đa cho mỗi câu', () => {
    const p = planRun({ configs: [fake], utteranceEndValues: [1300], items, endMode: 'utterance-end' });
    expect(p.passes[0]?.minutes).toBeCloseTo((7.5 + 3 * (1.3 + TAIL_MARGIN_MS / 1000)) / 60, 12);
    expect(TAIL_MARGIN_MS).toBe(1500);
  });

  it('mỗi giá trị utterance_end_ms là một lượt riêng với đuôi riêng', () => {
    const p = planRun({ configs: [fake], utteranceEndValues: [1000, 1500], items, endMode: 'utterance-end' });
    expect(p.passes.map((x) => x.utteranceEndMs)).toEqual([1000, 1500]);
    expect(p.passes[0]?.minutes).toBeCloseTo((7.5 + 3 * 2.5) / 60, 12);
    expect(p.passes[1]?.minutes).toBeCloseTo((7.5 + 3 * 3.0) / 60, 12);
  });

  it('trần phút chỉ tính các lượt chạy thật, không tính bản giả', () => {
    const p = planRun({ configs: [fake, real('deepgram-nova3', 0.0077)], utteranceEndValues: [1300], items, endMode: 'close' });
    expect(p.passes).toHaveLength(2);
    expect(p.realMinutes).toBeCloseTo(7.5 / 60, 12);
  });

  it('chi phí cộng các lượt thật có giá; cấu hình chưa có giá được nêu riêng', () => {
    const p = planRun({ configs: [real('deepgram-nova3', 0.0077), real('deepgram-nova2', null)], utteranceEndValues: [1300], items, endMode: 'close' });
    expect(p.realMinutes).toBeCloseTo(2 * (7.5 / 60), 12);
    expect(p.realCostUsd).toBeCloseTo((7.5 / 60) * 0.0077, 6);
    expect(p.passes[0]?.costUsd).toBeCloseTo((7.5 / 60) * 0.0077, 6);
    expect(p.passes[1]?.costUsd).toBeNull();
    expect(p.unpriced).toEqual(['deepgram-nova2']);
  });

  it('nhiều giá trị utterance_end_ms nhân số lượt chạy thật', () => {
    const p = planRun({ configs: [real('deepgram-nova3', 0.0077)], utteranceEndValues: [1000, 1300, 1500], items, endMode: 'close' });
    expect(p.passes).toHaveLength(3);
    expect(p.realMinutes).toBeCloseTo(3 * (7.5 / 60), 12);
  });

  it('Vbee giới hạn phiên 90 giây: câu dài (kể cả đuôi) bị báo', () => {
    const long = [{ id: 'dai-1', audioBytes: 88 * 32_000 }, ...items];
    const p = planRun({ configs: [real('vbee', null, { maxSessionMs: 90_000 }), real('deepgram-nova3', 0.0077)], utteranceEndValues: [1300], items: long, endMode: 'utterance-end' });
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0]).toMatch(/vbee: câu dai-1 dài 91 giây.*vượt giới hạn phiên 90 giây/);
  });

  it('Vbee với chế độ close: 88 giây vẫn vừa', () => {
    const long = [{ id: 'dai-1', audioBytes: 88 * 32_000 }];
    const p = planRun({ configs: [real('vbee', null, { maxSessionMs: 90_000 })], utteranceEndValues: [1300], items: long, endMode: 'close' });
    expect(p.problems).toEqual([]);
  });

  it('không có cấu hình thật thì không có phút thật', () => {
    const p = planRun({ configs: [fake], utteranceEndValues: [1300], items, endMode: 'utterance-end' });
    expect(p.realMinutes).toBe(0);
    expect(p.realCostUsd).toBe(0);
    expect(p.unpriced).toEqual([]);
  });

  it('danh sách câu rỗng', () => {
    expect(planRun({ configs: [fake], utteranceEndValues: [1300], items: [], endMode: 'close' }).passes[0]?.minutes).toBe(0);
  });
});

describe('utteranceEndProblems', () => {
  const pick = (id: ConfigId): BenchConfig => resolveConfigs([id], { real: true, env: KEY }).runnable[0]!;
  const nova3 = pick('deepgram-nova3');
  const vbee = pick('vbee');
  const fake = pick('fake');
  const cases: [string, BenchConfig, number[], number][] = [
    ['Deepgram 1000 vừa đủ', nova3, [1000], 0],
    ['Deepgram 1300', nova3, [1300], 0],
    ['Deepgram 10000', nova3, [10_000], 0],
    ['Deepgram 999 bị kẹp lên 1000 nên phải chặn', nova3, [999], 1],
    ['Deepgram 800', nova3, [800], 1],
    ['Deepgram 10001', nova3, [10_001], 1],
    ['Deepgram quét ba giá trị, một sai', nova3, [800, 1300, 1500], 1],
    ['Vbee 500 vừa đủ', vbee, [500], 0],
    ['Vbee 3000 vừa đủ', vbee, [3000], 0],
    ['Vbee 499', vbee, [499], 1],
    ['Vbee 3001', vbee, [3001], 1],
    ['Vbee 1300', vbee, [1300], 0],
    ['bản giả nhận mọi giá trị hợp lý', fake, [1, 800, 5000], 0],
  ];
  it.each(cases)('%s', (_name, config, values, count) => {
    expect(utteranceEndProblems([config], values)).toHaveLength(count);
  });

  it('thông báo nêu cấu hình, giá trị và khoảng nhận', () => {
    expect(utteranceEndProblems([nova3], [800])[0]).toBe('deepgram-nova3: utterance_end_ms 800 ngoài khoảng 1000 đến 10000 mà nhà cung cấp nhận');
  });

  it('nhiều cấu hình thì báo riêng từng cái', () => {
    expect(utteranceEndProblems([nova3, vbee], [400])).toHaveLength(2);
  });
});

describe('keytermUsage', () => {
  it('ít tên thì gửi hết', () => {
    expect(keytermUsage(['Tuấn', 'Phương', 'Kinh doanh'])).toEqual({ total: 3, sent: 3 });
  });
  it('rỗng', () => {
    expect(keytermUsage([])).toEqual({ total: 0, sent: 0 });
  });
  it('quá trần 500 token thì chỉ gửi một phần và báo thiếu', () => {
    const many = Array.from({ length: 400 }, (_, i) => `Nguyễn Văn Tên ${i}`);
    const r = keytermUsage(many);
    expect(r.total).toBe(400);
    expect(r.sent).toBeGreaterThan(10);
    expect(r.sent).toBeLessThan(400);
  });
  it('tên trùng chỉ tính một', () => {
    expect(keytermUsage(['Tuấn', 'tuấn', 'TUẤN']).sent).toBe(1);
  });
});
