import { formatLunar } from '@mihato/domain/lunar';
import { dayPart, fmtExecutive, formatDateFull, formatTimeSpoken, vi } from '@mihato/i18n';
import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { Glyph } from '@senior/Glyph';
import { LoadingText } from '@senior/Loading';
import { Notice } from '@senior/Notice';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorCard } from '@senior/SeniorCard';
import { SeniorText } from '@senior/SeniorText';
import { color, useSenior } from '@senior/theme';
import { useBriefing, useMe, useOverview, usePendingProposals } from '@/data/queries';
import { briefingPlayer } from '@/features/briefing-player';
import { groupPendingProposals } from '@/features/proposals';
import { useDisplayPrefs, useNow, useOnline } from '@/hooks';
import { AppScreen } from '@/ui/AppScreen';
import { DelegationBanner, OfflineBanner } from '@/ui/Banners';

const t = vi.executive.home;

/**
 * M1 Trang chủ (SPEC 7.4): lời chào theo buổi, ngày đầy đủ kèm ngày âm, lời chúc của Văn phòng nếu có,
 * dải Nghe báo cáo tổng hợp đầu ngày, và ba thẻ lớn. Việc chính: chạm một thẻ. Thẻ "Nói với trợ lý" là thẻ nền xanh đặc.
 */
