import type { ProposalView } from '@mihato/domain';
import { fmtExecutive, vi } from '@mihato/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { successFeedback } from '@senior/haptics';
import { Notice } from '@senior/Notice';
import { ResultPanel } from '@senior/ResultPanel';
import { SeniorText } from '@senior/SeniorText';
import { useSenior } from '@senior/theme';
import { UndoActions, UndoBanner } from '@senior/UndoBanner';
import { errorMessage, isApiError } from '@/api/errors';
import { useMe } from '@/data/queries';
import { failedReasonOf, processAppliedText } from '@/features/proposals';
import { playSentSound } from '@/features/sound';
import { announcedSeconds, appliedOutcome, secondsLeft, type AppliedOutcome } from '@/features/undo';
import { useDisplayPrefs } from '@/hooks';
import { api, session } from '@/services';
import { AppScreen, goBack } from '@/ui/AppScreen';

const t = vi.executive.undo;

type Stage =
  /** đang trong cửa hoàn tác: đồng hồ đếm ngược bằng chữ */
  | { kind: 'counting' }
  /** đã hết giờ hoặc đã bấm Gửi ngay: chờ máy chủ báo đã thực hiện; `proposals` là các đề xuất ở lần hỏi gần nhất */
  | { kind: 'settling'; via: 'expired' | 'sendNow'; outcome: AppliedOutcome; proposals: ProposalView[] }
  | { kind: 'undone' }
  /** 409 undo_window_closed: đã quá thời gian hoàn tác */
  | { kind: 'tooLate' };

const POLL_MS = 2000;
const MAX_POLLS = 15;

/**
 * M3b Đã đồng ý: cửa hoàn tác 30 giây (SPEC 7.4, 6.5 điều 8, 10.6). Đồng hồ đếm ngược hiện bằng chữ theo `undoUntil`
 * của máy chủ. Nút **Hoàn tác** và **Gửi ngay** (mức 2 không có Gửi ngay). Màn hình giữ nguyên, không tự đóng;
 * hết giờ thì báo đã gửi và chờ người dùng bấm **Đã rõ**.
 */
