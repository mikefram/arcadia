import type { StepView } from '@mihato/domain';
import { useCachedRunConfidentiality } from '../data/queries';
import { Chip } from '../ui/Chip';
import { stepBadges } from './comments';
import { Discussion } from './Discussion';

/** Chip "n bình luận" và "Mật" của một việc; "Mật" lấy từ lượt đã tải (chi tiết việc tải lượt ngay), không gọi mạng thêm. */
export function StepBadgeChips({ step }: { step: Pick<StepView, 'runId' | 'adhoc' | 'commentCount'> }) {
  const confidentiality = useCachedRunConfidentiality(step.runId, step.adhoc);
  return (
    <>
      {stepBadges(step, confidentiality).map((b) => (
        <Chip key={b.key} label={b.label} tone="neutral" glyph={b.key === 'restricted' ? 'lock' : 'chat'} testID={`chip-${b.key}`} />
      ))}
    </>
  );
}

/** Mục Thảo luận của một việc, kèm nhắc "Mật" khi lượt là văn bản mật. */
export function StepDiscussion({ step, onLayoutY }: { step: Pick<StepView, 'id' | 'runId' | 'adhoc'>; onLayoutY?: (y: number) => void }) {
  const confidentiality = useCachedRunConfidentiality(step.runId, step.adhoc);
  return <Discussion stepId={step.id} restricted={confidentiality === 'restricted'} onLayoutY={onLayoutY} />;
}
