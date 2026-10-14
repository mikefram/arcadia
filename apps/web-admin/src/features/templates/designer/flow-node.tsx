import { memo, useEffect, type ReactNode } from 'react';
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react';
import { BellRing, CalendarClock, CircleAlert, ClipboardCheck, FileOutput, Flag, Hourglass, PenLine, Play, Plus, Split, Stamp, TriangleAlert, UserRound, UsersRound, Webhook, type LucideIcon } from 'lucide-react';
import type { DraftNode } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { useDesigner, type ElementIssue } from './context';
import { assigneeSummary, assigneesSummary, branchName, dueSummary, durationText, ELSE, isContribute, NO_HANDLE, nodeKindLabel, nodeTitle, outEdges, sourceHandleOf, type AddableKind } from './model';

const t = vi.admin.designer.editor;

export type FlowNodeData = { node: DraftNode };
export type FlowNode = Node<FlowNodeData, 'step'>;

/** Mỗi loại bước một hình riêng: phân biệt bằng hình và chữ, không chỉ bằng màu. */
export const KIND_ICON: Record<DraftNode['type'], LucideIcon> = {
  start: Play,
  end: Flag,
  task: ClipboardCheck,
  approval: Stamp,
  condition: Split,
  timer: Hourglass,
  notify: BellRing,
  webhook: Webhook,
};

/** Màu nhấn theo loại: việc màu xanh lục, duyệt màu vàng đồng, các bước tự động màu trung tính. */
export const KIND_TINT: Record<DraftNode['type'], string> = {
  start: 'bg-primary text-on-primary',
  end: 'bg-primary text-on-primary',
  task: 'bg-primary-tint text-on-primary-tint',
  approval: 'bg-gold-tint text-gold',
  condition: 'bg-surface-alt text-ink',
  timer: 'bg-surface-alt text-ink',
  notify: 'bg-surface-alt text-ink',
  webhook: 'bg-surface-alt text-ink',
};

/** Khối "Góp nội dung" của cột trái: biểu tượng riêng để không lẫn với bước Duyệt. */
export const ADDABLE_ICON: Record<AddableKind, LucideIcon> = { ...KIND_ICON, contribute: PenLine };
export const ADDABLE_TINT: Record<AddableKind, string> = { ...KIND_TINT, contribute: KIND_TINT.approval };

/** Biểu tượng và màu của một bước đã có trên sơ đồ; bước duyệt ở cách "Góp nội dung" có biểu tượng riêng. */
export function iconOf(node: DraftNode): LucideIcon {
  return isContribute(node) ? PenLine : KIND_ICON[node.type];
}

function Row({ icon: Icon, muted, children }: { icon: LucideIcon; muted?: boolean; children: ReactNode }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-sm', muted ? 'text-ink-sub italic' : 'text-ink-sub')}>
      <Icon aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
      <span className="line-clamp-2 min-w-0">{children}</span>
    </p>
  );
}

/**
 * Dấu cộng "thêm bước kế tiếp" cạnh một cổng ra. Luôn hiện ở bước chưa nối đi đâu (để người mới biết bấm vào đâu),
 * còn lại chỉ hiện khi rê chuột hoặc đang chọn bước. Với nút có nhiều cổng (duyệt, rẽ nhánh), mỗi cổng còn trống có dấu cộng riêng.
 */
function AddNextButton({ node, handle, label }: { node: DraftNode; handle: string | null; label?: string }) {
  const { def, openQuickAdd, selection } = useDesigner();
  const dangling = outEdges(def, node.id).length === 0;
  const selected = selection.nodes.length === 1 && selection.nodes[0] === node.id;
  const name = fmt(t.canvas.addNext, { tên: label ? `${nodeTitle(node)}: ${label}` : nodeTitle(node) });
  return (
    <button
      type="button"
      aria-label={name}
      title={name}
      data-testid={handle ? `add-next-${node.id}-${handle}` : `add-next-${node.id}`}
      onClick={(e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        openQuickAdd({ screen: { x: rect.right + 6, y: rect.top }, from: { nodeId: node.id, handle } });
      }}
      className={cn(
        'nodrag nopan absolute top-1/2 left-full ml-3.5 inline-flex -translate-y-1/2 items-center justify-center rounded-full border border-primary bg-surface text-primary transition-opacity hover:bg-primary-tint focus-visible:opacity-100',
        handle ? 'size-6' : 'size-7',
        dangling || selected ? 'opacity-100' : 'opacity-0 group-hover/node:opacity-100',
      )}
    >
      <Plus aria-hidden="true" className="size-4" strokeWidth={2.5} />
    </button>
  );
}

