import type { WorkflowEngine } from '@mihato/domain';
import { advance } from './advance';
import { createRun } from './create-run';
import { replay } from './replay';
import { simulate } from './simulate';
import { validate } from './validate';

/**
 * @mihato/workflow-engine: engine quy trình thuần (SPEC 4). Không I/O, không đọc đồng hồ, không số ngẫu nhiên:
 * mọi thứ engine cần (đồng hồ, danh bạ, ủy quyền, lịch làm việc) được truyền vào; mọi thứ engine muốn làm
 * với thế giới bên ngoài (thông báo, hẹn giờ, webhook) được trả về dưới dạng effect để tầng lưu trữ ghi
 * trong cùng giao dịch.
 */
export { advance, createRun, replay, simulate, validate };
export { appointedFor, assertAppointed, type Appointed } from './appointed';
export { canStartRun } from './starters';
export { STANDARD_REMINDERS, STRICT_REMINDERS } from './reminders';

export const engine: WorkflowEngine = { createRun, advance, validate, simulate, replay };
