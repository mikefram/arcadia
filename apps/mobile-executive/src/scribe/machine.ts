import type { WsServerFrame } from '@mihato/domain';
import type { ScribeCloseReason } from './client';

/**
 * Máy trạng thái của trợ lý trên app (SPEC 6.1, 6.6, 6.10, 6.11, 10.7.2). Hàm thuần: nhận trạng thái và một sự kiện,
 * trả trạng thái mới cùng các việc phụ cần làm (dừng micro, phát âm thanh, mở M3…). Lớp điều khiển
 * (`assistant.ts`) làm các việc phụ đó; màn hình chỉ vẽ theo trạng thái.
 *
 * Thứ tự khung của một lượt nói:
 *   status listening → transcript.partial… → transcript.final → status thinking → (proposal.created)
 *   → assistant.delta… → assistant.done → (choices) → status speaking → audio.start → khung nhị phân → audio.end → status idle
 * Gõ chữ bắt đầu từ `status thinking`. Quá 2 giây chưa có chữ trả lời thì máy chủ gửi `status thinking` lần hai:
 * app hiện và đọc câu "xin chờ" để người dùng biết máy đã nghe thấy mình.
 *
 * CHẾ ĐỘ TRÒ CHUYỆN (`voice`, docs/DECISIONS.md 04/10/2026, đổi SPEC 6.5 điều 10): người dùng bấm micro MỘT lần; mỗi lượt
 * nghe vẫn là một cặp `start_turn` và chốt lượt như cũ (máy chủ tự chốt khi người nói ngừng, `utterance_end_ms`), nhưng đọc xong
 * câu trả lời thì tự nghe tiếp (`listen_again`). Micro chỉ mở lúc `listening`. Vòng dừng khi: người dùng bấm dừng, rời màn hình,
 * lâu không có tiếng (lớp điều khiển đặt giờ), có sự cố bất kỳ, nghe không rõ hai lần liên tiếp, hoặc có đề xuất (M3 xác nhận bằng
 * chạm; vòng này KHÔNG BAO GIỜ chạy lượt `confirm`, nên không thể xác nhận gì bằng giọng ở chế độ này).
 */
export type AssistantPhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export type AssistantNotice =
  /** "Trợ lý tạm nghỉ." LLM lỗi, tổ chức tắt AI, đứt kết nối giữa lượt */
  | 'resting'
  /** hết lượt dùng trong ngày */
  | 'quota'
  /** STT lỗi hoặc đứt: hiện ô gõ chữ và nút Thử lại */
  | 'stt_failed'
  | 'mic_denied'
  /** máy chưa thu âm được (bản native hôm nay): tự chuyển sang gõ chữ */
  | 'mic_unsupported'
  /** TTS lỗi và giọng của máy cũng không đọc được: chỉ có chữ */
  | 'text_only'
  /** nghe không rõ hai lần liên tiếp: đề nghị gõ chữ hoặc Nhờ Văn phòng */
  | 'unclear_twice'
  /** đang trò chuyện mà lâu không nghe thấy tiếng nào: trợ lý ngừng nghe và nói rõ lý do */
  | 'voice_idle'
  /** đang trò chuyện thì máy chủ đóng phiên êm (hết thời gian của một phiên...): micro đã đóng, nói rõ để người dùng biết */
  | 'voice_ended';

export type AssistantChoices = { kind: 'person' | 'template' | 'run'; options: { id: string; label: string; sub: string | null }[] };

/** `seq` tăng mỗi lần có tín hiệu mới để màn hình chỉ xử lý đúng một lần. */
export type ProposalSignal = { seq: number; proposalId: string; batchId: string | null; risk: number; itemCount: number };
export type TranscriptResult = { seq: number; text: string; confidence: number };

export type TurnKind = 'dictation' | 'confirm' | 'text';

