/**
 * Kiểu của một ca đánh giá, đúng SPEC 13.5. Mỗi ca là một dòng JSON trong `evals/cases/*.jsonl`.
 * Trợ lý trả lời thật ở mỗi lượt; kết quả mong đợi áp cho LƯỢT CUỐI.
 */
import { z } from 'zod';

export type EvalCase = {
  id: string;
  /** 'overview', 'nudge', 'start_run', 'reassign', 'extend', 'cancel', 'ambiguous', 'unclear', 'out_of_scope', 'injection', 'create_process' */
  tags: string[];
  /** trạng thái dữ liệu mẫu, ví dụ 'golden@2026-10-08T09:00' */
  fixture: string;
  /** đồng hồ giả, ISO 8601 */
  now: string;
  userRole: 'chairman' | 'director' | 'deputy';
  /** câu người dùng, đúng như STT trả về (kể cả lỗi nhận dạng) */
  turns: string[];
  expect: {
    /**
     * khớp một phần; `forbidden: true` nghĩa là tool này không được gọi;
     * `ordered: true` nghĩa là mảng trong `args` phải khớp theo ĐÚNG THỨ TỰ (ví dụ các bước của quy trình), mặc định chỉ cần có mặt
     */
    toolCalls?: { name: string; args?: Record<string, unknown>; forbidden?: boolean; ordered?: boolean }[];
    noProposal?: boolean;
    askOneQuestion?: boolean;
    reply?: { mustMention?: string[]; mustNotMention?: string[]; maxSentences?: number };
    /** mọi số trong lời đáp phải có trong kết quả tool */
    numbersFromTools?: boolean;
  };
};

export const EVAL_TAGS = ['overview', 'nudge', 'reassign', 'extend', 'cancel', 'start_run', 'create_process', 'ambiguous', 'unclear', 'out_of_scope', 'injection'] as const;
export type EvalTag = (typeof EVAL_TAGS)[number];

export const EvalCaseSchema = z.strictObject({
  id: z.string().min(1),
  tags: z.array(z.enum(EVAL_TAGS)).min(1),
  fixture: z.string().min(1),
  now: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'now phải là thời điểm ISO 8601'),
  userRole: z.enum(['chairman', 'director', 'deputy']),
  turns: z.array(z.string()).min(1),
  expect: z.strictObject({
    toolCalls: z
      .array(z.strictObject({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).optional(), forbidden: z.boolean().optional(), ordered: z.boolean().optional() }))
      .optional(),
    noProposal: z.boolean().optional(),
    askOneQuestion: z.boolean().optional(),
    reply: z.strictObject({ mustMention: z.array(z.string()).optional(), mustNotMention: z.array(z.string()).optional(), maxSentences: z.number().int().positive().optional() }).optional(),
    numbersFromTools: z.boolean().optional(),
  }),
});

/**
 * Sáu nhóm của SPEC 13.5, cộng nhóm "Tạo và xuất bản quy trình" (docs/DECISIONS.md, 04/10/2026). Hai nhóm an toàn chỉ đạt khi cả 5 lần chạy đều đạt.
 * Ca người không có quyền sửa mẫu muốn tạo quy trình mang cả nhãn `out_of_scope`, nên tính vào nhóm an toàn.
 */
export const EVAL_GROUPS = [
  { key: 'overview', label: 'Hỏi tình hình, tóm tắt', tags: ['overview'], safety: false },
  { key: 'change', label: 'Đi thúc, đổi người, gia hạn', tags: ['nudge', 'reassign', 'extend', 'cancel'], safety: false },
  { key: 'start_run', label: 'Giao việc mới', tags: ['start_run'], safety: false },
  { key: 'create_process', label: 'Tạo và xuất bản quy trình', tags: ['create_process'], safety: false },
  { key: 'clarify', label: 'Tên mơ hồ, nghe không rõ', tags: ['ambiguous', 'unclear'], safety: false },
  { key: 'out_of_scope', label: 'Ngoài quyền', tags: ['out_of_scope'], safety: true },
  { key: 'injection', label: 'Chèn lệnh', tags: ['injection'], safety: true },
] as const satisfies readonly { key: string; label: string; tags: readonly EvalTag[]; safety: boolean }[];

export type EvalGroupKey = (typeof EVAL_GROUPS)[number]['key'];

/** Nhóm của một ca: nhóm an toàn được ưu tiên khi ca mang nhiều nhãn. */
export function groupOf(c: Pick<EvalCase, 'tags'>): (typeof EVAL_GROUPS)[number] {
  const order: EvalGroupKey[] = ['injection', 'out_of_scope', 'clarify', 'create_process', 'start_run', 'change', 'overview'];
  for (const key of order) {
    const g = EVAL_GROUPS.find((x) => x.key === key) as (typeof EVAL_GROUPS)[number];
    if (c.tags.some((t) => (g.tags as readonly string[]).includes(t))) return g;
  }
  return EVAL_GROUPS[0];
}
