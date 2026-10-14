import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, X } from 'lucide-react';
import { Controller, useFieldArray, useForm, type FieldError as FormFieldError } from 'react-hook-form';
import type { z } from 'zod';
import { HONORIFICS, ROLES, UI_PROFILES, UserCreateSchema, type Honorific, type Role, type UiProfile, type UserView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { PersonPicker, type PickedPerson } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/errors';
import { personName } from '@/lib/person';
import { useApiMutation } from '@/lib/query';
import { fieldIssue, UnitPicker } from './shared';

const t = vi.admin.org.users.form;

/** Hai vai trò giống nhau cùng phạm vi là dòng lặp: báo ngay ở biểu mẫu thay vì để máy chủ gộp âm thầm. */
const FormSchema = UserCreateSchema.superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const grant of value.roles) {
    const key = `${grant.role}:${grant.unitId ?? ''}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['roles'], message: 'duplicate' });
    seen.add(key);
  }
});
type FormInput = z.input<typeof FormSchema>;
type FormOutput = z.output<typeof FormSchema>;

const PROFILE_KEYS = ['fullName', 'givenName', 'honorific', 'email', 'phone', 'unitId', 'managerId', 'uiProfile', 'displayOrder'] as const;
type ProfileFields = Pick<FormOutput, (typeof PROFILE_KEYS)[number]>;

/** Chỉ các trường đã đổi so với hồ sơ đang có: PATCH gửi đúng phần đó. */
function changedFields(next: ProfileFields, prev: ProfileFields): Partial<ProfileFields> {
  const out: Partial<ProfileFields> = {};
  const copy = <K extends keyof ProfileFields>(key: K) => {
    if (next[key] !== prev[key]) out[key] = next[key];
  };
  for (const key of PROFILE_KEYS) copy(key);
  return out;
}

const grantKeys = (roles: readonly { role: Role; unitId?: string | null }[]) =>
  roles
    .map((r) => `${r.role}:${r.unitId ?? ''}`)
    .sort()
    .join('|');

const HONORIFIC_OPTIONS = HONORIFICS.map((h: Honorific) => ({ value: h, label: vi.common.honorific[h] }));
const ROLE_OPTIONS = ROLES.map((r: Role) => ({ value: r, label: vi.common.role[r] }));
const PROFILE_OPTIONS = UI_PROFILES.map((p: UiProfile) => ({ value: p, label: t.profile[p] }));

const emptyToNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Câu lỗi của một ô: lỗi do máy chủ trả mang sẵn câu riêng; lỗi của schema dùng câu chung của ô đó. */
function message(error: FormFieldError | undefined, fallback: string): string | undefined {
  if (!error) return undefined;
  return error.type === 'server' && error.message ? error.message : fallback;
}

function UserForm({ user, onOpenChange }: { user: UserView | null; onOpenChange: (open: boolean) => void }) {
  const [manager, setManager] = useState<PickedPerson | null>(
    user?.managerId && user.managerName ? { id: user.managerId, fullName: user.managerName, givenName: user.managerName, honorific: null } : null,
  );
  const [failure, setFailure] = useState<unknown>(null);

  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(FormSchema),
    defaultValues: user
      ? {
          fullName: user.fullName,
          givenName: user.givenName,
          honorific: user.honorific,
          email: user.email,
          phone: user.phone,
          unitId: user.unitId,
          managerId: user.managerId,
          uiProfile: user.uiProfile,
          displayOrder: user.displayOrder,
          roles: user.roles.map((r) => ({ role: r.role, unitId: r.unitId })),
        }
      : { fullName: '', givenName: '', honorific: null, email: null, phone: null, unitId: null, managerId: null, uiProfile: 'standard', displayOrder: 0, roles: [{ role: 'employee', unitId: null }] },
  });
  const { errors } = form.formState;
  const roles = useFieldArray({ control: form.control, name: 'roles' });

  const invalidate = ['users.list', 'users.get', 'units.list', 'people.search'] as const;
  const create = useApiMutation('users.create', { toastError: false, invalidate });
  const update = useApiMutation('users.update', { toastError: false, invalidate });
  const setRoles = useApiMutation('users.setRoles', { toastError: false, invalidate });
  const pending = create.isPending || update.isPending || setRoles.isPending;

  /** Lỗi theo ô do máy chủ trả (SPEC 10.1): đặt đúng vào ô; còn lại hiện ở đầu biểu mẫu. */
  const applyFailure = (err: unknown) => {
    const email = fieldIssue(err, 'body.email');
    const managerIssue = fieldIssue(err, 'body.managerId');
    const rolesIssue = fieldIssue(err, 'body.roles');
    if (email === 'duplicate') form.setError('email', { type: 'server', message: t.errors.emailDuplicate }, { shouldFocus: true });
    else if (managerIssue === 'self') form.setError('managerId', { type: 'server', message: t.errors.managerSelf });
    else if (managerIssue === 'cycle') form.setError('managerId', { type: 'server', message: t.errors.managerCycle });
    else if (rolesIssue === 'last_it_admin') form.setError('roles', { type: 'server', message: t.errors.lastItAdmin });
    else setFailure(err);
  };

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    const name = personName(values, 'full');
    try {
      if (!user) {
        await create.mutateAsync({ body: values });
        toast.success(fmt(t.created, { tên: name }));
        if (values.email) toast.info(vi.admin.org.users.inviteEmail.createdHint);
        onOpenChange(false);
        return;
      }
      const patch = changedFields(values, user);
      const rolesChanged = grantKeys(values.roles) !== grantKeys(user.roles);
      if (Object.keys(patch).length === 0 && !rolesChanged) {
        toast.info(t.nothingChanged);
        onOpenChange(false);
        return;
      }
      if (Object.keys(patch).length > 0) await update.mutateAsync({ params: { id: user.id }, body: patch });
      if (rolesChanged) await setRoles.mutateAsync({ params: { id: user.id }, body: { roles: values.roles } });
      toast.success(fmt(t.updated, { tên: name }));
      onOpenChange(false);
    } catch (err) {
      applyFailure(err);
    }
  });

  const [honorific, givenName] = form.watch(['honorific', 'givenName']);
  const address = givenName ? personName({ fullName: givenName, givenName, honorific: honorific ?? null }, 'short') : null;

  const rolesError = errors.roles?.root ?? (errors.roles && 'message' in errors.roles ? (errors.roles as FormFieldError) : undefined);
  const rolesMessage = rolesError ? (rolesError.type === 'server' && rolesError.message ? rolesError.message : rolesError.message === 'duplicate' ? t.errors.rolesDuplicate : t.errors.roles) : undefined;

  const addRole = () => {
    const used = new Set(form.getValues('roles').map((r) => r.role));
    roles.append({ role: ROLES.find((r) => !used.has(r)) ?? 'employee', unitId: null });
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <SheetTitle>{user ? t.titleEdit : t.titleNew}</SheetTitle>
        <SheetDescription>{user ? personName(user, 'full') : t.introNew}</SheetDescription>
      </SheetHeader>
      <SheetBody>
        {failure ? <Callout tone="error">{errorMessage(failure)}</Callout> : null}

        <Field label={t.fullName} required error={message(errors.fullName, t.errors.fullName)}>
          <Input
            autoComplete="off"
            {...form.register('fullName', {
              setValueAs: trimmed,
              // Tên gọi thường là tiếng cuối của họ tên: điền sẵn, người nhập sửa lại được.
              onBlur: () => {
                const fullName = form.getValues('fullName');
                if (fullName && !form.getValues('givenName')) form.setValue('givenName', fullName.split(/\s+/).pop() ?? '', { shouldDirty: true });
              },
            })}
          />
        </Field>

        <div>
          <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] items-start gap-3">
            <Field label={t.honorific}>
              <Controller
                control={form.control}
                name="honorific"
                render={({ field }) => (
                  <Select value={field.value ?? null} onValueChange={(v) => field.onChange(v)} options={HONORIFIC_OPTIONS} emptyOption={t.honorificNone} />
                )}
              />
            </Field>
            <Field label={t.givenName} required error={message(errors.givenName, t.errors.givenName)}>
              <Input autoComplete="off" {...form.register('givenName', { setValueAs: trimmed })} />
            </Field>
          </div>
          <p className="mt-1.5 text-sm text-ink-sub">
            {address ? (
              <>
                {t.addressPreview} <span className="font-medium text-ink">{address}</span>
              </>
            ) : (
              t.givenNameHint
            )}
          </p>
        </div>

        <Field label={t.unit}>
          <Controller
            control={form.control}
            name="unitId"
            render={({ field }) => <UnitPicker value={field.value ?? null} onValueChange={field.onChange} emptyOption={t.unitNone} />}
          />
        </Field>

        <Field label={t.manager} hint={t.managerHint} error={message(errors.managerId, t.errors.managerSelf)}>
          <PersonPicker
            value={manager}
            placeholder={t.managerPlaceholder}
            excludeIds={user ? [user.id] : undefined}
            onChange={(p) => {
              setManager(p);
              form.clearErrors('managerId');
              form.setValue('managerId', p?.id ?? null, { shouldDirty: true });
            }}
          />
        </Field>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="text-base font-medium text-ink">
            {t.roles}
            <span className="font-normal text-ink-sub"> ({vi.admin.shell.ui.required})</span>
          </legend>
          <p className="-mt-0.5 text-sm text-ink-sub">{t.rolesHint}</p>
          {roles.fields.map((row, i) => (
            <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
              <Controller
                control={form.control}
                name={`roles.${i}.role`}
                render={({ field }) => (
                  <Select
                    aria-label={fmt(t.roleOf, { n: i + 1 })}
                    value={field.value}
                    onValueChange={(v) => {
                      if (v) field.onChange(v);
                      form.clearErrors('roles');
                    }}
                    options={ROLE_OPTIONS}
                  />
                )}
              />
              <Controller
                control={form.control}
                name={`roles.${i}.unitId`}
                render={({ field }) => (
                  <UnitPicker
                    aria-label={fmt(t.scopeOf, { n: i + 1 })}
                    value={field.value ?? null}
                    onValueChange={(v) => {
                      field.onChange(v);
                      form.clearErrors('roles');
                    }}
                    emptyOption={t.scopeAll}
                  />
                )}
              />
              <Button variant="ghost" size="icon" aria-label={fmt(t.removeRole, { n: i + 1 })} disabled={roles.fields.length === 1} onClick={() => roles.remove(i)}>
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button variant="ghost" size="sm" className="self-start" onClick={addRole}>
            <Plus aria-hidden="true" />
            {t.addRole}
          </Button>
          {rolesMessage ? <FieldError>{rolesMessage}</FieldError> : null}
        </fieldset>

        <Field label={t.email} hint={t.emailHint} error={message(errors.email, t.errors.email)}>
          <Input type="email" inputMode="email" autoComplete="off" spellCheck={false} {...form.register('email', { setValueAs: emptyToNull })} />
        </Field>
        <Field label={t.phone} error={message(errors.phone, t.errors.phone)}>
          <Input type="tel" inputMode="tel" autoComplete="off" {...form.register('phone', { setValueAs: emptyToNull })} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.uiProfile} hint={t.uiProfileHint}>
            <Controller
              control={form.control}
              name="uiProfile"
              render={({ field }) => <Select value={field.value ?? 'standard'} onValueChange={(v) => v && field.onChange(v)} options={PROFILE_OPTIONS} />}
            />
          </Field>
          <Field label={t.displayOrder} hint={t.displayOrderHint} error={message(errors.displayOrder, t.errors.displayOrder)}>
            <Input type="number" inputMode="numeric" step={1} className="tabular" {...form.register('displayOrder', { valueAsNumber: true })} />
          </Field>
        </div>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </SheetClose>
        <Button type="submit" variant="primary" loading={pending}>
          {user ? t.submitEdit : t.submitNew}
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * Bảng trượt thêm người dùng hoặc sửa hồ sơ (SPEC 9.5 điều 1). Thêm gọi `users.create`; sửa gọi `users.update`
 * chỉ với các trường đã đổi, rồi `users.setRoles` nếu vai trò đổi. `user = null` là thêm mới.
 */
export function UserFormSheet({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user: UserView | null }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <UserForm user={user} onOpenChange={onOpenChange} />
      </SheetContent>
    </Sheet>
  );
}
