import type { WsServerFrame } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { INITIAL_ASSISTANT_STATE, reduceAssistant, type AssistantEffect, type AssistantEvent, type AssistantState } from '../src/scribe/machine';

/** Máy trạng thái của trợ lý (SPEC 6.1, 6.6, 6.10, 6.11, 10.7.2): hàm thuần, chạy từng sự kiện theo thứ tự khung của máy chủ. */
const PROPOSAL = '0199c000-0000-7000-8000-00000000cccc';
const BATCH = '0199c000-0000-7000-8000-00000000dddd';

function run(events: (AssistantEvent | WsServerFrame)[], from: AssistantState = INITIAL_ASSISTANT_STATE) {
  let state = from;
  const effects: AssistantEffect[] = [];
  const phases: string[] = [];
  for (const e of events) {
    const event: AssistantEvent = 'type' in e && isFrame(e) ? { type: 'frame', frame: e } : (e as AssistantEvent);
    const r = reduceAssistant(state, event);
    state = r.state;
    effects.push(...r.effects);
    phases.push(state.phase);
  }
  return { state, effects, phases, types: effects.map((x) => x.type) };
}

const FRAME_TYPES = new Set(['ready', 'status', 'transcript.partial', 'transcript.final', 'assistant.delta', 'assistant.done', 'audio.start', 'audio.end', 'proposal.created', 'choices', 'error']);
const isFrame = (e: { type: string }): e is WsServerFrame => FRAME_TYPES.has(e.type);

const status = (phase: 'listening' | 'thinking' | 'speaking' | 'idle'): WsServerFrame => ({ type: 'status', phase });

describe('một lượt nói trọn vẹn', () => {
  const turn: (AssistantEvent | WsServerFrame)[] = [
    { type: 'connecting' },
    { type: 'ready', sessionId: PROPOSAL, conversationId: PROPOSAL, quotaLeft: 200 },
    { type: 'mic_started', mode: 'dictation' },
    status('listening'),
    { type: 'transcript.partial', turnId: 't1', text: 'tình hình' },
    { type: 'transcript.partial', turnId: 't1', text: 'tình hình đón đoàn' },
    { type: 'mic_stopped' },
    { type: 'transcript.final', turnId: 't1', text: 'tình hình đón đoàn Nhật', confidence: 0.95 },
    status('thinking'),
    { type: 'assistant.delta', turnId: 't1', text: 'Dạ, thưa Chủ tịch. ' },
    { type: 'assistant.delta', turnId: 't1', text: 'Lượt đang chậm 2 ngày.' },
    { type: 'assistant.done', turnId: 't1', text: 'Dạ, thưa Chủ tịch. Lượt đang chậm 2 ngày.' },
    status('speaking'),
    { type: 'audio.start', turnId: 't1', format: 'mp3' },
    { type: 'audio.end', turnId: 't1' },
    status('idle'),
    { type: 'playback_ended' },
  ];

  it('đi qua đúng các trạng thái: đang mở, nghe, xử lý, đọc, rảnh', () => {
    const { phases } = run(turn);
    expect(phases).toEqual(['connecting', 'idle', 'listening', 'listening', 'listening', 'listening', 'thinking', 'thinking', 'thinking', 'thinking', 'thinking', 'thinking', 'speaking', 'speaking', 'speaking', 'speaking', 'idle']);
  });

  it('chữ nghe được hiện ngay khi nói; câu trả lời ghép từ các cụm rồi thay bằng bản đầy đủ', () => {
    const partial = run(turn.slice(0, 6)).state;
    expect(partial).toMatchObject({ heard: 'tình hình đón đoàn', heardFinal: false });
    const midReply = run(turn.slice(0, 11)).state;
    expect(midReply).toMatchObject({ reply: 'Dạ, thưa Chủ tịch. Lượt đang chậm 2 ngày.', replyDone: false });
    const done = run(turn).state;
    expect(done).toMatchObject({ heard: 'tình hình đón đoàn Nhật', heardFinal: true, reply: 'Dạ, thưa Chủ tịch. Lượt đang chậm 2 ngày.', replyDone: true, unclearStreak: 0, notice: null });
  });

  it('máy chủ chốt lượt nói thì micro đóng; âm thanh phát sau audio.end; máy chủ báo idle trong lúc app còn đọc thì vẫn là "đang đọc"', () => {
    const { effects, phases } = run(turn);
    expect(effects).toEqual([{ type: 'stop_mic' }, { type: 'play_audio', turnId: 't1' }]);
    // khung `status idle` (áp chót) tới khi app còn phát: vẫn hiện "Đang đọc"
    expect(phases.at(-2)).toBe('speaking');
    expect(phases.at(-1)).toBe('idle');
  });
});

