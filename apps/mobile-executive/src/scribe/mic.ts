import { requireOptionalNativeModule } from 'expo';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { Platform } from 'react-native';
import { configurePlaybackAudioMode } from './audio-mode';
import { MicError, NativeMicSource, type MicSource, type NativeAudioStream, type NativeStreamOptions } from './mic-core';
import { Downsampler, PcmFramer, TARGET_SAMPLE_RATE } from './pcm';

export { MicError, type MicErrorReason, type MicSource } from './mic-core';

/**
 * Nguồn thu âm (SPEC 6.1, 10.7.2): PCM 16-bit, đơn kênh, 16 kHz, little-endian, mỗi khung 20 đến 100 ms.
 *
 * Câu hỏi Q15 (thư viện thu PCM trên iOS và Android) vẫn chờ Mike xác nhận sau khi thử trên máy thật; kết quả thử
 * ghi ở docs/benchmarks/mic-streaming-2026.md. Hôm nay có ba nguồn:
 * - `WebMicSource`: bản web, để thử được trọn đường giọng nói trên trình duyệt.
 * - `NativeMicSource` (mic-core.ts): iOS và Android, dùng `AudioStream` của expo-audio (có từ SDK 56, chạy trong Expo Go).
 * - `UnsupportedMicSource`: máy hoặc bản Expo Go chưa có `AudioStream`. `start()` ném `MicError('unsupported')`, app tự chuyển sang gõ chữ.
 */
export class UnsupportedMicSource implements MicSource {
  async start(): Promise<void> {
    // "chưa hỗ trợ thu âm trên máy này": câu hiện cho người dùng nằm ở vi.executive.assistant.micUnsupported
    throw new MicError('unsupported');
  }
  async stop(): Promise<void> {}
}

/** Mã của AudioWorklet: chuyển từng khối mẫu của kênh đầu về luồng chính. Nạp qua Blob để không cần tệp riêng. */
const WORKLET_SOURCE = `
class MihatoMicTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('mihato-mic-tap', MihatoMicTap);
`;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/**
 * Thu âm trên trình duyệt: getUserMedia, rồi AudioWorklet (hoặc ScriptProcessor ở trình duyệt cũ) lấy mẫu số thực,
 * hạ mẫu về 16 kHz và đổi sang PCM 16-bit. Không ghi âm thanh ra đâu cả; mỗi khung gửi đi rồi bỏ.
 */
export class WebMicSource implements MicSource {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private framer: PcmFramer | null = null;
  private onChunk: ((pcm16: Uint8Array) => void) | null = null;

  async start(onChunk: (pcm16: Uint8Array) => void): Promise<void> {
    await this.stop();
    const Ctor = audioContextCtor();
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!Ctor || !media?.getUserMedia) throw new MicError('unsupported');

    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new MicError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unsupported' : 'error');
    }

    try {
      const context = new Ctor();
      if (context.state === 'suspended') await context.resume();
      const source = context.createMediaStreamSource(stream);
      const downsampler = new Downsampler(context.sampleRate, TARGET_SAMPLE_RATE);
      const framer = new PcmFramer();
      const handle = (samples: Float32Array) => {
        const emit = this.onChunk;
        if (!emit) return;
        for (const frame of framer.push(downsampler.process(samples))) emit(frame);
      };

      let node: AudioNode;
      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        try {
          await context.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const worklet = new AudioWorkletNode(context, 'mihato-mic-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => handle(event.data);
        source.connect(worklet);
        node = worklet;
      } else {
        // Trình duyệt chưa có AudioWorklet: dùng ScriptProcessor (đã cũ nhưng còn chạy).
        const processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => handle(new Float32Array(event.inputBuffer.getChannelData(0)));
        source.connect(processor);
        processor.connect(context.destination);
        node = processor;
      }

      this.stream = stream;
      this.context = context;
      this.source = source;
      this.node = node;
      this.framer = framer;
      this.onChunk = onChunk;
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      throw err instanceof MicError ? err : new MicError('error');
    }
  }

  async stop(): Promise<void> {
    const { stream, context, node, source, framer, onChunk } = this;
    this.stream = null;
    this.context = null;
    this.node = null;
    this.source = null;
    this.framer = null;
    this.onChunk = null;
    if (!stream && !context) return;
    // Phần lẻ cuối cùng của câu nói vẫn gửi đi trước khi đóng.
    const tail = framer?.flush();
    if (tail && onChunk) onChunk(tail);
    try {
      source?.disconnect();
      node?.disconnect();
    } catch {}
    for (const track of stream?.getTracks() ?? []) track.stop();
    try {
      await context?.close();
    } catch {}
  }
}

type NativeAudioModule = { AudioStream?: new (options: NativeStreamOptions) => NativeAudioStream };

/** Mô-đun âm thanh gốc của expo-audio; null trên web, hoặc khi bản dựng (Expo Go cũ) không có mô-đun này. */
function nativeAudioModule(): NativeAudioModule | null {
  return Platform.OS === 'web' ? null : requireOptionalNativeModule<NativeAudioModule>('ExpoAudio');
}

/** Máy này có lớp `AudioStream` hay không. Không có thì app giữ đường gõ chữ, không báo lỗi lạ. */
function nativeStreamAvailable(): boolean {
  return !!nativeAudioModule()?.AudioStream;
}

/** Bản web và máy có `AudioStream` thu được âm; còn lại tự chuyển sang gõ chữ. */
export function createMicSource(): MicSource {
  if (Platform.OS === 'web') return new WebMicSource();
  if (!nativeStreamAvailable()) return new UnsupportedMicSource();
  return new NativeMicSource({
    requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
    createStream: (options) => {
      const Stream = nativeAudioModule()?.AudioStream;
      if (!Stream) throw new Error('audio_stream_unavailable');
      return new Stream(options);
    },
    restorePlayback: configurePlaybackAudioMode,
  });
}

/** Máy này có đường thu âm hay không (để chọn `channel: 'voice'` hay `'text'` khi tạo phiên). */
export function micSupported(): boolean {
  if (Platform.OS === 'web') return audioContextCtor() !== null && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  return nativeStreamAvailable();
}
