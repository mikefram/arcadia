import type { ProcessDefinition, ResolveContext, RunEventRecord, RunState } from '@mihato/domain';
import { runAdvance } from './advance';

/**
 * Phát lại: áp lại toàn bộ `run_events` từ lượt chạy `draft`, phải cho đúng trạng thái hiện tại từng bit
 * (SPEC 4.10 thuộc tính 3). Mỗi sự kiện được áp với `now` = thời điểm đã ghi ở dòng sự kiện (`at`).
 * Không kiểm lại quyền: sự kiện đã được cấp phép lúc xảy ra, còn danh bạ hiện tại có thể đã khác.
 */
export function replay(input: { def: ProcessDefinition; initial: RunState; events: RunEventRecord[]; ctx: ResolveContext }): RunState {
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq);
  let run = input.initial;
  for (const record of ordered) {
    run = runAdvance(
      { def: input.def, run, event: record.payload.event, ctx: input.ctx, now: new Date(record.at) },
      { checkPermissions: false },
    ).run;
  }
  return run;
}
