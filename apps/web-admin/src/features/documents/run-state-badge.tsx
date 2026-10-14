import { Ban, Check, CircleDashed, CircleSlash, Play, type LucideIcon } from 'lucide-react';
import type { RunStateName } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { Badge, type BadgeProps } from '@/components/ui/badge';

const t = vi.admin.documents.runState;

/** Mỗi tình trạng một hình và một chữ riêng: phân biệt không chỉ bằng màu. Không dùng tông "quá hạn" (chỉ dành cho việc trễ hạn). */
const VIEW: Record<RunStateName, { icon: LucideIcon; tone: NonNullable<BadgeProps['tone']> }> = {
  draft: { icon: CircleDashed, tone: 'muted' },
  running: { icon: Play, tone: 'neutral' },
  completed: { icon: Check, tone: 'primary' },
  cancelled: { icon: Ban, tone: 'muted' },
  failed: { icon: CircleSlash, tone: 'warn' },
};

/** Tình trạng xử lý của lượt chạy gắn với một dòng sổ: đang xử lý, đã hoàn tất, đã huỷ… */
export function RunStateBadge({ state }: { state: RunStateName }) {
  const { icon: Icon, tone } = VIEW[state];
  return (
    <Badge tone={tone} data-testid="entry-state" data-state={state}>
      <Icon aria-hidden="true" />
      {t[state]}
    </Badge>
  );
}