describe('gõ chữ cho kết quả y hệt', () => {
  it('bắt đầu từ status thinking; câu vừa gõ hiện ở chỗ chữ nghe được', () => {
    const { state, phases } = run([{ type: 'text_sent', text: 'đi thúc anh Tuấn' }, status('thinking'), { type: 'assistant.done', turnId: 't2', text: 'Dạ.' }, status('idle')]);
    expect(phases).toEqual(['thinking', 'thinking', 'thinking', 'idle']);
    expect(state).toMatchObject({ turn: 'text', heard: 'đi thúc anh Tuấn', heardFinal: true, reply: 'Dạ.', waitNotice: false, unclearStreak: 0 });
  });
});

describe('quá 2 giây chưa có chữ trả lời (SPEC 6.10)', () => {
  it('status thinking lần hai: hiện "Xin chờ thêm một chút" và đọc câu xin chờ, đúng một lần', () => {
    const first = run([{ type: 'text_sent', text: 'tuần này có gì đến hạn' }, status('thinking')]);
    expect(first.state.waitNotice).toBe(false);
    expect(first.effects).toEqual([]);
    const second = run([status('thinking')], first.state);
    expect(second.state).toMatchObject({ phase: 'thinking', waitNotice: true });
    expect(second.effects).toEqual([{ type: 'say_wait' }]);
    const third = run([status('thinking')], second.state);
    expect(third.effects).toEqual([]);
    // Có chữ trả lời thì dòng xin chờ biến mất.
    expect(run([{ type: 'assistant.delta', turnId: 't3', text: 'Dạ' }], third.state).state.waitNotice).toBe(false);
  });

  it('lượt nói: lần thinking đầu sau transcript.final không tính là chờ lâu', () => {
    const { state, effects } = run([{ type: 'mic_started', mode: 'dictation' }, { type: 'mic_stopped' }, { type: 'transcript.final', turnId: 't1', text: 'ai đang chậm', confidence: 0.9 }, status('thinking')]);
    expect(state.waitNotice).toBe(false);
    expect(effects.map((e) => e.type)).toEqual(['stop_mic']);
  });
});

describe('đề xuất và danh sách chạm chọn', () => {
  it('proposal.created: app mở M3 (câu xác nhận lấy từ máy chủ, không lấy từ assistant.*)', () => {
    const { state, effects } = run([{ type: 'text_sent', text: 'đi thúc anh Tuấn' }, status('thinking'), { type: 'proposal.created', proposalId: PROPOSAL, batchId: BATCH, risk: 1, itemCount: 2 }]);
    expect(effects).toEqual([{ type: 'open_review', proposalId: PROPOSAL, batchId: BATCH, risk: 1 }]);
    expect(state.proposal).toMatchObject({ proposalId: PROPOSAL, batchId: BATCH, risk: 1, itemCount: 2 });
    expect(run([{ type: 'proposal_opened' }], state).state.proposal).toBeNull();
  });

  it('choices: hiện danh sách để chạm chọn; lượt mới thì danh sách cũ biến mất', () => {
    const options = [
      { id: PROPOSAL, label: 'chị Nguyễn Thu Lan', sub: 'Kinh doanh' },
      { id: BATCH, label: 'chị Phạm Thị Lan', sub: 'Kế toán' },
    ];
    const { state } = run([{ type: 'text_sent', text: 'nhắc chị Lan' }, status('thinking'), { type: 'assistant.done', turnId: 't1', text: 'Dạ, chị Lan nào ạ?' }, { type: 'choices', turnId: 't1', kind: 'person', options }]);
    expect(state.choices).toEqual({ kind: 'person', options });
    expect(run([{ type: 'text_sent', text: 'chị Nguyễn Thu Lan' }], state).state.choices).toBeNull();
  });
});

describe('ngắt lời (SPEC 6.6)', () => {
  it('bấm micro khi đang đọc: dừng ngay, bỏ âm thanh còn đang về của lượt cũ', () => {
    const speaking = run([{ type: 'text_sent', text: 'tình hình' }, status('thinking'), { type: 'assistant.done', turnId: 't1', text: 'Dạ.' }, status('speaking'), { type: 'audio.start', turnId: 't1', format: 'mp3' }]);
    const cut = run([{ type: 'interrupted' }], speaking.state);
    expect(cut.state).toMatchObject({ phase: 'idle', playing: false, discardAudio: true });
    expect(cut.effects).toEqual([{ type: 'drop_audio' }]);
    // Máy chủ trả audio.end ngay sau interrupt: không phát.
    const late = run([{ type: 'audio.end', turnId: 't1' }, status('idle')], cut.state);
    expect(late.types).toEqual(['drop_audio']);
    expect(late.state.phase).toBe('idle');
    // Lượt mới thì lại phát bình thường.
    const next = run([{ type: 'mic_started', mode: 'dictation' }, { type: 'transcript.final', turnId: 't2', text: 'ai đang chậm', confidence: 0.9 }, status('thinking'), { type: 'assistant.done', turnId: 't2', text: 'Dạ.' }, { type: 'audio.end', turnId: 't2' }], late.state);
    expect(next.types).toEqual(['stop_mic', 'play_audio']);
  });
});

