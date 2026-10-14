import type { WsServerFrame } from '@mihato/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lớp điều khiển trợ lý ở chế độ trò chuyện: những điều liên quan an toàn mà máy trạng thái thuần không thấy được, vì chúng
 * nằm ở chỗ bất đồng bộ giữa "bấm" và "micro thật sự mở". Micro, máy khách WebSocket, loa và kho lưu là bản giả; lớp điều
 * khiển và máy trạng thái là bản thật.
 *
 * Lỗi đã gặp khi thử trên trình duyệt (04/10/2026): cú chạm dừng bị cờ `busy` nuốt lúc app đang mở micro hoặc mở phiên, nên
 * micro vẫn mở dù người dùng đã bấm dừng. Các test dưới đây giữ cho lỗi đó không quay lại.
 */
const h = vi.hoisted(() => ({
  mic: {
    holdStart: false,
    startCalls: 0,
    stopCalls: 0,
    pendingStart: null as { resolve: () => void; reject: (e: unknown) => void } | null,
  },
  client: {
    holdReady: false,
    pendingReady: null as { resolve: () => void; reject: (e: unknown) => void } | null,
    startTurns: [] as string[],
    interrupts: 0,
    onEvent: null as ((event: unknown) => void) | null,
    instance: null as { state: string } | null,
  },
  keepAwake: new Set<string>(),
  consentStored: '2' as string | null,
  apiCalls: [] as Array<{ route: string; body: unknown }>,
  createSession: null as null | (() => Promise<unknown>),
}));

vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: async (tag: string) => void h.keepAwake.add(tag),
  deactivateKeepAwake: async (tag: string) => void h.keepAwake.delete(tag),
}));
vi.mock('../src/config', () => ({ APP_VERSION: 'test' }));
vi.mock('../src/session/kv', () => ({ KV_KEYS: { assistantConsent: 'consent' } }));
vi.mock('../src/session/secure-kv', () => ({ secureKV: { get: async () => h.consentStored, set: async () => undefined } }));
vi.mock('../src/services', () => ({
  api: {
    call: async (route: string, input?: { body?: unknown }) => {
      h.apiCalls.push({ route, body: input?.body });
      return route === 'scribe.createSession' ? { wsUrl: 'ws://test', token: 't' } : {};
    },
  },
  localProfile: { getSnapshot: () => ({ address: 'Chủ tịch' }) },
  session: { subscribe: () => () => undefined, getSnapshot: () => ({ status: 'unlocked' }), noteActivity: () => undefined },
}));
vi.mock('../src/scribe/player', () => ({ playMp3Bytes: () => ({ finished: new Promise<boolean>(() => undefined), stop: () => undefined }) }));
vi.mock('../src/scribe/speech', () => ({ speakWithDevice: async () => true, stopDeviceSpeech: () => undefined }));
vi.mock('../src/scribe/mic', () => {
  class MicError extends Error {
    constructor(readonly reason: string) {
      super(`mic_${reason}`);
    }
  }
  return {
    MicError,
    micSupported: () => true,
    createMicSource: () => ({
      start: () => {
        h.mic.startCalls++;
        if (!h.mic.holdStart) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          h.mic.pendingStart = { resolve, reject };
        });
      },
      stop: () => {
        h.mic.stopCalls++;
        return Promise.resolve();
      },
    }),
  };
});
vi.mock('../src/scribe/client', () => {
  class ScribeConnectError extends Error {
    constructor(
      readonly reason: string,
      readonly code: number,
    ) {
      super(`scribe_connect_failed:${reason}`);
    }
  }
  class ScribeClient {
    state = 'closed';
    constructor(opts: { onEvent: (event: unknown) => void; createSession: () => Promise<unknown> }) {
      h.client.onEvent = opts.onEvent;
      h.createSession = opts.createSession;
      h.client.instance = this;
    }
    ensureReady(): Promise<void> {
      if (!h.client.holdReady) {
        this.state = 'ready';
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        h.client.pendingReady = {
          resolve: () => {
            this.state = 'ready';
            resolve();
          },
          reject,
        };
      });
    }
    startTurn(mode: string): boolean {
      h.client.startTurns.push(mode);
      return true;
    }
    endTurn(): boolean {
      return true;
    }
    interrupt(): boolean {
      h.client.interrupts++;
      return true;
    }
    sendAudio(): boolean {
      return true;
    }
    sendText(): boolean {
      return true;
    }
    markTurnClosed(): void {}
    close(): void {
      this.state = 'closed';
    }
  }
  return { ScribeClient, ScribeConnectError };
});

// Nạp sau khi đã khai báo bản giả (vi.mock được kéo lên đầu tệp).
const { assistant } = await import('../src/scribe/assistant');

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const server = (frame: WsServerFrame) => h.client.onEvent?.({ type: 'frame', frame });
const snap = () => assistant.getSnapshot();

