import { onlineManager } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { QueueItem } from './offline/queue';
import type { SessionSnapshot } from './session/controller';
import { queue, session } from './services';

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

const subscribeOnline = (listener: () => void) => onlineManager.subscribe(listener);
const getOnline = () => onlineManager.isOnline();

/** Đang có mạng hay không, theo cùng nguồn mà TanStack Query và hàng đợi ngoại tuyến dùng. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnline, getOnline);
}

export function useQueueItems(): readonly QueueItem[] {
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
}

/** Thao tác trong hàng đợi của một việc: đang chờ gửi và đã bị từ chối. */
export function useStepQueue(stepId: string | undefined): { pending: QueueItem[]; rejected: QueueItem[] } {
  const items = useQueueItems();
  return useMemo(() => {
    const mine = items.filter((i) => i.stepId === stepId);
    return { pending: mine.filter((i) => i.status === 'pending'), rejected: mine.filter((i) => i.status === 'rejected') };
  }, [items, stepId]);
}

/** Giờ hiện tại, tự cập nhật mỗi phút, để chữ "hôm nay", "ngày mai" không cũ khi màn hình mở lâu. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
