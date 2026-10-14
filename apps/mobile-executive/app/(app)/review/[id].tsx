import type { ProposalView } from '@mihato/domain';
import { matchVoiceConfirm } from '@mihato/domain/vi-normalize';
import { fmtExecutive, formatDateFull, vi } from '@mihato/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { BigMic } from '@senior/BigMic';
import { ConfirmList, type ConfirmItem } from '@senior/ConfirmList';
import { LoadingText } from '@senior/Loading';
import { Notice, SectionTitle } from '@senior/Notice';
import { ResultPanel } from '@senior/ResultPanel';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorCard } from '@senior/SeniorCard';
import { SeniorText } from '@senior/SeniorText';
import { useSenior } from '@senior/theme';
import { errorMessage, isApiError } from '@/api/errors';
import { keys, useProposalGroup } from '@/data/queries';
import { createNamer, fullPersonName } from '@/features/address';
import { buildConfirmCalls, draftStepAssignees, failedReasonOf, groupRisk, groupState, processAppliedText, reviewBody, reviewItemText, reviewLabels, type Voice } from '@/features/proposals';
import { useDisplayPrefs, useNow } from '@/hooks';
import { assistant } from '@/scribe/assistant';
import { micSupported } from '@/scribe/mic';
import { api } from '@/services';
import { stepUpWithReauth } from '@/session/step-up-flow';
import { AppScreen, goBack } from '@/ui/AppScreen';

const t = vi.executive.review;

type LocalResult = 'rejected' | null;

/**
 * M3 Xem lại đề xuất: cổng xác nhận, là một màn hình đầy đủ (SPEC 7.4, 6.5, 10.6).
 * Câu hiện ở đây lấy từ `summary` và `items[].text` do MÁY CHỦ dựng, không lấy chữ của trợ lý.
 * Mức 1: **Đồng ý gửi** xác nhận cả lô một lần (kèm mục đã bỏ và lời đã sửa); có thể bấm micro rồi nói "đồng ý" hoặc
 * "không". Mức 2 (dừng hẳn một lượt): chạm từng mục, rồi vân tay, khuôn mặt hoặc PIN; không giọng nói.
 * Soạn quy trình (mức 1, đề xuất lẻ): các bước của bản nháp là một khối, đồng ý hoặc không cả khối; xuất bản kèm giao việc
 * thì hiện các việc sẽ giao như khi giao việc mới. Nút và tiêu đề đổi theo loại (`reviewLabels`).
 */
