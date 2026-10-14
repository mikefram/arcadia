import { ApiError } from '@mihato/domain';
import { fmtExecutive, vi } from '@mihato/i18n';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { APP_VERSION } from '../config';
import { KV_KEYS } from '../session/kv';
import { secureKV } from '../session/secure-kv';
import { api, localProfile, session } from '../services';
import { AudioAssembler } from './audio-assembler';
import { ScribeClient, ScribeConnectError, type ScribeClientEvent } from './client';
import { LevelMeter } from './level';
import { INITIAL_ASSISTANT_STATE, reduceAssistant, type AssistantEffect, type AssistantEvent, type AssistantState } from './machine';
import { MicError, createMicSource, micSupported, type MicSource } from './mic';
import { playMp3Bytes, type Playback } from './player';
import { speakWithDevice, stopDeviceSpeech, type SpeechRateName } from './speech';
import { devTrace } from './trace';

/**
 * Lớp điều khiển trợ lý: nối lớp WebSocket, máy trạng thái, micro và loa. Một bản duy nhất cho cả app, vì phiên
 * hội thoại phải sống tiếp khi đi từ M2 sang M3 (xác nhận bằng giọng dùng cùng phiên) rồi quay lại.
 *
 * Điều phải giữ:
 * - Micro chỉ mở sau khi người dùng bấm nút micro. Ở chế độ trò chuyện (docs/DECISIONS.md 04/10/2026, đổi SPEC 6.5 điều 10)
 *   micro tự mở lại sau mỗi câu trả lời, nhưng: chỉ lúc `listening` (màn hình luôn nói rõ), một chạm là dừng, và chế độ tắt khi
 *   rời màn hình, khoá app, app xuống nền, lâu không có tiếng, có sự cố, hay có đề xuất. Chế độ này không bao giờ chạy lượt
 *   `confirm`: xác nhận bằng giọng vẫn chỉ xảy ra khi người dùng bấm micro ở M3.
 * - Không lưu bản chép hội thoại trên máy: trạng thái chỉ nằm trong bộ nhớ và bị xoá khi khoá app.
 * - Âm thanh không được lưu: khối mp3 phát xong là bỏ; khung thu âm chỉ để gửi đi và tính mức âm, rồi bỏ.
 */
export type AssistantSnapshot = AssistantState & {
  /** đã đồng ý ở màn "Trước khi dùng trợ lý"; null khi chưa đọc xong từ kho */
  consent: boolean | null;
};

/** LLM lỗi hoặc quá 15 giây thì máy chủ báo; đây là chốt chặn phía app nếu không có khung nào về. */
const THINKING_TIMEOUT_MS = 25_000;
/** Đang trò chuyện mà chừng này không nghe thấy tiếng nào thì trợ lý ngừng nghe (đóng micro, nói rõ lý do). */
const VOICE_IDLE_MS = 45_000;
/**
 * Chốt chặn vòng nghe tiếp: nếu một lượt vừa mở micro đã kết thúc ngay (dưới từng này) mà chưa nghe được chữ nào, ba lần liên tiếp,
 * thì có sự cố ở đâu đó (máy chủ chốt lượt ngay, micro rơi) nên dừng thay vì quay vòng mãi.
 */
const QUICK_RESTART_MS = 1_500;
const MAX_QUICK_RESTARTS = 3;
const KEEP_AWAKE_TAG = 'mihato-assistant-voice';
/** Đổi số này mỗi khi điều app làm với micro đổi (người đã đồng ý bản cũ sẽ thấy lại màn "Trước khi dùng trợ lý"). '2': chế độ trò chuyện, 04/10/2026. */
const CONSENT_VERSION = '2';

