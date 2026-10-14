import type { WsServerFrame } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { INITIAL_ASSISTANT_STATE, reduceAssistant, type AssistantEffect, type AssistantEvent, type AssistantState } from '../src/scribe/machine';

/**
 * Chế độ trò chuyện (docs/DECISIONS.md, 04/10/2026, đổi SPEC 6.5 điều 10): bấm micro một lần, trợ lý nghe liên tục, ngừng nói thì
 * tự trả lời, đọc xong thì nghe tiếp. Máy trạng thái là hàm thuần nên ở đây kiểm đúng chỗ liên quan an toàn: vòng chỉ chạy khi
 * nên chạy, dừng đúng lúc, không bao giờ chạy lượt `confirm`.
 */
const PROPOSAL = '0199c000-0000-7000-8000-00000000cccc';

type Step = AssistantEvent | WsServerFrame;
const FRAME_TYPES = new Set(['ready', 'status', 'transcript.partial', 'transcript.final', 'assistant.delta', 'assistant.done', 'audio.start', 'audio.end', 'proposal.created', 'choices', 'error']);
const isFrame = (e: { type: string }): e is WsServerFrame => FRAME_TYPES.has(e.type);

function run(steps: Step[], from: AssistantState = INITIAL_ASSISTANT_STATE) {
  let state = from;
  const effects: AssistantEffect[] = [];
  const after: { state: AssistantState; effects: AssistantEffect[] }[] = [];
  for (const step of steps) {
    const event: AssistantEvent = isFrame(step) ? { type: 'frame', frame: step } : (step as AssistantEvent);
    const r = reduceAssistant(state, event);
    state = r.state;
    effects.push(...r.effects);
    after.push({ state, effects: r.effects });
  }
  return { state, effects, after, count: (type: AssistantEffect['type']) => effects.filter((e) => e.type === type).length };
}

const status = (phase: 'listening' | 'thinking' | 'speaking' | 'idle'): WsServerFrame => ({ type: 'status', phase });
const partial = (text: string): WsServerFrame => ({ type: 'transcript.partial', turnId: 't1', text });
const final = (text: string, confidence = 0.95): WsServerFrame => ({ type: 'transcript.final', turnId: 't1', text, confidence });
const done = (text: string): WsServerFrame => ({ type: 'assistant.done', turnId: 't1', text });

/** Từ lúc bấm micro tới khi trợ lý trả lời xong bằng chữ (chưa có tiếng). */
const ASK: Step[] = [
  { type: 'voice_on' },
  { type: 'connecting' },
  { type: 'ready', sessionId: PROPOSAL, conversationId: PROPOSAL, quotaLeft: 200 },
  { type: 'mic_started', mode: 'dictation' },
  status('listening'),
  partial('tình hình'),
  partial('tình hình đón đoàn Nhật'),
  // máy chủ tự chốt khi người nói ngừng: không có `mic_stopped` vì người dùng không bấm gì
  final('tình hình đón đoàn Nhật'),
  status('thinking'),
  { type: 'assistant.delta', turnId: 't1', text: 'Dạ, thưa Chủ tịch. ' },
  done('Dạ, thưa Chủ tịch. Lượt đang chậm 2 ngày.'),
];

const SPOKEN: Step[] = [status('speaking'), { type: 'audio.start', turnId: 't1', format: 'mp3' }, { type: 'audio.end', turnId: 't1' }, status('idle')];

describe('vòng trò chuyện: trả lời xong thì nghe tiếp', () => {
  it('có tiếng: chỉ nghe tiếp SAU KHI đọc xong, không phải lúc máy chủ báo rảnh (app còn đang đọc)', () => {
    const r = run([...ASK, ...SPOKEN]);
    expect(r.state.phase).toBe('speaking');
    expect(r.count('listen_again')).toBe(0);

    const ended = run([...ASK, ...SPOKEN, { type: 'playback_ended' }]);
    expect(ended.state.phase).toBe('idle');
    expect(ended.count('listen_again')).toBe(1);
    expect(ended.effects.at(-1)).toEqual({ type: 'listen_again' });
    expect(ended.state.voice).toBe(true);
  });

  it('chỉ có chữ (TTS tắt): máy chủ báo rảnh thì nghe tiếp ngay', () => {
    const r = run([...ASK, status('idle')]);
    expect(r.count('listen_again')).toBe(1);
  });

  it('đọc hỏng nhưng vẫn có chữ (chỉ báo "chưa đọc thành tiếng được") thì vẫn nghe tiếp', () => {
    const r = run([...ASK, ...SPOKEN, { type: 'playback_failed', spoken: false }]);
    expect(r.state.notice).toBe('text_only');
    expect(r.count('listen_again')).toBe(1);
  });

  it('khung `status idle` đến muộn khi đã rảnh không mở micro lần hai', () => {
    const r = run([...ASK, ...SPOKEN, { type: 'playback_ended' }, status('idle'), status('idle')]);
    expect(r.count('listen_again')).toBe(1);
  });

  it('không bật chế độ trò chuyện thì không bao giờ tự nghe tiếp (đường bấm-để-nói cũ giữ nguyên)', () => {
    const noVoice = ASK.filter((s) => !('type' in s && s.type === 'voice_on'));
    const r = run([...noVoice, ...SPOKEN, { type: 'playback_ended' }]);
    expect(r.state.voice).toBe(false);
    expect(r.count('listen_again')).toBe(0);
  });

  it('nhiều lượt liên tiếp: mỗi lượt xong đúng một lần nghe tiếp', () => {
    const second: Step[] = [{ type: 'mic_started', mode: 'dictation' }, status('listening'), partial('đi thúc'), final('đi thúc anh Tuấn'), status('thinking'), done('Dạ.'), status('idle')];
    const r = run([...ASK, status('idle'), ...second]);
    expect(r.count('listen_again')).toBe(2);
    expect(r.state.voice).toBe(true);
  });
});

