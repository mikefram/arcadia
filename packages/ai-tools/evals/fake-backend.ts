/**
 * `FakeToolBackend`: bản trong bộ nhớ của `POST /internal/v1/tools/:name` (SPEC 10.7.1) cho bộ đánh giá và cho test
 * của `scribe`. Dựng từ trạng thái dữ liệu mẫu ở `fixtures.ts`, không cần CSDL, không cần mạng.
 *
 * Hình dạng kết quả chép theo máy chủ thật (`packages/backend/src/services/tools.ts`: `stepBrief`, `runBrief`,
 * `personBrief`, mã lỗi) để trợ lý được đánh giá trên đúng thứ nó sẽ thấy khi chạy thật. Máy chủ đổi hình dạng
 * thì sửa tệp này theo. Câu `summary` ở đây là mẫu của bản giả, không phải mẫu câu của máy chủ.
 *
 * Giữ đúng các điều của cổng xác nhận mà phía tool nhìn thấy (SPEC 6.5):
 *  - tool đọc trả dữ liệu tối thiểu (tên, tên việc, hạn, trạng thái, id); không có số điện thoại, thư điện tử, mô tả việc;
 *  - tool `propose_*` CHỈ tạo dòng đề xuất ở trạng thái chờ, không đổi dữ liệu của lượt chạy;
 *  - tham số qua Zod của `TOOLS` và kiểm thực thể: sai thì trả lỗi cho tool, không tạo đề xuất;
 *  - `summary` do "máy chủ" dựng bằng mẫu cố định, không lấy chữ của LLM.
 *
 * Quy trình soạn bằng trò chuyện (docs/DECISIONS.md, 04/10/2026): `preview_process` kiểm các bước rồi dựng câu đọc lại
 * (`processReadback`) khi không còn lỗi; `propose_create_process` và `propose_publish_process` chỉ tạo đề xuất, và báo `forbidden`
 * với người không có quyền sửa mẫu (Giám đốc, Phó giám đốc). Hai giá trị quy ước của lược đồ gửi cho Claude là "chưa nói":
 * `dueDays` 0 (hoặc vắng) và `assignee.kind` "unknown"; `readFrom` nhỏ hơn 1 nghĩa là đọc lại cả quy trình.
 */
import {
  can,
  DEFAULT_CALENDAR,
  type DraftProblem,
  type DraftStepArgs,
  type InternalToolResult,
  PROCESS_DRAFT_MAX_STEPS,
  type ProcessDraftPayload,
  PROPOSAL_RISK,
  type ProposalTool,
  type ResolvedDraftStep,
} from '@mihato/domain';
import { lateWorkingDays, nextWorkingDay, toLocalDate } from '@mihato/domain/calendar';
import { matchPerson, resolveDate, stripDiacritics } from '@mihato/domain/vi-normalize';
import { formatDateFull, vi } from '@mihato/i18n';
import { isToolName, TOOLS, type ToolName } from '../src/tools';
import { type Fixture, type FixturePerson, type FixtureRun, type FixtureStep, type FixtureTemplate, IDS, loadFixture } from './fixtures';

export type PersonBrief = { id: string; fullName: string; givenName: string; honorific: string | null; unitName: string | null; roleTitle: string | null };

export type StepBrief = {
  stepId: string;
  title: string;
  kind: 'task' | 'approval';
  state: FixtureStep['state'];
  stateText: string;
  runId: string;
  runTitle: string;
  assigneeId: string | null;
  /** nhãn dựng sẵn: xưng hô kèm họ tên */
  assignee: string | null;
  dueAt: string;
  dueText: string;
  isOverdue: boolean;
  lateWorkingDays: number;
  blocked: boolean;
};

export type RunBrief = {
  runId: string;
  title: string;
  templateName: string;
  state: FixtureRun['state'];
  stateText: string;
  done: number;
  total: number;
  schedule: 'on_track' | 'late' | 'done';
  lateWorkingDays: number;
  targetAt: string;
  targetText: string;
  startedAt: string;
  completedAt: string | null;
};