class AssistantController {
  private state: AssistantState = INITIAL_ASSISTANT_STATE;
  private consent: boolean | null = null;
  private snapshot: AssistantSnapshot = { ...INITIAL_ASSISTANT_STATE, consent: null };
  private listeners = new Set<() => void>();
  private readonly assembler = new AudioAssembler();
  private readonly mic: MicSource = createMicSource();
  private micOpen = false;
  private playback: Playback | null = null;
  private speechRate: SpeechRateName = 'normal';
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  // ── chế độ trò chuyện ──
  private readonly levelMeter = new LevelMeter();
  /** Mức âm micro 0..1 cho thanh "đang nghe" (`useSyncExternalStore`). Tính từ khung đang gửi đi, không giữ lại âm thanh. */
  readonly level = { subscribe: this.levelMeter.subscribe, getSnapshot: this.levelMeter.getSnapshot };
  /** tăng mỗi khi huỷ việc mở micro đang dở: bấm dừng trong lúc micro đang mở thì micro không được phép mở nốt */
  private micEpoch = 0;
  private voiceIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAwake = false;
  private listenStartedAt = 0;
  private heardSinceListen = false;
  private quickRestarts = 0;

  private readonly client = new ScribeClient({
    appVersion: APP_VERSION,
    createSession: async () => {
      const voice = micSupported();
      // Chỉ báo "đã đồng ý lưu bản chép" khi người dùng thật sự đã bấm đồng ý bản hiện hành. Màn M3 và M6 mở phiên mà không đi qua
      // màn "Trước khi dùng trợ lý"; gửi `true` cố định thì máy chủ ghi lời đồng ý chưa từng có (rà soát 07/10/2026, exec-3).
      if (this.consent === null) await this.loadConsent();
      const created = await api.call('scribe.createSession', { body: { channel: voice ? 'voice' : 'text', transcriptConsent: this.consent === true } });
      return { wsUrl: created.wsUrl, token: created.token };
    },
    onEvent: (event) => this.onClientEvent(event),
  });

  constructor() {
    // Khoá app, đăng xuất, thu hồi thiết bị: đóng micro, dừng đọc, đóng phiên, xoá câu chữ đang hiện.
    session.subscribe(() => {
      if (session.getSnapshot().status !== 'unlocked') this.shutdown();
    });
  }

  // ───── đọc trạng thái ─────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AssistantSnapshot => this.snapshot;

  private publish(): void {
    this.snapshot = { ...this.state, consent: this.consent };
    for (const l of this.listeners) l();
  }

  private dispatch(event: AssistantEvent): void {
    const { state, effects } = reduceAssistant(this.state, event);
    devTrace(`${event.type === 'frame' ? `frame:${event.frame.type}${event.frame.type === 'status' ? `:${event.frame.phase}` : ''}` : event.type} → ${state.phase}${state.voice ? ' voice' : ''}${state.playing ? ' playing' : ''}${effects.length ? ` [${effects.map((e) => e.type).join(',')}]` : ''}`);
    this.state = state;
    this.publish();
    for (const effect of effects) this.run(effect);
    this.watchThinking();
    this.watchVoice(event);
  }

  /**
   * Chế độ trò chuyện: giữ màn hình sáng suốt lúc trò chuyện (người dùng nói mà không chạm gì, máy tự khoá thì micro tắt giữa chừng),
   * và đặt giờ "lâu không có tiếng" chỉ trong lúc đang nghe: mỗi lần mở micro và mỗi lần có chữ mới thì tính lại từ đầu.
   */
  private watchVoice(event: AssistantEvent): void {
    const { voice, phase } = this.state;
    this.setKeepAwake(voice);
    if (!voice || phase !== 'listening') {
      this.clearVoiceIdle();
      return;
    }
    if (event.type === 'mic_started') {
      this.listenStartedAt = Date.now();
      this.heardSinceListen = false;
      this.armVoiceIdle();
    } else if (event.type === 'frame' && event.frame.type === 'transcript.partial') {
      this.heardSinceListen = true;
      this.armVoiceIdle();
    }
  }

  private armVoiceIdle(): void {
    this.clearVoiceIdle();
    this.voiceIdleTimer = setTimeout(() => {
      this.voiceIdleTimer = null;
      if (this.state.voice && this.state.phase === 'listening') this.stopVoice('idle');
    }, VOICE_IDLE_MS);
  }

