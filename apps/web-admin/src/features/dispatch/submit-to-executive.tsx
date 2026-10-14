import { useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useCan } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useApiMutation, useApiQuery } from '@/lib/query';

const t = vi.admin.shell.dispatch.submit;
const EXECUTIVE_TITLES: readonly string[] = [vi.common.role.chairman, vi.common.role.director, vi.common.role.deputy];

export type SubmitToExecutiveProps = {
  /** công cụ của đề xuất, đúng tên như AI gọi (SPEC 7.7: "Trình" dùng cùng cổng xác nhận) */
  tool: 'propose_nudge' | 'propose_start_run';
  /** tham số của công cụ; máy chủ kiểm lại và tự dựng câu xác nhận */
  payload: Record<string, unknown>;
  /** chú thích riêng của công cụ, hiện dưới phần giới thiệu */
  note?: string;
  disabled?: boolean;
  onDone?: () => void;
};

/**
 * "Trình" (SPEC 7.7, Giai đoạn 3): Văn phòng soạn sẵn lời nhắc hoặc đề nghị giao việc rồi trình người điều hành.
 * Đề xuất hiện ở mục "Việc cần quyết" trên ứng dụng của người nhận như một đề xuất của trợ lý; cùng cổng xác nhận,
 * cùng mức rủi ro: Văn phòng không duyệt thay ai. Chỉ người có quyền `proposal.create_office` thấy nút này.
 */
export function SubmitToExecutive({ tool, payload, note, disabled, onDone }: SubmitToExecutiveProps) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (!can('proposal.create_office')) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={disabled}>
          <Send aria-hidden="true" />
          {t.open}
        </Button>
      </DialogTrigger>
      <DialogContent size="md">
        <SubmitFlow
          tool={tool}
          payload={payload}
          note={note}
          onDone={() => {
            setOpen(false);
            onDone?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function SubmitFlow({ tool, payload, note, onDone }: Pick<SubmitToExecutiveProps, 'tool' | 'payload' | 'note'> & { onDone: () => void }) {
  const people = useApiQuery('people.search', { query: { q: '', limit: 100 } }, { staleTime: 60_000 });
  const executives = useMemo(() => (people.data?.items ?? []).filter((p) => p.roleTitle && EXECUTIVE_TITLES.includes(p.roleTitle)), [people.data]);
  const [chosen, setChosen] = useState<string | null>(null);
  // Mặc định trình lên Chủ tịch, vì SPEC 7.7 viết cho Chủ tịch.
  const recipientId = chosen ?? executives.find((p) => p.roleTitle === vi.common.role.chairman)?.id ?? executives[0]?.id ?? null;
  const options = executives.map((p) => ({ value: p.id, label: `${p.fullName}, ${p.roleTitle ?? ''}` }));

  const create = useApiMutation('proposals.create', { invalidate: [], toastError: false });
  const submit = () => {
    if (!recipientId) return;
    const target = executives.find((p) => p.id === recipientId);
    create.mutate(
      { body: { forUserId: recipientId, tool, payload } },
      {
        onSuccess: (res) => {
          toast.success(res.items.length > 1 ? fmt(t.doneMany, { n: res.items.length, tên: target?.fullName ?? '' }) : fmt(t.done, { tên: target?.fullName ?? '' }));
          onDone();
        },
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{t.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {note ? <p className="text-sm text-ink-sub">{note}</p> : null}
        <p className="text-sm text-ink-sub">{t.expiry}</p>
        {people.isSuccess && executives.length === 0 ? <Callout tone="warn">{t.noExecutives}</Callout> : null}
        {executives.length > 0 ? (
          <Field label={t.recipient}>
            <Select value={recipientId} onValueChange={setChosen} options={options} placeholder={t.recipientPlaceholder} />
          </Field>
        ) : null}
        {create.isError ? (
          <Callout tone="error" title={t.failed}>
            {errorMessage(create.error)}
          </Callout>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button variant="primary" loading={create.isPending} disabled={!recipientId} onClick={submit}>
          {t.submit}
        </Button>
      </DialogFooter>
    </>
  );
}
