import { aiBudgetJob, briefingJob, clock, expireProposals, proposalApplyHandler, purgePendingFiles, registerEffectHandler, registerMaintenanceJob, type WorkerDeps } from '@mihato/backend';

/**
 * Nơi đăng ký các handler effect và việc định kỳ ngoài lõi bằng registerEffectHandler và registerMaintenanceJob
 * của @mihato/backend.
 *
 * - `proposal.apply`: áp một đề xuất đã xác nhận sau cửa hoàn tác 30 giây (SPEC 10.6 bước 5). Handler kiểm lại quyền
 *   và trạng thái rồi mới gọi advance(); đây là đường duy nhất để thay đổi do AI đề xuất đi vào lượt chạy.
 * - Mỗi phút: đề xuất `pending` quá hạn sang `expired` (bước 7), và dựng bản tin sáng cho người điều hành tới giờ (SPEC 10.9).
 */
export function registerWorkerExtensions(_deps: WorkerDeps): void {
  registerEffectHandler('proposal.apply', proposalApplyHandler);
  registerMaintenanceJob(async (tx, ctx) => {
    await expireProposals(tx, ctx);
  });
  // Ngân sách AI chạm 80% và 100%: báo it_admin một lần mỗi mốc mỗi tháng, không tự cắt trợ lý (SPEC 12.6).
  registerMaintenanceJob(async (tx, ctx) => {
    await aiBudgetJob(tx, ctx);
  });
  // Tệp tải lên mà không gắn vào việc nào sau 24 giờ thì dọn (docs/DECISIONS.md, 06/10/2026).
  registerMaintenanceJob(async (tx) => {
    await purgePendingFiles(tx, new Date(clock.now().getTime() - 24 * 3_600_000));
  });
  // Bản tin dùng mẫu văn bản; khi có TtsProvider và LlmClient thì truyền vào tham số thứ ba của briefingJob.
  registerMaintenanceJob(async (tx, ctx) => {
    await briefingJob(tx, ctx);
  });
}