export type StoredProposal = {
  proposalId: string;
  batchId: string | null;
  tool: ProposalTool;
  risk: number;
  summary: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'confirmed';
};

export type ToolCallLog = { name: string; args: unknown; result: InternalToolResult };

const HONORIFIC_WORD: Record<string, string> = { anh: 'anh', chi: 'chị', ong: 'ông', ba: 'bà', co: 'cô', chu: 'chú', bac: 'bác' };
const OPEN_STATES = new Set<FixtureStep['state']>(['ready', 'in_progress']);
const fold = (s: string) => stripDiacritics(s.normalize('NFC')).toLowerCase();
const tokens = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Câu giải thích lỗi cho mô hình đọc, theo đúng mã của máy chủ thật. */
const TOOL_ERROR_TEXT: Record<string, string> = {
  unknown_tool: 'Không có công cụ này. Trợ lý không được duyệt, báo xong thay người khác, đổi quyền hay xoá dữ liệu.',
  not_found: 'Không tìm thấy, hoặc nằm ngoài tầm nhìn của người dùng. Hãy tìm lại bằng tool đọc, không đoán id.',
  input_invalid: 'Tham số chưa hợp lệ. Thiếu thông tin thì hỏi người dùng từng câu một.',
  state_conflict: 'Trạng thái hiện tại không cho phép: việc đã xong, đã đổi người, hoặc lượt đã dừng.',
  nudge_throttled: 'Chưa đi thúc được lúc này để tránh làm phiền người nhận.',
  date_unresolved: 'Chưa hiểu được cụm từ chỉ ngày. Hãy hỏi lại người dùng ngày cụ thể.',
  forbidden: 'Tài khoản của người dùng không có quyền làm việc này. Hãy nói thật là chưa làm được và chỉ đường làm trên trang quản trị hoặc nhờ Văn phòng; không thử cách khác.',
};

/** `detail` (nếu có) liệt kê chỗ sai theo dạng "args.steps.1.dueDays (due_missing)", chép theo máy chủ thật. */
const fail = (code: string, detail?: string): InternalToolResult => ({
  ok: false,
  error: { code, message: `${TOOL_ERROR_TEXT[code] ?? 'Hệ thống chưa làm được việc này.'}${detail ? ` Chi tiết: ${detail}.` : ''}` },
});
const ok = (result: unknown): InternalToolResult => ({ ok: true, result });

export class FakeToolBackend {
  readonly fixture: Fixture;
  readonly now: Date;
  /** người đang được thay mặt (header X-On-Behalf-Of); mặc định là Chủ tịch */
  readonly userId: string;
  readonly proposals: StoredProposal[] = [];
  readonly notes: { text: string; runId: string | null }[] = [];
  readonly calls: ToolCallLog[] = [];
  private seq = 0;

  constructor(opts: { fixture?: string | Fixture; now?: string | Date; userId?: string } = {}) {
    this.fixture = typeof opts.fixture === 'object' ? structuredClone(opts.fixture) : loadFixture(opts.fixture ?? 'golden@2026-10-08T09:00');
    this.now = new Date(opts.now ?? '2026-10-08T09:00:00+07:00');
    if (Number.isNaN(this.now.getTime())) throw new Error('FakeToolBackend: đồng hồ giả không hợp lệ');
    this.userId = opts.userId ?? IDS.U_CHAIRMAN;
  }

  private nextId(): string {
    return `01920000-0000-7000-8000-0000000f${String(++this.seq).padStart(4, '0')}`;
  }

  // ── Tra cứu ──

  private person(id: string | null | undefined): FixturePerson | undefined {
    return this.fixture.people.find((p) => p.id === id);
  }

  private personBrief(p: FixturePerson): PersonBrief {
    return { id: p.id, fullName: p.fullName, givenName: p.givenName, honorific: p.honorific ? (HONORIFIC_WORD[p.honorific] ?? p.honorific) : null, unitName: p.unitName, roleTitle: p.roleTitle };
  }