export default function HomeScreen() {
  const m = useSenior();
  const now = useNow();
  const online = useOnline();
  const { address, assistantEnabled } = useDisplayPrefs();
  const me = useMe().data;
  const overview = useOverview();
  const proposals = usePendingProposals();
  const briefing = useBriefing();
  const playerState = useSyncExternalStore(briefingPlayer.subscribe, briefingPlayer.getSnapshot, briefingPlayer.getSnapshot);

  const pendingGroups = groupPendingProposals(proposals.data?.items ?? []).length;
  const decisionCount = (overview.data?.awaitingMyDecision ?? 0) + pendingGroups;
  const countKnown = overview.data !== undefined;
  const lunar = formatLunar(new Date(now)).replace(/\s+âm lịch$/u, '');
  const playing = playerState === 'playing' || playerState === 'preparing';
  const b = briefing.data;

  return (
    <AppScreen tab="home" banner={<OfflineBanner online={online} updatedAt={overview.dataUpdatedAt} />} testID="screen-home">
      <View style={{ flexDirection: 'row', gap: m.space.md }}>
        <View style={{ width: 6, borderRadius: 3, backgroundColor: color.gold }} />
        <View style={{ flex: 1, gap: m.space.xs }}>
          <SeniorText variant="screenTitle" accessibilityRole="header" testID="home-greeting">
            {fmtExecutive(t.greeting[dayPart(now)], {}, address)}
          </SeniorText>
          <SeniorText testID="home-date">{fmtExecutive(t.today, { ngày: formatDateFull(now) })}</SeniorText>
          <SeniorText tone="gold" weight="medium" testID="home-lunar">
            {fmtExecutive(t.lunar, { 'ngày âm': lunar })}
          </SeniorText>
        </View>
      </View>

      {me?.greeting ? (
        <Notice title={t.officeGreeting} testID="home-office-greeting">
          {me.greeting}
        </Notice>
      ) : null}

      <DelegationBanner me={me} />

      <View style={{ gap: m.space.md }} testID="home-briefing">
        {briefing.isPending ? (
          <LoadingText text={fmtExecutive(t.briefing.preparing, {}, address)} testID="briefing-loading" />
        ) : b ? (
          <>
            {playing ? (
              <SeniorButton variant="secondary" icon="stop" label={t.briefing.stop} onPress={() => briefingPlayer.stop()} testID="briefing-stop" />
            ) : (
              <SeniorButton
                variant="secondary"
                icon="speaker"
                label={playerState === 'finished' ? t.briefing.listenAgain : t.briefing.listen}
                onPress={() => void briefingPlayer.play(b, me?.prefs.speechRate ?? 'normal')}
                accessibilityHint={fmtExecutive(t.briefing.builtAt, { giờ: formatTimeSpoken(b.builtAt) })}
                testID="briefing-listen"
              />
            )}
            {playerState !== 'idle' ? (
              <SeniorCard tone="quiet" testID="briefing-text">
                <View style={{ gap: m.space.sm }}>
                  <SeniorText variant="caption" tone="gold" weight="semibold" accessibilityLiveRegion="polite">
                    {playing ? t.briefing.playing : playerState === 'finished' ? t.briefing.finished : fmtExecutive(t.briefing.builtAt, { giờ: formatTimeSpoken(b.builtAt) })}
                  </SeniorText>
                  {b.sections.length > 0 ? (
                    b.sections.map((section) => (
                      <View key={section.key} style={{ gap: m.space.xs }}>
                        <SeniorText variant="emphasis" weight="bold">
                          {fmtExecutive(t.briefing.sections[section.key], {}, address)}
                        </SeniorText>
                        <SeniorText>{section.lead}</SeniorText>
                        {section.lines.map((line, i) => (
                          <SeniorText key={i}>{line}</SeniorText>
                        ))}
                      </View>
                    ))
                  ) : (
                    <SeniorText>{b.text}</SeniorText>
                  )}
                </View>
              </SeniorCard>
            ) : null}
          </>
        ) : (
          <SeniorCard tone="quiet" testID="briefing-not-ready">
            <SeniorText tone="sub">{fmtExecutive(t.briefing.notReady, {}, address)}</SeniorText>
          </SeniorCard>
        )}
      </View>

      {assistantEnabled ? (
        <SeniorCard tone="primary" onPress={() => router.push('/assistant')} accessibilityLabel={`${t.cards.talk}. ${t.cards.talkHint}`} testID="home-card-talk">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: m.space.md }}>
            <Glyph name="mic" size={Math.round(m.font.screenTitle * 1.2)} tint={color.onPrimary} />
            <View style={{ flex: 1 }}>
              <SeniorText variant="cardTitle" tone="onPrimary">
                {t.cards.talk}
              </SeniorText>
              <SeniorText tone="onPrimary">{t.cards.talkHint}</SeniorText>
            </View>
          </View>
        </SeniorCard>
      ) : null}

      <SeniorCard onPress={() => router.push('/progress')} accessibilityLabel={`${t.cards.progress}. ${t.cards.progressHint}`} testID="home-card-progress">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: m.space.md }}>
          <Glyph name="progress" size={Math.round(m.font.screenTitle)} tint={color.primary} />
          <View style={{ flex: 1 }}>
            <SeniorText variant="cardTitle">{t.cards.progress}</SeniorText>
            <SeniorText tone="sub">{t.cards.progressHint}</SeniorText>
          </View>
        </View>
      </SeniorCard>

      <SeniorCard
        tone={decisionCount > 0 ? 'gold' : 'plain'}
        onPress={() => router.push('/decisions')}
        accessibilityLabel={`${fmtExecutive(t.cards.decisions, {}, address)}. ${decisionCount > 0 ? fmtExecutive(t.cards.decisionsCount, { n: decisionCount }) : t.cards.decisionsNone}`}
        testID="home-card-decisions"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: m.space.md }}>
          <Glyph name="decide" size={Math.round(m.font.screenTitle)} tint={decisionCount > 0 ? color.gold : color.primary} />
          <View style={{ flex: 1 }}>
            <SeniorText variant="cardTitle">{fmtExecutive(t.cards.decisions, {}, address)}</SeniorText>
            {countKnown ? (
              <SeniorText weight={decisionCount > 0 ? 'bold' : 'regular'} tone={decisionCount > 0 ? 'text' : 'sub'} testID="home-decisions-count">
                {decisionCount > 0 ? fmtExecutive(t.cards.decisionsCount, { n: decisionCount }) : t.cards.decisionsNone}
              </SeniorText>
            ) : null}
          </View>
        </View>
      </SeniorCard>
    </AppScreen>
  );
}