  private clearVoiceIdle(): void {
    if (this.voiceIdleTimer) clearTimeout(this.voiceIdleTimer);
    this.voiceIdleTimer = null;
  }

  private setKeepAwake(on: boolean): void {
    if (on === this.keepAwake) return;
    this.keepAwake = on;
    // Không giữ được màn hình sáng (máy không cho, hoặc trình duyệt không có) thì vẫn trò chuyện được, chỉ là màn hình có thể tắt.
    try {
      void Promise.resolve(on ? activateKeepAwakeAsync(KEEP_AWAKE_TAG) : deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => undefined);
    } catch {}
  }

  /** Đang nghe, đang nghĩ hay đang đọc đều tính là đang dùng máy: không khoá app giữa chừng. */
  private watchThinking(): void {
    if (this.state.phase !== 'idle') session.noteActivity();
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = null;
    if (this.state.phase !== 'thinking') return;
    this.thinkingTimer = setTimeout(() => {
      if (this.state.phase !== 'thinking') return;
      this.client.interrupt();
      this.dispatch({ type: 'connect_failed', reason: 'resting' });
    }, THINKING_TIMEOUT_MS);
  }

  // ───── đồng ý lần đầu ─────

  async loadConsent(): Promise<void> {
    const stored = await secureKV.get(KV_KEYS.assistantConsent).catch(() => null);
    // Lời đồng ý có số phiên bản: bản '1' nói "không nghe liên tục", không còn đúng với chế độ trò chuyện, nên phải đồng ý lại.
    this.consent = stored === CONSENT_VERSION;
    this.publish();
  }

  /** Bấm "Tôi đồng ý": máy chủ ghi `conversations.transcript_consent` khi tạo phiên. */
  async agree(): Promise<void> {
    this.consent = true;
    this.publish();
    await secureKV.set(KV_KEYS.assistantConsent, CONSENT_VERSION).catch(() => undefined);
  }

  setSpeechRate(rate: SpeechRateName): void {
    this.speechRate = rate;
  }

  // ───── sự kiện từ máy chủ ─────

  private onClientEvent(event: ScribeClientEvent): void {
    switch (event.type) {
      case 'state':
        return;
      case 'audio':
        this.assembler.push(event.chunk);
        return;
      case 'frame': {
        const frame = event.frame;
        if (frame.type === 'audio.start') this.assembler.start(frame.turnId);
        if (frame.type === 'transcript.final' || (frame.type === 'status' && frame.phase !== 'listening')) this.client.markTurnClosed();
        this.dispatch({ type: 'frame', frame });
        return;
      }
      case 'closed':
        this.dispatch({ type: 'closed', reason: event.reason });
        return;
    }
  }

  private run(effect: AssistantEffect): void {
    switch (effect.type) {
      case 'stop_mic':
        void this.closeMic();
        return;
      case 'listen_again':
        void this.listenAgain();
        return;
      case 'drop_audio':
        this.assembler.reset();
        return;
      case 'say_wait':
        // Câu dựng sẵn, đọc bằng giọng của máy: người lớn tuổi cần biết máy đã nghe thấy mình (SPEC 6.10).
        void speakWithDevice(fmtExecutive(vi.executive.assistant.waitSpoken, {}, localProfile.getSnapshot().address), this.speechRate);
        return;
      case 'play_audio': {
        const audio = this.assembler.end(effect.turnId);
        if (!audio) {
          void this.speakFallback(this.state.reply);
          return;
        }
        stopDeviceSpeech();
        this.stopPlayback();
        devTrace(`phát mp3: ${audio.bytes.byteLength} byte`);
        const playback = playMp3Bytes(audio.bytes);
        this.playback = playback;
        playback.finished.then(
          (completed) => {
            if (this.playback !== playback) return;
            this.playback = null;
            if (completed) this.dispatch({ type: 'playback_ended' });
          },
          () => {
            if (this.playback !== playback) return;
            this.playback = null;
            // mp3 không phát được (hoặc TTS trả dữ liệu hỏng): đọc bằng giọng của máy, không được thì chỉ hiện chữ.
            void this.speakFallback(this.state.reply);
          },
        );
        return;
      }
      case 'speak_reply':
        void this.speakFallback(effect.text);
        return;
      case 'open_review':
        // Màn hình M2 theo dõi `state.proposal` và tự mở M3; ở đây không điều hướng để lớp này không phụ thuộc router.
        return;
    }
  }

