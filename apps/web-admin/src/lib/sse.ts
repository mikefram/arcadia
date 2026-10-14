import { useEffect, useSyncExternalStore } from 'react';
import type { RouteKey } from '@mihato/api-client';
import { queryClient } from './query';

/**
 * Cập nhật thời gian thực cho web (SPEC 10.8). Sự kiện chỉ mang id, không mang dữ liệu: nhận được thì
 * làm mới các truy vấn liên quan, gộp trong 300 ms. Nối lại sau khi mất kết nối thì làm mới mọi truy vấn
 * đang mở, vì máy chủ không phát lại sự kiện đã lỡ.
 */
const STREAM_URL = '/v1/stream';
const BATCH_MS = 300;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

type StreamKind = 'run.updated' | 'step.updated' | 'proposal.updated' | 'notification.created' | 'template.updated';

/** Loại sự kiện → các khoá route cần làm mới. Thêm màn hình mới đọc route khác thì bổ sung ở đây. */
const AFFECTED: Record<StreamKind, readonly RouteKey[]> = {
  'run.updated': ['runs.list', 'runs.get', 'runs.events', 'steps.list', 'steps.get', 'overview.get', 'activity.list', 'extensionRequests.list', 'reports.summary'],
  'step.updated': ['steps.list', 'steps.get', 'runs.list', 'runs.get', 'runs.events', 'overview.get', 'activity.list', 'extensionRequests.list', 'reports.summary'],
  'proposal.updated': ['proposals.list', 'proposals.get'],
  // Bình luận mới đến người giữ việc và người khởi chạy bằng một thông báo (comment_new): làm mới luôn thảo luận đang mở.
  'notification.created': ['notifications.list', 'admin.notifications', 'steps.comments.list', 'steps.list', 'steps.get'],
  'template.updated': ['templates.list', 'templates.get', 'templates.version'],
};
const KINDS = Object.keys(AFFECTED) as StreamKind[];

function isStreamKind(v: unknown): v is StreamKind {
  return typeof v === 'string' && v in AFFECTED;
}

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

let status: LiveStatus = 'connecting';
const listeners = new Set<() => void>();

function setStatus(next: LiveStatus): void {
  if (status === next) return;
  status = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Trạng thái kết nối để hiện dòng "Số liệu đang tự cập nhật" hoặc "Mất kết nối, đang nối lại…". */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(subscribe, () => status);
}

/** Gắn một lần ở bố cục chính (đã đăng nhập). */
export function useLiveUpdates(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = RETRY_MIN_MS;
    let wasDisconnected = false;
    let stopped = false;
    const pending = new Set<RouteKey>();

    const flush = () => {
      flushTimer = undefined;
      const keys = [...pending];
      pending.clear();
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
    };

    const queue = (kind: StreamKind) => {
      for (const key of AFFECTED[kind]) pending.add(key);
      flushTimer ??= setTimeout(flush, BATCH_MS);
    };

    const connect = () => {
      if (stopped) return;
      const es = new EventSource(STREAM_URL, { withCredentials: true });
      source = es;

      es.onopen = () => {
        retryDelay = RETRY_MIN_MS;
        setStatus('live');
        if (wasDisconnected) {
          wasDisconnected = false;
          void queryClient.invalidateQueries();
        }
      };

      // Máy chủ có thể gửi sự kiện có tên (event: run.updated) hoặc sự kiện mặc định với `kind` trong dữ liệu.
      for (const kind of KINDS) es.addEventListener(kind, () => queue(kind));
      es.onmessage = (ev: MessageEvent<unknown>) => {
        if (typeof ev.data !== 'string') return;
        try {
          const parsed: unknown = JSON.parse(ev.data);
          const kind = typeof parsed === 'object' && parsed !== null ? (parsed as { kind?: unknown }).kind : undefined;
          if (isStreamKind(kind)) queue(kind);
        } catch {
          // dòng không phải JSON (ví dụ ping): bỏ qua
        }
      };

      es.onerror = () => {
        wasDisconnected = true;
        setStatus('reconnecting');
        // CONNECTING: trình duyệt tự nối lại. CLOSED (máy chủ trả mã khác 200): tự nối lại, giãn dần.
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          if (source === es) source = null;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
        }
      };
    };

    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(flushTimer);
      source?.close();
      setStatus('connecting');
    };
  }, [enabled]);
}