/** Máy chủ chốt lượt, trả lời bằng chữ rồi báo rảnh. */
function replyAndIdle() {
  server({ type: 'status', phase: 'listening' });
  server({ type: 'transcript.partial', turnId: 't1', text: 'tình hình' });
  server({ type: 'transcript.final', turnId: 't1', text: 'tình hình đón đoàn Nhật', confidence: 0.95 });
  server({ type: 'status', phase: 'thinking' });
  server({ type: 'assistant.done', turnId: 't1', text: 'Dạ, thưa Chủ tịch.' });
  server({ type: 'status', phase: 'idle' });
}

afterEach(async () => {
  // Một ca đỏ giữa chừng không được để lại việc mở micro hoặc mở phiên còn treo: nó giữ cờ `busy` của bộ điều khiển (dùng chung
  // cho cả tệp) và làm các ca sau đỏ theo, che mất ca nào mới là ca hỏng thật.
  h.mic.pendingStart?.resolve();
  h.client.pendingReady?.resolve();
  await flush();
});

beforeEach(() => {
  h.mic.holdStart = false;
  h.mic.startCalls = 0;
  h.mic.stopCalls = 0;
  h.mic.pendingStart = null;
  h.client.holdReady = false;
  h.client.pendingReady = null;
  h.client.startTurns = [];
  h.client.interrupts = 0;
  h.keepAwake.clear();
  assistant.shutdown();
});

describe('bấm micro ở chế độ trò chuyện', () => {
  it('một lần bấm: bật chế độ, mở micro, gửi start_turn, giữ màn hình sáng', async () => {
    await assistant.pressMic();
    expect(snap()).toMatchObject({ voice: true, phase: 'listening' });
    expect(h.client.startTurns).toEqual(['dictation']);
    expect(h.mic.startCalls).toBe(1);
    expect([...h.keepAwake]).toEqual(['mihato-assistant-voice']);
  });

  it('bấm lần hai là dừng: tắt chế độ, đóng micro, báo máy chủ ngắt lượt, thả màn hình', async () => {
    await assistant.pressMic();
    await assistant.pressMic();
    expect(snap()).toMatchObject({ voice: false, phase: 'idle' });
    expect(h.mic.stopCalls).toBeGreaterThanOrEqual(1);
    expect(h.client.interrupts).toBe(1);
    expect(h.keepAwake.size).toBe(0);
  });
});