  private async speakFallback(text: string): Promise<void> {
    devTrace(`giọng máy: bắt đầu đọc (${text.length} ký tự)`);
    const spoken = text ? await speakWithDevice(text, this.speechRate) : false;
    devTrace(`giọng máy: xong, đọc được=${spoken}, còn đang phát=${this.state.playing}`);
    if (!this.state.playing) return;
    this.dispatch(spoken ? { type: 'playback_ended' } : { type: 'playback_failed', spoken: false });
  }

  private stopPlayback(): void {
    const playback = this.playback;
    this.playback = null;
    playback?.stop();
    stopDeviceSpeech();
  }

  private async closeMic(): Promise<void> {
    this.levelMeter.reset();
    if (!this.micOpen) return;
    this.micOpen = false;
    await this.mic.stop().catch(() => undefined);
  }

  // ───── nối ─────

  private async ready(): Promise<boolean> {
    if (this.client.state === 'ready') return true;
    this.dispatch({ type: 'connecting' });
    try {
      await this.client.ensureReady();
      return true;
    } catch (err) {
      const quota = (err instanceof ApiError && err.code === 'quota_exceeded') || (err instanceof ScribeConnectError && err.reason === 'quota');
      // `closed` có thể đã đặt lời báo; ở đây bảo đảm màn hình luôn rời trạng thái "đang mở trợ lý".
      this.dispatch({ type: 'connect_failed', reason: quota ? 'quota' : 'resting' });
      return false;
    }
  }

  private async openMic(mode: 'dictation' | 'confirm'): Promise<void> {
    // Mỗi lần mở micro có một số thứ tự; bấm dừng, rời màn hình hay khoá app trong lúc đang mở thì số đổi, và micro vừa mở xong
    // phải đóng lại ngay chứ không được đi tiếp (không thể để micro mở sau khi người dùng đã bấm dừng).
    const epoch = ++this.micEpoch;
    if (!micSupported()) {
      this.dispatch({ type: 'mic_failed', reason: 'unsupported' });
      return;
    }
    if (!(await this.ready())) return;
    if (epoch !== this.micEpoch) return;
    try {
      await this.mic.start((chunk) => {
        this.levelMeter.push(chunk);
        this.client.sendAudio(chunk);
      });
      this.micOpen = true;
    } catch (err) {
      if (epoch === this.micEpoch) this.dispatch({ type: 'mic_failed', reason: err instanceof MicError ? err.reason : 'error' });
      return;
    }
    if (epoch !== this.micEpoch) {
      await this.closeMic();
      return;
    }
    if (!this.client.startTurn(mode)) {
      await this.closeMic();
      this.dispatch({ type: 'connect_failed', reason: 'resting' });
      return;
    }
    this.dispatch({ type: 'mic_started', mode });
  }

  /** Dừng mọi thứ của lượt đang chạy: tiếng đang đọc, micro, lượt xử lý ở máy chủ. */
  private cutCurrentTurn(): void {
    this.micEpoch++;
    const { phase } = this.state;
    if (phase === 'idle' || phase === 'connecting') return;
    this.stopPlayback();
    void this.closeMic();
    this.client.interrupt();
    this.dispatch({ type: 'interrupted' });
  }

  // ───── thao tác của người dùng ─────

