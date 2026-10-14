import { useState } from 'react';
import { Minus, PencilLine, Plus, type LucideIcon } from 'lucide-react';
import type { DraftDefinition, TemplateDetail } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/features/templates/field-select';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/errors';
import { useApiQuery } from '@/lib/query';
import { findNode, nodeTitle } from './model';

const t = vi.admin.designer.editor.diff;

type Change = 'added' | 'removed' | 'changed';
const CHANGE_ICON: Record<Change, LucideIcon> = { added: Plus, removed: Minus, changed: PencilLine };
const CHANGE_LABEL: Record<Change, string> = { added: t.added, removed: t.removed, changed: t.changed };

function fieldName(field: string): string {
  const table: Record<string, string> = t.fields;
  return table[field] ?? t.fields.other;
}

/** Mỗi dòng có hình và chữ "Thêm", "Bớt", "Đổi": không phân biệt bằng màu. */
function ChangeRow({ change, title, detail }: { change: Change; title: string; detail?: string }) {
  const Icon = CHANGE_ICON[change];
  return (
    <li className="flex items-start gap-2.5 border-b border-hairline px-3.5 py-2 last:border-b-0" data-change={change}>
      <span className="mt-0.5 inline-flex w-[4.25rem] shrink-0 items-center gap-1 text-sm font-semibold">
        <Icon aria-hidden="true" className="size-3.5" />
        {CHANGE_LABEL[change]}
      </span>
      <span className="min-w-0">
        <span className="font-medium">{title}</span>
        {detail ? <span className="block text-sm text-ink-sub">{detail}</span> : null}
      </span>
    </li>
  );
}

function DiffBody({ template, current }: { template: TemplateDetail; current: DraftDefinition }) {
  const versions = [...template.versions].sort((a, b) => b.version - a.version);
  const options = versions.map((v) => ({ value: String(v.version), label: fmt(v.status === 'draft' ? t.draft : t.version, { n: v.version }) }));
  const [to, setTo] = useState(String(versions[0]?.version ?? ''));
  const [from, setFrom] = useState(String(versions[1]?.version ?? ''));
  const ready = from !== '' && to !== '' && from !== to;

  const diff = useApiQuery('templates.diff', { params: { id: template.id }, query: { from: Number(from), to: Number(to) } }, { enabled: ready, staleTime: 0 });

  // Tên bước lấy từ bản đang mở; bước đã bị bớt thì lấy tên máy chủ trả trong danh sách thay đổi.
  const nameOf = (id: string) => {
    const node = findNode(current, id);
    return node ? nodeTitle(node) : (diff.data?.nodes.find((n) => n.nodeId === id)?.label ?? id);
  };

  return (
    <>
      <DialogBody>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.from}>
            <Select value={from || null} options={options} onValueChange={(v) => setFrom(v ?? '')} />
          </Field>
          <Field label={t.to}>
            <Select value={to || null} options={options} onValueChange={(v) => setTo(v ?? '')} />
          </Field>
        </div>
        {template.hasDraft ? <p className="-mt-1 text-sm text-ink-sub">{t.unsavedNote}</p> : null}

        {!ready ? (
          <Callout tone="info">{t.same}</Callout>
        ) : diff.isPending ? (
          <Spinner showLabel />
        ) : diff.isError ? (
          <Callout tone="error">{errorMessage(diff.error)}</Callout>
        ) : diff.data.nodes.length === 0 && diff.data.edges.length === 0 ? (
          <Callout tone="info">{t.none}</Callout>
        ) : (
          <div className="flex flex-col gap-4" data-testid="diff-result">
            <section>
              <h3 className="mb-1.5 text-base font-semibold">{t.steps}</h3>
              {diff.data.nodes.length === 0 ? (
                <p className="text-sm text-ink-sub">{t.noSteps}</p>
              ) : (
                <ul className="rounded-xl border border-hairline">
                  {diff.data.nodes.map((n) => (
                    <ChangeRow
                      key={n.nodeId}
                      change={n.change}
                      title={n.label || n.nodeId}
                      detail={n.change === 'changed' ? fmt(t.changedFields, { phần: [...new Set(n.fields.map(fieldName))].join(', ') }) : undefined}
                    />
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="mb-1.5 text-base font-semibold">{t.edges}</h3>
              {diff.data.edges.length === 0 ? (
                <p className="text-sm text-ink-sub">{t.noEdges}</p>
              ) : (
                <ul className="rounded-xl border border-hairline">
                  {diff.data.edges.map((e) => (
                    <ChangeRow key={e.edgeId} change={e.change} title={fmt(t.edgeFromTo, { từ: nameOf(e.from), đến: nameOf(e.to) })} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="primary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}

/** So sánh hai phiên bản (SPEC 9.3, Giai đoạn 3): nút và đường nối thêm, bớt, đổi theo `templates.diff`. */
export function DiffDialog({ open, onOpenChange, template, current }: { open: boolean; onOpenChange: (open: boolean) => void; template: TemplateDetail; current: DraftDefinition }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="diff-dialog">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription className="sr-only">{t.title}</DialogDescription>
        </DialogHeader>
        <DiffBody template={template} current={current} />
      </DialogContent>
    </Dialog>
  );
}
