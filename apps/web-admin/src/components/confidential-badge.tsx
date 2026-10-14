import { Lock } from 'lucide-react';
import type { Confidentiality } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { Badge } from '@/components/ui/badge';

const t = vi.admin.runs.confidential;

/** Huy hiệu "Mật" của lượt chạy `restricted` (văn bản mật): biểu tượng khoá và chữ, không dựa vào màu. Lượt thường thì không vẽ gì. */
export function ConfidentialBadge({ confidentiality, className }: { confidentiality: Confidentiality | undefined; className?: string }) {
  if (confidentiality !== 'restricted') return null;
  return (
    <Badge tone="gold" title={t.badgeHint} className={className} data-testid="confidential-badge">
      <Lock aria-hidden="true" />
      {t.badge}
    </Badge>
  );
}
