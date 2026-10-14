/**
 * Kiểm phần ghép nối của ba bản thật mà KHÔNG gọi nhà cung cấp trả phí (CLAUDE.md luật 10):
 * Deepgram chạy với một máy chủ WebSocket cục bộ, Vbee với `fetch` giả, Anthropic với client giả.
 * Các test này chỉ chứng minh mã gửi đúng điều SPEC đã ghi; chúng không chứng minh nhà cung cấp thật chấp nhận.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  AnthropicLlm,
  buildDeepgramUrl,
  buildVbeeBody,
  DeepgramStt,
  limitKeyterms,
  readVbeeBatch,
  VbeeTts,
  type LlmEvent,
  type LlmToolDef,
  type SttEvent,
  type SttOpenOptions,
} from '../src';

// ───────────────────────── Deepgram ─────────────────────────

describe('DeepgramStt', () => {
  let wss: WebSocketServer | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    wss = undefined;
  });

  it('địa chỉ đúng tham số đã xác minh, không gửi smart_format', () => {
    const url = new URL(buildDeepgramUrl({ language: 'vi', sampleRate: 16000, keyterms: ['Bùi Quốc Tuấn', 'Kinh doanh', 'bùi quốc tuấn', ' '], utteranceEndMs: 1300 }, { useKeyterms: true }));
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen');
    const q = url.searchParams;
    expect(q.get('model')).toBe('nova-3');
    expect(q.get('language')).toBe('vi');
    expect(q.get('encoding')).toBe('linear16');
    expect(q.get('sample_rate')).toBe('16000');
    expect(q.get('interim_results')).toBe('true');
    expect(q.get('utterance_end_ms')).toBe('1300');
    expect(q.get('mip_opt_out')).toBe('true');
    expect(q.getAll('keyterm')).toEqual(['Bùi Quốc Tuấn', 'Kinh doanh']);
    expect(q.has('smart_format')).toBe(false);
    expect(q.has('numerals')).toBe(false);
    expect(q.has('detect_language')).toBe(false);
  });

  it('mặc định KHÔNG gửi keyterm: đo thật ngày 04/10/2026, từ 3 từ khoá trở lên thì Deepgram tiếng Việt trả rỗng mọi câu', () => {
    const o: SttOpenOptions = { language: 'vi', sampleRate: 16000, keyterms: ['Tuấn', 'Minh', 'Lan'], utteranceEndMs: 1300 };
    expect(new URL(buildDeepgramUrl(o)).searchParams.has('keyterm')).toBe(false);
    expect(new URL(buildDeepgramUrl(o, { useKeyterms: false })).searchParams.has('keyterm')).toBe(false);
    expect(new URL(buildDeepgramUrl(o, { useKeyterms: true })).searchParams.getAll('keyterm')).toEqual(['Tuấn', 'Minh', 'Lan']);
  });

  it('utterance_end_ms không xuống dưới 1000 và keyterm dừng ở trần token', () => {
    const url = new URL(buildDeepgramUrl({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 300 }));
    expect(url.searchParams.get('utterance_end_ms')).toBe('1000');
    const many = Array.from({ length: 400 }, (_, i) => `Nguyễn Văn Tên ${i}`);
    const kept = limitKeyterms(many, 500);
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(many.length);
    expect(kept.reduce((n, t) => n + Math.ceil(t.length / 2), 0)).toBeLessThanOrEqual(500);
  });

  it('gửi header Token, âm thanh nhị phân, KeepAlive và CloseStream dạng văn bản; đọc Results và UtteranceEnd', async () => {
    const seen: { auth?: string; url?: string; text: string[]; binaryBytes: number } = { text: [], binaryBytes: 0 };
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (socket, req) => {
      seen.auth = req.headers.authorization;
      seen.url = req.url;
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          seen.binaryBytes += (data as Buffer).byteLength;
          socket.send(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'đi thúc', confidence: 0.5 }] } }));
          return;
        }
        const msg = JSON.parse(String(data)) as { type: string };
        seen.text.push(msg.type);
        if (msg.type === 'CloseStream') {
          socket.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'đi thúc anh Tuấn', confidence: 0.91 }] } }));
          socket.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: '', confidence: 0 }] } }));
          socket.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 1.2 }));
          socket.send(JSON.stringify({ type: 'Metadata' }));
          socket.close(1000);
        }
      });
    });
    await new Promise<void>((resolve) => wss?.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;

    // prerollMs 0: máy chủ giả trả lời mỗi khung âm thanh, nên đoạn im lặng chèn đầu phiên sẽ lẫn vào kết quả cần so.
    const stt = new DeepgramStt({ apiKey: 'khoa-thu', baseUrl: `ws://127.0.0.1:${port}/v1/listen`, prerollMs: 0, useKeyterms: true });
    const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: ['Tuấn'], utteranceEndMs: 1300 });
    const events: SttEvent[] = [];
    for (const name of ['interim', 'final', 'utteranceEnd', 'error'] as const) session.on(name, (e) => events.push(e));
    session.sendAudio(new Uint8Array(3200));
    session.keepAlive();
    await session.close();

    expect(seen.auth).toBe('Token khoa-thu');
    expect(seen.url).toContain('model=nova-3');
    expect(seen.url).toContain('keyterm=Tu%E1%BA%A5n');
    expect(seen.binaryBytes).toBe(3200);
    expect(seen.text).toEqual(['KeepAlive', 'CloseStream']);
    expect(events).toEqual([
      { type: 'interim', text: 'đi thúc' },
      { type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.91 },
      { type: 'utteranceEnd' },
    ]);
  });

  /** Máy chủ giả chỉ ghi lại độ dài và nội dung từng khung nhị phân nhận được. */
  async function recordingServer(): Promise<{ port: number; frames: Buffer[]; waitFor: (count: number) => Promise<void> }> {
    const frames: Buffer[] = [];
    const waiters: { count: number; resolve: () => void }[] = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          // CloseStream: đóng ngay như Deepgram, để `session.close()` không phải chờ hết thời hạn.
          if ((JSON.parse(String(data)) as { type?: string }).type === 'CloseStream') socket.close(1000);
          return;
        }
        frames.push(data as Buffer);
        for (const w of waiters.filter((x) => frames.length >= x.count)) w.resolve();
      });
    });
    await new Promise<void>((resolve) => wss?.once('listening', () => resolve()));
    return {
      port: (wss.address() as AddressInfo).port,
      frames,
      waitFor: (count) => (frames.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }))),
    };
  }

  it('chèn im lặng 400 ms vào đầu phiên rồi mới tới âm thanh thật (đo thật: nói ngay ở giây 0 thì câu đầu bị trả rỗng)', async () => {
    const server = await recordingServer();
    const session = await new DeepgramStt({ apiKey: 'k', baseUrl: `ws://127.0.0.1:${server.port}` }).open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
    session.sendAudio(new Uint8Array(1920).fill(7));
    await server.waitFor(5);
    // 400 ms ở 16 kHz, 16-bit là 12.800 byte, gửi thành bốn khối 100 ms toàn số 0.
    expect(server.frames.slice(0, 4).map((f) => f.byteLength)).toEqual([3200, 3200, 3200, 3200]);
    expect(server.frames.slice(0, 4).every((f) => f.every((byte) => byte === 0))).toBe(true);
    expect(server.frames[4]?.byteLength).toBe(1920);
    expect(server.frames[4]?.every((byte) => byte === 7)).toBe(true);
    await session.close();
  });

  it('prerollMs đổi được; 0 là không chèn gì; không chia hết 100 thì làm tròn lên theo khối 100 ms', async () => {
    const off = await recordingServer();
    const none = await new DeepgramStt({ apiKey: 'k', baseUrl: `ws://127.0.0.1:${off.port}`, prerollMs: 0 }).open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
    none.sendAudio(new Uint8Array(640).fill(1));
    await off.waitFor(1);
    expect(off.frames.map((f) => f.byteLength)).toEqual([640]);
    await none.close();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    wss = undefined;

    const some = await recordingServer();
    const rounded = await new DeepgramStt({ apiKey: 'k', baseUrl: `ws://127.0.0.1:${some.port}`, prerollMs: 250 }).open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
    await some.waitFor(3);
    expect(some.frames.map((f) => f.byteLength)).toEqual([3200, 3200, 3200]);
    await rounded.close();
  });

  it('máy chủ đóng ngoài ý muốn thì phát sự kiện lỗi chỉ có mã', async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (socket) => socket.close(1011));
    await new Promise<void>((resolve) => wss?.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    const session = await new DeepgramStt({ apiKey: 'k', baseUrl: `ws://127.0.0.1:${port}` }).open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
    const error = await new Promise<SttEvent>((resolve) => session.on('error', resolve));
    expect(error).toEqual({ type: 'error', code: 'stt_closed_1011', retryable: true });
    await session.close();
  });

  it('không nối được thì open() báo lỗi không kèm địa chỉ', async () => {
    const stt = new DeepgramStt({ apiKey: 'k', baseUrl: 'ws://127.0.0.1:1', openTimeoutMs: 500 });
    await expect(stt.open({ language: 'vi', sampleRate: 16000, keyterms: ['Tên Riêng'], utteranceEndMs: 1300 })).rejects.toThrow(/^stt_open_failed$/);
  });

  it('thiếu khoá thì không dựng', () => {
    expect(() => new DeepgramStt({ apiKey: '' })).toThrow(/DEEPGRAM_API_KEY/);
  });
});

