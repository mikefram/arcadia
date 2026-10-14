import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { FormField, SimulateResponse } from '@mihato/domain';
import { fmt, formatDateWeekday, formatMoney, formatTime, vi } from '@mihato/i18n';
import { PersonName } from '@/components/person-name';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/features/templates/field-select';
import { Table, TableFrame, Td, Th } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, isApiError } from '@/lib/errors';
import { personName } from '@/lib/person';
import { useApiMutation } from '@/lib/query';
import { collect, isSkippedInSimulation, type Errors, type Groups, type Values } from './simulate-input';

const t = vi.admin.designer.editor.simulate;

export type SimulateTarget = { draft: true } | { version: number };

export type SimulateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  inputs: readonly FormField[];
  targetField: string | undefined;
  /** chạy thử bản nháp đang sửa, hoặc một phiên bản đã xuất bản */
  target: SimulateTarget;
  /** lưu nháp trước khi gọi máy chủ; trả false thì dừng (ví dụ nháp vừa bị người khác sửa) */
  beforeRun?: () => Promise<boolean>;
  /** mã các bước duyệt ở cách "Góp nội dung", để bảng ghi đúng loại */
  contributeIds?: ReadonlySet<string>;
};

function Result({ result, contributeIds }: { result: SimulateResponse; contributeIds?: ReadonlySet<string> }) {
  const rows = [...result.rows].sort((a, b) => a.order - b.order);
  const past = rows.filter((r) => r.pastDue);
  // Cảnh báo hạn đã qua được gom vào một lời báo chung phía trên; các cảnh báo khác liệt kê riêng.
  const others = [...new Set(result.warnings.filter((w) => !(w.nodeId && past.some((r) => r.nodeId === w.nodeId) && w.code === 'due_in_past')).map((w) => w.message))];

  return (
    <section aria-labelledby="chay-thu-ket-qua" className="flex flex-col gap-3" data-testid="simulate-result">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="chay-thu-ket-qua" className="text-lg font-semibold">
          {t.resultTitle}
        </h3>
        {result.targetAt ? <p className="text-sm text-ink-sub">{fmt(t.targetAt, { ngày: formatDateWeekday(result.targetAt) })}</p> : null}
      </div>

      {past.length > 0 ? (
        <Callout tone="warn" title={fmt(t.pastDueTitle, { n: past.length })}>
          {t.pastDueBody}
        </Callout>
      ) : null}
      {others.length > 0 ? (
        <Callout tone="warn" title={t.warningsTitle}>
          <ul className={others.length > 1 ? 'list-disc space-y-0.5 pl-4' : undefined}>
            {others.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-base text-ink-sub">{t.empty}</p>
      ) : (
        <TableFrame>
          <Table className="min-w-[640px] table-fixed">
            <caption className="sr-only">{t.resultCaption}</caption>
            <thead>
              <tr>
                <Th className="w-[64px] text-right">{t.colOrder}</Th>
                <Th>{t.colStep}</Th>
                <Th className="w-[176px]">{t.colAssignee}</Th>
                <Th className="w-[330px]">{t.colDue}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.nodeId} data-node-id={row.nodeId} className="last:[&>td]:border-b-0">
                  <Td className="py-2 tabular text-right text-ink-sub">{i + 1}</Td>
                  <Td className="py-2">
                    <p className="font-medium">{row.title}</p>
                    {/* "Việc" là loại mặc định nên không ghi lại ở mỗi dòng; chỉ ghi các loại khác (Duyệt). */}
                    {row.kind !== 'task' ? <p className="text-sm text-ink-sub">{contributeIds?.has(row.nodeId) ? t.contribute : vi.common.nodeKind[row.kind]}</p> : null}
                  </Td>
                  <Td className="py-2">
                    {row.assigneeChosenLater && !row.assignee ? (
                      <span className="text-ink-sub" title={t.chosenLaterTitle} data-testid="chosen-later">
                        {t.chosenLater}
                      </span>
                    ) : (
                      <PersonName person={row.assignee} fallback={t.noAssignee} />
                    )}
                    {row.onBehalfOf ? <p className="text-sm text-ink-sub">{fmt(vi.common.onBehalfOf, { tên: personName(row.onBehalfOf, 'short') })}</p> : null}
                  </Td>
                  {/* Nhãn "Hạn đã qua" nằm cạnh ngày; hết chỗ thì xuống dòng. Hàng thấp để sáu việc của "Đón đoàn" hiện đủ trong hộp thoại. */}
                  <Td className="py-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {row.dueAt ? (
                        <time dateTime={row.dueAt} className="tabular whitespace-nowrap">
                          {fmt(t.dueAt, { ngày: formatDateWeekday(row.dueAt), giờ: formatTime(row.dueAt) })}
                        </time>
                      ) : (
                        <span className="text-ink-sub">{t.noDue}</span>
                      )}
                      {row.pastDue ? <Badge tone="warn">{t.pastDue}</Badge> : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      )}
    </section>
  );
}

