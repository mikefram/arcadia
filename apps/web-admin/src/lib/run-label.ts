import type { StepView } from '@mihato/domain';
import { vi } from '@mihato/i18n';

/**
 * Dòng "thuộc đâu" dưới tên một việc: tên lượt chạy, hoặc "Việc giao riêng" khi việc không thuộc quy trình nào
 * (khi đó tên lượt chạy trùng tên việc nên không nhắc lại; docs/DECISIONS.md, 05/10/2026).
 */
export function runLabel(step: Pick<StepView, 'adhoc' | 'runTitle'>): string {
  return step.adhoc ? vi.admin.runs.list.adhoc : step.runTitle;
}