// ───────────────────────── Vbee ─────────────────────────

describe('VbeeTts', () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

  function fakeFetch(responses: (() => Response)[]): { fetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const next = responses.shift();
      if (!next) throw new Error('không còn phản hồi giả');
      return next();
    };
    return { fetch: impl as typeof fetch, calls };
  }

  it('sync: POST /v1/tts với Bearer và App-Id, mode sync, trả âm thanh theo khối', async () => {
    const audio = new Uint8Array([0xff, 0xfb, 1, 2, 3]);
    const { fetch: f, calls } = fakeFetch([() => new Response(audio)]);
    const tts = new VbeeTts({ appId: 'app-1', token: 'tok-1', fetch: f });
    const chunks: number[] = [];
    for await (const c of tts.synthesize('Dạ thưa Chủ tịch.', { voice: 'giong-bac', speed: 0.9, format: 'mp3' })) chunks.push(...c);
    expect(chunks).toEqual([...audio]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.vbee.vn/v1/tts', method: 'POST', headers: { Authorization: 'Bearer tok-1', 'App-Id': 'app-1' } });
    expect(calls[0]?.body).toMatchObject({ mode: 'sync', text: 'Dạ thưa Chủ tịch.', speed: 0.9 });
  });

  it('sync: quá 300 ký tự bị từ chối trước khi gọi mạng; lỗi HTTP chỉ mang mã', async () => {
    const { fetch: f, calls } = fakeFetch([() => new Response('lỗi', { status: 503 })]);
    const tts = new VbeeTts({ appId: 'a', token: 't', fetch: f });
    const drain = async (text: string) => {
      for await (const _ of tts.synthesize(text, { voice: 'v', speed: 1, format: 'mp3' })) void _;
    };
    await expect(drain('a'.repeat(301))).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
    await expect(drain('xin chào')).rejects.toThrow('tts_http_503');
  });

  it('batch: mode async rồi hỏi lại GET /v1/tts/requests/{requestId}', async () => {
    const { fetch: f, calls } = fakeFetch([
      () => Response.json({ result: { requestId: 'req 1', status: 'IN_PROGRESS' } }),
      () => Response.json({ result: { status: 'IN_PROGRESS' } }),
      () => Response.json({ result: { status: 'SUCCESS', audioLink: 'https://vbee.example/a.mp3' } }),
    ]);
    const tts = new VbeeTts({ appId: 'a', token: 't', fetch: f, pollIntervalMs: 1 });
    const out = await tts.synthesizeBatch('Bản tin sáng.', { voice: 'giong-bac', speed: 0.9 });
    expect(out.url).toBe('https://vbee.example/a.mp3');
    expect(out.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3 * 60_000);
    expect(calls[0]?.body).toMatchObject({ mode: 'async' });
    expect(calls[1]).toMatchObject({ url: 'https://api.vbee.vn/v1/tts/requests/req%201', method: 'GET' });
    expect(calls).toHaveLength(3);
  });

  it('tốc độ bị kẹp trong 0.25 đến 1.9; đọc được vài cách đặt tên trường của phản hồi batch', () => {
    expect(buildVbeeBody('a', { voice: 'v', speed: 5, mode: 'sync', format: 'mp3', sampleRate: 24000 }).speed).toBe(1.9);
    expect(buildVbeeBody('a', { voice: 'v', speed: 0, mode: 'sync', format: 'mp3', sampleRate: 24000 }).speed).toBe(0.25);
    expect(readVbeeBatch({ request_id: 'r', status: 'DONE', audio_link: 'u' })).toEqual({ requestId: 'r', status: 'DONE', audioUrl: 'u' });
    expect(readVbeeBatch(null)).toEqual({ requestId: null, status: null, audioUrl: null });
  });
});