export type AssistantState = {
  phase: AssistantPhase;
  turn: TurnKind | null;
  /** chữ trợ lý nghe được (hiện cỡ lớn ngay khi nói), hoặc câu vừa gõ */
  heard: string;
  heardFinal: boolean;
  reply: string;
  replyDone: boolean;
  /** quá 2 giây chưa có chữ trả lời: hiện "Xin chờ thêm một chút" */
  waitNotice: boolean;
  choices: AssistantChoices | null;
  /** có đề xuất mới: app mở M3 */
  proposal: ProposalSignal | null;
  /** kết quả của lượt `confirm` (chỉ chép chữ): M3 dùng để xác nhận bằng giọng, ô nhập dùng để điền chữ */
  transcript: TranscriptResult | null;
  unclearStreak: number;
  notice: AssistantNotice | null;
  typingOpen: boolean;
  /** đang ở chế độ trò chuyện: trợ lý nghe liên tục, ngừng nói thì tự trả lời, đọc xong thì nghe tiếp */
  voice: boolean;
  // ── nội bộ ──
  thinkingCount: number;
  /** app đang phát âm thanh câu trả lời (máy chủ đã báo `idle` nhưng app còn đọc) */
  playing: boolean;
  /** lượt này đã có tiếng (mp3 hoặc giọng của máy): không đọc lần hai */
  spoke: boolean;
  /** bị ngắt lời: bỏ âm thanh còn đang về của lượt cũ */
  discardAudio: boolean;
  seq: number;
};

export const INITIAL_ASSISTANT_STATE: AssistantState = {
  phase: 'idle',
  turn: null,
  heard: '',
  heardFinal: false,
  reply: '',
  replyDone: false,
  waitNotice: false,
  choices: null,
  proposal: null,
  transcript: null,
  unclearStreak: 0,
  notice: null,
  typingOpen: false,
  voice: false,
  thinkingCount: 0,
  playing: false,
  spoke: false,
  discardAudio: false,
  seq: 0,
};

export type AssistantEvent =
  | { type: 'connecting' }
  | { type: 'connect_failed'; reason: 'resting' | 'quota' }
  /** micro đã mở và `start_turn` đã gửi */
  | { type: 'mic_started'; mode: 'dictation' | 'confirm' }
  /** người dùng bấm micro lần nữa, `end_turn` đã gửi */
  | { type: 'mic_stopped' }
  | { type: 'mic_failed'; reason: 'denied' | 'unsupported' | 'error' }
  | { type: 'text_sent'; text: string }
  /** người dùng ngắt lời (bấm micro khi đang đọc, bấm Dừng đọc, rời màn hình) */
  | { type: 'interrupted' }
  | { type: 'frame'; frame: WsServerFrame }
  | { type: 'closed'; reason: ScribeCloseReason }
  | { type: 'playback_ended' }
  /** không phát được; `spoken`: đã đọc thay bằng giọng của máy hay chưa */
  | { type: 'playback_failed'; spoken: boolean }
  | { type: 'typing'; open: boolean }
  | { type: 'notice_dismissed' }
  | { type: 'proposal_opened' }
  | { type: 'transcript_taken' }
  /** người dùng bấm micro ở M2: bật chế độ trò chuyện (trước khi mở micro) */
  | { type: 'voice_on' }
  /** tắt chế độ trò chuyện: `user` là bấm dừng hoặc rời màn hình, `idle` là lâu không nghe thấy tiếng nào */
  | { type: 'voice_off'; reason: 'user' | 'idle' }
  | { type: 'reset' };

export type AssistantEffect =
  | { type: 'stop_mic' }
  /** đang trò chuyện và lượt vừa xong (đã đọc xong): mở micro nghe tiếp */
  | { type: 'listen_again' }
  /** phát câu dựng sẵn "Dạ, xin Chủ tịch chờ một chút." */
  | { type: 'say_wait' }
  | { type: 'play_audio'; turnId: string }
  | { type: 'drop_audio' }
  /** TTS lỗi: đọc bằng giọng của hệ điều hành */
  | { type: 'speak_reply'; text: string }
  | { type: 'open_review'; proposalId: string; batchId: string | null; risk: number };

export type Reduction = { state: AssistantState; effects: AssistantEffect[] };

const NO_EFFECTS: AssistantEffect[] = [];
const only = (state: AssistantState): Reduction => ({ state, effects: NO_EFFECTS });

