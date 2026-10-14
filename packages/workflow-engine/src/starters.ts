import type { ProcessDefinition, ResolveContext } from '@mihato/domain';
import { buildDirectory, hasPermission, usableUser } from './directory';

/**
 * Người này có được khởi chạy quy trình này không (docs/DECISIONS.md, 06/10/2026). Hàm thuần.
 * Định nghĩa không khai `starters` (hoặc để trống) thì giữ cách cũ: người có quyền `run.start`.
 * Có khai báo thì chỉ người khớp ít nhất một dòng mới khởi chạy được. Người đã vô hiệu hoá hoặc không có trong danh bạ thì không.
 */
export function canStartRun(def: Pick<ProcessDefinition, 'starters'>, userId: string, ctx: ResolveContext): boolean {
  const user = usableUser(buildDirectory(ctx), userId);
  if (!user) return false;
  const rules = def.starters ?? [];
  if (rules.length === 0) return hasPermission(user, 'run.start');
  return rules.some((rule) => {
    switch (rule.kind) {
      case 'everyone':
        return true;
      case 'permission':
        return hasPermission(user, 'run.start');
      case 'role':
        return user.roles.some((r) => r.role === rule.role);
      case 'unit':
        return user.unitId === rule.unitId;
      case 'user':
        return user.id === rule.userId;
    }
  });
}
