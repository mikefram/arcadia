import type { StepView } from '@mihato/domain';
import { moneyTwice } from '@mihato/domain/vi-speak';
import { fmtExecutive, formatDateFull, vi } from '@mihato/i18n';
import { useQueryClient } from '@tanstack/react-query';
import * as ScreenCapture from 'expo-screen-capture';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, View } from 'react-native';
import { ChoiceGroup } from '@senior/ChoiceGroup';
import { LoadingText } from '@senior/Loading';
import { Notice } from '@senior/Notice';
import { ResultPanel } from '@senior/ResultPanel';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorCard } from '@senior/SeniorCard';
import { SeniorInput } from '@senior/SeniorInput';
import { SeniorText } from '@senior/SeniorText';
import { StatusChip } from '@senior/StatusChip';
import { successFeedback } from '@senior/haptics';
import { useSenior } from '@senior/theme';
import { errorMessage } from '@/api/errors';
import { keys, useApprovals, useMe, usePendingProposals } from '@/data/queries';
import { fullPersonName } from '@/features/address';
import { groupPendingProposals, type ProposalGroup } from '@/features/proposals';
import { stepChip } from '@/features/steps';
import { useDisplayPrefs } from '@/hooks';
import { assistant } from '@/scribe/assistant';
import { api } from '@/services';
import { stepUpWithReauth } from '@/session/step-up-flow';
import { AppScreen, goBack } from '@/ui/AppScreen';
import { DelegationBanner } from '@/ui/Banners';

const t = vi.executive.decisions;

type DeckItem = { kind: 'step'; key: string; step: StepView } | { kind: 'proposal'; key: string; group: ProposalGroup };
type ReasonKey = keyof typeof t.reasons;
const REASON_KEYS: readonly ReasonKey[] = ['needInfo', 'amount', 'timing', 'discuss'];
const SCREEN_CAPTURE_KEY = 'm6-decisions';

/**
 * M6 Việc cần quyết (SPEC 7.4, 6.5, 11.2): mỗi lần MỘT thẻ. Việc duyệt: nội dung, người đề nghị, số tiền viết hai lần;
 * **Đồng ý** và **Chưa đồng ý** (chọn lý do mẫu, hoặc gõ hay nói lý do). Có số tiền thì xác thực vân tay, khuôn mặt
 * hoặc PIN trên máy rồi lấy mã nâng quyền. Đề xuất đang chờ (của trợ lý, của Văn phòng trình) dẫn sang M3.
 * Trợ lý không duyệt thay: người dùng tự bấm ở đây. Trên Android chặn chụp màn hình ở màn này.
 */