/**
 * Bắt đầu một lượt mới: xoá câu cũ, giữ số lần nghe chưa rõ liên tiếp. Đang trò chuyện thì cặp hỏi đáp trước vẫn nằm trên
 * màn hình trong lúc trợ lý nghe tiếp (người dùng còn đọc được câu trả lời); chữ đầu tiên của lượt mới mới thay nó.
 */
function freshTurn(state: AssistantState, turn: TurnKind): AssistantState {
  const keepConversation = turn === 'confirm' || (state.voice && turn === 'dictation');
  return {
    ...state,
    turn,
    heard: keepConversation ? state.heard : '',
    heardFinal: keepConversation ? state.heardFinal : false,
    reply: keepConversation ? state.reply : '',
    replyDone: keepConversation ? state.replyDone : false,
    choices: keepConversation ? state.choices : null,
    waitNotice: false,
    notice: null,
    transcript: null,
    thinkingCount: 0,
    playing: false,
    spoke: false,
    discardAudio: false,
  };
}

function onFrame(state: AssistantState, frame: WsServerFrame): Reduction {
  switch (frame.type) {
    case 'ready':
      return only(state.phase === 'connecting' ? { ...state, phase: 'idle' } : state);

    case 'status':
      switch (frame.phase) {
        case 'listening':
          return only({ ...state, phase: 'listening' });
        case 'thinking': {
          const thinkingCount = state.thinkingCount + 1;
          // Lần hai trong cùng một lượt: đã quá 2 giây chưa có chữ trả lời (SPEC 6.10).
          const wait = thinkingCount >= 2 && !state.waitNotice;
          return { state: { ...state, phase: 'thinking', thinkingCount, waitNotice: state.waitNotice || wait }, effects: wait ? [{ type: 'say_wait' }] : NO_EFFECTS };
        }
        case 'speaking':
          return only({ ...state, phase: 'speaking', waitNotice: false });
        case 'idle': {
          const wasListening = state.phase === 'listening';
          return { state: { ...state, phase: state.playing ? 'speaking' : 'idle', waitNotice: false }, effects: wasListening ? [{ type: 'stop_mic' }] : NO_EFFECTS };
        }
      }
      return only(state);

    case 'transcript.partial': {
      if (state.turn === 'confirm') return only(state);
      // Đang trò chuyện: chữ đầu tiên của lượt mới thay cho cặp hỏi đáp trước (cặp đó còn nằm trên màn hình lúc trợ lý nghe tiếp).
      // Ngoài chế độ trò chuyện `heardFinal` đã là false từ `freshTurn`, nên nhánh này không đổi gì.
      const previousExchange = state.heardFinal ? { reply: '', replyDone: false, choices: null } : {};
      return only({ ...state, ...previousExchange, heard: frame.text, heardFinal: false });
    }

    case 'transcript.final': {
      // Máy chủ đã chốt lượt nói (người dùng bấm dừng, hoặc hết câu): micro phải đóng.
      const effects: AssistantEffect[] = [{ type: 'stop_mic' }];
      if (state.turn === 'confirm') {
        const seq = state.seq + 1;
        return { state: { ...state, seq, transcript: { seq, text: frame.text, confidence: frame.confidence } }, effects };
      }
      return { state: { ...state, heard: frame.text, heardFinal: true, thinkingCount: 0, phase: state.phase === 'listening' ? 'thinking' : state.phase }, effects };
    }

    case 'assistant.delta':
      return only({ ...state, reply: state.replyDone ? frame.text : state.reply + frame.text, replyDone: false, waitNotice: false });

    case 'assistant.done': {
      // Lượt nói mà máy chủ trả lời thẳng, không qua `status thinking`, là lượt nghe chưa rõ (không gọi LLM).
      const unclear = state.turn === 'dictation' && state.thinkingCount === 0;
      const unclearStreak = unclear ? state.unclearStreak + 1 : 0;
      const twice = unclearStreak >= 2;
      return only({
        ...state,
        reply: frame.text,
        replyDone: true,
        waitNotice: false,
        unclearStreak,
        notice: twice ? 'unclear_twice' : state.notice,
        typingOpen: state.typingOpen || twice,
        // Nghe không rõ hai lần liên tiếp: đừng cứ nghe mãi, mời gõ chữ.
        voice: twice ? false : state.voice,
      });
    }

    case 'audio.start':
      return only(state);

    case 'audio.end':
      if (state.discardAudio) return { state, effects: [{ type: 'drop_audio' }] };
      return { state: { ...state, playing: true, spoke: true, phase: 'speaking' }, effects: [{ type: 'play_audio', turnId: frame.turnId }] };

    case 'proposal.created': {
      const seq = state.seq + 1;
      return {
        // Có đề xuất: M3 mở ra và việc xác nhận là của người dùng (chạm, hoặc bấm micro ở M3). Vòng trò chuyện dừng ở đây.
        state: { ...state, voice: false, seq, proposal: { seq, proposalId: frame.proposalId, batchId: frame.batchId, risk: frame.risk, itemCount: frame.itemCount } },
        effects: [{ type: 'open_review', proposalId: frame.proposalId, batchId: frame.batchId, risk: frame.risk }],
      };
    }

    case 'choices':
      return only({ ...state, choices: { kind: frame.kind, options: frame.options } });

    case 'error':
      switch (frame.code) {
        case 'stt_unavailable':
          return { state: { ...state, voice: false, phase: state.playing ? 'speaking' : 'idle', notice: 'stt_failed', typingOpen: true }, effects: [{ type: 'stop_mic' }] };
        case 'llm_unavailable':
        case 'ai_disabled':
          return only({ ...state, voice: false, notice: 'resting', waitNotice: false });
        case 'quota_exceeded':
          return only({ ...state, voice: false, notice: 'quota', waitNotice: false });
        case 'tts_unavailable':
          // Vẫn có chữ. Chưa có tiếng nào của lượt này thì đọc bằng giọng của máy (SPEC 6.11).
          if (state.spoke || state.discardAudio || !state.reply) return only(state);
          return { state: { ...state, playing: true, spoke: true, phase: 'speaking' }, effects: [{ type: 'speak_reply', text: state.reply }] };
        case 'session_expired':
          return only(state);
      }
      return only(state);
  }
  return only(state);
}

