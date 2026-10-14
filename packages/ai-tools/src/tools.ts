import { DRAFT_ASSIGNABLE_ROLES, DraftStepArgsSchema, IdSchema, PROCESS_DRAFT_MAX_STEPS, PROPOSAL_RISK, type ProposalTool } from '@mihato/domain';
import { z } from 'zod';

/**
 * Danh mục công cụ của AI Scribe (SPEC 6.5). AI không có đường ghi: tool đọc chỉ trả dữ liệu tối thiểu,
 * tool `propose_*` chỉ tạo dòng `proposals` chờ người bấm xác nhận. KHÔNG có tool nào để duyệt hay từ chối
 * một bước, đánh dấu việc của người khác là xong, đổi quyền, hay xoá dữ liệu.
 *
 * Mỗi tool có hai schema:
 *  - `inputSchema`: JSON Schema gửi cho Claude, mặc định với `strict: true`. Theo ràng buộc đã xác minh ở SPEC 6.3,
 *    không dùng minimum, maximum, minLength, maxLength, anyOf; luôn có `additionalProperties: false`.
 *  - `args`: Zod kiểm lại ở máy chủ, nơi đặt các giới hạn mà schema gửi cho Claude không được có.
 * Giữ bộ tool cố định: đổi định nghĩa tool làm mất cache prompt toàn bộ (SPEC 6.3).
 *
 * TỔNG CỠ văn phạm của các tool strict có trần (đo với Claude thật ngày 04/10/2026): cả 18 tool strict thì Claude trả 400 "The compiled
 * grammar is too large" cho CẢ yêu cầu, tức là trợ lý hỏng ở mọi câu. Nhận: 16 tool strict, tổng schema 7.772 ký tự JSON. Từ chối:
 * 17 tool strict, 9.833 ký tự. Hai tool mang mảng các bước quy trình (`preview_process`, `propose_create_process`, mỗi cái hơn 2 KB) được
 * tắt `strict`: dữ liệu vào vẫn do Zod ở máy chủ kiểm kỹ, sai thì trả lỗi cho model làm lại. Test `schema-limits` giữ trần này.
 */
export type ToolKind = 'read' | 'note' | 'propose';

type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

export type ToolDef<A extends z.ZodType = z.ZodType> = {
  name: string;
  kind: ToolKind;
  /** mức rủi ro của cổng xác nhận; null với tool đọc */
  risk: 0 | 1 | 2 | null;
  description: string;
  inputSchema: JsonSchema;
  args: A;
  /** gửi cho Claude với `strict: true` hay không; xem ghi chú về trần cỡ văn phạm ở đầu tệp */
  strict: boolean;
};

const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });

function def<A extends z.ZodType>(name: string, kind: ToolKind, description: string, inputSchema: JsonSchema, args: A): ToolDef<A> {
  const risk = kind === 'read' ? null : PROPOSAL_RISK[name as ProposalTool];
  return { name, kind, risk, description, inputSchema, args, strict: true };
}

/** Tool quá nặng cho văn phạm strict của Claude: gửi không strict (Zod ở máy chủ vẫn kiểm đầy đủ). */
const notStrict = <A extends z.ZodType>(tool: ToolDef<A>): ToolDef<A> => ({ ...tool, strict: false });

/** Giá trị ô biểu mẫu khởi chạy dạng cặp khoá và chuỗi: schema strict không cho object tự do. */
const KeyValueSchema = z.object({ key: z.string().min(1), value: z.string() });
const keyValueJson = {
  type: 'array',
  description: 'Giá trị từng ô của biểu mẫu khởi chạy. Ngày viết YYYY-MM-DD (lấy từ resolve_date). Người viết bằng id (lấy từ search_people).',
  items: obj({ key: str('Khoá của ô trong biểu mẫu'), value: str('Giá trị dạng chuỗi') }, ['key', 'value']),
};

/**
 * Một bước của quy trình đang được đọc (preview_process, propose_create_process).
 *
 * Giới hạn của `strict: true` (đã đối chiếu tài liệu Claude "structured outputs"): không quá 24 tham số TUỲ CHỌN trong toàn bộ
 * bộ công cụ, không quá 20 công cụ strict, không dùng minimum, maximum, minLength, maxLength, anyOf (SPEC 6.3). Bước này được
 * lặp ở hai công cụ nên mọi ô đều BẮT BUỘC; "chưa nói" được biểu diễn bằng giá trị quy ước (dueDays 0, assignee.kind "unknown")
 * để model không phải đoán, và máy chủ coi các giá trị đó là thiếu thông tin. Test `schema-limits` giữ tổng số tham số tuỳ chọn.
 */