describe('nghe không rõ (SPEC 6.6)', () => {
  const unclearTurn: (AssistantEvent | WsServerFrame)[] = [
    { type: 'mic_started', mode: 'dictation' },
    { type: 'mic_stopped' },
    { type: 'transcript.final', turnId: 't1', text: '', confidence: 0 },
    // máy chủ không gọi LLM: không có status thinking, trả lời thẳng
    { type: 'assistant.done', turnId: 't1', text: 'Dạ, trợ lý nghe chưa rõ, xin Chủ tịch nhắc lại.' },
    status('idle'),
  ];

  it('một lần: chỉ đếm; hai lần liên tiếp: đề nghị gõ chữ hoặc Nhờ Văn phòng và mở ô gõ chữ', () => {
    const once = run(unclearTurn);
    expect(once.state).toMatchObject({ unclearStreak: 1, notice: null, typingOpen: false });
    const twice = run(unclearTurn, once.state);
    expect(twice.state).toMatchObject({ unclearStreak: 2, notice: 'unclear_twice', typingOpen: true });
  });

  it('một lượt nghe rõ ở giữa thì đếm lại từ đầu', () => {
    const once = run(unclearTurn);
    const clear = run([{ type: 'mic_started', mode: 'dictation' }, { type: 'transcript.final', turnId: 't2', text: 'ai đang chậm', confidence: 0.93 }, status('thinking'), { type: 'assistant.done', turnId: 't2', text: 'Dạ.' }, status('idle')], once.state);
    expect(clear.state.unclearStreak).toBe(0);
    expect(run(unclearTurn, clear.state).state).toMatchObject({ unclearStreak: 1, notice: null });
  });
});

describe('lượt confirm: chỉ chép chữ (xác nhận bằng giọng ở M3, nút Nói cạnh ô nhập)', () => {
  it('trả transcript kèm độ tin cậy, không đụng tới hội thoại đang hiện', () => {
    const before = run([{ type: 'text_sent', text: 'đi thúc anh Tuấn' }, status('thinking'), { type: 'assistant.done', turnId: 't1', text: 'Dạ, trợ lý hiểu như sau.' }, status('idle')]).state;
    const { state, effects } = run([{ type: 'mic_started', mode: 'confirm' }, status('listening'), { type: 'transcript.partial', turnId: 't2', text: 'đồng' }, { type: 'mic_stopped' }, { type: 'transcript.final', turnId: 't2', text: 'đồng ý', confidence: 0.97 }, status('idle')], before);
    expect(state.transcript).toMatchObject({ text: 'đồng ý', confidence: 0.97 });
    expect(state).toMatchObject({ phase: 'idle', heard: 'đi thúc anh Tuấn', reply: 'Dạ, trợ lý hiểu như sau.' });
    expect(effects).toEqual([{ type: 'stop_mic' }]);
    expect(run([{ type: 'transcript_taken' }], state).state.transcript).toBeNull();
  });
});

