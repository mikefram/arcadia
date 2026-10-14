import { ApiError } from '@mihato/api-client';
import { vi } from '@mihato/i18n';
import type { Action } from '@mihato/domain';
import { errorMessage } from '@/lib/errors';

const t = vi.admin.org.permissions;

export const actionLabel = (action: Action): string => t.actions[action].label;
export const actionHint = (action: Action): string => t.actions[action].hint;
export const groupLabel = (id: string): string => (t.groups as Record<string, string>)[id] ?? id;

/** Câu cho lỗi lưu quyền: mã con của `input_invalid` (chống tự khoá mình ra, quyền bị khoá), không thì câu chung theo mã lỗi. */
export function permissionErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.extra.errors?.[0]?.code;
    const table: Record<string, string> = { ...t.errors, ...t.user.errors };
    if (code && table[code]) return table[code]!;
  }
  return errorMessage(error);
}
