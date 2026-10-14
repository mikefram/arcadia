import { ApiError, newId, type TemplateVersion } from '@mihato/domain';
import { desc, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { schema, type Tx } from '../src/db/client';

/** Chờ một lỗi nghiệp vụ có đúng mã; trả lỗi để test xem tiếp `errors[]`, `currentState`. */
export async function expectApiError(promise: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`Chờ lỗi ${code} nhưng lời gọi lại thành công`);
}

/** Quy trình nhỏ hợp lệ: hai việc chạy song song ngay sau Bắt đầu, hạn tính từ lúc tới lượt. */
/**
 * Ủy quyền toàn phần từ `fromUserId` sang `toUserId`, hiệu lực cả năm 2026 và 2027, ghi thẳng vào bảng để test dựng được cảnh
 * "người được ủy quyền nhận việc". Việc trong quy trình chỉ giao lại được cho người được bổ nhiệm hoặc người được ủy quyền
 * (docs/DECISIONS.md, 05/10/2026), nên test cần giao lại một việc phải dựng ủy quyền này trước.
 */
export async function delegate(tx: Tx, orgId: string, createdBy: string, fromUserId: string, toUserId: string): Promise<void> {
  await tx.insert(schema.delegations).values({
    id: newId(),
    orgId,
    fromUserId,
    toUserId,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: new Date('2027-12-31T00:00:00Z'),
    scope: 'all',
    scopeRef: null,
    createdBy,
  });
}

export function twoTaskDefinition(name: string, firstAssigneeId: string, secondAssigneeId: string): TemplateVersion['definition'] {
  return {
    schemaVersion: 1,
    name,
    inputs: [],
    layout: { start: { x: 0, y: 100 }, t1: { x: 200, y: 0 }, t2: { x: 200, y: 200 }, end: { x: 400, y: 100 } },
    nodes: [
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      { id: 't1', type: 'task', label: 'Soạn', title: 'Soạn hồ sơ', assignee: { kind: 'user', userId: firstAssigneeId }, due: { anchor: 'activation', offset: { value: 2, unit: 'working_day' } } },
      { id: 't2', type: 'task', label: 'Kiểm', title: 'Kiểm hồ sơ', assignee: { kind: 'user', userId: secondAssigneeId }, due: { anchor: 'activation', offset: { value: 3, unit: 'working_day' } } },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 't1' },
      { id: 'e2', from: 'start', to: 't2' },
      { id: 'e3', from: 't1', to: 'end' },
      { id: 'e4', from: 't2', to: 'end' },
    ],
  };
}

/** Các dòng audit_log của tổ chức đang đặt ở giao dịch, mới nhất trước, lọc theo hành động. */
export async function auditRows(tx: Tx, action: string) {
  return tx.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).orderBy(desc(schema.auditLog.at), desc(schema.auditLog.id));
}