describe('khi có sự cố (bảng SPEC 6.11)', () => {
  const thinking = run([{ type: 'text_sent', text: 'tình hình' }, status('thinking')]).state;

  it('STT lỗi: hiện ô gõ chữ và nút Thử lại, micro đóng', () => {
    const listening = run([{ type: 'mic_started', mode: 'dictation' }, status('listening')]).state;
    const { state, effects } = run([{ type: 'error', code: 'stt_unavailable', retryable: true }, status('idle')], listening);
    expect(state).toMatchObject({ phase: 'idle', notice: 'stt_failed', typingOpen: true });
    expect(effects).toContainEqual({ type: 'stop_mic' });
  });

  it('LLM lỗi hoặc quá 15 giây: "Trợ lý tạm nghỉ."', () => {
    const { state } = run([{ type: 'error', code: 'llm_unavailable', retryable: true }, status('idle')], thinking);
    expect(state).toMatchObject({ phase: 'idle', notice: 'resting' });
  });

  it('TTS lỗi trước khi có tiếng: vẫn có chữ, đọc bằng giọng của máy; giọng của máy cũng không được thì báo chỉ có chữ', () => {
    const replied = run([{ type: 'assistant.done', turnId: 't1', text: 'Dạ, có 2 việc chậm.' }, status('speaking')], thinking).state;
    const { state, effects } = run([{ type: 'error', code: 'tts_unavailable', retryable: true }, status('idle')], replied);
    expect(effects).toEqual([{ type: 'speak_reply', text: 'Dạ, có 2 việc chậm.' }]);
    expect(state).toMatchObject({ phase: 'speaking', playing: true, reply: 'Dạ, có 2 việc chậm.' });
    expect(run([{ type: 'playback_ended' }], state).state).toMatchObject({ phase: 'idle', notice: null });
    expect(run([{ type: 'playback_failed', spoken: false }], state).state).toMatchObject({ phase: 'idle', notice: 'text_only' });
  });

  it('TTS lỗi giữa chừng khi đã có tiếng: không đọc lại lần hai', () => {
    const played = run([{ type: 'assistant.done', turnId: 't1', text: 'Dạ.' }, status('speaking'), { type: 'audio.start', turnId: 't1', format: 'mp3' }, { type: 'audio.end', turnId: 't1' }], thinking);
    expect(played.types).toEqual(['play_audio']);
    expect(run([{ type: 'error', code: 'tts_unavailable', retryable: true }], played.state).effects).toEqual([]);
  });

  it('hết hạn mức (khung error hoặc mã đóng 4429) và tổ chức tắt AI', () => {
    expect(run([{ type: 'error', code: 'quota_exceeded', retryable: false }, { type: 'closed', reason: 'quota' }], thinking).state).toMatchObject({ phase: 'idle', notice: 'quota' });
    expect(run([{ type: 'closed', reason: 'quota' }]).state.notice).toBe('quota');
    expect(run([{ type: 'connecting' }, { type: 'error', code: 'ai_disabled', retryable: false }, { type: 'closed', reason: 'idle' }]).state).toMatchObject({ phase: 'idle', notice: 'resting' });
  });

  it('đứt kết nối giữa lượt: tạm nghỉ, micro đóng, âm thanh dở bị bỏ; im 60 giây lúc rảnh thì không báo gì', () => {
    const cut = run([{ type: 'closed', reason: 'network' }], thinking);
    expect(cut.state).toMatchObject({ phase: 'idle', notice: 'resting' });
    expect(cut.types).toEqual(['stop_mic', 'drop_audio']);
    expect(run([{ type: 'closed', reason: 'idle' }]).state).toMatchObject({ phase: 'idle', notice: null });
  });

  it('không mở được phiên: rời trạng thái đang mở, báo tạm nghỉ hoặc hết lượt', () => {
    expect(run([{ type: 'connecting' }, { type: 'connect_failed', reason: 'resting' }]).state).toMatchObject({ phase: 'idle', notice: 'resting' });
    expect(run([{ type: 'connecting' }, { type: 'connect_failed', reason: 'quota' }]).state.notice).toBe('quota');
  });

  it('micro: bị từ chối quyền, hoặc máy chưa thu âm được thì tự chuyển sang gõ chữ', () => {
    expect(run([{ type: 'mic_failed', reason: 'denied' }]).state).toMatchObject({ phase: 'idle', notice: 'mic_denied', typingOpen: true });
    expect(run([{ type: 'mic_failed', reason: 'unsupported' }]).state).toMatchObject({ phase: 'idle', notice: 'mic_unsupported', typingOpen: true });
  });
});

describe('dọn màn hình', () => {
  it('reset xoá câu chữ đang hiện (không lưu bản chép trên máy) và đóng micro', () => {
    const talked = run([{ type: 'text_sent', text: 'tình hình' }, status('thinking'), { type: 'assistant.done', turnId: 't1', text: 'Dạ.' }, status('idle')]).state;
    const { state, types } = run([{ type: 'reset' }], talked);
    expect(state).toMatchObject({ heard: '', reply: '', phase: 'idle', choices: null, proposal: null });
    expect(types).toEqual(['stop_mic', 'drop_audio']);
  });
});

describe('ngắt lượt nghe giữa chừng', () => {
  it('rời màn hình khi đang nghe: chữ nghe dở biến mất, không để giống như trợ lý đã hiểu câu đó', () => {
    const { state } = run([{ type: 'mic_started', mode: 'dictation' }, status('listening'), { type: 'transcript.partial', turnId: 't1', text: 'đi thúc' }, { type: 'interrupted' }]);
    expect(state.phase).toBe('idle');
    expect(state.heard).toBe('');
  });

  it('ngắt lời khi trợ lý đang đọc: câu đã nghe xong (đã chốt) vẫn giữ trên màn hình', () => {
    const { state } = run([
      { type: 'text_sent', text: 'Ai đang chậm?' },
      status('thinking'),
      { type: 'assistant.done', turnId: 't1', text: 'Dạ, thưa Chủ tịch.' },
      status('speaking'),
      { type: 'interrupted' },
    ]);
    expect(state.heard).toBe('Ai đang chậm?');
    expect(state.phase).toBe('idle');
  });
});
