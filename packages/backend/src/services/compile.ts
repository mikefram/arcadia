import { ApiError, type DocSpec, type FormField, type ProcessDefinition, type StepCompileResponse, type StepState } from '@mihato/domain';
import { toLocalDate } from '@mihato/domain/calendar';
import { and, eq, inArray } from 'drizzle-orm';
import { audit } from '../audit';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { loadRun } from '../engine/runner';
import { buildStepViews, type Viewer } from '../views';
import { renderDocx, type DocBlock, type DocSectionOut, type RenderInput } from './doc-render';
import { renderPdf } from './doc-render-pdf';
import { storeGeneratedFile } from './files';
import { findVisibleStep } from './runs';

/**
 * Xuất tệp Word tổng hợp (docs/DECISIONS.md, 06/10/2026): việc tổng hợp có cấu hình `compile`, người làm bấm "Xuất tệp" bất cứ
 * lúc nào (xuất lại sau khi sửa dữ liệu thì ra tệp mới, tệp cũ vẫn giữ trong hồ sơ) rồi trình người có thẩm quyền duyệt.
 * Dữ liệu lấy từ lượt chạy theo `ref` của từng mục: `inputs.<ô>`, `steps.<bước>.<ô>`, `responses.<bước>.<ô>`.
 */

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_PDF = 'application/pdf';

const dmy = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
};
const money = (n: number): string => `${n.toLocaleString('vi-VN')} đồng`;

type Ctx = {
  ctx: OrgContext;
  fileNames: Map<string, string>;
};

/** Giá trị của một ô thành các khối chữ, theo loại ô. Ô trống cho ra danh sách rỗng. */
function blocksOf(field: FormField | undefined, value: unknown, c: Ctx): DocBlock[] {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return [];
  const type = field?.type ?? (Array.isArray(value) ? 'users' : 'text');
  const nameOf = (id: unknown) => (typeof id === 'string' ? (c.ctx.person(id)?.fullName ?? '') : '');
  switch (type) {
    case 'longtext':
    case 'text':
    case 'autonumber':
      return String(value)
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((text) => ({ kind: 'paragraph' as const, text }));
    case 'date':
      return [{ kind: 'paragraph', text: dmy(String(value)) }];
    case 'money':
      return typeof value === 'number' ? [{ kind: 'paragraph', text: money(value) }] : [];
    case 'number':
      return [{ kind: 'paragraph', text: String(value) }];
    case 'select': {
      const label = field?.options?.find((o) => o.value === value)?.label ?? String(value);
      return [{ kind: 'paragraph', text: label }];
    }
    case 'user':
      return [{ kind: 'paragraph', text: nameOf(value) }];
    case 'users':
      return [{ kind: 'list', items: (Array.isArray(value) ? value : []).map(nameOf).filter(Boolean) }];
    case 'file':
      return [{ kind: 'list', items: (Array.isArray(value) ? value : []).map((id) => c.fileNames.get(String(id)) ?? '').filter(Boolean) }];
  }
}

const textOf = (blocks: DocBlock[]): string =>
  blocks
    .flatMap((b) => (b.kind === 'list' ? b.items : [b.text]))
    .join(', ');

function formOfNode(def: ProcessDefinition, nodeId: string): FormField[] {
  const node = def.nodes.find((n) => n.id === nodeId);
  return node && (node.type === 'task' || node.type === 'approval') ? (node.form ?? []) : [];
}

function latestStep(steps: StepState[], nodeId: string): StepState | undefined {
  return steps.filter((s) => s.nodeId === nodeId).sort((a, b) => b.attempt - a.attempt)[0];
}

/** Bước đã (hoặc đang) chạy. Bước nằm trên nhánh không đi qua (bị bỏ qua hoặc huỷ) thì mục lấy dữ liệu từ nó bị bỏ, không in tiêu đề trống. */
const ranStep = (step: StepState | undefined): step is StepState => step !== undefined && step.state !== 'skipped' && step.state !== 'cancelled';

type Resolved = { sections: DocSectionOut[]; title: string; number: string | null; issuedOn: string | null; recipient: string | null; attachments: string[] };