  /** Nhãn người như máy chủ: xưng hô kèm họ tên ("anh Bùi Quốc Tuấn"). */
  private label(id: string | null | undefined): string {
    const p = this.person(id);
    if (!p) return 'người nhận việc';
    return p.honorific ? `${HONORIFIC_WORD[p.honorific] ?? p.honorific} ${p.fullName}` : p.fullName;
  }

  private findStep(id: string): { run: FixtureRun; step: FixtureStep } | undefined {
    for (const run of this.fixture.runs) {
      const step = run.steps.find((s) => s.id === id);
      if (step) return { run, step };
    }
    return undefined;
  }

  private late(step: FixtureStep): number {
    return OPEN_STATES.has(step.state) ? lateWorkingDays(step.dueAt, this.now, DEFAULT_CALENDAR) : 0;
  }

  private isOverdue(step: FixtureStep): boolean {
    return OPEN_STATES.has(step.state) && new Date(step.dueAt).getTime() < this.now.getTime();
  }

  private stepBrief(run: FixtureRun, step: FixtureStep): StepBrief {
    return {
      stepId: step.id,
      title: step.title,
      kind: step.kind,
      state: step.state,
      stateText: vi.common.stepState[step.state],
      runId: run.id,
      runTitle: run.title,
      assigneeId: this.person(step.assigneeId)?.id ?? null,
      assignee: this.person(step.assigneeId) ? this.label(step.assigneeId) : null,
      dueAt: step.dueAt,
      dueText: formatDateFull(step.dueAt),
      isOverdue: this.isOverdue(step),
      lateWorkingDays: this.late(step),
      blocked: false,
    };
  }

  private runBrief(run: FixtureRun): RunBrief {
    const anyOverdue = run.steps.some((s) => this.isOverdue(s));
    return {
      runId: run.id,
      title: run.title,
      templateName: this.fixture.templates.find((t) => t.id === run.templateId)?.name ?? '',
      state: run.state,
      stateText: vi.common.runState[run.state],
      done: run.steps.filter((s) => s.state === 'done').length,
      total: run.steps.length,
      schedule: run.state === 'completed' ? 'done' : anyOverdue ? 'late' : 'on_track',
      lateWorkingDays: Math.max(0, ...run.steps.map((s) => this.late(s))),
      targetAt: run.targetAt,
      targetText: formatDateFull(run.targetAt),
      startedAt: run.startedAt,
      completedAt: null,
    };
  }

  private openSteps(): { run: FixtureRun; step: FixtureStep }[] {
    return this.fixture.runs.filter((r) => r.state === 'running').flatMap((run) => run.steps.filter((s) => OPEN_STATES.has(s.state)).map((step) => ({ run, step })));
  }

  // ── Mẫu quy trình và quy trình soạn bằng trò chuyện ──

  /** Người đang được thay mặt có quyền này theo bảng mặc định không (Chủ tịch có mọi quyền về mẫu, Giám đốc và Phó giám đốc không có quyền nào). */
  private mayDo(action: 'template.edit' | 'template.publish'): boolean {
    const role = this.person(this.userId)?.role;
    return role !== undefined && can([role], action);
  }

  /** Ô biểu mẫu khởi chạy có đủ không: ô bắt buộc không để trống, ô ngày đúng dạng YYYY-MM-DD và không ở quá khứ. */
  private inputsValid(template: FixtureTemplate, inputs: ReadonlyMap<string, string>, today: string): boolean {
    for (const field of template.inputs) {
      const value = inputs.get(field.key) ?? '';
      if (field.required && !value) return false;
      if (field.type === 'date' && value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return false;
        if (value < today) return false;
      }
    }
    return true;
  }