/** Lời báo nào làm vòng trò chuyện dừng: người dùng cần đọc và làm gì đó trước khi trợ lý nghe tiếp. */
const BLOCKS_LISTENING: ReadonlySet<AssistantNotice> = new Set<AssistantNotice>(['resting', 'quota', 'stt_failed', 'mic_denied', 'mic_unsupported', 'unclear_twice', 'voice_idle', 'voice_ended']);

/**
 * Đang trò chuyện, lượt vừa xong (trợ lý đã đọc xong hoặc chỉ có chữ) và không có gì cản: nghe tiếp.
 * Chỉ tính khi phase VỪA chuyển về `idle` do lượt tự kết thúc (khung của máy chủ, đọc xong, đọc hỏng), nên:
 * - một khung `status idle` đến muộn khi đã rảnh không mở micro lần hai;
 * - người dùng ngắt lời (`interrupted`) không tự mở micro ở đây: lớp điều khiển tự quyết (bấm Ngắt lời thì nghe ngay,
 *   bấm dừng hay rời màn hình thì không).
 */
function shouldListenAgain(before: AssistantState, after: AssistantState, event: AssistantEvent): boolean {
  const turnEnded = event.type === 'frame' || event.type === 'playback_ended' || event.type === 'playback_failed';
  // `connecting` về `idle` (khung `ready`) chỉ là mở xong phiên, chưa phải một lượt vừa kết thúc.
  const wasInTurn = before.phase === 'listening' || before.phase === 'thinking' || before.phase === 'speaking';
  return (
    turnEnded &&
    after.voice &&
    wasInTurn &&
    after.phase === 'idle' &&
    after.turn !== 'confirm' &&
    after.proposal === null &&
    !after.typingOpen &&
    !(after.notice !== null && BLOCKS_LISTENING.has(after.notice))
  );
}

