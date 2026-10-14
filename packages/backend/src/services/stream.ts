import { PG_NOTIFY_CHANNEL, type StreamEvent } from '@mihato/domain';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

/**
 * Phát một sự kiện SSE (chỉ id, không dữ liệu; SPEC 10.8) cho web quản trị. Sự kiện đi qua pg_notify và chỉ tới người xem được lượt chạy
 * (apps/api/src/sse.ts dùng cùng quy tắc tầm nhìn). Dùng cho thay đổi không đi qua engine, như bình luận và chia sẻ.
 */
export async function notifyStream(tx: Tx, event: StreamEvent): Promise<void> {
  await tx.execute(sql`select pg_notify(${PG_NOTIFY_CHANNEL}, ${JSON.stringify(event)})`);
}
