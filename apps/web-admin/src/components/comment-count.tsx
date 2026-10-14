import { MessageSquare } from 'lucide-react';
import { fmt, vi } from '@mihato/i18n';
import { Badge } from '@/components/ui/badge';

/** Số bình luận của một việc (`StepView.commentCount`); không có bình luận thì không vẽ gì. */
export function CommentCount({ count, className }: { count: number | undefined; className?: string }) {
  if (!count || count <= 0) return null;
  return (
    <Badge tone="muted" className={className} data-testid="comment-count">
      <MessageSquare aria-hidden="true" />
      {fmt(vi.admin.runs.comments.count, { n: count })}
    </Badge>
  );
}