describe('dừng luôn có tác dụng, kể cả lúc micro hoặc phiên đang mở dở', () => {
  it('bấm dừng lúc micro đang mở dở: micro mở xong muộn bị đóng ngay, không có lượt nào bắt đầu', async () => {
    h.mic.holdStart = true;
    const first = assistant.pressMic();
    await flush();
    expect(snap().voice).toBe(true);
    expect(h.mic.startCalls).toBe(1);

    await assistant.pressMic(); // cú chạm dừng trong lúc cờ `busy` còn đang giữ
    expect(snap().voice).toBe(false);

    h.mic.pendingStart?.resolve(); // micro mở xong muộn
    await first;
    await flush();
    expect(h.mic.stopCalls).toBeGreaterThanOrEqual(1);
    expect(h.client.startTurns).toEqual([]);
    expect(snap().phase).not.toBe('listening');
    expect(h.keepAwake.size).toBe(0);
  });

  it('bấm dừng lúc phiên đang mở dở: phiên mở xong thì micro cũng không mở', async () => {
    h.client.holdReady = true;
    const first = assistant.pressMic();
    await flush();
    expect(snap()).toMatchObject({ voice: true, phase: 'connecting' });

    await assistant.pressMic();
    expect(snap().voice).toBe(false);

    h.client.pendingReady?.resolve();
    await first;
    await flush();
    expect(h.mic.startCalls).toBe(0);
    expect(h.client.startTurns).toEqual([]);
  });

  it('vòng tự nghe tiếp mở micro lần hai; bấm dừng đúng lúc đó vẫn có tác dụng', async () => {
    await assistant.pressMic();
    expect(h.client.startTurns).toEqual(['dictation']);

    h.mic.holdStart = true; // lần mở micro kế tiếp sẽ bị giữ dở
    replyAndIdle(); // máy trạng thái yêu cầu nghe tiếp; lớp điều khiển bắt đầu mở micro
    await flush();
    expect(h.mic.startCalls).toBe(2);
    expect(snap().voice).toBe(true);

    await assistant.pressMic(); // dừng trong lúc vòng đang mở micro
    expect(snap().voice).toBe(false);

    h.mic.pendingStart?.resolve();
    await flush();
    expect(h.client.startTurns).toEqual(['dictation']); // không có start_turn thứ hai
    expect(h.mic.stopCalls).toBeGreaterThanOrEqual(2);
    expect(snap().phase).not.toBe('listening');
  });

  it('rời màn hình lúc micro đang mở dở: micro không mở nốt, chế độ tắt', async () => {
    h.mic.holdStart = true;
    const first = assistant.pressMic();
    await flush();
    assistant.leaveScreen();
    expect(snap().voice).toBe(false);

    h.mic.pendingStart?.resolve();
    await first;
    await flush();
    expect(h.client.startTurns).toEqual([]);
    expect(h.mic.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it('khoá app hoặc xuống nền lúc micro đang mở dở: micro không mở nốt, thả màn hình', async () => {
    h.mic.holdStart = true;
    const first = assistant.pressMic();
    await flush();
    expect(h.keepAwake.size).toBe(1);
    assistant.shutdown();
    expect(h.keepAwake.size).toBe(0);

    h.mic.pendingStart?.resolve();
    await first;
    await flush();
    expect(h.client.startTurns).toEqual([]);
    expect(snap()).toMatchObject({ voice: false, phase: 'idle' });
  });
});

describe('vòng nghe tiếp và các chốt chặn', () => {
  it('lượt xong thì tự mở micro nghe tiếp, không cần bấm', async () => {
    await assistant.pressMic();
    replyAndIdle();
    await flush();
    expect(h.client.startTurns).toEqual(['dictation', 'dictation']);
    expect(snap()).toMatchObject({ voice: true, phase: 'listening' });
  });

  it('có đề xuất thì dừng vòng: không nghe tiếp, thả màn hình', async () => {
    await assistant.pressMic();
    server({ type: 'status', phase: 'listening' });
    server({ type: 'transcript.final', turnId: 't1', text: 'đi thúc anh Tuấn', confidence: 0.95 });
    server({ type: 'status', phase: 'thinking' });
    server({ type: 'proposal.created', proposalId: '0199c000-0000-7000-8000-00000000cccc', batchId: null, risk: 1, itemCount: 1 });
    server({ type: 'assistant.done', turnId: 't1', text: 'Dạ, trợ lý hiểu như sau.' });
    server({ type: 'status', phase: 'idle' });
    await flush();
    expect(h.client.startTurns).toEqual(['dictation']);
    expect(snap().voice).toBe(false);
    expect(h.keepAwake.size).toBe(0);
  });

  it('chốt chặn: ba lượt liên tiếp kết thúc ngay mà chưa nghe được chữ nào thì dừng và báo sự cố, không quay vòng mãi', async () => {
    await assistant.pressMic();
    for (let i = 0; i < 6; i++) {
      server({ type: 'status', phase: 'idle' }); // máy chủ chốt lượt ngay, không có chữ nào
      await flush();
    }
    expect(h.client.startTurns.length).toBe(3);
    expect(snap()).toMatchObject({ voice: false, notice: 'stt_failed' });
    expect(h.keepAwake.size).toBe(0);
  });

  it('nghe được chữ rồi thì lượt kết thúc nhanh vẫn không bị tính là sự cố', async () => {
    await assistant.pressMic();
    for (let i = 0; i < 5; i++) {
      server({ type: 'status', phase: 'listening' });
      server({ type: 'transcript.partial', turnId: 't1', text: 'ừ' });
      server({ type: 'status', phase: 'idle' });
      await flush();
    }
    expect(h.client.startTurns.length).toBe(6);
    expect(snap().voice).toBe(true);
  });
});

describe('đồng ý lưu bản chép khi mở phiên (rà soát 07/10/2026, exec-3)', () => {
  const sessionBody = async () => {
    h.apiCalls.length = 0;
    await h.createSession?.();
    const call = h.apiCalls.find((c) => c.route === 'scribe.createSession');
    return call?.body as { channel: string; transcriptConsent: boolean };
  };

  it('chưa từng bấm đồng ý, hoặc mới đồng ý bản cũ: phiên mở với transcriptConsent=false', async () => {
    h.consentStored = null;
    await assistant.loadConsent();
    expect((await sessionBody()).transcriptConsent).toBe(false);
    h.consentStored = '1';
    await assistant.loadConsent();
    expect((await sessionBody()).transcriptConsent).toBe(false);
  });

  it('đã đồng ý bản hiện hành, hoặc vừa bấm "Tôi đồng ý": transcriptConsent=true', async () => {
    h.consentStored = '2';
    await assistant.loadConsent();
    expect((await sessionBody()).transcriptConsent).toBe(true);
    h.consentStored = null;
    await assistant.loadConsent();
    expect((await sessionBody()).transcriptConsent).toBe(false);
    await assistant.agree();
    expect((await sessionBody()).transcriptConsent).toBe(true);
  });
});