  /**
   * Kiểm tên và các bước của một quy trình đang soạn, trả TỪNG lỗi để trợ lý hỏi đúng chỗ còn thiếu. Thứ tự: tên, số bước,
   * rồi từng bước theo tên việc, người làm, hạn. "Chưa nói" là `dueDays` 0 hoặc vắng, và `assignee.kind` "unknown" hoặc vắng.
   */
  private draftProblems(name: string, steps: readonly DraftStepArgs[]): DraftProblem[] {
    const problems: DraftProblem[] = [];
    const trimmed = name.trim();
    if (!trimmed) problems.push({ step: null, field: 'name', code: 'name_missing' });
    else if (this.fixture.templates.some((t) => fold(t.name) === fold(trimmed))) problems.push({ step: null, field: 'name', code: 'name_taken' });
    if (steps.length === 0) problems.push({ step: null, field: 'steps', code: 'no_steps' });
    else if (steps.length > PROCESS_DRAFT_MAX_STEPS) problems.push({ step: null, field: 'steps', code: 'too_many_steps' });
    steps.forEach((s, i) => {
      const step = i + 1;
      if (!s.title.trim()) problems.push({ step, field: 'title', code: 'title_missing' });
      const a = s.assignee;
      if (!a || a.kind === 'unknown' || (a.kind === 'person' && !a.personId) || (a.kind === 'role' && !a.role)) problems.push({ step, field: 'assignee', code: 'assignee_missing' });
      else if (a.kind === 'person' && !this.person(a.personId)) problems.push({ step, field: 'assignee', code: 'person_unavailable' });
      if (s.dueDays === undefined || s.dueDays === 0) problems.push({ step, field: 'dueDays', code: 'due_missing' });
      else if (s.dueDays < 1 || s.dueDays > 365) problems.push({ step, field: 'dueDays', code: 'due_invalid' });
    });
    return problems;
  }

  /** Câu "máy chủ" dựng cho một bước: "Bước 1: ‘Soạn tài liệu họp’, anh Bùi Quốc Tuấn làm, hạn 3 ngày làm việc." Bước làm cùng lúc có thêm một câu. */
  private stepLine(n: number, s: DraftStepArgs): string {
    const a = s.assignee;
    const who = a?.kind === 'person' ? this.label(a.personId) : a?.kind === 'role' && a.role ? vi.common.role[a.role] : a?.kind === 'initiator' ? 'người giao việc' : null;
    const parts = [`Bước ${n}: ‘${s.title.trim() || '…'}’`];
    if (who) parts.push(`${who} ${s.kind === 'approval' ? 'duyệt' : 'làm'}`);
    if (s.dueDays !== undefined && s.dueDays >= 1) parts.push(`hạn ${s.dueDays} ngày làm việc`);
    return `${parts.join(', ')}.${s.parallel ? ' Làm cùng lúc với bước trước.' : ''}`;
  }

  /** Các bước đã kiểm đủ, đổi sang dạng lưu ở `proposals.payload`. Chỉ gọi sau khi `draftProblems` không còn lỗi. */
  private resolveSteps(steps: readonly DraftStepArgs[]): ResolvedDraftStep[] {
    const out: ResolvedDraftStep[] = [];
    for (const s of steps) {
      const a = s.assignee;
      const assignee: ResolvedDraftStep['assignee'] | null =
        a?.kind === 'person' && a.personId ? { kind: 'person', userId: a.personId } : a?.kind === 'role' && a.role ? { kind: 'role', role: a.role } : a?.kind === 'initiator' ? { kind: 'initiator' } : null;
      if (assignee && s.dueDays !== undefined) out.push({ title: s.title.trim(), kind: s.kind ?? 'task', assignee, dueDays: s.dueDays, parallel: s.parallel ?? false });
    }
    return out;
  }

  // ── Đề xuất ──

  /** `texts` thay cho danh sách câu `items` của kết quả (mặc định là `summary` của từng đề xuất): `propose_create_process` trả các câu bước. */
  private propose(tool: ProposalTool, items: { summary: string; payload: Record<string, unknown> }[], texts?: string[]): InternalToolResult {
    const batchId = items.length > 1 ? this.nextId() : null;
    const created = items.map((item) => {
      const risk = PROPOSAL_RISK[tool];
      const proposal: StoredProposal = { proposalId: this.nextId(), batchId, tool, risk, summary: item.summary, payload: item.payload, state: risk === 0 ? 'confirmed' : 'pending' };
      this.proposals.push(proposal);
      return { proposalId: proposal.proposalId, batchId, risk, summary: proposal.summary };
    });
    return { ok: true, result: { created: created.length, items: texts ?? created.map((c) => c.summary), saved: tool === 'save_note', skipped: [] }, proposals: created };
  }

