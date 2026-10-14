import { newId } from '@mihato/domain';
import { clock } from './clock';
import { schema, type Tx } from './db/client';

export type AuditInput = {
  orgId: string;
  action: string;
  actorType?: 'user' | 'system' | 'ai_service';
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** chỉ id, mã và số liệu; không chứa tên người, tên việc, số tiền, câu nói (CLAUDE.md luật 6) */
  detail?: Record<string, unknown>;
};

/** Nhật ký bảo mật và quản trị (SPEC 11.3). Chỉ thêm. Không thay cho run_events. */
export async function audit(tx: Tx, a: AuditInput): Promise<void> {
  await tx.insert(schema.auditLog).values({
    id: newId(),
    orgId: a.orgId,
    at: clock.now(),
    actorType: a.actorType ?? (a.actorUserId ? 'user' : 'system'),
    actorUserId: a.actorUserId ?? null,
    actorDeviceId: a.actorDeviceId ?? null,
    action: a.action,
    targetType: a.targetType ?? null,
    targetId: a.targetId ?? null,
    ip: a.ip ?? null,
    userAgent: a.userAgent ?? null,
    detail: a.detail ?? {},
  });
}
