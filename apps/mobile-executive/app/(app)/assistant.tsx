import { fmtExecutive, vi } from '@mihato/i18n';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { BigMic } from '@senior/BigMic';
import { Glyph } from '@senior/Glyph';
import { LoadingText } from '@senior/Loading';
import { Notice, SectionTitle } from '@senior/Notice';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorCard } from '@senior/SeniorCard';
import { SeniorInput } from '@senior/SeniorInput';
import { SeniorText } from '@senior/SeniorText';
import { VoiceMeter } from '@senior/VoiceMeter';
import { color, useSenior } from '@senior/theme';
import { useMe, useRunningRuns } from '@/data/queries';
import { sortRuns } from '@/features/steps';
import { useDisplayPrefs } from '@/hooks';
import { assistant } from '@/scribe/assistant';
import type { AssistantNotice } from '@/scribe/machine';
import { micSupported } from '@/scribe/mic';
import { AppScreen, goTab } from '@/ui/AppScreen';

const t = vi.executive.assistant;
const c = vi.executive.consent;

/** Thời hạn lưu bản chép chữ, mặc định 90 ngày [GIẢ ĐỊNH] (SPEC 6.8). `me` chưa trả giá trị cấu hình của tổ chức. */
const TRANSCRIPT_DAYS = 90;

function AssistantLabel() {
  const m = useSenior();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={vi.executive.assistantLabel}
      style={{
        alignSelf: 'flex-start',
        borderRadius: m.radius,
        borderWidth: m.borderWidth,
        borderColor: color.gold,
        backgroundColor: color.goldTint,
        paddingHorizontal: m.space.md,
        paddingVertical: m.space.xs,
      }}
      testID="assistant-label"
    >
      <SeniorText variant="caption" weight="bold" tone="gold">
        {vi.executive.assistantLabel}
      </SeniorText>
    </View>
  );
}

/** Chip luôn hiện khi đang trò chuyện: màn hình nói rõ trợ lý đang ở chế độ nghe (chữ và hình, không chỉ màu). */
function VoiceChip() {
  const m = useSenior();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={t.voiceChip}
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: m.space.sm,
        borderRadius: m.radius,
        borderWidth: m.borderWidth,
        borderColor: color.primary,
        backgroundColor: color.primaryTint,
        paddingHorizontal: m.space.md,
        paddingVertical: m.space.xs,
      }}
      testID="assistant-voice-chip"
    >
      <Glyph name="mic" size={20} tint={color.primary} />
      <SeniorText variant="caption" weight="bold" tone="primary">
        {t.voiceChip}
      </SeniorText>
    </View>
  );
}

/** Thanh mức âm tự đăng ký theo dõi, để chỉ phần này vẽ lại khoảng 10 lần một giây chứ không phải cả màn hình. */
function LiveMeter({ active }: { active: boolean }) {
  const level = useSyncExternalStore(assistant.level.subscribe, assistant.level.getSnapshot, assistant.level.getSnapshot);
  return <VoiceMeter level={level} active={active} testID="assistant-meter" />;
}

function noticeText(notice: AssistantNotice, address: string): { title?: string; body: string } {
  switch (notice) {
    case 'voice_idle':
      return { body: fmtExecutive(t.voiceIdle, {}, address) };
    case 'voice_ended':
      return { body: fmtExecutive(t.voiceEnded, {}, address) };
    case 'resting':
      return { title: t.resting, body: t.restingBody };
    case 'quota':
      return { body: fmtExecutive(t.dailyLimit, {}, address) };
    case 'stt_failed':
      return { body: fmtExecutive(t.sttFailed, {}, address) };
    case 'mic_denied':
      return { body: fmtExecutive(t.micDenied, {}, address) };
    case 'mic_unsupported':
      return { body: fmtExecutive(t.micUnsupported, {}, address) };
    case 'text_only':
      return { body: t.textOnly };
    case 'unclear_twice':
      return { body: fmtExecutive(t.unclearTwice, {}, address) };
  }
}