export default function ReviewScreen() {
  const m = useSenior();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { address } = useDisplayPrefs();
  const queryClient = useQueryClient();
  const now = useNow(15_000);
  const query = useProposalGroup(id);
  const assistantState = useSyncExternalStore(assistant.subscribe, assistant.getSnapshot, assistant.getSnapshot);

  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<LocalResult>(null);
  const voiceTarget = useRef<'confirm' | 'edit' | null>(null);

  const proposals = useMemo(() => query.data ?? [], [query.data]);
  const state = groupState(proposals, now);
  const pending = useMemo(() => proposals.filter((p) => p.state === 'pending'), [proposals]);
  const first = proposals[0];
  const risk = groupRisk(pending.length > 0 ? pending : proposals);
  const labels = reviewLabels(first?.tool ?? 'propose_nudge', first);
  const listening = assistantState.phase === 'listening' && assistantState.turn === 'confirm';

  // Rời màn hình: micro tự đóng, trợ lý dừng đọc.
  useFocusEffect(
    useCallback(() => {
      return () => assistant.leaveScreen(false);
    }, []),
  );

  // Đã đồng ý (ở máy khác, hoặc vừa quay lại): mở thẳng cửa hoàn tác M3b.
  const confirmedKey = state === 'confirmed' ? proposals.filter((p) => p.state === 'confirmed').map((p) => p.id).join(',') : '';
  useEffect(() => {
    if (!confirmedKey) return;
    const confirmed = proposals.filter((p) => p.state === 'confirmed');
    const undoUntil = confirmed.reduce<string>((max, p) => (p.undoUntil && p.undoUntil > max ? p.undoUntil : max), '');
    router.replace({ pathname: '/agreed', params: { ids: confirmedKey, undoUntil, risk: String(groupRisk(confirmed)), tool: confirmed[0]?.tool ?? '' } });
  }, [confirmedKey]);

  const submit = useCallback(
    async (voice: Voice | null) => {
      if (submitting) return;
      setMessage(null);
      const calls = buildConfirmCalls(proposals, dropped, edits, voice);
      if (calls.length === 0) return;
      setSubmitting(true);
      try {
        let stepUpToken: string | undefined;
        if (risk === 2) {
          // Mức 2: vân tay, khuôn mặt hoặc PIN ngay trên máy, rồi thiết bị ký thử thách lấy mã nâng quyền.
          const stepUp = await stepUpWithReauth(t.cancelRun.stepUp);
          if (!stepUp.ok) {
            setMessage(stepUp.reason === 'unsupported' ? fmtExecutive(vi.executive.status.stepUpUnsupported, {}, address) : t.stepUpCancelled);
            return;
          }
          stepUpToken = stepUp.token;
        }
        const confirmedIds: string[] = [];
        let undoUntil = '';
        let rejected = false;
        for (const call of calls) {
          const res =
            call.kind === 'batch'
              ? await api.call('proposalBatches.confirm', { params: { id: call.batchId }, body: call.body }, { stepUpToken })
              : await api.call('proposals.confirm', { params: { id: call.proposalId }, body: call.body }, { stepUpToken });
          if (res.state === 'confirmed') {
            confirmedIds.push(...res.proposalIds);
            if (res.undoUntil && res.undoUntil > undoUntil) undoUntil = res.undoUntil;
          } else rejected = true;
        }
        void queryClient.invalidateQueries({ queryKey: keys.pendingProposals });
        if (confirmedIds.length > 0) {
          router.replace({ pathname: '/agreed', params: { ids: confirmedIds.join(','), undoUntil, risk: String(risk), tool: first?.tool ?? '' } });
          return;
        }
        if (rejected) setResult('rejected');
      } catch (err) {
        if (voice && isApiError(err, 'input_invalid')) setMessage(fmtExecutive(t.voiceUnclear, {}, address));
        else setMessage(errorMessage(err, address));
        // Đề xuất có thể vừa hết hạn hoặc vừa được xử lý ở nơi khác: tải lại để hiện đúng tình trạng.
        void query.refetch();
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, proposals, dropped, edits, risk, address, queryClient, first?.tool, query],
  );

  const reject = async () => {
    if (submitting) return;
    assistant.leaveScreen(false);
    setMessage(null);
    setSubmitting(true);
    try {
      for (const p of pending) await api.call('proposals.reject', { params: { id: p.id }, body: {} });
      void queryClient.invalidateQueries({ queryKey: keys.pendingProposals });
      setResult('rejected');
    } catch (err) {
      setMessage(errorMessage(err, address));
      void query.refetch();
    } finally {
      setSubmitting(false);
    }
  };

  // Kết quả của lượt chỉ chép chữ: điền vào ô đang sửa, hoặc dùng để xác nhận bằng giọng.
  const transcript = assistantState.transcript;
  useEffect(() => {
    if (!transcript) return;
    assistant.transcriptTaken();
    const target = voiceTarget.current;
    voiceTarget.current = null;
    const text = transcript.text.trim();
    if (target === 'edit') {
      if (text) setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text));
      return;
    }
    if (target !== 'confirm') return;
    // Chỉ nhận tập câu đóng; máy chủ tự kiểm lại câu và độ tin cậy (SPEC 6.5 điều 10).
    if (matchVoiceConfirm(text) === null) {
      setMessage(fmtExecutive(t.voiceUnclear, {}, address));
      return;
    }
    void submit({ transcript: text, sttConfidence: transcript.confidence });
  }, [transcript, address, submit]);

  const speak = (target: 'confirm' | 'edit') => {
    setMessage(null);
    voiceTarget.current = target;
    void assistant.pressTranscribe();
  };

  const namer = createNamer(proposals.flatMap((p) => p.items.map((i) => i.toUser)));
  const bodyKind = reviewBody(pending);
  const multi = pending.length > 1;
  const items: ConfirmItem[] = pending.map((p) => {
    const item = p.items[0];
    return {
      id: p.id,
      text: reviewItemText(p, multi),
      // "Gửi tới" chỉ đúng với lời nhắc; đổi người, đổi hạn đã nói rõ người ngay trong câu do máy chủ dựng.
      recipient: p.tool === 'propose_nudge' && item?.toUser ? fullPersonName(item.toUser) : null,
      lateLabel: item?.lateWorkingDays && item.lateWorkingDays > 0 ? fmtExecutive(t.item.late, { n: item.lateWorkingDays }) : null,
      message: edits.get(p.id) ?? item?.message ?? null,
      editable: p.tool === 'propose_nudge' && (item?.editable ?? false),
      droppable: multi && p.risk < 2,
      dropped: dropped.has(p.id),
      needsAcknowledge: p.risk === 2,
      acknowledged: acknowledged.has(p.id),
    };
  });
  const remaining = items.filter((i) => !i.dropped);
  const allAcknowledged = items.every((i) => !i.needsAcknowledge || i.acknowledged);
  const noticeOf = assistantState.notice === 'mic_unsupported' || assistantState.notice === 'mic_denied' || assistantState.notice === 'stt_failed' || assistantState.notice === 'resting' || assistantState.notice === 'quota';

  const body = () => {
    if (query.isPending) return <LoadingText address={address} />;
    if (query.isError || !first) {
      return <ResultPanel tone="info" title={errorMessage(query.error, address)} onUnderstood={goBack} secondary={{ label: vi.executive.status.retry, onPress: () => void query.refetch(), testID: 'review-retry' }} />;
    }
    if (result === 'rejected' || state === 'rejected') return <ResultPanel tone="info" title={t.rejected} onUnderstood={goBack} testID="review-rejected" />;
    if (state === 'expired') return <ResultPanel tone="info" title={fmtExecutive(t.expired, {}, address)} onUnderstood={goBack} testID="review-expired" />;
    if (state === 'undone') return <ResultPanel tone="info" title={vi.executive.undo.undone} onUnderstood={goBack} testID="review-undone" />;
    if (state === 'applied') {
      return <ResultPanel title={processAppliedText(first.tool, proposals) ?? (risk === 2 ? vi.executive.undo.done : vi.executive.undo.sent)} onUnderstood={goBack} testID="review-applied" />;
    }
    if (state === 'failed') {
      return (
        <ResultPanel tone="info" title={t.failedTitle} onUnderstood={goBack} testID="review-failed">
          {proposals
            .filter((p) => p.state === 'failed')
            .map((p) => (
              <View key={p.id} style={{ gap: m.space.xs }}>
                <SeniorText weight="semibold">{p.summary}</SeniorText>
                <SeniorText testID="review-failed-reason">{fmtExecutive(t.failedReason, { 'lý do': failedReasonOf(p) })}</SeniorText>
              </View>
            ))}
        </ResultPanel>
      );
    }
    if (state === 'confirmed') return <LoadingText address={address} />;

    return (
      <>
        <SeniorText variant="caption" tone="gold" weight="semibold" testID="review-source">
          {first.source === 'office' ? t.source.office : t.source.ai}
        </SeniorText>

        {pending.length === 1 ? (
          <View style={{ gap: m.space.xs }}>
            {first.source === 'ai' ? <SeniorText tone="sub">{t.understood}</SeniorText> : null}
            <SeniorText variant="heard" testID="review-summary">
              {pending[0]?.summary}
            </SeniorText>
          </View>
        ) : (
          <SeniorText variant="heard" testID="review-count">
            {fmtExecutive(first.tool === 'propose_nudge' ? t.countNudges : t.count, { n: pending.length })}
          </SeniorText>
        )}

        {labels.heading ? <SectionTitle>{labels.heading}</SectionTitle> : null}

        {bodyKind === 'runPreview' ? (
          <StartRunPreview proposal={first} namer={namer} address={address} />
        ) : bodyKind === 'processSteps' ? (
          <ProcessSteps proposal={first} />
        ) : bodyKind === 'items' ? (
          <ConfirmList
            items={items}
            editingId={editingId}
            draft={draft}
            onDraftChange={setDraft}
            onEdit={(pid) => {
              setEditingId(pid);
              setDraft(items.find((i) => i.id === pid)?.message ?? '');
            }}
            onEditDone={() => {
              // Xong sửa lời nhắc: nếu đang nói vào ô thì đóng micro luôn.
              assistant.leaveScreen(false);
              if (editingId && draft.trim()) setEdits((prev) => new Map(prev).set(editingId, draft.trim()));
              setEditingId(null);
            }}
            onDrop={(pid) => setDropped((prev) => new Set(prev).add(pid))}
            onRestore={(pid) =>
              setDropped((prev) => {
                const next = new Set(prev);
                next.delete(pid);
                return next;
              })
            }
            onAcknowledge={(pid) =>
              setAcknowledged((prev) => {
                const next = new Set(prev);
                if (next.has(pid)) next.delete(pid);
                else next.add(pid);
                return next;
              })
            }
            onSpeak={() => speak('edit')}
            speaking={listening && voiceTarget.current === 'edit'}
            disabled={submitting}
          />
        ) : null}

        {risk === 2 ? <Notice testID="review-step-up">{allAcknowledged ? t.cancelRun.stepUp : fmtExecutive(t.cancelRun.acknowledgeFirst, {}, address)}</Notice> : null}
        {remaining.length === 0 ? <Notice testID="review-all-dropped">{t.allDropped}</Notice> : null}

        {risk < 2 && micSupported() && remaining.length > 0 && editingId === null ? (
          <View style={{ gap: m.space.md, alignItems: 'center' }} testID="review-voice">
            <SeniorText tone="sub" center>
              {t.voiceHint}
            </SeniorText>
            <BigMic outlined listening={listening} onPress={() => speak('confirm')} label={listening ? t.voiceListening : t.voiceButton} accessibilityLabel={t.a11yVoice} disabled={submitting} testID="review-mic" />
          </View>
        ) : null}

        {noticeOf && assistantState.notice ? (
          <Notice live testID="review-mic-notice">
            {fmtExecutive(assistantState.notice === 'mic_unsupported' ? vi.executive.assistant.micUnsupported : assistantState.notice === 'mic_denied' ? vi.executive.assistant.micDenied : vi.executive.assistant.sttFailed, {}, address)}
          </Notice>
        ) : null}
        {message ? (
          <Notice live testID="review-message">
            {message}
          </Notice>
        ) : null}
      </>
    );
  };

  const showForm = !query.isPending && !query.isError && first !== undefined && result === null && state === 'pending';

  return (
    <AppScreen
      title={fmtExecutive(t.title, {}, address)}
      back
      footer={
        showForm ? (
          <>
            <SeniorButton
              label={labels.confirm}
              onPress={() => void submit(null)}
              disabled={remaining.length === 0 || editingId !== null || !allAcknowledged}
              busyLabel={submitting ? fmtExecutive(t.sending, {}, address) : null}
              testID="review-confirm"
            />
            <SeniorButton variant="secondary" label={labels.reject} onPress={() => void reject()} disabled={submitting} testID="review-reject" />
          </>
        ) : undefined
      }
      testID="screen-review"
    >
      {body()}
    </AppScreen>
  );
}

