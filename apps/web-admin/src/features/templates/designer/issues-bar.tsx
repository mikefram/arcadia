import { ChevronUp, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { DefinitionIssue, DraftDefinition } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import type { Issues } from './context';
import { findNode, nodeTitle } from './model';

const t = vi.admin.designer.editor.issues;

export type IssuesBarProps = {
  def: DraftDefinition;
  issues: Issues;
  /** bản vẽ mới tinh: chưa coi là lỗi, chỉ nhắc thêm bước */
  blank: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** chọn và cuộn tới nút hoặc đường nối có vấn đề */
  onGoTo: (target: { nodeId?: string; edgeId?: string }) => void;
};

function Item({ def, issue, level, onGoTo }: { def: DraftDefinition; issue: DefinitionIssue; level: 'error' | 'warning'; onGoTo: IssuesBarProps['onGoTo'] }) {
  const node = findNode(def, issue.nodeId);
  const edge = issue.edgeId ? def.edges.find((e) => e.id === issue.edgeId) : undefined;
  const Icon = level === 'error' ? CircleAlert : TriangleAlert;
  const where = node ? nodeTitle(node) : edge ? vi.admin.designer.editor.panel.edge.heading : t.general;
  const body = (
    <>
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', level === 'warning' && 'text-warn')} />
      <span className="min-w-0 flex-1">
        <span className="sr-only">{level === 'error' ? t.error : t.warning}: </span>
        <span className={cn(level === 'error' && 'font-medium')}>{issue.message}</span>
        <span className="block text-xs text-ink-sub">{where}</span>
      </span>
    </>
  );
  if (!node && !edge) return <li className="flex items-start gap-2 px-4 py-1.5 text-sm">{body}</li>;
  return (
    <li>
      <button
        type="button"
        title={node ? fmt(t.goTo, { tên: nodeTitle(node) }) : t.goToEdge}
        onClick={() => onGoTo(node ? { nodeId: node.id } : { edgeId: edge?.id })}
        className="flex w-full items-start gap-2 px-4 py-1.5 text-left text-sm hover:bg-surface-alt"
        data-testid="issue-item"
        data-level={level}
        data-node-id={node?.id}
      >
        {body}
      </button>
    </li>
  );
}

/**
 * Dải kết quả kiểm tra ở đáy khung vẽ (SPEC 9.3): đếm lỗi và điều cần lưu ý, mở ra thành danh sách;
 * bấm một dòng thì chọn và cuộn tới bước đó. Lỗi hiện bằng hình và chữ đậm màu mực, không dùng màu quá hạn.
 */
export function IssuesBar({ def, issues, blank, open, onOpenChange, onGoTo }: IssuesBarProps) {
  const errors = issues.errors.length;
  const warnings = issues.warnings.length;
  const clean = errors === 0 && warnings === 0;

  if (blank) {
    return (
      <div className="flex items-start gap-2 border-t border-hairline bg-surface px-4 py-2 text-sm text-ink-sub" data-testid="issues-bar" data-errors={0}>
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t.emptyDraft}
      </div>
    );
  }

  return (
    <section aria-label={t.title} className="border-t border-hairline bg-surface" data-testid="issues-bar" data-errors={errors} data-warnings={warnings}>
      <button
        type="button"
        aria-expanded={open}
        disabled={clean}
        onClick={() => onOpenChange(!open)}
        className="flex h-10 w-full items-center gap-3 px-4 text-left text-sm enabled:hover:bg-surface-alt"
        data-testid="issues-toggle"
      >
        <span className="font-semibold">{t.title}</span>
        {clean ? (
          <span className="inline-flex items-center gap-1.5 text-on-primary-tint">
            <CircleCheck aria-hidden="true" className="size-4" />
            {t.none}
          </span>
        ) : (
          <>
            {errors > 0 ? (
              <span className="inline-flex items-center gap-1.5 font-semibold">
                <CircleAlert aria-hidden="true" className="size-4" />
                {fmt(t.errors, { n: errors })}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-on-primary-tint">
                <CircleCheck aria-hidden="true" className="size-4" />
                {t.none}
              </span>
            )}
            {warnings > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-warn">
                <TriangleAlert aria-hidden="true" className="size-4" />
                {fmt(t.warnings, { n: warnings })}
              </span>
            ) : null}
          </>
        )}
        {clean ? null : (
          <span className="ml-auto inline-flex items-center gap-1 text-ink-sub">
            {open ? t.hide : t.show}
            <ChevronUp aria-hidden="true" className={cn('size-4 transition-transform', open && 'rotate-180')} />
          </span>
        )}
      </button>
      {open && !clean ? (
        <ul className="max-h-44 overflow-y-auto border-t border-hairline py-1" data-testid="issues-list">
          {issues.errors.map((issue, i) => (
            <Item key={`e${i}`} def={def} issue={issue} level="error" onGoTo={onGoTo} />
          ))}
          {issues.warnings.map((issue, i) => (
            <Item key={`w${i}`} def={def} issue={issue} level="warning" onGoTo={onGoTo} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