function resolve(def: ProcessDefinition, spec: DocSpec, run: { title: string; inputs: Record<string, unknown>; steps: StepState[] }, c: Ctx, files: { id: string; name: string; fieldKey: string | null }[]): Resolved {
  const inputField = (key: string) => def.inputs.find((f) => f.key === key);
  const title = spec.title.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_all, key: string) => textOf(blocksOf(inputField(key), run.inputs[key], c)) || '……');
  const sections: DocSectionOut[] = [];
  for (const sec of spec.sections) {
    const blocks: DocBlock[] = [];
    if (sec.text) blocks.push(...sec.text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean).map((text) => ({ kind: 'paragraph' as const, text })));
    if (sec.ref) {
      const [root, a, b] = sec.ref.split('.');
      if (root === 'inputs' && a) {
        blocks.push(...blocksOf(inputField(a), run.inputs[a], c));
      } else if (root === 'steps' && a && b) {
        const step = latestStep(run.steps, a);
        // Bước nằm trên nhánh không đi qua (ví dụ ý kiến Chủ tịch ở văn bản thường) thì bỏ cả mục, không in tiêu đề trống.
        if (!ranStep(step)) continue;
        blocks.push(...blocksOf(formOfNode(def, a).find((f) => f.key === b), step?.result?.[b], c));
      } else if (root === 'responses' && a && b) {
        const step = latestStep(run.steps, a);
        if (!ranStep(step)) continue;
        const responses = Array.isArray(step?.result?.['responses']) ? (step!.result!['responses'] as { userId: string; result: Record<string, unknown> }[]) : [];
        const field = formOfNode(def, a).find((f) => f.key === b);
        for (const r of responses) {
          const part = blocksOf(field, r.result?.[b], c);
          if (part.length === 0) continue;
          const person = c.ctx.person(r.userId);
          const user = c.ctx.users.get(r.userId);
          const unit = user?.unitId ? c.ctx.units.get(user.unitId)?.name : null;
          blocks.push({ kind: 'subheading', text: `${person?.fullName ?? 'Người tham gia'}${unit ? ` (${unit})` : ''}` }, ...part);
        }
      }
    }
    if (blocks.length === 0) blocks.push({ kind: 'paragraph', text: '(chưa có nội dung)' });
    sections.push({ heading: sec.heading, blocks });
  }
  // Số văn bản: ô cấp số của biểu mẫu khởi chạy (văn bản đến, chỉ thị) hoặc của một việc (văn bản đi: văn thư cấp số sau khi duyệt).
  const autonumber = def.inputs.find((f) => f.type === 'autonumber');
  let number = autonumber && typeof run.inputs[autonumber.key] === 'string' ? (run.inputs[autonumber.key] as string) : null;
  // Ngày ban hành: ô `ngayBanHanh` (kiểu ngày) của một việc, thường là việc cấp số. Chưa có thì tệp lấy ngày xuất.
  let issuedOn: string | null = null;
  for (const n of def.nodes) {
    if (n.type !== 'task' && n.type !== 'approval') continue;
    const step = latestStep(run.steps, n.id);
    if (!step?.result) continue;
    for (const f of n.form ?? []) {
      const v = step.result[f.key];
      if (number === null && f.type === 'autonumber' && typeof v === 'string' && v !== '') number = v;
      if (f.key === 'ngayBanHanh' && f.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) issuedOn = v;
    }
  }
  const recipientField = def.inputs.find((f) => f.key === 'noiNhan' || f.key === 'nguoiNhan');
  const recipient = recipientField ? textOf(blocksOf(recipientField, run.inputs[recipientField.key], c)) || null : null;
  const attachments = spec.includeAttachments ? files.filter((f) => f.fieldKey !== '__compiled').map((f) => f.name) : [];
  return { sections, title, number, issuedOn, recipient, attachments };
}

