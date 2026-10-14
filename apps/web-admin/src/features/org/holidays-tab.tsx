import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import type { RouteResponse } from '@mihato/api-client';
import { HOLIDAY_KINDS, HolidayKindSchema, HolidaySchema, type Holiday, type HolidayKind } from '@mihato/domain';
import { fmt, formatDateFull, formatDateWeekday, vi, vnParts } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableFrame, Td, Th } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { invalidateRoutes, useApiMutation, useApiQuery } from '@/lib/query';
import { vnNoon } from './dates';
import { LoadError, StateChip } from './shared';

const t = vi.admin.org.holidays;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const HOLIDAY_ROUTES = ['holidays.list', 'holidays.suggestions', 'admin.audit'] as const;

type Suggestion = RouteResponse<'holidays.suggestions'>['items'][number];
type FormValues = z.infer<typeof HolidaySchema>;

const fullDate = (day: string) => formatDateFull(vnNoon(day));

const KIND_TONE: Record<HolidayKind, 'good' | 'plain' | 'warn'> = { public: 'good', company: 'plain', makeup_workday: 'warn' };
const KIND_OPTIONS = HOLIDAY_KINDS.map((k: HolidayKind) => ({ value: k, label: t.kind[k] }));

/** "Thứ Hai đến Thứ Sáu" khi các ngày liền nhau, ngược lại liệt kê từng ngày. */
function workweekText(days: readonly number[]): string {
  const names = vi.admin.org.settings.calendar.weekdays;
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return '';
  const contiguous = sorted.length > 2 && last - first === sorted.length - 1;
  return contiguous ? fmt(t.workweekRange, { từ: names[first - 1] ?? '', đến: names[last - 1] ?? '' }) : sorted.map((d) => names[d - 1]).join(', ');
}

// ───────────────────────── Thêm, sửa một ngày nghỉ ─────────────────────────

function HolidayForm({ holiday, existing, onSaved, onOpenChange }: { holiday: Holiday | null; existing: readonly Holiday[]; onSaved: (day: string) => void; onOpenChange: (open: boolean) => void }) {
  const form = useForm<FormValues>({
    resolver: zodResolver(HolidaySchema),
    defaultValues: holiday ?? { day: '', name: '', kind: 'public' },
  });
  const { errors } = form.formState;
  const [day, kind] = form.watch(['day', 'kind']);
  const save = useApiMutation('holidays.put', { toastError: false, invalidate: HOLIDAY_ROUTES });
  const clash = holiday ? undefined : existing.find((h) => h.day === day);

  const submit = form.handleSubmit((values) => {
    save.mutate(
      { params: { day: values.day }, body: { name: values.name, kind: values.kind } },
      {
        onSuccess: () => {
          toast.success(fmt(t.form.saved, { ngày: fullDate(values.day) }));
          onSaved(values.day);
          onOpenChange(false);
        },
      },
    );
  });

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{holiday ? t.form.titleEdit : t.form.titleNew}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {save.isError ? <Callout tone="error">{errorMessage(save.error)}</Callout> : null}
        <Field label={t.form.day} required hint={holiday ? t.form.dayLocked : undefined} error={errors.day ? t.form.dayRequired : undefined}>
          <Input type="date" min={`${MIN_YEAR}-01-01`} max={`${MAX_YEAR}-12-31`} readOnly={holiday !== null} {...form.register('day')} />
        </Field>
        {day && !errors.day ? <p className="-mt-2 text-sm text-ink-sub">{fullDate(day)}</p> : null}
        {clash ? <Callout tone="warn">{fmt(t.form.exists, { tên: clash.name })}</Callout> : null}
        <Field label={t.form.name} required error={errors.name ? t.form.nameRequired : undefined}>
          <Input autoComplete="off" placeholder={t.form.namePlaceholder} {...form.register('name', { setValueAs: (v: unknown) => (typeof v === 'string' ? v.trim() : '') })} />
        </Field>
        <Field label={t.form.kind} hint={t.kindHint[kind]}>
          <Controller
            control={form.control}
            name="kind"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(v) => {
                  const next = HolidayKindSchema.safeParse(v);
                  if (next.success) field.onChange(next.data);
                }}
                options={KIND_OPTIONS}
              />
            )}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {holiday ? t.form.submitEdit : t.form.submitNew}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ───────────────────────── Gợi ý ngày lễ cố định ─────────────────────────