export function reduceAssistant(state: AssistantState, event: AssistantEvent): Reduction {
  const reduction = reduceEvent(state, event);
  if (!shouldListenAgain(state, reduction.state, event)) return reduction;
  return { state: reduction.state, effects: [...reduction.effects, { type: 'listen_again' }] };
}

function reduceEvent(state: AssistantState, event: AssistantEvent): Reduction {
  switch (event.type) {
    case 'connecting':
      return only(state.phase === 'idle' ? { ...state, phase: 'connecting', notice: null } : state);

    case 'connect_failed':
      return { state: { ...state, voice: false, phase: 'idle', waitNotice: false, notice: event.reason }, effects: [{ type: 'stop_mic' }] };

    case 'mic_started':
      return only({ ...freshTurn(state, event.mode), phase: 'listening' });

    case 'mic_stopped':
      return only(state.phase === 'listening' ? { ...state, phase: 'thinking' } : state);

    case 'mic_failed':
      return only({
        ...state,
        voice: false,
        phase: state.playing ? 'speaking' : 'idle',
        notice: event.reason === 'denied' ? 'mic_denied' : event.reason === 'unsupported' ? 'mic_unsupported' : 'stt_failed',
        typingOpen: true,
      });

    case 'text_sent':
      return only({ ...freshTurn(state, 'text'), phase: 'thinking', heard: event.text, heardFinal: true, unclearStreak: 0 });

    case 'interrupted':
      // Chữ nghe dở (chưa chốt) của lượt bị ngắt phải biến mất: để lại sẽ giống như trợ lý đã hiểu và đang làm theo câu đó.
      return {
        state: { ...state, phase: 'idle', playing: false, waitNotice: false, discardAudio: true, heard: state.heardFinal ? state.heard : '' },
        effects: [{ type: 'drop_audio' }],
      };

    case 'frame':
      return onFrame(state, event.frame);

    case 'closed': {
      const midTurn = state.phase === 'listening' || state.phase === 'thinking' || state.phase === 'connecting';
      const notice: AssistantNotice | null =
        event.reason === 'quota'
          ? 'quota'
          : midTurn && (event.reason === 'network' || event.reason === 'server_error' || event.reason === 'bad_token')
            ? 'resting'
            : // Máy chủ đóng êm (hết thời gian của một phiên, 4408) khi đang trò chuyện: micro đã đóng, người dùng cần biết vì sao.
              state.voice && event.reason === 'idle'
              ? 'voice_ended'
              : state.notice;
      return {
        // Phiên đóng (hết thời hạn, mất mạng, hết lượt): trò chuyện kết thúc, người dùng bấm micro để mở lại.
        state: { ...state, voice: false, phase: state.playing ? 'speaking' : 'idle', waitNotice: false, notice },
        effects: [{ type: 'stop_mic' }, { type: 'drop_audio' }],
      };
    }

    case 'playback_ended':
      return only({ ...state, playing: false, phase: state.phase === 'speaking' ? 'idle' : state.phase });

    case 'playback_failed':
      return only({ ...state, playing: false, phase: state.phase === 'speaking' ? 'idle' : state.phase, notice: event.spoken ? state.notice : (state.notice ?? 'text_only') });

    case 'typing':
      return only({ ...state, typingOpen: event.open });

    case 'notice_dismissed':
      return only({ ...state, notice: null });

    case 'proposal_opened':
      return only({ ...state, proposal: null });

    case 'transcript_taken':
      return only({ ...state, transcript: null });

    case 'voice_on':
      return only({ ...state, voice: true, notice: state.notice === 'voice_idle' || state.notice === 'voice_ended' ? null : state.notice });

    case 'voice_off':
      // `voice_off` không đóng micro hay dừng đọc: lớp điều khiển làm việc đó (tiếng đang đọc có thể cho đọc nốt).
      return only({ ...state, voice: false, notice: event.reason === 'idle' ? 'voice_idle' : state.notice });

    case 'reset':
      return { state: { ...INITIAL_ASSISTANT_STATE, seq: state.seq }, effects: [{ type: 'stop_mic' }, { type: 'drop_audio' }] };
  }
}