export default function AgreedScreen() {
  const m = useSenior();
  const params = useLocalSearchParams<{ ids?: string; undoUntil?: string; risk?: string; tool?: string }>();
  const { address } = useDisplayPrefs();
  const me = useMe().data;
  const queryClient = useQueryClient();
  const ids = (params.ids ?? '').split(',').filter(Boolean);
  const idsKey = ids.join(',');
  const undoUntil = params.undoUntil ?? '';
  const level2 = params.risk === '2';
  const isNudge = params.tool === 'propose_nudge';

  const [openedAt] = useState(() => Date.now());
  const [left, setLeft] = useState(() => secondsLeft(undoUntil, Date.now()));
  const [stage, setStage] = useState<Stage>({ kind: 'counting' });
  const [busy, setBusy] = useState<'undo' | 'sendNow' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const chimed = useRef(false);

  // Đếm ngược theo đồng hồ, không theo số lần hẹn giờ: app bị tạm dừng rồi mở lại vẫn hiện đúng số giây còn lại.
  useEffect(() => {
    if (stage.kind !== 'counting') return;
    const timer = setInterval(() => {
      const next = secondsLeft(undoUntil, Date.now());
      setLeft(next);
      session.noteActivity();
      if (next <= 0 && busy === null) setStage({ kind: 'settling', via: 'expired', outcome: 'sending', proposals: [] });
    }, 250);
    return () => clearInterval(timer);
  }, [stage.kind, undoUntil, busy]);

  // Hết giờ hoặc đã bấm Gửi ngay: hỏi máy chủ đã thực hiện chưa, vài giây một lần, tới khi có kết quả.
  const settlingVia = stage.kind === 'settling' ? stage.via : null;
  const settled = stage.kind === 'settling' && stage.outcome !== 'sending';
  useEffect(() => {
    if (!settlingVia || settled) return;
    let cancelled = false;
    let polls = 0;
    const poll = async () => {
      polls++;
      try {
        const list = await Promise.all(idsKey.split(',').filter(Boolean).map((id) => api.call('proposals.get', { params: { id } })));
        if (cancelled) return;
        const outcome = appliedOutcome(list);
        if (outcome === 'undone') return setStage({ kind: 'undone' });
        setStage({ kind: 'settling', via: settlingVia, outcome, proposals: list });
        if (outcome !== 'sending') return;
      } catch {
        // Mất mạng lúc đang hỏi: thử lại ở lần sau; màn hình vẫn nói rõ hệ thống đang gửi.
      }
      if (!cancelled && polls < MAX_POLLS) timer = setTimeout(() => void poll(), POLL_MS);
    };
    let timer = setTimeout(() => void poll(), settlingVia === 'sendNow' ? 600 : 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [settlingVia, settled, idsKey]);

  // Gửi xong: âm "tinh" (tắt được trong Cài đặt) và rung báo xong, đúng một lần.
  const sent = stage.kind === 'settling' && stage.outcome === 'sent';
  useEffect(() => {
    if (!sent || chimed.current) return;
    chimed.current = true;
    successFeedback();
    playSentSound(me?.prefs.sendSound ?? true);
    void queryClient.invalidateQueries();
  }, [sent, me?.prefs.sendSound, queryClient]);

  const undo = useCallback(async () => {
    setMessage(null);
    setBusy('undo');
    try {
      for (const id of ids) await api.call('proposals.undo', { params: { id } });
      setStage({ kind: 'undone' });
      void queryClient.invalidateQueries();
    } catch (err) {
      // 409 undo_window_closed: worker đã lấy việc, nội dung đã được gửi. Nói rõ, không để người dùng tưởng đã thu lại được.
      if (isApiError(err, 'undo_window_closed')) setStage({ kind: 'tooLate' });
      else setMessage(errorMessage(err, address));
    } finally {
      setBusy(null);
    }
  }, [idsKey, address, queryClient]);

  const sendNow = useCallback(async () => {
    setMessage(null);
    setBusy('sendNow');
    try {
      for (const id of ids) await api.call('proposals.sendNow', { params: { id } });
      setStage({ kind: 'settling', via: 'sendNow', outcome: 'sending', proposals: [] });
    } catch (err) {
      setMessage(errorMessage(err, address));
    } finally {
      setBusy(null);
    }
  }, [idsKey, address]);

  // Lời nhắc: "Đã gửi 2 lời nhắc." Soạn quy trình (tạo bản nháp, xuất bản, xuất bản và giao việc): câu riêng từng loại.
  // Các đề xuất khác (giao việc, đổi người, đổi hạn, dừng lượt): "Đã thực hiện."
  const sentTextOf = (applied: readonly ProposalView[]): string =>
    processAppliedText(params.tool, applied) ?? (isNudge ? (ids.length > 1 ? fmtExecutive(t.sentCount, { n: ids.length }) : t.sent) : t.done);

  const content = () => {
    switch (stage.kind) {
      case 'counting':
        return (
          <>
            <UndoBanner secondsLeft={left} title={fmtExecutive(level2 ? t.titleLevel2 : t.title, { n: announcedSeconds(undoUntil, openedAt) })} address={address} />
            {message ? (
              <Notice live testID="agreed-message">
                {message}
              </Notice>
            ) : null}
          </>
        );
      case 'undone':
        return <ResultPanel tone="info" title={t.undone} onUnderstood={goBack} testID="agreed-undone" />;
      case 'tooLate':
        return <ResultPanel tone="info" title={fmtExecutive(t.tooLate, {}, address)} onUnderstood={goBack} testID="agreed-too-late" />;
      case 'settling':
        if (stage.outcome === 'sent') return <ResultPanel title={sentTextOf(stage.proposals)} onUnderstood={goBack} testID="agreed-sent" />;
        if (stage.outcome === 'failed') {
          return (
            <ResultPanel tone="info" title={vi.executive.review.failedTitle} onUnderstood={goBack} testID="agreed-failed">
              {stage.proposals
                .filter((p) => p.state === 'failed')
                .map((p) => (
                  <View key={p.id} style={{ gap: m.space.xs }}>
                    <SeniorText weight="semibold">{p.summary}</SeniorText>
                    <SeniorText>{fmtExecutive(vi.executive.review.failedReason, { 'lý do': failedReasonOf(p) })}</SeniorText>
                  </View>
                ))}
            </ResultPanel>
          );
        }
        return (
          <ResultPanel
            tone="info"
            title={stage.via === 'sendNow' ? fmtExecutive(vi.executive.review.sending, {}, address) : t.sending}
            onUnderstood={goBack}
            testID="agreed-sending"
          />
        );
    }
  };

  // Đang trong cửa hoàn tác: hai nút dính ở chân màn hình, luôn thấy dù cỡ chữ lớn tới đâu (SPEC 6.5 điều 8).
  const footer = stage.kind === 'counting' ? <UndoActions onUndo={() => void undo()} onSendNow={level2 ? undefined : () => void sendNow()} busy={busy} address={address} /> : undefined;

  return (
    <AppScreen footer={footer} testID="screen-agreed">
      {content()}
    </AppScreen>
  );
}
