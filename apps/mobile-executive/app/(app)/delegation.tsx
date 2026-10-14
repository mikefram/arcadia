import type { DelegationScope, DelegationView, Me } from '@mihato/domain';
import { fmtExecutive, formatDateFull, vi, vnParts } from '@mihato/i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { ChoiceGroup } from '@senior/ChoiceGroup';
import { LoadingText } from '@senior/Loading';
import { Notice, SectionTitle } from '@senior/Notice';
import { ResultPanel } from '@senior/ResultPanel';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorCard } from '@senior/SeniorCard';
import { SeniorText } from '@senior/SeniorText';
import { useSenior } from '@senior/theme';
import { errorMessage } from '@/api/errors';
import { keys, useMe, usePeople, useTemplates } from '@/data/queries';
import { fullPersonName, shortPersonName } from '@/features/address';
import { useDisplayPrefs } from '@/hooks';
import { api } from '@/services';
import { stepUpWithReauth } from '@/session/step-up-flow';
import { AppScreen } from '@/ui/AppScreen';

const t = vi.executive.delegation;
const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

type Panel = { kind: 'main' } | { kind: 'form' } | { kind: 'end'; delegation: DelegationView } | { kind: 'result'; text: string };

/** 00:00 giờ Việt Nam của ngày chứa thời điểm `ms`. */
function startOfVnDay(ms: number): number {
  const p = vnParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day) - VN_OFFSET_MS;
}

const SCOPE_LABEL: Record<DelegationScope, string> = { all: t.scope.all, process: t.scope.process, role: t.scope.role };

function executiveRoleOf(me: Me): 'chairman' | 'director' | 'deputy' | null {
  for (const role of ['chairman', 'director', 'deputy'] as const) if (me.roles.some((r) => r.role === role)) return role;
  return null;
}

/**
 * Ủy quyền cho Phó giám đốc (SPEC 7.7): chọn người, phạm vi, ngày bắt đầu và kết thúc; cần vân tay, khuôn mặt hoặc
 * PIN để lấy mã nâng quyền (`X-Step-Up-Token`). Đổi quyền là mức 3: chỉ làm trực tiếp ở màn này, không qua trợ lý.
 * Ngày chọn bằng nút lùi và thêm từng ngày, không dùng bánh xe hay thanh trượt.
 */