// ───────────────────────── Anthropic ─────────────────────────

describe('AnthropicLlm', () => {
  const tools: LlmToolDef[] = [
    { name: 'search_people', description: 'Tìm người', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, strict: true },
  ];

  type StreamParams = Record<string, unknown>;

  /** Client giả: ghi lại tham số, phát lại các sự kiện SSE đã ghi sẵn. */
  function fakeClient(events: unknown[], final: unknown, opts: { hang?: boolean; fail?: unknown } = {}): { client: Anthropic; seen: { params?: StreamParams } } {
    const seen: { params?: StreamParams } = {};
    const client = {
      messages: {
        stream(params: StreamParams, options?: { signal?: AbortSignal }) {
          seen.params = params;
          return {
            async *[Symbol.asyncIterator]() {
              if (opts.fail !== undefined) throw opts.fail;
              if (opts.hang) {
                await new Promise<void>((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('bị huỷ'))));
              }
              for (const e of events) yield e;
            },
            finalMessage: async () => final,
          };
        },
      },
    };
    return { client: client as unknown as Anthropic, seen };
  }

  async function collect(stream: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
    const out: LlmEvent[] = [];
    for await (const e of stream) out.push(e);
    return out;
  }

  const thinking = { type: 'thinking', thinking: '', signature: 'chu-ky' };
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'search_people', input: { query: 'anh Tuấn' } };

  it('gửi đúng ràng buộc của SPEC 6.3 và chỉ phân tích tham số tool tại content_block_stop', async () => {
    const events = [
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: thinking },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Dạ, ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'để trợ lý xem.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_people', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query": "anh' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' Tuấn"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    const final = {
      stop_reason: 'tool_use',
      content: [thinking, { type: 'text', text: 'Dạ, để trợ lý xem.' }, toolUse],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
    };
    const { client, seen } = fakeClient(events, final);
    const llm = new AnthropicLlm({ client, model: 'claude-sonnet-5-5' });
    const out = await collect(
      llm.stream({
        system: [
          { type: 'text', text: 'TĨNH', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: 'TỔ CHỨC', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: 'LƯỢT' },
        ],
        tools,
        messages: [{ role: 'user', content: 'đi thúc anh Tuấn' }],
        effort: 'low',
      }),
    );

    expect(out).toEqual([
      { type: 'text_delta', text: 'Dạ, ' },
      { type: 'text_delta', text: 'để trợ lý xem.' },
      { type: 'tool_use', id: 'toolu_1', name: 'search_people', input: { query: 'anh Tuấn' } },
      {
        type: 'message_stop',
        stopReason: 'tool_use',
        usage: { inputTokens: 1050, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 },
        raw: { provider: 'anthropic', content: final.content },
      },
    ]);

    const p = seen.params ?? {};
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p.tool_choice).toEqual({ type: 'auto' });
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.tools).toEqual(tools);
    expect(p.cache_control).toEqual({ type: 'ephemeral' });
    // Không đặt tham số lấy mẫu, không tự cấu hình thinking, không bật fallback sang model khác.
    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'fallbacks', 'stop_sequences']) expect(p).not.toHaveProperty(banned);
    // Không prefill: tin nhắn cuối là của người dùng.
    const messages = p.messages as { role: string }[];
    expect(messages.at(-1)?.role).toBe('user');
    // Tối đa 4 điểm cache: hai khối system cộng một điểm tự động.
    const marked = (p.system as { cache_control?: unknown }[]).filter((b) => b.cache_control).length;
    expect(marked + 1).toBeLessThanOrEqual(4);
  });

  it('trả lại nguyên khối của Claude (kể cả thinking) và gom mọi tool_result vào một tin nhắn người dùng', async () => {
    const final = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Dạ.' }], usage: { input_tokens: 1, output_tokens: 1 } };
    const { client, seen } = fakeClient([], final);
    const llm = new AnthropicLlm({ client });
    const rawContent = [thinking, toolUse, { ...toolUse, id: 'toolu_2' }];
    await collect(
      llm.stream({
        system: [],
        tools,
        messages: [
          { role: 'user', content: 'đi thúc anh Tuấn' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_people', input: { query: 'anh Tuấn' } }], raw: { provider: 'anthropic', content: rawContent } },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' },
              { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"ok":false}', is_error: true },
            ],
          },
        ],
        effort: 'medium',
      }),
    );
    const messages = (seen.params?.messages ?? []) as { role: string; content: unknown }[];
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: 'assistant', content: rawContent });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"ok":false}', is_error: true },
      ],
    });
    expect(seen.params?.output_config).toEqual({ effort: 'medium' });
  });

  it('JSON tham số tool hỏng: báo lỗi, không phát tool_use', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'search_people', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query": "anh' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const { client } = fakeClient(events, {});
    const out = await collect(new AnthropicLlm({ client }).stream({ system: [], tools, messages: [{ role: 'user', content: 'a' }], effort: 'low' }));
    expect(out).toEqual([{ type: 'error', code: 'bad_tool_input', retryable: true }]);
  });

  it('bị từ chối (refusal) thì trả stopReason refusal để scribe dùng câu mẫu', async () => {
    const final = { stop_reason: 'refusal', content: [], usage: { input_tokens: 5, output_tokens: 0 } };
    const { client } = fakeClient([], final);
    const out = await collect(new AnthropicLlm({ client }).stream({ system: [], tools, messages: [{ role: 'user', content: 'a' }], effort: 'low' }));
    expect(out.at(-1)).toMatchObject({ type: 'message_stop', stopReason: 'refusal' });
  });

  it('lỗi 400 vì bộ công cụ strict biên dịch ra văn phạm quá lớn có mã riêng `schema_too_large` (gặp thật 04/10/2026: trợ lý hỏng ở mọi câu)', async () => {
    const tooLarge = Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'The compiled grammar is too large, which would cause performance issues.' } }, 'The compiled grammar is too large, which would cause performance issues.', new Headers());
    const llm = new AnthropicLlm({ client: fakeClient([], {}, { fail: tooLarge }).client });
    const out = await collect(llm.stream({ system: [], tools, messages: [{ role: 'user', content: 'a' }], effort: 'low' }));
    expect(out).toEqual([{ type: 'error', code: 'schema_too_large', retryable: false }]);
    // thông điệp cũ của giới hạn tham số cũng được nhận ra
    const tooComplex = Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex for compilation.' } }, 'Schema is too complex for compilation.', new Headers());
    expect(await collect(new AnthropicLlm({ client: fakeClient([], {}, { fail: tooComplex }).client }).stream({ system: [], tools, messages: [{ role: 'user', content: 'a' }], effort: 'low' }))).toEqual([{ type: 'error', code: 'schema_too_large', retryable: false }]);
  });

  it('lỗi 400 khác vẫn là `bad_request`; lỗi 5xx là `unavailable` có thể thử lại', async () => {
    const other = Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too large' } }, 'max_tokens: too large', new Headers());
    expect(await collect(new AnthropicLlm({ client: fakeClient([], {}, { fail: other }).client }).stream({ system: [], tools, messages: [{ role: 'user', content: 'a' }], effort: 'low' }))).toEqual([{ type: 'error', code: 'bad_request', retryable: false }]);
    const down = Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', new Headers());
    expect(await collect(new AnthropicLlm({ client: fakeClient([], {}, { fail: down }).client }).stream({ system: [], tools, messages: [{ role: 'user', content: 'a' }], effort: 'low' }))).toEqual([{ type: 'error', code: 'unavailable', retryable: true }]);
  });

  it('quá hạn token đầu thì huỷ và báo timeout', async () => {
    const { client } = fakeClient([], {}, { hang: true });
    const llm = new AnthropicLlm({ client, firstTokenTimeoutMs: 30 });
    const out = await collect(llm.stream({ system: [], tools, messages: [{ role: 'user', content: 'a' }], effort: 'low' }));
    expect(out).toEqual([{ type: 'error', code: 'timeout', retryable: true }]);
  });

  it('bên gọi huỷ thì báo aborted', async () => {
    const { client } = fakeClient([], {}, { hang: true });
    const controller = new AbortController();
    const llm = new AnthropicLlm({ client });
    const pending = collect(llm.stream({ system: [], tools, messages: [{ role: 'user', content: 'a' }], effort: 'low', signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toEqual([{ type: 'error', code: 'aborted', retryable: false }]);
  });
});
