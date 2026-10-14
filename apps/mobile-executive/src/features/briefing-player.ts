import type { Briefing } from '@mihato/domain';
import { playAudioUrl, type Playback } from '../scribe/player';
import { speakWithDevice, stopDeviceSpeech, type SpeechRateName } from '../scribe/speech';
import { session } from '../services';

/**
 * Nghe báo cáo tổng hợp đầu ngày (SPEC 6.7, 10.9): có `audioUrl` thì phát tệp; không có, hoặc tệp không phát được, thì đọc `text`
 * bằng giọng của hệ điều hành. Chữ hiện cùng lúc trên màn hình. Có nút dừng.
 */
export type BriefingPlayerState = 'idle' | 'preparing' | 'playing' | 'finished' | 'unavailable';

class BriefingPlayer {
  private state: BriefingPlayerState = 'idle';
  private listeners = new Set<() => void>();
  private playback: Playback | null = null;
  private run = 0;

  constructor() {
    session.subscribe(() => {
      if (session.getSnapshot().status !== 'unlocked') this.stop();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BriefingPlayerState => this.state;

  private set(state: BriefingPlayerState): void {
    if (this.state === state) return;
    this.state = state;
    for (const l of this.listeners) l();
  }

  async play(briefing: Pick<Briefing, 'text' | 'audioUrl'>, rate: SpeechRateName): Promise<void> {
    this.stop();
    const run = ++this.run;
    this.set('preparing');
    const keepAwake = setInterval(() => session.noteActivity(), 15_000);
    try {
      if (briefing.audioUrl) {
        const playback = playAudioUrl(briefing.audioUrl);
        this.playback = playback;
        this.set('playing');
        try {
          const completed = await playback.finished;
          if (run !== this.run) return;
          this.playback = null;
          this.set(completed ? 'finished' : 'idle');
          return;
        } catch {
          // Tệp hết hạn chữ ký hoặc không phát được: đọc bằng giọng của máy.
          if (run !== this.run) return;
          this.playback = null;
        }
      }
      this.set('playing');
      const spoken = await speakWithDevice(briefing.text, rate);
      if (run !== this.run) return;
      this.set(spoken ? 'finished' : 'unavailable');
    } finally {
      clearInterval(keepAwake);
    }
  }

  stop(): void {
    this.run++;
    const playback = this.playback;
    this.playback = null;
    playback?.stop();
    stopDeviceSpeech();
    this.set('idle');
  }
}

export const briefingPlayer = new BriefingPlayer();