/** Một cổng ra có tên (Đồng ý, Chưa đồng ý, tên nhánh, Còn lại): kéo từ chấm tròn ở cuối dòng để nối. */
function OutRow({ node, id, label, tone, connectable, free }: { node: DraftNode; id: string; label: string; tone?: 'primary' | 'gold' | 'plain'; connectable: boolean; free: boolean }) {
  return (
    <div className="relative flex min-h-[30px] items-center justify-end py-1 pr-4 pl-3">
      <span
        className={cn(
          'max-w-full truncate rounded-md px-1.5 py-0.5 text-xs font-medium',
          tone === 'primary' ? 'bg-primary-tint text-on-primary-tint' : tone === 'gold' ? 'bg-gold-tint text-gold' : 'bg-surface-alt text-ink-sub',
        )}
      >
        {label}
      </span>
      <Handle type="source" id={id} position={Position.Right} isConnectable={connectable} aria-label={`${t.canvas.handleSource}: ${label}`} />
      {connectable && free ? <AddNextButton node={node} handle={id} label={label} /> : null}
    </div>
  );
}

function IssueStrip({ issue }: { issue: ElementIssue }) {
  const Icon = issue.level === 'error' ? CircleAlert : TriangleAlert;
  const more = issue.messages.length - 1;
  return (
    <div
      className={cn(
        'flex items-start gap-1.5 rounded-b-[11px] border-t px-3 py-1.5 text-xs leading-snug',
        issue.level === 'error' ? 'border-ink bg-surface font-medium text-ink' : 'border-warn/40 bg-warn-bg text-warn',
      )}
    >
      <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>
        <span className="sr-only">{issue.level === 'error' ? t.issues.error : t.issues.warning}: </span>
        {issue.messages[0]}
        {more > 0 ? <span className="font-normal"> {fmt(t.node.moreIssues, { n: more })}</span> : null}
      </span>
    </div>
  );
}

function StepNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { def, readOnly, lookups, nodeIssue } = useDesigner();
  const node = data.node;
  const issue = nodeIssue(node.id);
  const Icon = iconOf(node);
  const contribute = isContribute(node);
  const connectable = !readOnly;

  // Thêm, bớt nhánh làm đổi các cổng ra: báo React Flow đo lại vị trí cổng để đường nối bám đúng chỗ.
  const updateNodeInternals = useUpdateNodeInternals();
  const handleKey = node.type === 'condition' ? (node.branches ?? []).map((b) => b.id).join('|') : node.type === 'approval' ? (contribute ? 'contribute' : 'approve') : '';
  useEffect(() => {
    updateNodeInternals(id);
  }, [handleKey, id, updateNodeInternals]);

  if (node.type === 'start' || node.type === 'end') {
    const isStart = node.type === 'start';
    return (
      // Câu báo lỗi nằm trong chính nút (không treo lơ lửng), để React Flow đo cả phần này và các nút khác không bị đè lên.
      <div className="group/node flex flex-col items-start gap-1.5">
        <div className="relative">
          <div
            data-kind={node.type}
            data-issue={issue?.level}
            className={cn(
              'flex h-11 min-w-[124px] items-center gap-2 rounded-full pr-5 pl-4 text-base font-semibold',
              isStart ? 'bg-primary text-on-primary' : 'border-2 border-primary bg-surface text-primary',
              issue?.level === 'error' && 'outline-2 outline-offset-2 outline-ink',
              selected && 'outline-2 outline-offset-2 outline-primary',
            )}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" fill={isStart ? 'currentColor' : 'none'} />
            <span className="max-w-40 truncate">{node.label || vi.common.nodeKind[node.type]}</span>
            {issue ? issue.level === 'error' ? <CircleAlert aria-hidden="true" className="size-4 shrink-0" /> : <TriangleAlert aria-hidden="true" className="size-4 shrink-0" /> : null}
          </div>
          {isStart ? (
            <Handle type="source" position={Position.Right} isConnectable={connectable} aria-label={t.canvas.handleSource} />
          ) : (
            <Handle type="target" position={Position.Left} isConnectable={connectable} aria-label={t.canvas.handleTarget} />
          )}
          {isStart && !readOnly ? <AddNextButton node={node} handle={null} /> : null}
        </div>
        {issue ? (
          <p
            className={cn(
              'w-52 rounded-lg border px-2.5 py-1.5 text-xs leading-snug',
              issue.level === 'error' ? 'border-ink bg-surface font-medium text-ink' : 'border-warn/40 bg-warn-bg text-warn',
            )}
          >
            <span className="sr-only">{issue.level === 'error' ? t.issues.error : t.issues.warning}: </span>
            {issue.messages[0]}
          </p>
        ) : null}
      </div>
    );
  }

  const title = nodeTitle(node);
  const untitled = (node.type === 'task' || node.type === 'approval') && !(node.title ?? '').trim();
  const used = new Set(outEdges(def, node.id).map((e) => sourceHandleOf(def, e)));

  return (
    <div className="group/node relative">
      <div
        data-kind={node.type}
        data-action={contribute ? 'contribute' : undefined}
        data-issue={issue?.level}
        className={cn(
          'w-[224px] rounded-xl border bg-surface',
          issue?.level === 'error' ? 'border-ink ring-1 ring-ink' : issue?.level === 'warning' ? 'border-warn ring-1 ring-warn' : 'border-line',
          selected && 'outline-2 outline-offset-2 outline-primary',
        )}
      >
        <div className="flex flex-col gap-1 px-3 pt-2.5 pb-2.5">
          <div className="flex items-center gap-1.5">
            <span className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-md', KIND_TINT[node.type])}>
              <Icon aria-hidden="true" className="size-3.5" />
            </span>
            <span className="text-xs font-semibold text-ink-sub">{nodeKindLabel(node)}</span>
          </div>
          <p className={cn('line-clamp-2 text-base leading-snug font-semibold', untitled && 'text-ink-sub')}>{title}</p>

          {node.type === 'task' ? (
            <>
              <Row icon={UserRound} muted={!node.assignee}>
                {assigneeSummary(def, node.assignee, lookups) ?? t.node.noAssignee}
              </Row>
              <Row icon={CalendarClock} muted={!node.due}>
                {dueSummary(node.due) ?? t.node.noDue}
              </Row>
              {node.compile ? <Row icon={FileOutput}>{fmt(t.node.compile, { tên: node.compile.title })}</Row> : null}
            </>
          ) : null}

          {node.type === 'approval' ? (
            <>
              <Row icon={(node.approvers?.length ?? 0) > 1 ? UsersRound : UserRound} muted={!node.approvers?.length}>
                {assigneesSummary(def, node.approvers, lookups) ?? (contribute ? t.node.noContributor : t.node.noApprover)}
                {(node.approvers?.length ?? 0) > 1 ? `, ${contribute ? (node.mode === 'all' ? t.node.contributeAll : t.node.contributeAny) : node.mode === 'all' ? t.node.modeAll : t.node.modeAny}` : null}
              </Row>
              <Row icon={CalendarClock} muted={!node.due}>
                {dueSummary(node.due) ?? t.node.noDue}
              </Row>
            </>
          ) : null}

          {node.type === 'timer' && node.wait ? <Row icon={Hourglass}>{fmt(t.node.wait, { khoảng: durationText(node.wait) })}</Row> : null}

          {node.type === 'notify' ? (
            <Row icon={UserRound} muted={!node.to?.length}>
              {assigneesSummary(def, node.to, lookups) ?? t.node.noRecipient}
            </Row>
          ) : null}
        </div>

        {node.type === 'approval' ? (
          <div className="border-t border-hairline py-0.5">
            <OutRow node={node} id="approved" label={contribute ? t.node.contributeDone : vi.common.actions.approve} tone="primary" connectable={connectable} free={!used.has('approved')} />
            {/* Bước góp nội dung không có "Chưa đồng ý": ẩn cổng này. Đường cũ còn sót thì hiện ở cổng tạm bên dưới cho người vẽ thấy và xoá. */}
            {contribute ? null : <OutRow node={node} id="rejected" label={vi.common.actions.reject} connectable={connectable} free={!used.has('rejected')} />}
            {used.has(NO_HANDLE) ? <OutRow node={node} id={NO_HANDLE} label={t.node.unlabelled} connectable={false} free={false} /> : null}
          </div>
        ) : null}

        {node.type === 'condition' ? (
          <div className="border-t border-hairline py-0.5">
            {(node.branches ?? []).map((b) => (
              <OutRow key={b.id} node={node} id={b.id} label={branchName(def, node, b.id)} tone="gold" connectable={connectable} free={!used.has(b.id)} />
            ))}
            <OutRow node={node} id={ELSE} label={t.node.branchElse} connectable={connectable} free={!used.has(ELSE)} />
            {used.has(NO_HANDLE) ? <OutRow node={node} id={NO_HANDLE} label={t.node.unlabelled} connectable={false} free={false} /> : null}
          </div>
        ) : null}

        {issue ? <IssueStrip issue={issue} /> : null}
      </div>

      <Handle type="target" position={Position.Left} isConnectable={connectable} aria-label={t.canvas.handleTarget} />
      {node.type !== 'approval' && node.type !== 'condition' ? (
        <>
          <Handle type="source" position={Position.Right} isConnectable={connectable} aria-label={t.canvas.handleSource} />
          {!readOnly ? <AddNextButton node={node} handle={null} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** Nút tự vẽ của sơ đồ (không dùng nút mặc định của React Flow): loại, tên, người nhận, hạn, lỗi kiểm tra. */
export const StepNode = memo(StepNodeView);