const safeName = (s: string): string =>
  s
    .normalize('NFC')
    // Dấu hai chấm thành gạch ngang (tiêu đề "Phiếu xử lý: ..." vẫn đọc được), ký tự cấm trong tên tệp thì bỏ.
    .replace(/\s*:\s*/g, ' - ')
    // eslint-disable-next-line no-control-regex -- loại ký tự điều khiển khỏi tên tệp là chủ đích
    .replace(/[\\/*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'tong-hop';

/**
 * Xuất tệp tổng hợp cho một việc tổng hợp: một tệp Word (để người ký còn sửa được) và một bản PDF dựng cùng lúc từ cùng nội dung
 * (để đọc trên mọi máy, kể cả điện thoại). Hai tệp cùng đính vào việc; bản PDF trỏ về tệp Word qua `renditionOf`.
 * Chỉ người đang giữ việc (hoặc người được ủy quyền) làm được, khi việc còn mở.
 */
export async function compileStep(tx: Tx, ctx: OrgContext, viewer: Viewer, stepId: string, current: Record<string, unknown> | undefined = undefined, meta: { ip?: string | null } = {}): Promise<StepCompileResponse> {
  const found = await findVisibleStep(tx, ctx, viewer, stepId);
  const [view] = await buildStepViews(tx, ctx, viewer, [found]);
  if (!view!.allowedActions.includes('complete')) throw new ApiError('forbidden');
  const loaded = await loadRun(tx, found.run.id);
  if (!loaded) throw new ApiError('not_found');
  const node = loaded.def.nodes.find((n) => n.id === found.step.nodeId);
  if (node?.type !== 'task' || !node.compile) throw new ApiError('input_invalid', { errors: [{ path: 'stepId', code: 'compile_not_configured' }] });

  const fileRows = await tx
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.runId, found.run.id), eq(schema.files.kind, 'attachment'), eq(schema.files.status, 'attached')));
  const fileNames = new Map(fileRows.map((f) => [f.id, f.name ?? 'tệp']));
  // Tệp ở các ô `file` cũng cần tên: có thể còn chờ gắn nếu người dùng chưa gửi, nên không bắt buộc có trong danh sách.
  const referenced = new Set<string>();
  for (const v of Object.values(loaded.run.inputs)) if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') referenced.add(x);
  const missing = [...referenced].filter((id) => !fileNames.has(id));
  if (missing.length > 0) {
    const more = await tx.select({ id: schema.files.id, name: schema.files.name }).from(schema.files).where(inArray(schema.files.id, missing));
    for (const f of more) fileNames.set(f.id, f.name ?? 'tệp');
  }

  const [org] = await tx.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId));
  const spec = node.compile;
  // Phần người làm đang gõ ở chính việc này (chưa gửi) thay cho kết quả của việc, để tệp có cả phần họ vừa viết.
  const steps = loaded.run.steps.map((s) => (s.id === found.step.id && current ? { ...s, result: { ...(s.result ?? {}), ...current } } : s));
  const resolved = resolve(loaded.def, spec, { title: loaded.run.title, inputs: loaded.run.inputs, steps }, { ctx, fileNames }, fileRows.map((f) => ({ id: f.id, name: f.name ?? 'tệp', fieldKey: f.fieldKey })));
  const now = clock.now();
  const local = toLocalDate(now, ctx.calendar);
  // Có ngày ban hành thì dòng "ngày … tháng … năm …" của tệp công văn in ngày đó; chưa có thì ngày xuất.
  const [y, m, d] = (resolved.issuedOn ?? local).split('-').map(Number) as [number, number, number];
  const rendered: RenderInput = {
    layout: spec.layout,
    orgName: org?.name ?? '',
    title: resolved.title,
    number: resolved.number,
    dateText: dmy(local),
    day: d,
    month: m,
    year: y,
    recipient: resolved.recipient,
    preparedBy: ctx.person(viewer.id)?.fullName ?? null,
    sections: resolved.sections,
    attachments: resolved.attachments,
  };
  const [docx, pdf] = await Promise.all([renderDocx(rendered), renderPdf(rendered)]);
  const base = { runId: found.run.id, stepRunId: found.step.id, ownerUserId: viewer.id };
  const file = await storeGeneratedFile(tx, ctx, { ...base, name: `${safeName(resolved.title)}.docx`, mime: MIME_DOCX, data: docx });
  const pdfFile = await storeGeneratedFile(tx, ctx, { ...base, name: `${safeName(resolved.title)}.pdf`, mime: MIME_PDF, data: pdf, sourceFileId: file.id });
  // Nhật ký chỉ ghi id và cỡ, không ghi tên tệp hay tiêu đề (CLAUDE.md luật 6).
  await audit(tx, { orgId: ctx.orgId, action: 'document_compiled', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'step', targetId: found.step.id, ip: meta.ip, detail: { fileId: file.id, sizeBytes: file.sizeBytes, pdfFileId: pdfFile.id, pdfSizeBytes: pdfFile.sizeBytes } });
  return { ...file, pdf: pdfFile };
}

/** Việc có cấu hình compile bắt buộc xuất tệp: đã có tệp tổng hợp ở việc này chưa. */
export async function hasCompiledFile(tx: Tx, stepRunId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.files.id })
    .from(schema.files)
    .where(and(eq(schema.files.stepRunId, stepRunId), eq(schema.files.fieldKey, '__compiled')))
    .limit(1);
  return rows.length > 0;
}