const draftStepJson = obj(
  {
    title: str('Tên việc của bước, ngắn gọn, đúng như người dùng nói'),
    kind: { type: 'string', enum: ['task', 'approval'], description: 'task là việc phải làm; approval là bước duyệt (người duyệt đồng ý hoặc chưa đồng ý)' },
    assignee: obj(
      {
        kind: {
          type: 'string',
          enum: ['person', 'role', 'initiator', 'unknown'],
          description: 'person: một người cụ thể, cần personId. role: một vai trò, cần role. initiator: chính người giao việc lúc khởi chạy. unknown: người dùng chưa nói ai làm bước này',
        },
        personId: str('Id người, lấy từ search_people; chỉ khi kind là person'),
        role: { type: 'string', enum: [...DRAFT_ASSIGNABLE_ROLES], description: 'Chỉ khi kind là role: chairman là Chủ tịch, director là Giám đốc, deputy là Phó giám đốc, office_admin là Văn phòng' },
      },
      ['kind'],
    ),
    dueDays: { type: 'integer', description: 'Hạn của bước: số ngày làm việc kể từ lúc bước này bắt đầu. Đặt 0 nếu người dùng chưa nói hạn; không tự đoán' },
    parallel: { type: 'boolean', description: 'true khi bước này làm cùng lúc với bước đứng ngay trước nó; false khi làm nối tiếp' },
  },
  ['title', 'kind', 'assignee', 'dueDays', 'parallel'],
);
const draftStepsJson = {
  type: 'array',
  description: 'TOÀN BỘ các bước đã nghe tới lúc này, đúng thứ tự đọc. Không bỏ bước nào đã có, kể cả bước đã đọc ở các lượt trước',
  items: draftStepJson,
};