/**
 * M2 Trợ lý (SPEC 7.4, 6.1, 6.6, 6.8, 6.10, 6.11). Nhãn cố định **Trợ lý AI**. Chế độ trò chuyện (docs/DECISIONS.md 04/10/2026):
 * bấm micro MỘT lần, trợ lý nghe liên tục; người dùng ngừng nói thì trợ lý tự trả lời; đọc xong thì nghe tiếp. Cho tới khi
 * bấm dừng, lâu không có tiếng, rời màn hình, có sự cố, hoặc có đề xuất (M3 xác nhận bằng chạm). Màn hình luôn nói rõ micro
 * đang mở (chip, dòng trạng thái, thanh mức âm) và luôn có một nút dừng. Chữ nghe được hiện cỡ lớn ngay khi nói; câu trả lời có
 * cả chữ và tiếng. Nút **Gõ chữ** cho kết quả y hệt. Có đề xuất thì mở M3; câu xác nhận ở M3 do máy chủ dựng.
 */
export default function AssistantScreen() {
  const m = useSenior();
  const { address, assistantEnabled } = useDisplayPrefs();
  const params = useLocalSearchParams<{ prefill?: string }>();
  const state = useSyncExternalStore(assistant.subscribe, assistant.getSnapshot, assistant.getSnapshot);
  const me = useMe().data;
  const runs = useRunningRuns().data?.items;
  const [draft, setDraft] = useState('');
  const toReview = useRef(false);
  const prefillUsed = useRef<string | null>(null);

  useEffect(() => {
    if (state.consent === null) void assistant.loadConsent();
  }, [state.consent]);

  useEffect(() => {
    if (me) assistant.setSpeechRate(me.prefs.speechRate);
  }, [me]);

  // M5 mở màn này với câu đã soạn sẵn: mở ô gõ chữ, điền câu, người dùng chỉ cần bấm Gửi.
  useEffect(() => {
    const prefill = typeof params.prefill === 'string' ? params.prefill.trim() : '';
    if (!prefill || prefillUsed.current === prefill || !state.consent) return;
    prefillUsed.current = prefill;
    setDraft(prefill);
    assistant.setTyping(true);
  }, [params.prefill, state.consent]);

  // Máy chưa thu âm được (iOS, Android hôm nay; tổ chức tắt STT): mở sẵn ô gõ chữ.
  useEffect(() => {
    if (state.consent && (!micSupported() || me?.ai.stt === 'off')) assistant.setTyping(true);
  }, [state.consent, me?.ai.stt]);

  // Có đề xuất: mở M3. Trợ lý vẫn đọc nốt điều đã hiểu trong lúc màn xác nhận hiện câu do máy chủ dựng.
  const proposal = state.proposal;
  useEffect(() => {
    if (!proposal) return;
    toReview.current = true;
    assistant.proposalOpened();
    router.push({ pathname: '/review/[id]', params: { id: proposal.proposalId } });
  }, [proposal]);

  // Rời màn hình: micro tự đóng; tiếng đang đọc cũng dừng, trừ khi đang sang M3.
  useFocusEffect(
    useCallback(() => {
      toReview.current = false;
      return () => assistant.leaveScreen(toReview.current);
    }, []),
  );

  if (!assistantEnabled) {
    return (
      <AppScreen tab="assistant" testID="screen-assistant-off">
        <AssistantLabel />
        <Notice title={t.resting}>{t.restingBody}</Notice>
        <SeniorButton variant="secondary" label={t.openProgress} onPress={() => goTab('progress')} testID="assistant-open-progress" />
        <SeniorButton variant="secondary" label={t.openDecisions} onPress={() => router.push('/decisions')} testID="assistant-open-decisions" />
      </AppScreen>
    );
  }

  if (state.consent === null) {
    return (
      <AppScreen tab="assistant" testID="screen-assistant-loading">
        <AssistantLabel />
        <LoadingText address={address} />
      </AppScreen>
    );
  }

  if (!state.consent) {
    return (
      <AppScreen
        tab="assistant"
        title={c.title}
        footer={
          <>
            <SeniorButton label={c.agree} onPress={() => void assistant.agree()} testID="consent-agree" />
            <SeniorButton variant="secondary" label={c.later} onPress={() => goTab('home')} testID="consent-later" />
          </>
        }
        testID="screen-consent"
      >
        <AssistantLabel />
        <SeniorText variant="emphasis">{fmtExecutive(c.intro, {}, address)}</SeniorText>
        {[c.points.machine, c.points.mic, c.points.audio, c.points.transcript, c.points.erase].map((point, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: m.space.md }}>
            <View style={{ width: 4, borderRadius: 2, backgroundColor: color.gold }} />
            <SeniorText style={{ flex: 1 }}>{fmtExecutive(point, { n: TRANSCRIPT_DAYS }, address)}</SeniorText>
          </View>
        ))}
        <SeniorText tone="sub">{c.laterNote}</SeniorText>
      </AppScreen>
    );
  }

  const { phase } = state;
  const listening = phase === 'listening';
  const busy = phase === 'thinking' || phase === 'connecting';
  const hasConversation = state.heard !== '' || state.reply !== '';
  const statusText =
    phase === 'connecting'
      ? fmtExecutive(t.connecting, {}, address)
      : phase === 'listening'
        ? t.listening
        : phase === 'thinking'
          ? fmtExecutive(t.processing, {}, address)
          : phase === 'speaking'
            ? t.speaking
            : state.voice
              ? // Đang trò chuyện nhưng micro chưa mở (vừa bấm, hoặc giữa hai lượt): nói đúng điều đang xảy ra, không báo "đang nghe" khi chưa nghe.
                fmtExecutive(t.voiceOpening, {}, address)
              : hasConversation || state.typingOpen || state.notice
                ? null
                : fmtExecutive(t.prompt, {}, address);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void assistant.sendText(text);
  };

  const firstRun = runs && runs.length > 0 ? sortRuns(runs)[0] : undefined;
  const suggestions = [
    ...(firstRun ? [fmtExecutive(t.suggestions.status, { lượt: firstRun.title })] : []),
    t.suggestions.late,
    t.suggestions.decisions,
    t.suggestions.week,
  ];
  const notice = state.notice ? noticeText(state.notice, address) : null;

  return (
    <AppScreen
      tab="assistant"
      footer={
        state.typingOpen ? (
          <>
            <SeniorButton label={t.sendTyped} onPress={send} disabled={draft.trim() === '' || busy} testID="assistant-send" />
            <SeniorButton variant="secondary" label={t.closeTyping} onPress={() => assistant.setTyping(false)} testID="assistant-close-typing" />
          </>
        ) : state.voice ? (
          <>
            {/* Đang trò chuyện: nút micro luôn là nút dừng, ở mọi lúc (nghe, nghĩ, đọc). Một chạm là micro đóng. */}
            <BigMic listening onPress={() => void assistant.pressMic()} label={t.voiceStop} accessibilityLabel={t.a11yVoiceStop} testID="assistant-mic" />
            {listening && state.heard !== '' && !state.heardFinal ? (
              <SeniorButton variant="secondary" label={t.voiceDone} onPress={() => void assistant.finishSpeaking()} testID="assistant-voice-done" />
            ) : null}
            {phase === 'thinking' || phase === 'speaking' ? (
              <SeniorButton variant="secondary" icon="stop" label={t.voiceInterrupt} onPress={() => void assistant.interruptAndListen()} testID="assistant-voice-interrupt" />
            ) : null}
          </>
        ) : (
          <>
            <BigMic listening={false} onPress={() => void assistant.pressMic()} label={t.voiceStart} accessibilityLabel={t.a11yVoiceStart} disabled={phase === 'connecting'} testID="assistant-mic" />
            <SeniorButton variant="secondary" icon="keyboard" label={t.typeInstead} onPress={() => assistant.setTyping(true)} testID="assistant-type" />
          </>
        )
      }
      testID="screen-assistant"
    >
      <AssistantLabel />

      {state.voice ? <VoiceChip /> : null}

      {statusText ? (
        <View accessible accessibilityRole="text" accessibilityLiveRegion="polite" style={{ gap: m.space.xs }} testID="assistant-status">
          <SeniorText variant="cardTitle" tone="primary">
            {statusText}
          </SeniorText>
          {state.waitNotice ? <SeniorText tone="sub">{t.waitLonger}</SeniorText> : null}
        </View>
      ) : null}

      {/* Lúc đang nghe: thanh mức âm cho thấy máy nghe thấy mình; lượt đầu chưa có chữ thì nhắc cách dùng một lần. */}
      {state.voice && listening ? (
        <View style={{ gap: m.space.sm }}>
          <LiveMeter active />
          {state.heard === '' ? (
            <SeniorText tone="sub" testID="assistant-voice-intro">
              {fmtExecutive(t.voiceIntro, {}, address)}
            </SeniorText>
          ) : null}
        </View>
      ) : null}

      {/* Ô gõ chữ nằm ngay dưới dòng trạng thái: mở ra là thấy ngay, không phải cuộn xuống dưới câu trả lời dài. */}
      {state.typingOpen ? (
        <SeniorInput
          value={draft}
          onChangeText={setDraft}
          label={t.typeLabel}
          placeholder={t.typePlaceholder}
          onSpeak={() => {
            assistant.setTyping(false);
            void assistant.pressMic();
          }}
          speaking={listening}
          maxLength={2000}
          testID="assistant-input"
        />
      ) : null}

      {notice ? (
        <View style={{ gap: m.space.md }} testID={`assistant-notice-${state.notice}`}>
          <Notice title={notice.title} live>
            {notice.body}
          </Notice>
          {state.notice === 'stt_failed' ? <SeniorButton variant="secondary" label={t.retry} onPress={() => void assistant.pressMic()} testID="assistant-retry" /> : null}
          {state.notice === 'resting' || state.notice === 'quota' ? (
            <>
              <SeniorButton variant="secondary" label={t.openProgress} onPress={() => goTab('progress')} testID="assistant-open-progress" />
              <SeniorButton variant="secondary" label={t.openDecisions} onPress={() => router.push('/decisions')} testID="assistant-open-decisions" />
            </>
          ) : null}
        </View>
      ) : null}

      {state.heard !== '' ? (
        <View style={{ gap: m.space.xs }} testID="assistant-heard">
          <SeniorText variant="caption" tone="gold" weight="semibold">
            {state.turn === 'text' ? t.askedTitle : t.heardTitle}
          </SeniorText>
          <SeniorText variant="heard" accessibilityLiveRegion="polite" testID="assistant-heard-text">
            {state.heard}
          </SeniorText>
        </View>
      ) : null}

      {state.reply !== '' && state.notice !== 'unclear_twice' ? (
        <SeniorCard tone="quiet" testID="assistant-reply">
          <View style={{ gap: m.space.sm }}>
            <SeniorText variant="caption" tone="gold" weight="semibold">
              {t.replyTitle}
            </SeniorText>
            <SeniorText accessibilityLiveRegion="polite" testID="assistant-reply-text">
              {state.reply}
            </SeniorText>
          </View>
        </SeniorCard>
      ) : null}

      {state.choices ? (
        <View style={{ gap: m.space.md }} testID="assistant-choices">
          <SeniorText variant="emphasis">{fmtExecutive(state.choices.kind === 'person' ? t.choosePersonHint : t.chooseOne, {}, address)}</SeniorText>
          {state.choices.options.map((option) => (
            <SeniorCard key={option.id} onPress={() => void assistant.sendText(option.label)} accessibilityLabel={option.sub ? `${option.label}, ${option.sub}` : option.label} testID={`assistant-choice-${option.id}`}>
              <SeniorText variant="emphasis">{option.label}</SeniorText>
              {option.sub ? <SeniorText tone="sub">{option.sub}</SeniorText> : null}
            </SeniorCard>
          ))}
        </View>
      ) : null}

      {/* Đang trò chuyện thì nút Ngắt lời ở chân màn hình làm việc này; ở đây chỉ còn cho đường không trò chuyện. */}
      {phase === 'speaking' && !state.voice ? <SeniorButton variant="secondary" icon="stop" label={t.stopSpeaking} onPress={() => assistant.stopSpeaking()} testID="assistant-stop-speaking" /> : null}
      {phase === 'idle' && !state.voice && state.reply !== '' && state.replyDone ? (
        <SeniorButton variant="secondary" icon="speaker" label={t.readAloud} onPress={() => void assistant.readAgain()} testID="assistant-read-again" />
      ) : null}

      {!hasConversation && phase === 'idle' && !state.typingOpen && !state.voice ? (
        <View style={{ gap: m.space.md }} testID="assistant-suggestions">
          <SectionTitle>{t.suggestionsTitle}</SectionTitle>
          {suggestions.map((text) => (
            <SeniorCard key={text} onPress={() => void assistant.sendText(text)} accessibilityLabel={text}>
              <SeniorText>{text}</SeniorText>
            </SeniorCard>
          ))}
        </View>
      ) : null}
    </AppScreen>
  );
}
