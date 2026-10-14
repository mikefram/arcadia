import {
  compileStep,
  downloadFile,
  listEntries,
  listRegisters,
  attachRunFiles,
  listRunFiles,
  removePendingFile,
  uploadFile,
  upsertRegister,
} from '@mihato/backend';
import type { Registrar } from '../registrar';
import { requestMeta } from '../registrar';

/**
 * Tệp đính kèm, tệp tổng hợp và sổ văn bản (docs/DECISIONS.md, 06/10/2026). Handler mỏng; kiểm quyền xem theo lượt chạy,
 * kiểm loại và cỡ tệp, cấp số đều ở @mihato/backend.
 */
export function registerFileRoutes(r: Registrar): void {
  r.user('files.upload', ({ tx, ctx, viewer, input }) => uploadFile(tx, ctx, viewer, input.body));

  r.user('files.download', async ({ tx, ctx, viewer, input, reply }) => {
    const { row, data } = await downloadFile(tx, ctx, viewer, input.params.id);
    const name = row.name ?? 'tep';
    // Tên tệp theo RFC 5987 cho chữ có dấu; bản ASCII dự phòng cho trình duyệt cũ. Không bao giờ cho trình duyệt tự đoán loại nội dung.
    const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'tep';
    reply
      .header('Content-Type', row.mime)
      .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('Content-Length', data.length)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(data);
    // Đã gửi nội dung nhị phân: registrar không gửi thêm gì (reply.sent).
    return null;
  });

  r.user('files.remove', async ({ tx, viewer, input }) => {
    await removePendingFile(tx, viewer, input.params.id);
    return { ok: true };
  });

  r.user('runs.attachFiles', async ({ tx, ctx, viewer, input, req }) => ({ items: await attachRunFiles(tx, ctx, viewer, input.params.id, input.body.fileIds, requestMeta(req)) }));
  r.user('runs.files', async ({ tx, ctx, viewer, input }) => ({ items: await listRunFiles(tx, ctx, viewer, input.params.id) }));
  r.user('steps.compile', ({ tx, ctx, viewer, input, req }) => compileStep(tx, ctx, viewer, input.params.id, input.body.result, requestMeta(req)));

  r.user('registers.list', async ({ tx, ctx, viewer }) => ({ items: await listRegisters(tx, ctx, viewer) }));
  r.user('registers.upsert', ({ tx, ctx, viewer, input, req }) => upsertRegister(tx, ctx, viewer, input.params.code, input.body, requestMeta(req)));
  r.user('registers.entries', ({ tx, ctx, viewer, input }) => listEntries(tx, ctx, viewer, input.params.code, input.query));
}