  /**
   * Nút micro ở M2: một nút, một việc, luôn có chữ nói rõ việc đó.
   * - Chưa trò chuyện: bật chế độ trò chuyện và mở micro. Trợ lý nghe, tự trả lời khi người dùng ngừng nói, đọc xong thì nghe tiếp.
   * - Đang trò chuyện, ở bất kỳ lúc nào (nghe, nghĩ, đọc): dừng trò chuyện.
   * Muốn ngắt lời để nói ngay thì có nút riêng (`interruptAndListen`); nói xong sớm không cần chờ thì có `finishSpeaking`.
   */
  async pressMic(): Promise<void> {
    // Dừng phải luôn có tác dụng, không phụ thuộc cờ `busy`: cờ đó giữ suốt lúc app mở micro hoặc mở phiên (có thể vài giây khi mạng
    // chậm hay đang hiện hộp xin quyền), mà cú chạm dừng trong lúc ấy mà bị nuốt thì micro vẫn mở dù người dùng đã bấm dừng.
    // `stopVoice` chạy đồng bộ và huỷ cả việc mở micro đang dở (`micEpoch`), nên gọi lúc nào cũng an toàn.
    if (this.state.voice) {
      this.stopVoice('user');
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      this.cutCurrentTurn();
      this.quickRestarts = 0;
      this.dispatch({ type: 'voice_on' });
      await this.openMic('dictation');
    } finally {
      this.busy = false;
    }
  }

  /**
   * Dừng trò chuyện. Tắt cờ TRƯỚC (để vòng nghe tiếp không mở micro lại), rồi dừng tiếng đang đọc, đóng micro và huỷ lượt đang chạy.
   * Chữ nghe dở (chưa chốt) của lượt bị dừng biến mất, không để giống như trợ lý đã hiểu câu đó.
   */
  private stopVoice(reason: 'user' | 'idle'): void {
    this.dispatch({ type: 'voice_off', reason });
    this.cutCurrentTurn();
  }

  /** Nút "Đã nói xong": không chờ máy chủ nhận ra chỗ ngừng nói, chốt lượt ngay và để trợ lý trả lời. */
  async finishSpeaking(): Promise<void> {
    if (this.busy || this.state.phase !== 'listening') return;
    this.busy = true;
    try {
      await this.closeMic();
      this.client.endTurn();
      this.dispatch({ type: 'mic_stopped' });
    } finally {
      this.busy = false;
    }
  }

  /** Nút "Ngắt lời": trợ lý đang nghĩ hoặc đang đọc thì dừng ngay và nghe tiếp (SPEC 6.6). Vẫn đang trò chuyện. */
  async interruptAndListen(): Promise<void> {
    if (this.busy || !this.state.voice) return;
    this.busy = true;
    try {
      this.cutCurrentTurn();
      await this.openMic('dictation');
    } finally {
      this.busy = false;
    }
  }

  /** Vòng trò chuyện: lượt vừa xong thì mở micro nghe tiếp (do máy trạng thái yêu cầu qua `listen_again`). */
  private async listenAgain(attempt = 0): Promise<void> {
    if (!this.state.voice || this.state.phase !== 'idle') return;
    if (this.busy) {
      // Có thao tác của người dùng đang dở (ví dụ vừa chạm chọn một người): đợi nó xong rồi nghe tiếp.
      if (attempt < 10) setTimeout(() => void this.listenAgain(attempt + 1), 150);
      return;
    }
    if (this.listenStartedAt > 0 && Date.now() - this.listenStartedAt < QUICK_RESTART_MS && !this.heardSinceListen) {
      this.quickRestarts++;
      if (this.quickRestarts >= MAX_QUICK_RESTARTS) {
        this.quickRestarts = 0;
        this.dispatch({ type: 'mic_failed', reason: 'error' });
        return;
      }
    } else {
      this.quickRestarts = 0;
    }
    this.busy = true;
    try {
      await this.openMic('dictation');
    } finally {
      this.busy = false;
    }
  }