/**
 * Các bước của `propose_create_process`: mỗi bước một thẻ. Câu của thẻ do máy chủ dựng và đã có số thứ tự ("Bước 1: …").
 * Người làm là một người cụ thể thì có thêm một dòng riêng cho dễ dò; vai trò (Giám đốc, Văn phòng) đã nằm trong câu.
 * Một đề xuất là một khối: không có nút bỏ từng bước, Chủ tịch đồng ý hoặc không cả bản nháp.
 */
function ProcessSteps({ proposal }: { proposal: ProposalView }) {
  const m = useSenior();
  const assignees = draftStepAssignees(proposal.items);
  return (
    <View style={{ gap: m.space.betweenCards }} testID="review-steps">
      {proposal.items.map((item, i) => {
        const assignee = assignees[i];
        return (
          <SeniorCard key={i} tone="quiet" testID={`review-step-${i}`}>
            <View accessible accessibilityRole="text" accessibilityLabel={item.text} style={{ gap: m.space.sm }}>
              <SeniorText variant="emphasis" testID={`review-step-${i}-text`}>
                {item.text}
              </SeniorText>
              {assignee ? <SeniorText testID={`review-step-${i}-assignee`}>{fmtExecutive(t.createProcess.assignee, { người: assignee })}</SeniorText> : null}
            </View>
          </SeniorCard>
        );
      })}
    </View>
  );
}