describe('cặp hỏi đáp trước nằm lại trên màn hình trong lúc nghe tiếp', () => {
  const afterReply = run([...ASK, status('idle')]).state;

  it('mic_started ở chế độ trò chuyện giữ câu hỏi và câu trả lời trước, chưa xoá gì', () => {
    const r = run([{ type: 'mic_started', mode: 'dictation' }, status('listening')], afterReply);
    expect(r.state).toMatchObject({ phase: 'listening', heard: 'tình hình đón đoàn Nhật', heardFinal: true, reply: 'Dạ, thưa Chủ tịch. Lượt đang chậm 2 ngày.', replyDone: true });
  });

  it('chữ đầu tiên của lượt mới thay cả câu hỏi lẫn câu trả lời cũ, và xoá danh sách chọn cũ', () => {
    const withChoices = run([{ type: 'choices', turnId: 't1', kind: 'person', options: [{ id: 'u1', label: 'Tuấn', sub: null }] }], afterReply).state;
    expect(withChoices.choices).not.toBeNull();
    const r = run([{ type: 'mic_started', mode: 'dictation' }, status('listening'), partial('anh')], withChoices);
    expect(r.state).toMatchObject({ heard: 'anh', heardFinal: false, reply: '', replyDone: false, choices: null });
  });

  it('ngoài chế độ trò chuyện, mic_started vẫn xoá sạch như cũ', () => {
    const plain = run([{ type: 'mic_started', mode: 'dictation' }], { ...afterReply, voice: false }).state;
    expect(plain).toMatchObject({ heard: '', reply: '', heardFinal: false });
  });
});