export const TOOLS = {
  get_overview: def(
    'get_overview',
    'read',
    'Số liệu tổng hợp: đang chạy, quá hạn, đến hạn hôm nay và ngày mai, chờ quyết, cần biết, mới xong. Dùng cho câu hỏi tình hình chung.',
    obj({ scope: { type: 'string', enum: ['all', 'run', 'unit'], description: 'Phạm vi' }, runId: str('Id lượt chạy khi scope là run'), unitId: str('Id đơn vị khi scope là unit') }, ['scope']),
    z.object({ scope: z.enum(['all', 'run', 'unit']), runId: IdSchema.optional(), unitId: IdSchema.optional() }),
  ),
  list_runs: def(
    'list_runs',
    'read',
    'Danh sách lượt chạy. Tìm theo tên bằng `query` (không phân biệt dấu).',
    obj({ state: { type: 'string', enum: ['running', 'completed', 'cancelled'] }, query: str('Một phần tên lượt chạy') }),
    z.object({ state: z.enum(['running', 'completed', 'cancelled']).optional(), query: z.string().max(200).optional() }),
  ),
  get_run: def(
    'get_run',
    'read',
    'Chi tiết một lượt chạy: các việc, người nhận, hạn, trạng thái.',
    obj({ runId: str('Id lượt chạy') }, ['runId']),
    z.object({ runId: IdSchema }),
  ),
  list_overdue_steps: def(
    'list_overdue_steps',
    'read',
    'Các việc đang quá hạn kèm số ngày làm việc trễ. Dùng trước khi đi thúc.',
    obj({ runId: str('Chỉ trong lượt chạy này'), assigneeId: str('Chỉ của người này'), minDaysLate: { type: 'integer', description: 'Trễ ít nhất bao nhiêu ngày làm việc' } }),
    z.object({ runId: IdSchema.optional(), assigneeId: IdSchema.optional(), minDaysLate: z.number().int().min(0).max(365).optional() }),
  ),
  get_person_workload: def(
    'get_person_workload',
    'read',
    'Một người đang giữ những việc gì: số việc đang giữ, số quá hạn, tỉ lệ đúng hạn, danh sách việc đang mở.',
    obj({ personId: str('Id người') }, ['personId']),
    z.object({ personId: IdSchema }),
  ),
  search_people: def(
    'search_people',
    'read',
    'Tìm người theo tên, khớp mờ, không phân biệt dấu. Nhiều người khớp thì phải hỏi lại người dùng, không tự chọn.',
    obj({ query: str('Tên hoặc cách gọi, ví dụ "chị Lan", "Lan kinh doanh"') }, ['query']),
    z.object({ query: z.string().min(1).max(100) }),
  ),
  search_templates: def(
    'search_templates',
    'read',
    'Tìm mẫu quy trình đã xuất bản theo tên; trả kèm các ô của biểu mẫu khởi chạy. Đặt includeDrafts là true để tìm cả bản nháp chưa xuất bản (chỉ người có quyền sửa mẫu thấy), kết quả có `status`.',
    obj({ query: str('Tên quy trình hoặc từ khoá'), includeDrafts: { type: 'boolean', description: 'true để tìm cả bản nháp chưa xuất bản, ví dụ khi người dùng muốn xuất bản quy trình vừa tạo' } }, ['query']),
    z.object({ query: z.string().max(200), includeDrafts: z.boolean().optional() }),
  ),
  resolve_date: def(
    'resolve_date',
    'read',
    'Đổi cụm từ chỉ ngày ("thứ Năm tuần sau", "mười lăm tháng mười", "ngày kia") thành ngày cụ thể, thứ, ngày âm. Luôn dùng tool này, không tự tính ngày.',
    obj({ phrase: str('Cụm từ chỉ ngày đúng như người dùng nói') }, ['phrase']),
    z.object({ phrase: z.string().min(1).max(100) }),
  ),
  list_pending_proposals: def('list_pending_proposals', 'read', 'Các đề xuất đang chờ người dùng xác nhận.', obj({}), z.object({})),
  preview_process: notStrict(def(
    'preview_process',
    'read',
    'Dùng khi người dùng đang đọc từng bước của một quy trình MỚI. Gửi toàn bộ các bước đã nghe tới lúc này; hệ thống kiểm tra rồi tự đọc lại các bước vừa nghe để người dùng xác nhận, bạn không viết câu đọc lại. Thiếu thông tin thì kết quả có `problems`: hỏi đúng chỗ còn thiếu, mỗi lượt một câu. Không ghi gì vào hệ thống.',
    obj(
      {
        name: str('Tên quy trình'),
        steps: draftStepsJson,
        readFrom: { type: 'integer', description: 'Số thứ tự của bước đầu tiên vừa thêm hoặc vừa sửa trong lượt này; hệ thống đọc lại từ bước đó. Đặt 0 để đọc lại cả quy trình' },
      },
      ['name', 'steps', 'readFrom'],
    ),
    z.object({ name: z.string().max(200), steps: z.array(DraftStepArgsSchema).max(PROCESS_DRAFT_MAX_STEPS + 10), readFrom: z.number().int().optional() }),
  )),
  save_note: def(
    'save_note',
    'note',
    'Ghi một ghi chú, có thể gắn vào một lượt chạy. Không ảnh hưởng ai.',
    obj({ text: str('Nội dung ghi chú'), runId: str('Id lượt chạy để gắn ghi chú') }, ['text']),
    z.object({ text: z.string().min(1).max(2000), runId: IdSchema.optional() }),
  ),
  propose_nudge: def(
    'propose_nudge',
    'propose',
    'Đề xuất đi thúc các việc. Máy chủ soạn lời nhắc theo vai vế; người dùng xem lại rồi bấm Đồng ý gửi.',
    obj(
      {
        stepRunIds: { type: 'array', items: { type: 'string' }, description: 'Id các việc cần đi thúc' },
        tone: { type: 'string', enum: ['down', 'peer', 'up'], description: 'Chỉ đặt khi người dùng nêu rõ cách xưng hô' },
        named: { type: 'boolean', description: 'true khi người dùng nêu đích danh việc hoặc người, kể cả việc chưa quá hạn' },
      },
      ['stepRunIds'],
    ),
    z.object({ stepRunIds: z.array(IdSchema).min(1).max(50), tone: z.enum(['down', 'peer', 'up']).optional(), named: z.boolean().optional() }),
  ),
  propose_start_run: def(
    'propose_start_run',
    'propose',
    'Đề xuất khởi chạy một quy trình. Chỉ gọi khi đã đủ mọi ô bắt buộc của biểu mẫu; thiếu ô nào thì hỏi người dùng từng câu một.',
    obj(
      {
        templateId: str('Id mẫu quy trình'),
        title: str('Tên lượt chạy, ví dụ "Đón đoàn nhà đầu tư Nhật Bản 15/10"'),
        inputs: keyValueJson,
      },
      ['templateId', 'title', 'inputs'],
    ),
    z.object({ templateId: IdSchema, title: z.string().min(1).max(200), inputs: z.array(KeyValueSchema).max(50) }),
  ),
  propose_assign_task: notStrict(def(
    'propose_assign_task',
    'propose',
    'Đề xuất giao MỘT việc lẻ, không thuộc quy trình nào, cho một người bất kỳ. Dùng khi người dùng giao việc mà không có mẫu quy trình phù hợp. Chỉ gọi khi đã đủ: tên việc, người nhận (id từ search_people), ngày hạn (YYYY-MM-DD từ resolve_date). Việc nằm trong một quy trình thì KHÔNG dùng tool này: nó tự về đúng người quy trình chỉ định.',
    obj(
      {
        title: str('Tên việc, ví dụ "Gửi báo giá cho công ty Sakura"'),
        description: str('Nội dung dặn thêm, chỉ khi người dùng có nói'),
        assigneeId: str('Id người nhận'),
        dueDate: str('Ngày hạn dạng YYYY-MM-DD, lấy từ resolve_date'),
      },
      ['title', 'assigneeId', 'dueDate'],
    ),
    z.object({ title: z.string().min(1).max(200), description: z.string().max(2000).optional(), assigneeId: IdSchema, dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  )),
  propose_reassign: def(
    'propose_reassign',
    'propose',
    'Đề xuất đổi người nhận của một việc. Việc nằm trong quy trình chỉ giao lại được cho người được bổ nhiệm hoặc người được ủy quyền; người khác bị từ chối (not_appointed).',
    obj({ stepRunId: str('Id việc'), toUserId: str('Id người nhận mới'), reason: str('Lý do') }, ['stepRunId', 'toUserId', 'reason']),
    z.object({ stepRunId: IdSchema, toUserId: IdSchema, reason: z.string().min(1).max(2000) }),
  ),
  propose_extend_due: def(
    'propose_extend_due',
    'propose',
    'Đề xuất đổi hạn của một việc.',
    obj({ stepRunId: str('Id việc'), newDue: str('Ngày hạn mới dạng YYYY-MM-DD, lấy từ resolve_date'), reason: str('Lý do') }, ['stepRunId', 'newDue', 'reason']),
    z.object({ stepRunId: IdSchema, newDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().min(1).max(2000) }),
  ),
  propose_cancel_run: def(
    'propose_cancel_run',
    'propose',
    'Đề xuất huỷ cả một lượt chạy. Mức 2: người dùng phải chạm xác nhận kèm sinh trắc học hoặc PIN; không xác nhận được bằng giọng.',
    obj({ runId: str('Id lượt chạy'), reason: str('Lý do') }, ['runId', 'reason']),
    z.object({ runId: IdSchema, reason: z.string().min(1).max(500) }),
  ),
  propose_create_process: notStrict(def(
    'propose_create_process',
    'propose',
    'Đề xuất tạo BẢN NHÁP một quy trình mới. Chỉ gọi sau khi người dùng nói đã hết các bước (ví dụ "xong", "hết rồi") và đã nghe hệ thống đọc lại. Gửi đúng danh sách bước đã đọc lại. Bản nháp chưa giao việc cho ai và chưa xuất bản; người dùng xem rồi bấm Đồng ý thì máy chủ mới tạo.',
    obj({ name: str('Tên quy trình'), description: str('Mô tả ngắn, chỉ khi người dùng có nói'), steps: draftStepsJson }, ['name', 'steps']),
    z.object({ name: z.string().min(1).max(200), description: z.string().max(2000).optional(), steps: z.array(DraftStepArgsSchema).min(1).max(PROCESS_DRAFT_MAX_STEPS) }),
  )),
  propose_publish_process: def(
    'propose_publish_process',
    'propose',
    'Đề xuất xuất bản một bản nháp quy trình (tìm bằng search_templates với includeDrafts là true), có thể giao việc ngay theo quy trình vừa xuất bản bằng startRun. Xuất bản xong thì phiên bản đó không sửa được nữa. Muốn giao việc ngay mà chưa có tên lượt giao việc thì hỏi người dùng.',
    obj(
      {
        templateId: str('Id mẫu quy trình (bản nháp)'),
        startRun: obj({ title: str('Tên lượt giao việc, ví dụ "Họp hội đồng quản trị 15/10"'), inputs: keyValueJson }, ['title', 'inputs']),
      },
      ['templateId'],
    ),
    z.object({ templateId: IdSchema, startRun: z.object({ title: z.string().min(1).max(200), inputs: z.array(KeyValueSchema).max(50).optional() }).optional() }),
  ),
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];
export type ToolArgs<N extends ToolName> = z.infer<(typeof TOOLS)[N]['args']>;

/** Định nghĩa tool đúng dạng gửi cho Claude Messages API: thứ tự cố định để giữ cache prompt. */
export function claudeToolDefinitions(): { name: string; description: string; input_schema: JsonSchema; strict?: true }[] {
  return TOOL_NAMES.map((n) => ({
    name: TOOLS[n].name,
    description: TOOLS[n].description,
    input_schema: TOOLS[n].inputSchema,
    ...(TOOLS[n].strict ? { strict: true as const } : {}),
  }));
}

/** Tên các tool gửi không strict (quá nặng cho trần cỡ văn phạm của Claude). Test dùng danh sách này để khoá lại. */
export const NON_STRICT_TOOL_NAMES: readonly string[] = TOOL_NAMES.filter((n) => !TOOLS[n].strict);

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}
