import type { StepView } from '@mihato/domain';
import { useMe, useRun } from '../data/queries';
import { FilesSection } from './FileList';
import { ContributionInfo, RunInfo } from './RunInfo';

/**
 * Ba mục của chi tiết việc (S2) và màn gửi phần hay duyệt (S6) cần thông tin của lượt chạy: "Thông tin của lượt", "Tệp đính kèm",
 * và với việc duyệt hoặc đóng góp thì "Người cùng gửi phần" và phần mình đã gửi. Lượt chạy tải bằng `GET /v1/runs/:id`;
 * việc giao riêng không có lượt để đọc nên chỉ hiện tệp của chính việc đó.
 */
export function StepRunSections({ step }: { step: StepView }) {
  const me = useMe();
  const run = useRun(step.runId, !step.adhoc);
  const retry = () => void run.refetch();
  return (
    <>
      {!step.adhoc ? <RunInfo stepId={step.id} run={run.data} loading={run.isLoading} failed={run.isError} onRetry={retry} /> : null}
      <FilesSection stepId={step.id} stepFiles={step.files} runFiles={run.data?.files} runLoading={!step.adhoc && run.isLoading} runFailed={!step.adhoc && run.isError} onRetry={retry} />
      {step.kind === 'approval' ? <ContributionInfo step={step} myId={me.data?.id ?? null} run={run.data} /> : null}
    </>
  );
}