/** Ô "Chọn nhiều người" khi chạy thử: những người đã chọn kèm nút bỏ, và ô tìm để thêm người. */
function PeopleInput({ value, onChange }: { value: readonly PersonOption[]; onChange: (people: PersonOption[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((p) => (
            <li key={p.id} className="inline-flex items-center gap-1 rounded-lg border border-hairline bg-canvas py-0.5 pr-0.5 pl-2.5 text-sm">
              {p.fullName}
              <Button variant="ghost" size="icon-sm" className="size-6" aria-label={fmt(t.peopleRemove, { tên: p.fullName })} onClick={() => onChange(value.filter((x) => x.id !== p.id))}>
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <PersonPicker
        value={null}
        placeholder={t.peopleAdd}
        excludeIds={value.map((p) => p.id)}
        onChange={(person) => person && onChange([...value, person])}
      />
    </div>
  );
}

function SimulateForm({ templateId, inputs, targetField, target, beforeRun, contributeIds }: Omit<SimulateDialogProps, 'open' | 'onOpenChange'>) {
  const [values, setValues] = useState<Values>({});
  const [groups, setGroups] = useState<Groups>({});
  const [people, setPeople] = useState<Record<string, PersonOption | null>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [preparing, setPreparing] = useState(false);
  const simulate = useApiMutation('templates.simulate', { toastError: false });

  const set = (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const collected = collect(inputs, values, groups);
    setErrors(collected.errors);
    if (Object.keys(collected.errors).length > 0) return;
    setPreparing(true);
    const ready = beforeRun ? await beforeRun() : true;
    setPreparing(false);
    if (!ready) return;
    simulate.mutate({ params: { id: templateId }, body: { ...target, inputs: collected.inputs } });
  };

  const failure = simulate.error ? (isApiError(simulate.error, 'template_invalid') ? t.failedInvalid : errorMessage(simulate.error)) : null;

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{inputs.length > 0 ? t.intro : t.introNoInputs}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-ink-sub">{'version' in target ? fmt(t.versionNote, { n: target.version }) : t.draftNote}</p>
        {inputs.length > 0 ? (
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            {inputs.map((f) => {
              const label = (
                <>
                  {f.label}
                  {f.key === targetField ? (
                    <Badge tone="gold" className="ml-2 align-middle">
                      {t.targetBadge}
                    </Badge>
                  ) : null}
                </>
              );
              if (isSkippedInSimulation(f)) {
                return (
                  <div key={f.key} className="flex flex-col gap-1">
                    <p className="text-base font-medium">{label}</p>
                    <p className="text-sm text-ink-sub">{f.type === 'autonumber' ? t.autoNumber : t.fileNote}</p>
                  </div>
                );
              }
              return (
                <Field key={f.key} label={label} hint={f.hint} required={f.required} error={errors[f.key]}>
                  {f.type === 'select' ? (
                    <Select value={values[f.key] || null} placeholder={t.selectPlaceholder} options={f.options ?? []} onValueChange={(v) => set(f.key, v ?? '')} />
                  ) : f.type === 'user' ? (
                    <PersonPicker
                      value={people[f.key] ?? null}
                      onChange={(person) => {
                        setPeople((prev) => ({ ...prev, [f.key]: person }));
                        set(f.key, person?.id ?? '');
                      }}
                    />
                  ) : f.type === 'users' ? (
                    <PeopleInput
                      value={groups[f.key] ?? []}
                      onChange={(list) => {
                        setGroups((prev) => ({ ...prev, [f.key]: list }));
                        if (errors[f.key]) setErrors(({ [f.key]: _gone, ...rest }) => rest);
                      }}
                    />
                  ) : f.type === 'longtext' ? (
                    <Textarea rows={3} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} data-input-key={f.key} data-input-type={f.type} />
                  ) : (
                    <Input
                      type={f.type === 'date' ? 'date' : 'text'}
                      inputMode={f.type === 'number' || f.type === 'money' ? 'numeric' : undefined}
                      value={values[f.key] ?? ''}
                      onChange={(e) => set(f.key, e.target.value)}
                      data-input-key={f.key}
                      data-input-type={f.type}
                    />
                  )}
                  {f.type === 'money' && /^\d+$/.test((values[f.key] ?? '').replace(/[.\s]/g, '')) ? (
                    <p className="tabular text-sm text-ink-sub">{formatMoney(Number((values[f.key] ?? '').replace(/[.\s]/g, '')))}</p>
                  ) : null}
                </Field>
              );
            })}
          </div>
        ) : null}

        {failure ? <Callout tone="error">{failure}</Callout> : null}
        {simulate.data ? <Result result={simulate.data} contributeIds={contributeIds} /> : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={preparing || simulate.isPending} data-testid="simulate-run">
          {simulate.data ? t.rerun : t.run}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Chạy thử (SPEC 9.3): nhập biểu mẫu khởi chạy với mốc đích mẫu, nhận bảng "ai làm gì, hạn nào".
 * Chỉ mô phỏng bằng `templates.simulate`: không tạo lượt chạy, không ghi CSDL.
 */
export function SimulateDialog({ open, onOpenChange, ...rest }: SimulateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Rộng hơn cỡ "lg" để tên việc dài và nhãn "Hạn đã qua" không xuống dòng: sáu việc của "Đón đoàn" hiện đủ trong màn 1280×800. */}
      <DialogContent size="lg" className="max-w-[60rem]" data-testid="simulate-dialog">
        <SimulateForm {...rest} />
      </DialogContent>
    </Dialog>
  );
}