function Suggestions({ year }: { year: number }) {
  const [addingAll, setAddingAll] = useState(false);
  const suggestions = useApiQuery('holidays.suggestions', { query: { year } });
  const add = useApiMutation('holidays.put', { invalidate: HOLIDAY_ROUTES });
  const items = suggestions.data?.items ?? [];
  const remaining = items.filter((s) => !s.alreadyAdded);

  const addOne = (s: Suggestion) => {
    add.mutate({ params: { day: s.day }, body: { name: s.name, kind: s.kind } }, { onSuccess: () => toast.success(fmt(t.suggestions.addedOne, { tên: s.name })) });
  };

  const addAll = async () => {
    setAddingAll(true);
    let done = 0;
    for (const s of remaining) {
      try {
        await api.call('holidays.put', { params: { day: s.day }, body: { name: s.name, kind: s.kind } });
        done += 1;
      } catch {
        // đếm ở dưới: ngày nào chưa thêm được vẫn còn nút "Thêm" để thử lại
      }
    }
    invalidateRoutes(HOLIDAY_ROUTES);
    setAddingAll(false);
    if (done === remaining.length) toast.success(fmt(t.suggestions.addedMany, { n: done }));
    else toast.error(fmt(t.suggestions.addedPartial, { n: done, tổng: remaining.length }));
  };

  return (
    <Card aria-labelledby="goi-y-ngay-le">
      <CardHeader className="items-center">
        <CardTitle id="goi-y-ngay-le">{t.suggestions.title}</CardTitle>
        {remaining.length > 1 ? (
          <Button size="sm" loading={addingAll} disabled={add.isPending} onClick={() => void addAll()}>
            {fmt(t.suggestions.addAll, { n: remaining.length })}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Callout tone="info" title={t.suggestions.noteTitle}>
          {t.suggestions.note}
        </Callout>
        {suggestions.isError ? (
          <LoadError error={suggestions.error} onRetry={() => void suggestions.refetch()} />
        ) : suggestions.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-ink-sub">{t.suggestions.empty}</p>
        ) : (
          <>
            {remaining.length === 0 ? <p className="text-sm text-ink-sub">{fmt(t.suggestions.allAdded, { năm: year })}</p> : null}
            <ul className="divide-y divide-hairline">
              {items.map((s) => (
                <li key={s.day} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.name}</p>
                    <p className="text-sm text-ink-sub">
                      <time dateTime={s.day}>{formatDateWeekday(vnNoon(s.day))}</time>
                      {s.lunarLabel ? `, ${s.lunarLabel}` : null}
                    </p>
                  </div>
                  {s.alreadyAdded ? (
                    <StateChip tone="muted" icon={Check}>
                      {t.suggestions.added}
                    </StateChip>
                  ) : (
                    <Button size="sm" disabled={addingAll || add.isPending} aria-label={fmt(t.suggestions.addFor, { tên: s.name })} onClick={() => addOne(s)}>
                      {t.suggestions.add}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Tab ─────────────────────────

/**
 * Tab "Ngày nghỉ" (SPEC 4.5): ngày nghỉ không mã hoá cứng, Văn phòng nhập hằng năm theo thông báo chính thức.
 * Hệ thống chỉ gợi ý các ngày lễ cố định (`holidays.suggestions`, kèm nhãn ngày âm).
 */
export function HolidaysTab() {
  const [year, setYear] = useState(() => vnParts(Date.now()).year);
  const [editing, setEditing] = useState<{ holiday: Holiday | null } | null>(null);
  const [removing, setRemoving] = useState<Holiday | null>(null);

  const holidays = useApiQuery('holidays.list', { query: { year } });
  const settings = useApiQuery('org.settingsGet', {}, { staleTime: 5 * 60_000 });
  const remove = useApiMutation('holidays.delete', { invalidate: HOLIDAY_ROUTES });
  const items = [...(holidays.data?.items ?? [])].sort((a, b) => a.day.localeCompare(b.day));
  const workweek = settings.data ? workweekText(settings.data.workdays) : '';

  return (
    <section aria-labelledby="tab-ngay-nghi" className="flex min-w-0 flex-col gap-4">
      <h2 id="tab-ngay-nghi" className="sr-only">
        {vi.admin.org.page.tabs.holidays}
      </h2>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div role="group" aria-label={t.year} className="flex items-center gap-1">
          <Button variant="secondary" size="icon" aria-label={fmt(t.prevYear, { năm: year - 1 })} disabled={year <= MIN_YEAR} onClick={() => setYear(year - 1)}>
            <ChevronLeft aria-hidden="true" />
          </Button>
          <p aria-live="polite" className="tabular min-w-36 px-2 text-center text-lg font-semibold">
            {`${t.year} ${year}`}
          </p>
          <Button variant="secondary" size="icon" aria-label={fmt(t.nextYear, { năm: year + 1 })} disabled={year >= MAX_YEAR} onClick={() => setYear(year + 1)}>
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        <Button variant="primary" onClick={() => setEditing({ holiday: null })}>
          <Plus aria-hidden="true" />
          {t.add}
        </Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-lg font-semibold">{fmt(t.listTitle, { năm: year })}</h3>
            {holidays.isSuccess && items.length > 0 ? <span className="text-sm text-ink-sub">{fmt(t.count, { n: items.length })}</span> : null}
          </div>
          {holidays.isError ? (
            <LoadError error={holidays.error} onRetry={() => void holidays.refetch()} />
          ) : (
            <TableFrame>
              <Table aria-busy={holidays.isPending || undefined} className="min-w-[520px]">
                <caption className="sr-only">{fmt(t.caption, { năm: year })}</caption>
                <thead>
                  <tr>
                    <Th>{t.col.day}</Th>
                    <Th className="w-52">{t.col.kind}</Th>
                    <Th className="w-28">
                      <span className="sr-only">{vi.admin.shell.ui.rowActions}</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {holidays.isPending ? (
                    Array.from({ length: 4 }, (_, i) => (
                      <tr key={i}>
                        <Td colSpan={3}>
                          <Skeleton className="h-5 w-full max-w-80" />
                        </Td>
                      </tr>
                    ))
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={3}>
                        <EmptyState icon={CalendarDays} title={fmt(t.empty.title, { năm: year })} description={t.empty.body} />
                      </td>
                    </tr>
                  ) : (
                    items.map((h) => (
                      <tr key={h.day} className="transition-colors hover:bg-canvas [&:last-child>td]:border-b-0">
                        <Td className="align-middle">
                          <p className="font-medium">{h.name}</p>
                          <time dateTime={h.day} className="text-sm text-ink-sub">
                            {fullDate(h.day)}
                          </time>
                        </Td>
                        <Td className="align-middle">
                          <StateChip tone={KIND_TONE[h.kind]}>{t.kind[h.kind]}</StateChip>
                        </Td>
                        <Td className="align-middle">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" aria-label={fmt(t.editFor, { ngày: fullDate(h.day) })} onClick={() => setEditing({ holiday: h })}>
                              {t.edit}
                            </Button>
                            <Button variant="ghost" size="sm" aria-label={fmt(t.removeFor, { ngày: fullDate(h.day) })} onClick={() => setRemoving(h)}>
                              {t.remove}
                            </Button>
                          </div>
                        </Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </Table>
            </TableFrame>
          )}
          {workweek ? <p className="text-sm text-ink-sub">{fmt(t.workweek, { ngày: workweek })}</p> : null}
        </div>

        <Suggestions year={year} />
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setEditing(null);
        }}
      >
        <DialogContent size="sm">
          {editing ? (
            <HolidayForm
              holiday={editing.holiday}
              existing={items}
              // Ngày thuộc năm khác năm đang xem vẫn lưu được: bảng chuyển sang năm đó để thấy ngày vừa thêm.
              onSaved={(day) => {
                const savedYear = Number(day.slice(0, 4));
                if (savedYear !== year && savedYear >= MIN_YEAR && savedYear <= MAX_YEAR) setYear(savedYear);
              }}
              onOpenChange={(isOpen) => !isOpen && setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRemoving(null);
        }}
        tone="danger"
        title={t.removeTitle}
        description={removing ? fmt(t.removeBody, { ngày: fullDate(removing.day), tên: removing.name }) : undefined}
        confirmLabel={t.removeConfirm}
        loading={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          const day = fullDate(removing.day);
          remove.mutate({ params: { day: removing.day } }, { onSuccess: () => toast.success(fmt(t.removed, { ngày: day })), onSettled: () => setRemoving(null) });
        }}
      />
    </section>
  );
}