export default function DecisionsScreen() {
  const m = useSenior();
  const { address } = useDisplayPrefs();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const approvals = useApprovals();
  const proposals = usePendingProposals();
  const assistantState = useSyncExternalStore(assistant.subscribe, assistant.getSnapshot, assistant.getSnapshot);

  const [position, setPosition] = useState(0);
  const [mode, setMode] = useState<'card' | 'reason'>('card');
  const [reasonKey, setReasonKey] = useState<ReasonKey | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'android') void ScreenCapture.preventScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(() => undefined);
      return () => {
        if (Platform.OS === 'android') void ScreenCapture.allowScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(() => undefined);
        assistant.leaveScreen(false);
      };
    }, []),
  );

  const deck = useMemo<DeckItem[]>(() => {
    const steps = (approvals.data?.items ?? []).filter((s) => s.allowedActions.includes('approve') || s.allowedActions.includes('reject'));
    const groups = groupPendingProposals(proposals.data?.items ?? []);
    return [...steps.map((step) => ({ kind: 'step' as const, key: step.id, step })), ...groups.map((group) => ({ kind: 'proposal' as const, key: group.key, group }))];
  }, [approvals.data, proposals.data]);

  const total = deck.length;
  const index = Math.min(position, Math.max(0, total - 1));
  const current = deck[index];
  const loading = approvals.isPending || proposals.isPending;
  const failed = (approvals.isError && !approvals.data) || (proposals.isError && !proposals.data);

  // Lý do nói bằng giọng: lượt chỉ chép chữ, điền vào ô lý do.
  const transcript = assistantState.transcript;
  useEffect(() => {
    if (!transcript) return;
    assistant.transcriptTaken();
    const text = transcript.text.trim();
    if (text) setReasonText((d) => (d.trim() ? `${d.trim()} ${text}` : text));
  }, [transcript]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['decisions'] });
    void queryClient.invalidateQueries({ queryKey: ['progress'] });
  };

  /** Việc vừa quyết xong rời khỏi chồng thẻ ngay, không chờ lần tải lại. */
  const removeDecided = (stepId: string) => {
    queryClient.setQueryData<{ items: StepView[]; nextCursor: string | null }>(keys.approvals, (old) => (old ? { ...old, items: old.items.filter((s) => s.id !== stepId) } : old));
  };

  const approve = async (step: StepView) => {
    if (busy) return;
    setMessage(null);
    setBusy(true);
    try {
      let stepUpToken: string | undefined;
      if (step.requiresStepUp) {
        // Có số tiền: vân tay, khuôn mặt hoặc PIN ngay trên máy, rồi thiết bị ký thử thách lấy mã nâng quyền 60 giây.
        const stepUp = await stepUpWithReauth(fmtExecutive(t.stepUp, {}, address));
        if (!stepUp.ok) {
          setMessage(stepUp.reason === 'unsupported' ? fmtExecutive(vi.executive.status.stepUpUnsupported, {}, address) : vi.executive.review.stepUpCancelled);
          return;
        }
        stepUpToken = stepUp.token;
      }
      await api.call('steps.approve', { params: { id: step.id }, body: {} }, { stepUpToken });
      successFeedback();
      removeDecided(step.id);
      setResult(t.approved);
      refresh();
    } catch (err) {
      setMessage(errorMessage(err, address));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const reasonFull = [reasonKey ? t.reasons[reasonKey] : '', reasonText.trim()].filter(Boolean).join('. ');

  const sendReject = async (step: StepView) => {
    if (busy || !reasonFull) return;
    assistant.leaveScreen(false);
    setMessage(null);
    setBusy(true);
    try {
      await api.call('steps.reject', { params: { id: step.id }, body: { reason: reasonFull.slice(0, 2000) } });
      setMode('card');
      setReasonKey(null);
      setReasonText('');
      removeDecided(step.id);
      setResult(t.rejected);
      refresh();
    } catch (err) {
      setMessage(errorMessage(err, address));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const closeResult = () => {
    setResult(null);
    setMessage(null);
    if (total === 0) goBack();
  };

  const listening = assistantState.phase === 'listening' && assistantState.turn === 'confirm';
  const micNotice = assistantState.notice === 'mic_unsupported' || assistantState.notice === 'mic_denied' || assistantState.notice === 'stt_failed' || assistantState.notice === 'resting' || assistantState.notice === 'quota';

  // ───── Kết quả: nằm yên tới khi bấm Đã rõ ─────
  if (result) {
    return (
      <AppScreen title={fmtExecutive(t.title, {}, address)} back testID="screen-decisions">
        <ResultPanel title={result} tone={result === t.approved ? 'done' : 'info'} understoodLabel={total > 0 ? t.nextOne : undefined} onUnderstood={closeResult} testID="decision-result" />
      </AppScreen>
    );
  }

  // ───── Bước nêu lý do "Chưa đồng ý" ─────
  if (mode === 'reason' && current?.kind === 'step') {
    const step = current.step;
    return (
      <AppScreen
        title={fmtExecutive(t.reasonTitle, {}, address)}
        back={() => {
          // Chỉ đổi bước trong cùng một màn hình, nên micro không tự đóng: đóng ở đây (SPEC 6.5: micro chỉ mở khi bấm).
          assistant.leaveScreen(false);
          setMode('card');
          setMessage(null);
        }}
        footer={<SeniorButton label={t.reasonSend} onPress={() => void sendReject(step)} disabled={!reasonFull} busyLabel={busy ? fmtExecutive(vi.executive.review.sending, {}, address) : null} testID="decision-reason-send" />}
        testID="screen-decision-reason"
      >
        <SeniorText variant="emphasis">{step.title}</SeniorText>
        <ChoiceGroup<ReasonKey> vertical label={fmtExecutive(t.reasonTitle, {}, address)} options={REASON_KEYS.map((key) => ({ value: key, label: t.reasons[key] }))} value={reasonKey} onChange={setReasonKey} testID="decision-reason" />
        <SeniorInput value={reasonText} onChangeText={setReasonText} label={t.reasonType} onSpeak={() => void assistant.pressTranscribe()} speaking={listening} maxLength={1500} testID="decision-reason-input" />
        {micNotice ? (
          <Notice live testID="decision-mic-notice">
            {fmtExecutive(assistantState.notice === 'mic_unsupported' ? vi.executive.assistant.micUnsupported : assistantState.notice === 'mic_denied' ? vi.executive.assistant.micDenied : vi.executive.assistant.sttFailed, {}, address)}
          </Notice>
        ) : null}
        {message ? (
          <Notice live testID="decision-message">
            {message}
          </Notice>
        ) : null}
      </AppScreen>
    );
  }

  const footer =
    current?.kind === 'step' ? (
      <>
        {current.step.allowedActions.includes('approve') ? (
          <SeniorButton label={t.approve} onPress={() => void approve(current.step)} busyLabel={busy ? fmtExecutive(vi.executive.review.sending, {}, address) : null} testID="decision-approve" />
        ) : null}
        {current.step.allowedActions.includes('reject') ? (
          <SeniorButton
            variant="secondary"
            label={t.reject}
            disabled={busy}
            onPress={() => {
              setMessage(null);
              setMode('reason');
            }}
            testID="decision-reject"
          />
        ) : null}
      </>
    ) : current?.kind === 'proposal' ? (
      <SeniorButton label={t.openProposal} onPress={() => router.push({ pathname: '/review/[id]', params: { id: current.group.proposals[0]?.id ?? '' } })} testID="decision-open-proposal" />
    ) : undefined;

  return (
    <AppScreen title={fmtExecutive(t.title, {}, address)} back footer={footer} testID="screen-decisions">
      <DelegationBanner me={me} />
      {loading ? <LoadingText address={address} /> : null}
      {failed ? (
        <View style={{ gap: m.space.md }}>
          <Notice live>{errorMessage(approvals.error ?? proposals.error, address)}</Notice>
          <SeniorButton variant="secondary" label={vi.executive.status.retry} onPress={refresh} testID="decisions-retry" />
        </View>
      ) : null}

      {!loading && !failed && total === 0 ? (
        <SeniorCard tone="quiet" testID="decisions-empty">
          <SeniorText>{t.empty}</SeniorText>
        </SeniorCard>
      ) : null}

      {current ? (
        <>
          <SeniorText variant="caption" tone="gold" weight="semibold" testID="decision-position">
            {fmtExecutive(t.position, { n: index + 1, tổng: total })}
          </SeniorText>

          {current.kind === 'step' ? <StepDecisionCard step={current.step} address={address} /> : <ProposalDecisionCard group={current.group} address={address} />}

          {message ? (
            <Notice live testID="decision-message">
              {message}
            </Notice>
          ) : null}

          {total > 1 ? (
            <View style={{ gap: m.space.betweenButtons }}>
              {index < total - 1 ? <SeniorButton variant="secondary" label={t.nextOne} disabled={busy} onPress={() => setPosition(index + 1)} testID="decision-next" /> : null}
              {index > 0 ? <SeniorButton variant="secondary" label={t.previousOne} disabled={busy} onPress={() => setPosition(index - 1)} testID="decision-previous" /> : null}
            </View>
          ) : null}
        </>
      ) : null}
    </AppScreen>
  );
}

function Field({ label, value, testID }: { label?: string; value: string; testID?: string }) {
  return (
    <View>
      {label ? (
        <SeniorText variant="caption" tone="gold" weight="semibold">
          {label}
        </SeniorText>
      ) : null}
      <SeniorText testID={testID}>{value}</SeniorText>
    </View>
  );
}

function StepDecisionCard({ step, address }: { step: StepView; address: string }) {
  const m = useSenior();
  const chip = stepChip(step);
  return (
    <SeniorCard tone="plain" testID="decision-card">
      <View style={{ gap: m.space.md }}>
        <SeniorText variant="cardTitle" testID="decision-title">
          {step.title}
        </SeniorText>
        {step.description ? <Field label={t.content} value={step.description} /> : null}
        {step.amountVnd !== null ? (
          // Số tiền viết hai lần: bằng số và bằng chữ (SPEC 7.5), để không nhìn nhầm số không.
          <SeniorText variant="heard" weight="bold" testID="decision-amount">
            {fmtExecutive(t.amount, { tiền: moneyTwice(step.amountVnd) })}
          </SeniorText>
        ) : null}
        {step.requestedBy ? <SeniorText testID="decision-requester">{fmtExecutive(t.requester, { người: fullPersonName(step.requestedBy) })}</SeniorText> : null}
        <SeniorText>{fmtExecutive(t.run, { lượt: step.runTitle })}</SeniorText>
        {step.dueAt ? <SeniorText>{fmtExecutive(t.due, { hạn: formatDateFull(step.dueAt) })}</SeniorText> : null}
        {chip.kind === 'late' ? <StatusChip kind="late" label={chip.label} /> : null}
        {step.requiresStepUp ? <SeniorText tone="sub">{fmtExecutive(t.stepUp, {}, address)}</SeniorText> : null}
      </View>
    </SeniorCard>
  );
}

function ProposalDecisionCard({ group, address }: { group: ProposalGroup; address: string }) {
  const m = useSenior();
  return (
    <SeniorCard tone="plain" testID="decision-proposal-card">
      <View style={{ gap: m.space.md }}>
        <SeniorText variant="cardTitle">{group.source === 'office' ? t.officeProposals : t.aiProposals}</SeniorText>
        {/* Câu do máy chủ dựng; người dùng mở M3 để xem đủ, sửa hoặc bỏ từng mục rồi mới quyết. */}
        {group.proposals.map((p) => (
          <SeniorText key={p.id}>{p.summary}</SeniorText>
        ))}
        <SeniorText tone="sub">{fmtExecutive(t.proposalHint, {}, address)}</SeniorText>
      </View>
    </SeniorCard>
  );
}