  // ── Điểm vào ──

  /** Chạy một tool thay cho người dùng. Không bao giờ ném lỗi: lỗi nghiệp vụ trả về trong `error`. */
  call(name: string, args: unknown): InternalToolResult {
    const result = this.run(name, args);
    this.calls.push({ name, args: structuredClone(args), result });
    return result;
  }

  private run(name: string, rawArgs: unknown): InternalToolResult {
    if (!isToolName(name)) return fail('unknown_tool');
    const parsed = TOOLS[name].args.safeParse(rawArgs);
    if (!parsed.success) return fail('input_invalid');
    return this.dispatch(name, parsed.data as Record<string, unknown>);
  }

  private dispatch(name: ToolName, a: Record<string, unknown>): InternalToolResult {
    const cal = DEFAULT_CALENDAR;
    const today = toLocalDate(this.now, cal);
    switch (name) {
      case 'get_overview': {
        if (a.scope === 'run' && typeof a.runId !== 'string') return fail('input_invalid');
        const runs = this.fixture.runs.filter((r) => (a.scope === 'run' ? r.id === a.runId : true));
        if (a.scope === 'run' && runs.length === 0) return fail('not_found');
        const open = runs.filter((r) => r.state === 'running').flatMap((run) => run.steps.filter((s) => OPEN_STATES.has(s.state)).map((step) => ({ run, step })));
        const tomorrow = nextWorkingDay(today, cal);
        const dueOn = (day: string) => open.filter(({ step }) => !this.isOverdue(step) && toLocalDate(step.dueAt, cal) === day).length;
        // 00:00 Thứ Hai của tuần này, giờ Việt Nam.
        const daysSinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
        const weekStart = new Date(Date.parse(`${today}T00:00:00+07:00`) - daysSinceMonday * 86_400_000);
        const doneThisWeek = runs.flatMap((r) => r.steps).filter((s) => s.completedAt !== null && new Date(s.completedAt).getTime() >= weekStart.getTime());
        const onTime = doneThisWeek.filter((s) => new Date(s.completedAt as string).getTime() <= new Date(s.dueAt).getTime()).length;
        return ok({
          scope: a.scope,
          asOf: this.now.toISOString(),
          today: formatDateFull(this.now),
          running: runs.filter((r) => r.state === 'running').length,
          overdue: open.filter(({ step }) => this.isOverdue(step)).length,
          dueToday: dueOn(today),
          dueTomorrow: dueOn(tomorrow),
          awaitingMyDecision: open.filter(({ step }) => step.kind === 'approval' && step.assigneeId === this.userId).length,
          pendingApproval: open.filter(({ step }) => step.kind === 'approval').length,
          unassigned: 0,
          pendingExtensions: 0,
          completedThisWeek: doneThisWeek.length,
          onTimePercentThisWeek: doneThisWeek.length > 0 ? Math.round((onTime / doneThisWeek.length) * 100) : null,
          needsAttention: open.filter(({ step }) => this.late(step) >= 3).map(({ run, step }) => this.stepBrief(run, step)),
          recentlyCompletedRuns: [],
        });
      }
      case 'list_runs': {
        const want = typeof a.query === 'string' ? tokens(a.query) : [];
        const runs = this.fixture.runs
          .filter((r) => (typeof a.state === 'string' ? r.state === a.state : true))
          .filter((r) => {
            const hay = fold(`${r.title} ${this.fixture.templates.find((t) => t.id === r.templateId)?.name ?? ''}`);
            return want.every((w) => hay.includes(w));
          });
        return ok({ count: runs.length, runs: runs.map((r) => this.runBrief(r)) });
      }
      case 'get_run': {
        const run = this.fixture.runs.find((r) => r.id === a.runId);
        if (!run) return fail('not_found');
        return ok({ ...this.runBrief(run), steps: run.steps.map((s) => this.stepBrief(run, s)) });
      }
      case 'list_overdue_steps': {
        if (typeof a.assigneeId === 'string' && !this.person(a.assigneeId)) return fail('not_found');
        if (typeof a.runId === 'string' && !this.fixture.runs.some((r) => r.id === a.runId)) return fail('not_found');
        const minLate = typeof a.minDaysLate === 'number' ? a.minDaysLate : 0;
        const steps = this.openSteps()
          .filter(({ run }) => (typeof a.runId === 'string' ? run.id === a.runId : true))
          .filter(({ step }) => (typeof a.assigneeId === 'string' ? step.assigneeId === a.assigneeId : true))
          .filter(({ step }) => this.isOverdue(step) && this.late(step) >= minLate)
          .map(({ run, step }) => ({ ...this.stepBrief(run, step), canNudge: true, lastNudgedAt: null }))
          .sort((x, y) => y.lateWorkingDays - x.lateWorkingDays);
        return ok({ count: steps.length, steps });
      }
      case 'get_person_workload': {
        const person = this.person(a.personId as string);
        if (!person) return fail('not_found');
        const mine = this.fixture.runs.flatMap((run) => run.steps.filter((s) => s.assigneeId === person.id).map((step) => ({ run, step })));
        const open = mine.filter(({ step }) => OPEN_STATES.has(step.state));
        const done = mine.filter(({ step }) => step.state === 'done' && step.completedAt !== null);
        const onTime = done.filter(({ step }) => new Date(step.completedAt as string).getTime() <= new Date(step.dueAt).getTime()).length;
        return ok({
          person: this.personBrief(person),
          holding: open.length,
          overdue: open.filter(({ step }) => this.isOverdue(step)).length,
          completed: done.length,
          onTimePercent: done.length > 0 ? Math.round((onTime / done.length) * 100) : null,
          steps: open.map(({ run, step }) => this.stepBrief(run, step)),
        });
      }
      case 'search_people': {
        const candidates = this.fixture.people.map((p) => ({ id: p.id, fullName: p.fullName, givenName: p.givenName, honorific: p.honorific, unitName: p.unitName }));
        const found = matchPerson(a.query as string, candidates);
        const top = found[0]?.score ?? 0;
        // Như máy chủ: trả CẢ danh sách (kể cả ứng viên khớp yếu) kèm điểm, và báo mơ hồ khi nhiều người gần ngang nhau.
        const ambiguous = found.filter((m) => m.score >= top * 0.9).length > 1;
        return ok({
          count: found.length,
          ambiguous,
          people: found.slice(0, 10).map((m) => ({ ...this.personBrief(this.person(m.id) as FixturePerson), score: m.score })),
        });
      }
      case 'search_templates': {
        const want = tokens(a.query as string);
        // Mẫu chỉ có bản nháp chỉ hiện khi tìm kèm bản nháp VÀ người dùng có quyền sửa mẫu; khi đó mỗi mẫu có thêm `status`.
        const withDrafts = a.includeDrafts === true;
        const templates = this.fixture.templates
          .filter((t) => (t.status ?? 'published') !== 'draft_only' || (withDrafts && (this.mayDo('template.edit') || this.mayDo('template.publish'))))
          .filter((t) => {
            const hay = fold(`${t.name} ${t.description}`);
            return want.every((w) => hay.includes(w));
          })
          .map((t) => ({
            templateId: t.id,
            name: t.name,
            description: t.description,
            stepCount: t.stepCount,
            targetField: t.inputs.find((i) => i.type === 'date')?.key ?? null,
            fields: t.inputs,
            ...(withDrafts ? { status: t.status ?? 'published' } : {}),
          }));
        return ok({ count: templates.length, templates });
      }
      case 'resolve_date': {
        const r = resolveDate(a.phrase as string, this.now, cal);
        if (!r) return fail('date_unresolved');
        return ok({ date: r.date, weekday: r.weekday, text: formatDateFull(`${r.date}T10:00:00.000Z`), lunarLabel: r.lunarLabel, isWorkingDay: r.isWorkingDay, isToday: r.date === today, isPast: r.date < today });
      }
      case 'list_pending_proposals': {
        const pending = this.proposals.filter((p) => p.state === 'pending');
        return ok({ count: pending.length, proposals: pending.map(({ proposalId, batchId, tool, risk, summary }) => ({ proposalId, batchId, tool, risk, summary, requiresStepUp: risk >= 2 })) });
      }
      case 'save_note': {
        if (typeof a.runId === 'string' && !this.fixture.runs.some((r) => r.id === a.runId)) return fail('not_found');
        const text = a.text as string;
        this.notes.push({ text, runId: typeof a.runId === 'string' ? a.runId : null });
        return this.propose('save_note', [{ summary: `Ghi chú: ${text}`, payload: a }]);
      }
      case 'propose_nudge': {
        const items: { summary: string; payload: Record<string, unknown> }[] = [];
        for (const stepId of a.stepRunIds as string[]) {
          const found = this.findStep(stepId);
          if (!found) return fail('not_found');
          const { step } = found;
          if (!OPEN_STATES.has(step.state)) return fail('state_conflict');
          if (!this.isOverdue(step) && a.named !== true) return fail('nudge_throttled');
          const late = this.late(step);
          items.push({
            summary: `Gửi lời nhắc tới ${this.label(step.assigneeId)} về việc “${step.title}”${late > 0 ? `, đã quá hạn ${late} ngày làm việc` : ''}.`,
            payload: { stepRunId: step.id, toUserId: step.assigneeId, tone: a.tone ?? 'down' },
          });
        }
        return this.propose('propose_nudge', items);
      }
      case 'propose_start_run': {
        const template = this.fixture.templates.find((t) => t.id === a.templateId);
        if (!template) return fail('not_found');
        // Mẫu chưa từng xuất bản thì chưa khởi chạy được.
        if (template.status === 'draft_only') return fail('state_conflict');
        const inputs = new Map((a.inputs as { key: string; value: string }[]).map((kv) => [kv.key, kv.value.trim()]));
        if (!this.inputsValid(template, inputs, today)) return fail('input_invalid');
        const dateField = template.inputs.find((f) => f.type === 'date');
        const date = dateField ? inputs.get(dateField.key) : undefined;
        return this.propose('propose_start_run', [
          {
            summary: `Khởi chạy quy trình “${template.name}” với tên “${a.title as string}”: ${template.stepCount} việc${date ? `, mốc là ${formatDateFull(`${date}T10:00:00.000Z`)}` : ''}.`,
            payload: a,
          },
        ]);
      }
      case 'propose_reassign': {
        const found = this.findStep(a.stepRunId as string);
        if (!found || !this.person(a.toUserId as string)) return fail('not_found');
        if (!OPEN_STATES.has(found.step.state) || found.step.assigneeId === a.toUserId) return fail('state_conflict');
        return this.propose('propose_reassign', [
          { summary: `Chuyển việc “${found.step.title}” từ ${this.label(found.step.assigneeId)} sang ${this.label(a.toUserId as string)}.`, payload: a },
        ]);
      }
      case 'propose_extend_due': {
        const found = this.findStep(a.stepRunId as string);
        if (!found) return fail('not_found');
        if (!OPEN_STATES.has(found.step.state)) return fail('state_conflict');
        const newDue = a.newDue as string;
        if (Number.isNaN(Date.parse(`${newDue}T00:00:00Z`)) || newDue < today) return fail('input_invalid');
        return this.propose('propose_extend_due', [
          { summary: `Đổi hạn việc “${found.step.title}” của ${this.label(found.step.assigneeId)} sang ${formatDateFull(`${newDue}T10:00:00.000Z`)}.`, payload: a },
        ]);
      }
      case 'propose_assign_task': {
        const person = this.person(a.assigneeId as string);
        const dueDate = a.dueDate as string;
        if (!person) return fail('not_found');
        if (Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)) || dueDate < today) return fail('input_invalid');
        return this.propose('propose_assign_task', [
          { summary: `Giao việc “${a.title as string}” cho ${this.label(a.assigneeId as string)}, hạn ${formatDateFull(`${dueDate}T10:00:00.000Z`)}.`, payload: a },
        ]);
      }
      case 'propose_cancel_run': {
        const run = this.fixture.runs.find((r) => r.id === a.runId);
        if (!run) return fail('not_found');
        if (run.state !== 'running') return fail('state_conflict');
        return this.propose('propose_cancel_run', [{ summary: `Huỷ cả đợt “${run.title}”.`, payload: a }]);
      }
      case 'preview_process': {
        // Giống máy chủ thật: người không có quyền sửa mẫu bị từ chối ngay từ bước đầu, không phải đọc hết rồi mới biết.
        if (!this.mayDo('template.edit')) return fail('forbidden');
        // Tool đọc: kiểm rồi dựng câu đọc lại; không ghi gì. `processReadback` có mặt khi và chỉ khi không còn lỗi.
        const name = (a.name as string).trim();
        const steps = a.steps as DraftStepArgs[];
        const problems = this.draftProblems(name, steps);
        const lines = steps.map((s, i) => this.stepLine(i + 1, s));
        const result = { name, stepCount: steps.length, steps: lines.map((text, i) => ({ n: i + 1, text })), problems, complete: problems.length === 0 };
        if (problems.length > 0) return ok(result);
        // `readFrom` nhỏ hơn 1 (hoặc ngoài phạm vi) nghĩa là đọc lại cả quy trình.
        const from = typeof a.readFrom === 'number' && a.readFrom >= 1 && a.readFrom <= steps.length ? a.readFrom : 1;
        return { ok: true, result, processReadback: { name, lines: lines.slice(from - 1), total: steps.length } };
      }
      case 'propose_create_process': {
        if (!this.mayDo('template.edit')) return fail('forbidden');
        const name = (a.name as string).trim();
        const steps = a.steps as DraftStepArgs[];
        const problems = this.draftProblems(name, steps);
        if (problems.length > 0) {
          return fail('input_invalid', problems.map((p) => `args.${p.step === null ? p.field : `steps.${p.step - 1}.${p.field}`} (${p.code})`).join('; '));
        }
        const description = typeof a.description === 'string' && a.description.trim() ? a.description.trim() : undefined;
        const payload: ProcessDraftPayload = { name, ...(description ? { description } : {}), steps: this.resolveSteps(steps) };
        return this.propose(
          'propose_create_process',
          [{ summary: `Tạo bản nháp quy trình “${name}” gồm ${steps.length} bước, chưa giao việc cho ai.`, payload }],
          steps.map((s, i) => this.stepLine(i + 1, s)),
        );
      }
      case 'propose_publish_process': {
        if (!this.mayDo('template.publish')) return fail('forbidden');
        const template = this.fixture.templates.find((t) => t.id === a.templateId);
        if (!template) return fail('not_found');
        // Không có bản nháp để xuất bản (mẫu chỉ có bản đã xuất bản).
        if ((template.status ?? 'published') === 'published') return fail('state_conflict');
        const startRun = a.startRun as { title: string; inputs?: { key: string; value: string }[] } | undefined;
        if (startRun && !this.inputsValid(template, new Map((startRun.inputs ?? []).map((kv) => [kv.key, kv.value.trim()])), today)) return fail('input_invalid');
        return this.propose('propose_publish_process', [
          {
            summary: `Xuất bản quy trình “${template.name}”${startRun ? ` và giao việc ngay với tên “${startRun.title}”` : ''}.`,
            payload: a,
          },
        ]);
      }
    }
  }
}
