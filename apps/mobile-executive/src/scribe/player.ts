import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { devTrace } from './trace';

/**
 * Phát âm thanh câu trả lời (mp3 đã ghép) và tệp bản tin sáng. iOS và Android dùng expo-audio; bản web dùng `Audio`
 * của trình duyệt. Âm thanh KHÔNG được lưu lại: trên máy, khối mp3 ghi ra một tệp tạm trong thư mục đệm chỉ để phát,
 * phát xong (hoặc bị dừng) là xoá ngay.
 */
export type Playback = {
  /** kết thúc: true khi phát hết, false khi bị dừng. Ném lỗi khi không phát được (app sẽ đọc bằng giọng của máy). */
  finished: Promise<boolean>;
  stop(): void;
};

const START_TIMEOUT_MS = 8000;

function playOnWeb(src: string, revoke: (() => void) | null): Playback {
  let stopped = false;
  const audio = new Audio(src);
  let settle: ((ok: boolean) => void) | null = null;
  const finished = new Promise<boolean>((resolve, reject) => {
    const done = (ok: boolean) => {
      revoke?.();
      resolve(ok);
    };
    settle = done;
    audio.onended = () => done(true);
    audio.onerror = () => {
      revoke?.();
      if (stopped) resolve(false);
      else reject(new Error('audio_playback_failed'));
    };
    audio.play().catch(() => {
      revoke?.();
      if (stopped) resolve(false);
      else reject(new Error('audio_playback_failed'));
    });
  });
  return {
    finished,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        audio.pause();
      } catch {}
      settle?.(false);
    },
  };
}

function playOnDevice(uri: string, cleanup: (() => void) | null): Playback {
  let stopped = false;
  let player: AudioPlayer | null = null;
  let settle: ((ok: boolean) => void) | null = null;
  const release = () => {
    try {
      player?.remove();
    } catch {}
    player = null;
    cleanup?.();
  };
  const finished = new Promise<boolean>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean, failed = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      release();
      if (failed && !stopped) reject(new Error('audio_playback_failed'));
      else resolve(ok);
    };
    settle = (ok) => finish(ok);
    let started = false;
    const timer = setTimeout(() => {
      if (!started) devTrace(`expo-audio: ${START_TIMEOUT_MS} ms mà chưa phát được, chuyển sang giọng máy`);
      if (!started) finish(false, true);
    }, START_TIMEOUT_MS);
    try {
      player = createAudioPlayer({ uri });
      let lastSignature = '';
      player.addListener('playbackStatusUpdate', (status) => {
        const signature = `playing=${status.playing} loaded=${status.isLoaded} duration=${status.duration} buffering=${status.isBuffering} lỗi=${status.error ? 'có' : 'không'} xong=${status.didJustFinish}`;
        if (signature !== lastSignature) devTrace(`expo-audio: ${signature}`);
        lastSignature = signature;
        if (status.error) return finish(false, true);
        if (status.playing) started = true;
        if (status.didJustFinish) finish(true);
      });
      player.play();
    } catch {
      finish(false, true);
    }
  });
  return {
    finished,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        player?.pause();
      } catch {}
      settle?.(false);
    },
  };
}

let tempSeq = 0;

/** Phát một khối mp3 trong bộ nhớ (các khung nhị phân giữa `audio.start` và `audio.end` đã ghép). */
export function playMp3Bytes(bytes: Uint8Array): Playback {
  if (Platform.OS === 'web') {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: 'audio/mpeg' }));
    return playOnWeb(url, () => URL.revokeObjectURL(url));
  }
  const file = new File(Paths.cache, `tra-loi-${Date.now()}-${++tempSeq}.mp3`);
  const remove = () => {
    try {
      if (file.exists) file.delete();
    } catch {}
  };
  try {
    file.create({ overwrite: true });
    file.write(bytes);
  } catch {
    remove();
    return { finished: Promise.reject(new Error('audio_playback_failed')), stop: () => undefined };
  }
  return playOnDevice(file.uri, remove);
}

/** Phát tệp âm thanh từ đường dẫn có chữ ký (bản tin sáng, sống 10 phút). */
export function playAudioUrl(url: string): Playback {
  return Platform.OS === 'web' ? playOnWeb(url, null) : playOnDevice(url, null);
}
