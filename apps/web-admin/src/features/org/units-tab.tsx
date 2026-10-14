import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { CornerDownRight, Network, Plus } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { UnitCreateSchema, type UnitView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { PersonPicker, type PickedPerson } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableFrame, Td, Th } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { viCollator } from '@/lib/collator';
import { errorMessage } from '@/lib/errors';
import { useApiMutation, useApiQuery } from '@/lib/query';
import { fieldIssue, LoadError, UnitPicker } from './shared';

const t = vi.admin.org.units;

type FormInput = z.input<typeof UnitCreateSchema>;
type FormOutput = z.output<typeof UnitCreateSchema>;
type UnitRow = { unit: UnitView; depth: number; parentName: string | null };

/** Trải cây đơn vị thành các dòng có bậc thụt; anh em cùng cấp xếp theo thứ tự chữ cái tiếng Việt. */
function toRows(units: readonly UnitView[]): UnitRow[] {
  const ids = new Set(units.map((u) => u.id));
  const byParent = new Map<string | null, UnitView[]>();
  for (const u of units) {
    const parent = u.parentId && ids.has(u.parentId) ? u.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), u]);
  }
  const rows: UnitRow[] = [];
  const walk = (parent: UnitView | null, depth: number) => {
    const children = [...(byParent.get(parent?.id ?? null) ?? [])].sort((a, b) => viCollator.compare(a.name, b.name));
    for (const unit of children) {
      rows.push({ unit, depth, parentName: parent?.name ?? null });
      walk(unit, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** Chính đơn vị đó và mọi đơn vị nằm dưới nó: không được chọn làm đơn vị cha (tránh vòng lặp). */
function selfAndDescendants(units: readonly UnitView[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.parentId && out.has(u.parentId) && !out.has(u.id)) {
        out.add(u.id);
        grew = true;
      }
    }
  }
  return out;
}

type FormTarget = { unit: UnitView | null; parentId: string | null };

function UnitForm({ target, units, onOpenChange }: { target: FormTarget; units: readonly UnitView[]; onOpenChange: (open: boolean) => void }) {
  const { unit } = target;
  const [head, setHead] = useState<PickedPerson | null>(
    unit?.headUserId && unit.headName ? { id: unit.headUserId, fullName: unit.headName, givenName: unit.headName, honorific: null } : null,
  );
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(UnitCreateSchema),
    defaultValues: { name: unit?.name ?? '', parentId: unit ? unit.parentId : target.parentId, headUserId: unit?.headUserId ?? null },
  });
  const excluded = useMemo(() => (unit ? selfAndDescendants(units, unit.id) : undefined), [units, unit]);

  const invalidate = ['units.list', 'users.list', 'people.search', 'admin.audit'] as const;
  const create = useApiMutation('units.create', { toastError: false, invalidate });
  const update = useApiMutation('units.update', { toastError: false, invalidate });
  const failure = create.error ?? update.error;
  const cycle = fieldIssue(failure, 'body.parentId') === 'cycle';

  const submit = form.handleSubmit((values) => {
    const done = (message: string) => () => {
      toast.success(fmt(message, { tên: values.name }));
      onOpenChange(false);
    };
    if (!unit) {
      create.mutate({ body: values }, { onSuccess: done(t.form.created) });
      return;
    }
    const patch = {
      ...(values.name !== unit.name ? { name: values.name } : {}),
      ...(values.parentId !== unit.parentId ? { parentId: values.parentId } : {}),
      ...(values.headUserId !== unit.headUserId ? { headUserId: values.headUserId } : {}),
    };
    if (Object.keys(patch).length === 0) {
      toast.info(t.form.nothingChanged);
      onOpenChange(false);
      return;
    }
    update.mutate({ params: { id: unit.id }, body: patch }, { onSuccess: done(t.form.updated) });
  });

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{unit ? t.form.titleEdit : t.form.titleNew}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {failure ? <Callout tone="error">{cycle ? t.form.cycle : errorMessage(failure)}</Callout> : null}
        <Field label={t.form.name} required error={form.formState.errors.name ? t.form.nameRequired : undefined}>
          <Input autoComplete="off" {...form.register('name', { setValueAs: (v: unknown) => (typeof v === 'string' ? v.trim() : '') })} />
        </Field>
        <Field label={t.form.parent}>
          <Controller
            control={form.control}
            name="parentId"
            render={({ field }) => <UnitPicker value={field.value ?? null} onValueChange={field.onChange} emptyOption={t.form.parentNone} excludeIds={excluded} />}
          />
        </Field>
        <Field label={t.form.head} hint={t.form.headHint}>
          <PersonPicker
            value={head}
            placeholder={t.form.headPlaceholder}
            onChange={(p) => {
              setHead(p);
              form.setValue('headUserId', p?.id ?? null, { shouldDirty: true });
            }}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={create.isPending || update.isPending}>
          {unit ? t.form.submitEdit : t.form.submitNew}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Tab "Đơn vị": cây đơn vị (cha con, trưởng đơn vị, số thành viên), thêm và sửa (`units.create`, `units.update`). */