  /**
   * Nút micro ở M3 và nút Nói cạnh ô nhập: lượt `confirm` chỉ chép chữ, không gọi LLM. Kết quả về ở `state.transcript`.
   */
  async pressTranscribe(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.state.phase === 'listening') {
        await this.closeMic();
        this.client.endTurn();
        this.dispatch({ type: 'mic_stopped' });
        return;
      }
      this.cutCurrentTurn();
      await this.openMic('confirm');
    } finally {
      this.busy = false;
    }
  }

  /** Gõ chữ, chạm một câu gợi ý, hoặc chạm chọn trong danh sách: kết quả y hệt đường giọng nói. */
  async sendText(text: string): Promise<void> {
    const content = text.trim();
    if (!content || this.busy) return;
    this.busy = true;
    try {
      this.cutCurrentTurn();
      if (!(await this.ready())) return;
      if (!this.client.sendText(content)) {
        this.dispatch({ type: 'connect_failed', reason: 'resting' });
        return;
      }
      this.dispatch({ type: 'text_sent', text: content });
    } finally {
      this.busy = false;
    }
  }

  /** Nút "Dừng đọc". Đang trò chuyện thì dừng đọc nghĩa là ngắt lời và nghe tiếp. */
  stopSpeaking(): void {
    if (this.state.voice) {
      void this.interruptAndListen();
      return;
    }
    this.cutCurrentTurn();
  }

  /** Nút "Đọc lại": đọc câu trả lời đang hiện bằng giọng của máy. */
  async readAgain(): Promise<void> {
    if (!this.state.reply || this.state.phase !== 'idle') return;
    this.stopPlayback();
    await speakWithDevice(this.state.reply, this.speechRate);
  }

  setTyping(open: boolean): void {
    // Mở ô gõ chữ là chuyển sang gõ: dừng trò chuyện trước, không để micro mở trong lúc người dùng gõ.
    if (open && this.state.voice) this.stopVoice('user');
    this.dispatch({ type: 'typing', open });
  }

  dismissNotice(): void {
    this.dispatch({ type: 'notice_dismissed' });
  }

  proposalOpened(): void {
    this.dispatch({ type: 'proposal_opened' });
  }

  transcriptTaken(): void {
    this.dispatch({ type: 'transcript_taken' });
  }

  /**
   * Rời màn hình: micro tự đóng. `keepSpeaking`: đang sang M3 thì để trợ lý đọc nốt điều đã hiểu;
   * các trường hợp khác dừng đọc luôn.
   */
  leaveScreen(keepSpeaking = false): void {
    // Rời màn hình là dừng trò chuyện: micro không bao giờ mở ở màn hình khác, kể cả khi vừa bấm mà micro chưa kịp mở xong.
    if (this.state.voice) this.dispatch({ type: 'voice_off', reason: 'user' });
    this.micEpoch++;
    if (this.state.phase === 'listening') {
      void this.closeMic();
      this.client.interrupt();
      this.dispatch({ type: 'interrupted' });
      return;
    }
    if (!keepSpeaking) this.cutCurrentTurn();
  }

  /** Bắt đầu hội thoại mới trên màn hình (không đóng phiên: trợ lý vẫn nhớ ngữ cảnh của phiên đang mở). */
  clearScreen(): void {
    this.cutCurrentTurn();
    this.dispatch({ type: 'reset' });
  }

  /** Khoá app, app xuống nền, đăng xuất: đóng hết và quên câu chữ đang hiện. */
  shutdown(): void {
    // Huỷ cả việc mở micro đang dở, tắt giờ chờ và giữ-màn-hình-sáng: khoá app hay xuống nền là micro không được mở nữa.
    this.micEpoch++;
    this.clearVoiceIdle();
    this.setKeepAwake(false);
    this.levelMeter.reset();
    const signedOut = session.getSnapshot().status === 'signedOut';
    if (signedOut && this.consent !== null) {
      this.consent = null;
      this.publish();
    }
    const idle = this.client.state === 'closed' && this.state === INITIAL_ASSISTANT_STATE;
    if (idle) return;
    this.stopPlayback();
    void this.closeMic();
    this.assembler.reset();
    this.client.close();
    this.state = INITIAL_ASSISTANT_STATE;
    this.publish();
    this.watchThinking();
  }
}

export const assistant = new AssistantController();