/** Bản xem trước các việc sẽ giao, người nhận, hạn (lấy từ simulate() ở máy chủ): của `propose_start_run` và của `propose_publish_process` kèm giao việc. */
function StartRunPreview({ proposal, namer, address }: { proposal: ProposalView; namer: (p: NonNullable<ProposalView['createdBy']>) => string; address: string }) {
  const m = useSenior();
  const s = t.startRun;
  const rows = [...(proposal.preview ?? [])].sort((a, b) => a.order - b.order);
  if (rows.length === 0) {
    return (
      <View style={{ gap: m.space.md }}>
        {proposal.items.map((item, i) => (
          <SeniorCard key={i} tone="quiet">
            <SeniorText>{item.text}</SeniorText>
          </SeniorCard>
        ))}
      </View>
    );
  }
  return (
    <View style={{ gap: m.space.md }} testID="review-preview">
      {rows.map((row, i) => (
        <SeniorCard key={row.nodeId} tone="quiet" testID={`review-preview-${i}`}>
          <View style={{ gap: m.space.xs }}>
            <SeniorText variant="emphasis" weight="bold">
              {row.title}
            </SeniorText>
            <SeniorText>{row.assignee ? fmtExecutive(s.assignee, { người: namer(row.assignee) }) : s.unassigned}</SeniorText>
            {row.dueAt ? <SeniorText>{fmtExecutive(s.due, { hạn: formatDateFull(row.dueAt) })}</SeniorText> : null}
            {row.pastDue ? (
              <SeniorText weight="semibold" tone="warn">
                {fmtExecutive(s.duePassed, {}, address)}
              </SeniorText>
            ) : null}
          </View>
        </SeniorCard>
      ))}
    </View>
  );
}