export function UnitsTab() {
  const [target, setTarget] = useState<FormTarget | null>(null);
  const units = useApiQuery('units.list', {});
  const items = units.data?.items;
  const rows = useMemo(() => toRows(items ?? []), [items]);

  return (
    <section aria-labelledby="tab-don-vi" className="flex min-w-0 flex-col gap-3">
      <h2 id="tab-don-vi" className="sr-only">
        {vi.admin.org.page.tabs.units}
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="max-w-[72ch] text-ink-sub">{t.intro}</p>
        <Button variant="primary" onClick={() => setTarget({ unit: null, parentId: null })}>
          <Plus aria-hidden="true" />
          {t.add}
        </Button>
      </div>

      {units.isError ? (
        <LoadError error={units.error} onRetry={() => void units.refetch()} />
      ) : (
        <TableFrame>
          <Table aria-busy={units.isPending || undefined} className="min-w-[640px]">
            <caption className="sr-only">{t.caption}</caption>
            <thead>
              <tr>
                <Th>{t.col.name}</Th>
                <Th className="w-[30%]">{t.col.head}</Th>
                <Th className="w-28 text-right">{t.col.members}</Th>
                <Th className="w-32">
                  <span className="sr-only">{vi.admin.shell.ui.rowActions}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {units.isPending ? (
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i}>
                    <Td colSpan={4}>
                      <Skeleton className="h-5 w-full max-w-72" />
                    </Td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState icon={Network} title={t.empty.title} description={t.empty.body} />
                  </td>
                </tr>
              ) : (
                rows.map(({ unit, depth, parentName }) => (
                  <tr key={unit.id} className="transition-colors hover:bg-canvas [&:last-child>td]:border-b-0">
                    <Td className="align-middle">
                      <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * 1.5}rem` }}>
                        {depth > 0 ? <CornerDownRight aria-hidden="true" className="size-4 shrink-0 text-ink-sub" /> : null}
                        <span className={depth === 0 ? 'font-semibold' : 'font-medium'}>{unit.name}</span>
                        {parentName ? <span className="sr-only">{fmt(t.childOf, { tên: parentName })}</span> : null}
                      </div>
                    </Td>
                    <Td className="align-middle">{unit.headName ?? <span className="text-ink-sub">{t.noHead}</span>}</Td>
                    <Td className="tabular text-right align-middle">{unit.memberCount}</Td>
                    <Td className="align-middle">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" aria-label={fmt(t.editOf, { tên: unit.name })} onClick={() => setTarget({ unit, parentId: unit.parentId })}>
                          {t.edit}
                        </Button>
                        <Tooltip content={t.addChild}>
                          <Button variant="ghost" size="icon-sm" aria-label={fmt(t.addChildOf, { tên: unit.name })} onClick={() => setTarget({ unit: null, parentId: unit.id })}>
                            <Plus aria-hidden="true" />
                          </Button>
                        </Tooltip>
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </TableFrame>
      )}
      {rows.length > 0 ? <p className="text-sm text-ink-sub">{fmt(t.count, { n: rows.length })}</p> : null}

      <Dialog
        open={target !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setTarget(null);
        }}
      >
        <DialogContent>{target ? <UnitForm target={target} units={items ?? []} onOpenChange={(isOpen) => !isOpen && setTarget(null)} /> : null}</DialogContent>
      </Dialog>
    </section>
  );
}
