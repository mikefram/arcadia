/**
 * @mihato/domain: nguồn của mọi kiểu dữ liệu (SPEC 3.5). Schema Zod ở đây là hợp đồng chung
 * giữa CSDL, engine, API, web và hai app.
 *
 * Các module tính toán nặng nằm ở đường dẫn con để app chỉ nạp thứ cần dùng:
 *   @mihato/domain/calendar      lịch làm việc và hạn (SPEC 4.5)
 *   @mihato/domain/lunar         lịch âm, chỉ để hiển thị và gợi ý ngày nghỉ
 *   @mihato/domain/vi-normalize  chuẩn hoá tiếng Việt bằng mã (SPEC 6.6)
 *   @mihato/domain/vi-speak      đổi số, tiền, ngày, viết tắt thành chữ đọc được (SPEC 6.4.1)
 *   @mihato/domain/nudge         ma trận xưng hô và mẫu lời nhắc (SPEC 4.7)
 */
export * from './enums';
export * from './ids';
export * from './process';
export * from './process-draft';
export * from './adhoc';
export * from './engine';
export * from './errors';
export * from './permissions';
export * from './permission-rules';
export * from './confidentiality';
export * from './contract';
export * from './api/common';
export * from './api/auth';
export * from './api/org';
export * from './api/permissions';
export * from './api/files';
export * from './api/documents';
export * from './document-number';
export * from './api/templates';
export * from './api/runs';
export * from './api/proposals';
export * from './api/notifications';
export * from './api/admin';
export * from './api/scribe';