describe('vòng dừng đúng lúc', () => {
  it('có đề xuất: dừng vòng, mở M3, KHÔNG nghe tiếp (xác nhận là việc của người dùng ở M3)', () => {
    const r = run([...ASK.slice(0, 8), status('thinking'), { type: 'proposal.created', proposalId: PROPOSAL, batchId: null, risk: 1, itemCount: 1 }, done('Dạ, trợ lý hiểu như sau.'), ...SPOKEN, { type: 'playback_ended' }]);
    expect(r.state.voice).toBe(false);
    expect(r.count('open_review')).toBe(1);
    expect(r.count('listen_again')).toBe(0);
  });

  it.each([
    ['STT lỗi', { type: 'error', code: 'stt_unavailable', retryable: true } as WsServerFrame],
    ['LLM lỗi', { type: 'error', code: 'llm_unavailable', retryable: true } as WsServerFrame],
    ['tổ chức tắt AI', { type: 'error', code: 'ai_disabled', retryable: false } as WsServerFrame],
    ['hết lượt trong ngày', { type: 'error', code: 'quota_exceeded', retryable: false } as WsServerFrame],
  ])('%s: tắt chế độ trò chuyện và hiện lời báo, không nghe tiếp', (_name, frame) => {
    const r = run([...ASK.slice(0, 5), frame, status('idle')]);
    expect(r.state.voice).toBe(false);
    expect(r.state.notice).not.toBeNull();
    expect(r.count('listen_again')).toBe(0);
  });

  it('phiên bị đóng (mất mạng, hết thời hạn): tắt chế độ trò chuyện', () => {
    const r = run([...ASK.slice(0, 5), { type: 'closed', reason: 'network' }]);
    expect(r.state.voice).toBe(false);
    expect(r.count('listen_again')).toBe(0);
  });

  it('không mở được micro hoặc không mở được phiên: tắt chế độ trò chuyện', () => {
    expect(run([{ type: 'voice_on' }, { type: 'mic_failed', reason: 'denied' }]).state).toMatchObject({ voice: false, notice: 'mic_denied' });
    expect(run([{ type: 'voice_on' }, { type: 'mic_failed', reason: 'unsupported' }]).state).toMatchObject({ voice: false, notice: 'mic_unsupported' });
    expect(run([{ type: 'voice_on' }, { type: 'connecting' }, { type: 'connect_failed', reason: 'resting' }]).state).toMatchObject({ voice: false, notice: 'resting' });
  });

  it('nghe không rõ hai lần liên tiếp: tắt chế độ trò chuyện, mời gõ chữ (một lần thì vẫn nghe tiếp)', () => {
    const unclear: Step[] = [{ type: 'mic_started', mode: 'dictation' }, status('listening'), final('', 0), done('Dạ, trợ lý nghe chưa rõ.'), status('idle')];
    const once = run([{ type: 'voice_on' }, ...unclear]);
    expect(once.state.voice).toBe(true);
    expect(once.count('listen_again')).toBe(1);
    const twice = run([{ type: 'voice_on' }, ...unclear, ...unclear]);
    expect(twice.state).toMatchObject({ voice: false, notice: 'unclear_twice', typingOpen: true });
    expect(twice.count('listen_again')).toBe(1);
  });

  it('người dùng đang gõ chữ thì không mở micro', () => {
    const r = run([{ type: 'typing', open: true }, ...ASK.slice(0, 5), done('Dạ.'), status('idle')], { ...INITIAL_ASSISTANT_STATE, voice: true });
    expect(r.count('listen_again')).toBe(0);
  });

  it('hết thời gian không có tiếng: voice_off lý do `idle` để lại lời báo; bật lại thì lời báo mất', () => {
    const off = run([{ type: 'voice_on' }, { type: 'voice_off', reason: 'idle' }]).state;
    expect(off).toMatchObject({ voice: false, notice: 'voice_idle' });
    expect(run([{ type: 'voice_on' }], off).state).toMatchObject({ voice: true, notice: null });
    // lời báo này chặn vòng nghe tiếp nếu còn sót
    expect(run([{ type: 'voice_off', reason: 'user' }], off).state.notice).toBe('voice_idle');
  });

  it('máy chủ đóng phiên êm khi đang trò chuyện (hết thời gian của một phiên): tắt chế độ và nói rõ "cuộc trò chuyện đã kết thúc"', () => {
    const ended = run([...ASK.slice(0, 5), { type: 'closed', reason: 'idle' }]).state;
    expect(ended).toMatchObject({ voice: false, notice: 'voice_ended' });
    // bấm micro lại thì lời báo mất và trò chuyện bắt đầu lại
    expect(run([{ type: 'voice_on' }], ended).state).toMatchObject({ voice: true, notice: null });
    // không đang trò chuyện, hoặc do chính app đóng (khoá app, rời màn hình): không có lời báo này
    expect(run([{ type: 'closed', reason: 'idle' }]).state.notice).toBeNull();
    expect(run([...ASK.slice(0, 5), { type: 'closed', reason: 'client' }]).state.notice).toBeNull();
    // lời báo này chặn vòng nghe tiếp nếu còn sót
    expect(run([status('idle')], { ...INITIAL_ASSISTANT_STATE, voice: true, phase: 'thinking', notice: 'voice_ended' }).count('listen_again')).toBe(0);
  });

  it('người dùng bấm dừng (voice_off) rồi ngắt lượt: không có listen_again nào', () => {
    const r = run([...ASK.slice(0, 5), { type: 'voice_off', reason: 'user' }, { type: 'interrupted' }, status('idle')]);
    expect(r.state.voice).toBe(false);
    expect(r.count('listen_again')).toBe(0);
  });

  it('ngắt lời khi vẫn đang trò chuyện (bấm Ngắt lời): máy trạng thái không tự mở micro, lớp điều khiển tự quyết', () => {
    const r = run([...ASK.slice(0, 9), ...SPOKEN.slice(0, 3), { type: 'interrupted' }], undefined);
    expect(r.state.voice).toBe(true);
    expect(r.state.phase).toBe('idle');
    expect(r.count('listen_again')).toBe(0);
  });
});

describe('chế độ trò chuyện không bao giờ chạy lượt xác nhận', () => {
  it('lượt `confirm` (bấm micro ở M3) xong thì không tự nghe tiếp, kể cả khi cờ trò chuyện còn bật', () => {
    const r = run(
      [{ type: 'mic_started', mode: 'confirm' }, status('listening'), final('đồng ý'), status('idle')],
      { ...INITIAL_ASSISTANT_STATE, voice: true },
    );
    expect(r.state.transcript?.text).toBe('đồng ý');
    expect(r.count('listen_again')).toBe(0);
  });
});