export default function DelegationScreen() {
  const m = useSenior();
  const { address } = useDisplayPrefs();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const delegations = useQuery({ queryKey: keys.delegations, queryFn: () => api.call('delegations.list', {}), refetchOnMount: 'always' });

  const [panel, setPanel] = useState<Panel>({ kind: 'main' });
  const [toUserId, setToUserId] = useState<string | null>(null);
  const [scope, setScope] = useState<DelegationScope>('all');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [today] = useState(() => startOfVnDay(Date.now()));
  const [fromDay, setFromDay] = useState(today);
  const [toDay, setToDay] = useState(today + 7 * DAY_MS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const people = usePeople(panel.kind === 'form');
  const templates = useTemplates(panel.kind === 'form' && scope === 'process');

  const mine = (delegations.data?.items ?? []).filter((d) => me && d.fromUser.id === me.id && Date.parse(d.validTo) > Date.now());
  // Người nhận ủy quyền: Phó giám đốc trước, rồi Giám đốc; không tính chính mình.
  const candidates = (people.data?.items ?? [])
    .filter((p) => p.id !== me?.id && (p.roleTitle === vi.common.role.deputy || p.roleTitle === vi.common.role.director))
    .sort((a, b) => Number(b.roleTitle === vi.common.role.deputy) - Number(a.roleTitle === vi.common.role.deputy));
  const chosen = candidates.find((p) => p.id === toUserId) ?? null;
  const role = me ? executiveRoleOf(me) : null;
  const scopeOptions = (['all', 'process', ...(role ? (['role'] as const) : [])] as DelegationScope[]).map((value) => ({ value, label: SCOPE_LABEL[value] }));
  const scopeRef = scope === 'process' ? templateId : scope === 'role' ? role : null;
  const rangeValid = toDay >= fromDay;
  const ready = chosen !== null && rangeValid && (scope === 'all' || scopeRef !== null);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: keys.delegations });
    void queryClient.invalidateQueries({ queryKey: keys.me });
  };

  const create = async () => {
    if (!me || !chosen || !ready || busy) return;
    setMessage(null);
    setBusy(true);
    try {
      const stepUp = await stepUpWithReauth(t.stepUp);
      if (!stepUp.ok) {
        setMessage(stepUp.reason === 'unsupported' ? fmtExecutive(vi.executive.status.stepUpUnsupported, {}, address) : vi.executive.review.stepUpCancelled);
        return;
      }
      // Bắt đầu hôm nay thì có hiệu lực ngay; kết thúc vào cuối ngày đã chọn (giờ Việt Nam).
      const validFrom = new Date(fromDay === today ? Date.now() : fromDay).toISOString();
      const validTo = new Date(toDay + DAY_MS - 1000).toISOString();
      await api.call('delegations.create', { body: { fromUserId: me.id, toUserId: chosen.id, validFrom, validTo, scope, scopeRef } }, { stepUpToken: stepUp.token });
      refreshAll();
      setPanel({ kind: 'result', text: fmtExecutive(t.created, { người: shortPersonName(chosen), ngày: formatDateFull(toDay) }) });
    } catch (err) {
      setMessage(errorMessage(err, address));
    } finally {
      setBusy(false);
    }
  };

  const end = async (delegation: DelegationView) => {
    if (busy) return;
    setMessage(null);
    setBusy(true);
    try {
      await api.call('delegations.delete', { params: { id: delegation.id } });
      refreshAll();
      setPanel({ kind: 'result', text: t.ended });
    } catch (err) {
      setMessage(errorMessage(err, address));
      setPanel({ kind: 'main' });
    } finally {
      setBusy(false);
    }
  };

  if (panel.kind === 'result') {
    return (
      <AppScreen title={t.title} testID="screen-delegation-result">
        <ResultPanel title={panel.text} onUnderstood={() => setPanel({ kind: 'main' })} />
      </AppScreen>
    );
  }

  if (panel.kind === 'end') {
    const d = panel.delegation;
    return (
      <AppScreen
        title={t.end}
        back={() => setPanel({ kind: 'main' })}
        footer={
          <>
            <SeniorButton label={t.endConfirm} onPress={() => void end(d)} busyLabel={busy ? fmtExecutive(vi.executive.status.loading, {}, address) : null} testID="delegation-end-confirm" />
            <SeniorButton variant="secondary" label={t.endKeep} onPress={() => setPanel({ kind: 'main' })} disabled={busy} testID="delegation-end-keep" />
          </>
        }
        testID="screen-delegation-end"
      >
        <SeniorText variant="emphasis">{fmtExecutive(t.banner, { người: fullPersonName(d.toUser), ngày: formatDateFull(d.validTo) })}</SeniorText>
      </AppScreen>
    );
  }

  if (panel.kind === 'form') {
    return (
      <AppScreen
        title={t.title}
        back={() => setPanel({ kind: 'main' })}
        footer={
          <>
            <SeniorButton label={t.confirm} onPress={() => void create()} disabled={!ready} busyLabel={busy ? fmtExecutive(vi.executive.status.loading, {}, address) : null} testID="delegation-confirm" />
            <SeniorButton variant="secondary" label={t.reject} onPress={() => setPanel({ kind: 'main' })} disabled={busy} testID="delegation-reject" />
          </>
        }
        testID="screen-delegation-form"
      >
        <View style={{ gap: m.space.md }}>
          <SectionTitle>{t.choosePerson}</SectionTitle>
          {people.isPending ? <LoadingText address={address} /> : null}
          {people.data && candidates.length === 0 ? <Notice>{fmtExecutive(t.noCandidates, {}, address)}</Notice> : null}
          {candidates.length > 0 ? (
            <ChoiceGroup vertical label={t.choosePerson} options={candidates.map((p) => ({ value: p.id, label: `${fullPersonName(p)}${p.roleTitle ? `, ${p.roleTitle}` : ''}` }))} value={toUserId} onChange={setToUserId} testID="delegation-person" />
          ) : null}
        </View>

        <View style={{ gap: m.space.md }}>
          <SectionTitle>{t.scopeTitle}</SectionTitle>
          <ChoiceGroup vertical label={t.scopeTitle} options={scopeOptions} value={scope} onChange={setScope} testID="delegation-scope" />
          {scope === 'role' && role ? <SeniorText tone="sub">{vi.common.role[role]}</SeniorText> : null}
          {scope === 'process' ? (
            <View style={{ gap: m.space.md }}>
              <SeniorText variant="emphasis">{t.chooseProcess}</SeniorText>
              {templates.isPending ? <LoadingText address={address} /> : null}
              {templates.isError ? <Notice>{errorMessage(templates.error, address)}</Notice> : null}
              {templates.data && templates.data.items.length === 0 ? <SeniorText tone="sub">{t.noProcess}</SeniorText> : null}
              {templates.data && templates.data.items.length > 0 ? (
                <ChoiceGroup vertical label={t.chooseProcess} options={templates.data.items.map((tpl) => ({ value: tpl.id, label: tpl.name }))} value={templateId} onChange={setTemplateId} testID="delegation-process" />
              ) : null}
            </View>
          ) : null}
        </View>

        <DayStepper label={t.from} day={fromDay} min={today} onChange={(d) => setFromDay(d)} testID="delegation-from" />
        <DayStepper label={t.to} day={toDay} min={today} onChange={(d) => setToDay(d)} testID="delegation-to" />
        {!rangeValid ? <Notice live>{t.invalidRange}</Notice> : null}

        {chosen && ready ? (
          <SeniorCard tone="gold" testID="delegation-summary">
            <View style={{ gap: m.space.sm }}>
              <SeniorText variant="emphasis" weight="bold">
                {t.review}
              </SeniorText>
              <SeniorText>{fmtExecutive(t.summary, { người: fullPersonName(chosen), 'phạm vi': SCOPE_LABEL[scope].toLocaleLowerCase('vi-VN'), từ: formatDateFull(fromDay), đến: formatDateFull(toDay) })}</SeniorText>
              <SeniorText tone="sub">{t.stepUp}</SeniorText>
            </View>
          </SeniorCard>
        ) : null}

        {message ? (
          <Notice live testID="delegation-message">
            {message}
          </Notice>
        ) : null}
      </AppScreen>
    );
  }

  return (
    <AppScreen title={t.title} back footer={<SeniorButton label={t.start} onPress={() => setPanel({ kind: 'form' })} testID="delegation-start" />} testID="screen-delegation">
      <SeniorText>{t.intro}</SeniorText>
      {message ? <Notice live>{message}</Notice> : null}
      {delegations.isPending ? <LoadingText address={address} /> : null}
      {delegations.isError && !delegations.data ? <Notice live>{errorMessage(delegations.error, address)}</Notice> : null}
      {delegations.data && mine.length === 0 ? (
        <SeniorCard tone="quiet" testID="delegation-none">
          <SeniorText tone="sub">{t.none}</SeniorText>
        </SeniorCard>
      ) : null}
      {mine.map((d, i) => (
        <SeniorCard key={d.id} tone="gold" testID={`delegation-${i}`}>
          <View style={{ gap: m.space.md }}>
            <SeniorText variant="emphasis" weight="bold">
              {fmtExecutive(t.banner, { người: fullPersonName(d.toUser), ngày: formatDateFull(d.validTo) })}
            </SeniorText>
            <SeniorText>{`${t.scopeTitle}: ${SCOPE_LABEL[d.scope].toLocaleLowerCase('vi-VN')}. ${t.from}: ${formatDateFull(d.validFrom)}.`}</SeniorText>
            <SeniorButton variant="secondary" label={t.end} onPress={() => setPanel({ kind: 'end', delegation: d })} testID={`delegation-${i}-end`} />
          </View>
        </SeniorCard>
      ))}
      <Notice tone="plain">{fmtExecutive(t.notViaAssistant, {}, address)}</Notice>
    </AppScreen>
  );
}

/** Chọn ngày bằng hai nút lớn: lùi một ngày, thêm một ngày. Ngày viết đủ thứ, ngày, tháng, năm. */
function DayStepper({ label, day, min, onChange, testID }: { label: string; day: number; min: number; onChange: (day: number) => void; testID: string }) {
  const m = useSenior();
  return (
    <View style={{ gap: m.space.md }} testID={testID}>
      <SectionTitle>{label}</SectionTitle>
      <SeniorText variant="emphasis" accessibilityLiveRegion="polite" testID={`${testID}-value`}>
        {formatDateFull(day)}
      </SeniorText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: m.space.betweenButtons }}>
        <SeniorButton variant="secondary" label={t.dayEarlier} disabled={day - DAY_MS < min} onPress={() => onChange(day - DAY_MS)} style={{ flexGrow: 1 }} testID={`${testID}-earlier`} />
        <SeniorButton variant="secondary" label={t.dayLater} onPress={() => onChange(day + DAY_MS)} style={{ flexGrow: 1 }} testID={`${testID}-later`} />
      </View>
    </View>
  );
}
