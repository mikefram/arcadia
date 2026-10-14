import { can, newId, type DelegationView } from '@mihato/domain';
import { fmt, formatDate, formatDateWeekday, vi, vnDateKey } from '@mihato/i18n';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { errorMessage, isApiError } from '@/api/errors';
import { keys, useDelegations, useMe } from '@/data/queries';
import { PersonPicker, type PickedPerson } from '@/features/PersonPicker';
import { OfflineBanner } from '@/features/StatusNotices';
import { noonOf } from '@/features/calendar';
import { createDelegationFlow } from '@/features/delegation-flow';
import { IdempotencyKeys } from '@/features/idempotency';
import { personName, vnInstant } from '@/features/steps';
import { useNow, useOnline } from '@/hooks';
import { api, queryClient, stepUpSigner } from '@/services';
import { obtainStepUpToken } from '@/session/step-up-flow';
import { useReauth } from '@/session/useReauth';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { Card, ErrorState, LoadingState, SectionHeading } from '@/ui/Blocks';
import { Button } from '@/ui/Button';
import { DateGrid } from '@/ui/DateGrid';
import { Field } from '@/ui/Field';
import { showFlash } from '@/ui/Flash';
import { Screen } from '@/ui/Screen';
import { space } from '@/ui/theme';

const t = vi.staff.me.delegation;

/**
 * S9, mục Ủy quyền khi vắng (SPEC 4.8, `/v1/delegations`): xem ủy quyền đang có, tạo ủy quyền mới cho một người
 * trong một khoảng ngày, và thu lại. Chỉ hiện phần tạo khi tài khoản có quyền `delegation.self`.
 */
export default function DelegationsScreen() {
  const now = useNow();
  const today = vnDateKey(now);
  const online = useOnline();
  const me = useMe();
  const allowed = me.data ? can(me.data, 'delegation.self') : false;
  const query = useDelegations(allowed);
  const reauth = useReauth(vi.staff.approval.stepUpPinTitle);

  const [creating, setCreating] = useState(false);
  const [person, setPerson] = useState<PickedPerson | null>(null);
  const [from, setFrom] = useState<string>(today);
  const [to, setTo] = useState<string | null>(null);
  const [openGrid, setOpenGrid] = useState<'from' | 'to' | null>(null);
  const [errors, setErrors] = useState<{ person?: string; to?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mỗi lần gửi bị máy chủ từ chối (403 cần nâng quyền, 4xx khác) đổi khoá: máy chủ lưu cả phản hồi lỗi theo khoá.
  const keyRing = useRef(new IdempotencyKeys<'create'>(newId));

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.delegations });

  const create = async () => {
    if (!me.data) return;
    setErrors({ person: person ? undefined : t.personRequired, to: to ? undefined : t.toRequired });
    if (!person || !to) return;
    if (!online) {
      setError(vi.staff.feedback.needNetwork);
      return;
    }
    setBusy(true);
    setError(null);
    const body = { fromUserId: me.data.id, toUserId: person.id, validFrom: vnInstant(from, '00:00'), validTo: vnInstant(to, '23:59') };
    try {
      const outcome = await createDelegationFlow({
        keys: keyRing.current,
        call: async (options) => {
          await api.call('delegations.create', { body }, options);
        },
        isStepUpRequired: (err) => isApiError(err, 'step_up_required') && stepUpSigner.supported,
        reauth: () => reauth.confirm(),
        obtainStepUpToken,
      });
      if (outcome === 'cancelled') return;
      setCreating(false);
      setPerson(null);
      setTo(null);
      showFlash(vi.staff.feedback.saved);
      await refresh();
      void queryClient.invalidateQueries({ queryKey: keys.me });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const end = async (item: DelegationView) => {
    if (!online) {
      setError(vi.staff.feedback.needNetwork);
      return;
    }
    setError(null);
    try {
      await api.call('delegations.delete', { params: { id: item.id } });
      await refresh();
      void queryClient.invalidateQueries({ queryKey: keys.me });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const line = (item: DelegationView): string => {
    const given = item.fromUser.id === me.data?.id;
    const other = personName(given ? item.toUser : item.fromUser) ?? '';
    return fmt(given ? t.active : t.received, { người: other, ngày: formatDate(item.validTo) });
  };

  const items = query.data?.items;

  return (
    <>
      <Screen
        title={t.title}
        back
        keyboard
        footer={
          allowed && creating ? (
            <>
              <Button label={t.confirm} busy={busy} onPress={() => void create()} testID="delegation-confirm" />
              <Button variant="quiet" label={vi.common.actions.back} disabled={busy} onPress={() => setCreating(false)} />
            </>
          ) : allowed ? (
            <Button label={t.create} onPress={() => setCreating(true)} testID="delegation-create" />
          ) : undefined
        }
        testID="screen-delegations"
      >
        <OfflineBanner updatedAt={query.dataUpdatedAt || undefined} />
        <AppText tone="sub">{t.intro}</AppText>

        {error ? (
          <Banner tone="info" live>
            {error}
          </Banner>
        ) : null}

        {me.data && !allowed ? <Banner tone="info">{t.notAllowed}</Banner> : null}

        {allowed && creating ? (
          <View style={{ gap: space.lg }}>
            <PersonPicker
              label={t.toPerson}
              value={person}
              excludeId={me.data?.id}
              error={errors.person}
              onChange={(next) => {
                setPerson(next);
                setErrors((e) => ({ ...e, person: undefined }));
              }}
            />
            <Field label={t.from}>
              <Button variant="secondary" label={formatDateWeekday(noonOf(from))} onPress={() => setOpenGrid((g) => (g === 'from' ? null : 'from'))} testID="delegation-from" />
              {openGrid === 'from' ? (
                <DateGrid
                  value={from}
                  min={today}
                  today={today}
                  onChange={(day) => {
                    setFrom(day);
                    if (to && to < day) setTo(null);
                    setOpenGrid(null);
                  }}
                />
              ) : null}
            </Field>
            <Field label={t.to} error={errors.to}>
              <Button variant="secondary" label={to ? formatDateWeekday(noonOf(to)) : vi.staff.extension.pickDate} onPress={() => setOpenGrid((g) => (g === 'to' ? null : 'to'))} testID="delegation-to" />
              {openGrid === 'to' ? (
                <DateGrid
                  value={to}
                  min={from}
                  today={today}
                  onChange={(day) => {
                    setTo(day);
                    setErrors((e) => ({ ...e, to: undefined }));
                    setOpenGrid(null);
                  }}
                />
              ) : null}
            </Field>
          </View>
        ) : allowed ? (
          <View style={{ gap: space.sm }}>
            <SectionHeading title={t.current} />
            {!items ? (
              query.isError ? (
                <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
              ) : (
                <LoadingState />
              )
            ) : items.length === 0 ? (
              <AppText tone="sub">{t.none}</AppText>
            ) : (
              items.map((item) => (
                <Card key={item.id} testID={`delegation-${item.id}`}>
                  <AppText>{line(item)}</AppText>
                  {item.fromUser.id === me.data?.id ? <Button variant="secondary" label={t.end} onPress={() => void end(item)} /> : null}
                </Card>
              ))
            )}
          </View>
        ) : null}
      </Screen>
      {reauth.element}
    </>
  );
}
