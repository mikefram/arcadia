/**
 * Giao diện JS của mô-đun gốc `DuplexAudio` (modules/duplex-audio; hôm nay chỉ có bản iOS): MỘT engine âm thanh vừa thu
 * micro vừa phát tiếng trợ lý, bật khử tiếng vọng của hệ điều hành. Nền tảng của việc ngắt lời trợ lý bằng giọng nói
 * (docs/DECISIONS.md, "Ngắt lời bằng giọng nói"). Chưa nối vào máy trạng thái của trợ lý: hôm nay chỉ màn đo khử vọng dùng.
 *
 * Mô-đun không có trong Expo Go, trên web và Android; khi đó `duplexAudio()` trả `null` và app giữ đường cũ
 * (thu bằng `AudioStream` của expo-audio, nút Ngắt lời).
 */

export type DuplexStartOptions = {
  /** Bật voice processing của hệ điều hành: khử tiếng vọng, giảm ồn. Tắt để so sánh. */
  voiceProcessing: boolean;
  /** true: phiên âm thanh chế độ gọi thoại (`voiceChat`); false: chế độ thường. */
  voiceChatMode: boolean;
  /** Độ dài mỗi khung gửi lên JS, 10 đến 200 mili giây. */
  frameMs: number;
  /** false: chỉ gửi mức âm, không gửi PCM. */
  emitPcm: boolean;
};

export type DuplexStartResult = {
  /** Tần số micro thật sự trả về (trước khi đổi sang 16 kHz). */
  inputSampleRate: number;
  inputChannels: number;
  /** Voice processing có thật sự đang bật không (xin bật mà hệ điều hành không cho thì false). */
  voiceProcessing: boolean;
  /** Ví dụ `Speaker / MicrophoneBuiltIn`. */
  route: string;
};

/** Một khung PCM 16-bit, 16 kHz, đơn kênh (nếu `emitPcm`), kèm mức âm đo trên chính khung đó. */
export type DuplexFrameEvent = {
  /** Mức RMS của micro sau khử vọng, dBFS (0 là toàn thang, -120 là im lặng). */
  micDb: number;
  peakDb: number;
  /** Mức tín hiệu đang phát ra loa, cùng thang. -120 khi loa im. */
  refDb: number;
  /** Mili giây kể từ lúc mở, theo đồng hồ của mô-đun. */
  t: number;
  /** PCM mã base64; vắng khi `emitPcm` là false. */
  pcm?: string;
};

export type DuplexPlaybackEvent = { state: 'started' | 'ended' | 'stopped' };

/** `stopped` kèm lý do (`config_change`, `interruption`); `route` kèm mô tả đường âm thanh mới. */
export type DuplexStateEvent = { state: 'stopped' | 'route'; detail: string };

export type Subscription = { remove(): void };

export interface DuplexAudioNative {
  start(options: DuplexStartOptions): Promise<DuplexStartResult>;
  stop(): Promise<void>;
  /** Phát một tệp (wav, mp3, m4a) qua cùng engine. `uri` là đường dẫn `file://` hoặc đường dẫn tuyệt đối. */
  playFile(uri: string): Promise<void>;
  stopPlayback(): Promise<void>;
  getRoute(): string;
  addListener(event: 'onFrame', listener: (event: DuplexFrameEvent) => void): Subscription;
  addListener(event: 'onPlayback', listener: (event: DuplexPlaybackEvent) => void): Subscription;
  addListener(event: 'onState', listener: (event: DuplexStateEvent) => void): Subscription;
}
