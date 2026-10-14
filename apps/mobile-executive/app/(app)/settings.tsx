import type { Me } from '@mihato/domain';
import { fmtExecutive, formatTimeSpoken, vi } from '@mihato/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { ChoiceGroup } from '@senior/ChoiceGroup';
import { LoadingText } from '@senior/Loading';
import { Notice, SectionTitle } from '@senior/Notice';
import { ResultPanel } from '@senior/ResultPanel';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorText } from '@senior/SeniorText';
import { useSenior } from '@senior/theme';
import { errorMessage } from '@/api/errors';
import { APP_VERSION, PRIVACY_POLICY_URL } from '@/config';
import { keys, useMe } from '@/data/queries';
import { fullPersonName } from '@/features/address';
import { useDisplayPrefs } from '@/hooks';
import { removePushToken } from '@/push/push';
import { assistant } from '@/scribe/assistant';
import { api, localProfile, session } from '@/services';
import { AppScreen } from '@/ui/AppScreen';
import { DelegationBanner } from '@/ui/Banners';

const t = vi.executive.settings;

type Prefs = Me['prefs'];
type Panel = 'main' | 'clearHistory' | 'cleared' | 'signOut' | 'dataRequest';

/** "07:30" → số phút; và ngược lại, giữ trong khoảng 05:00 đến 10:00 cho bản tin sáng. */
const toMinutes = (hhmm: string) => {
  const [h, min] = hhmm.split(':').map(Number);
  return (h ?? 7) * 60 + (min ?? 30);
};
const fromMinutes = (total: number) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
const EARLIEST = 5 * 60;
const LATEST = 10 * 60;
const spoken = (hhmm: string) => formatTimeSpoken(Date.UTC(2026, 0, 1, Math.floor(toMinutes(hhmm) / 60) - 7, toMinutes(hhmm) % 60));

/**
 * M7 Cài đặt (SPEC 7.4): cỡ chữ (ba nút, không dùng thanh trượt), tốc độ đọc, giờ nhận bản tin, âm báo khi gửi xong,
 * xoá lịch sử hội thoại, ủy quyền, đăng xuất. Mỗi lựa chọn là một chạm và có hiệu lực ngay; lưu ở máy chủ
 * (`PATCH /v1/me/prefs`) để đổi máy vẫn giữ.
 */
export default function SettingsScreen() {
  const m = useSenior();
  const { address, profile } = useDisplayPrefs();
  const queryClient = useQueryClient();
  const meQuery = useMe();
  const me = meQuery.data;
  const [panel, setPanel] = useState<Panel>('main');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Đổi ngay trên màn hình rồi mới gửi; máy chủ không nhận thì trả về như cũ và nói rõ. */
  const patch = async (change: Partial<Prefs>) => {
    if (!me) return;
    setMessage(null);
    const previous = me;
    queryClient.setQueryData<Me>(keys.me, { ...me, prefs: { ...me.prefs, ...change } });
    try {
      const updated = await api.call('me.prefs', { body: change });
      queryClient.setQueryData<Me>(keys.me, updated);
      if (change.speechRate) assistant.setSpeechRate(change.speechRate);
    } catch (err) {
      queryClient.setQueryData<Me>(keys.me, previous);
      setMessage(err instanceof TypeError ? errorMessage(err, address) : fmtExecutive(t.saveFailed, {}, address));
    }
  };

  const clearHistory = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.call('conversations.delete', {});
      assistant.clearScreen();
      setPanel('cleared');
    } catch (err) {
      setMessage(errorMessage(err, address));
      setPanel('main');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    await removePushToken();
    await api.call('auth.logout', {}).catch(() => undefined);
    await session.end('signed_out');
  };

  if (panel === 'clearHistory') {
    return (
      <AppScreen
        title={t.clearHistory.title}
        back={() => setPanel('main')}
        footer={
          <>
            <SeniorButton label={t.clearHistory.confirm} onPress={() => void clearHistory()} busyLabel={busy ? fmtExecutive(vi.executive.status.loading, {}, address) : null} testID="clear-history-confirm" />
            <SeniorButton variant="secondary" label={t.clearHistory.keep} onPress={() => setPanel('main')} disabled={busy} testID="clear-history-keep" />
          </>
        }
        testID="screen-clear-history"
      >
        <SeniorText>{t.clearHistory.body}</SeniorText>
      </AppScreen>
    );
  }

  if (panel === 'cleared') {
    return (
      <AppScreen title={t.clearHistory.title} testID="screen-clear-history-done">
        <ResultPanel title={t.clearHistory.done} onUnderstood={() => setPanel('main')} />
      </AppScreen>
    );
  }

  if (panel === 'dataRequest') {
    const d = t.dataRequest;
    const policyUrl = PRIVACY_POLICY_URL;
    // Cách yêu cầu xoá dữ liệu phải rõ ràng trong app (App Store 5.1.1). App không tạo tài khoản: đường xoá dữ liệu máy chủ là Văn phòng.
    return (
      <AppScreen
        title={d.title}
        back={() => setPanel('main')}
        footer={
          <>
            <SeniorButton label={d.askOffice} onPress={() => router.push('/office')} testID="data-request-office" />
            {policyUrl ? (
              <SeniorButton
                variant="secondary"
                label={d.policy}
                onPress={() => {
                  void Linking.openURL(policyUrl).catch(() => undefined);
                }}
                testID="privacy-policy"
              />
            ) : null}
          </>
        }
        testID="screen-data-request"
      >
        <View style={{ gap: m.space.md }}>
          <SectionTitle>{d.onDeviceTitle}</SectionTitle>
          <SeniorText>{d.onDevice}</SeniorText>
        </View>
        <View style={{ gap: m.space.md }}>
          <SectionTitle>{d.onServerTitle}</SectionTitle>
          <SeniorText>{d.onServer}</SeniorText>
        </View>
        <View style={{ gap: m.space.md }}>
          <SectionTitle>{d.lostTitle}</SectionTitle>
          <SeniorText>{d.lost}</SeniorText>
        </View>
      </AppScreen>
    );
  }

  if (panel === 'signOut') {
    return (
      <AppScreen
        title={t.signOut.title}
        back={() => setPanel('main')}
        footer={
          <>
            <SeniorButton label={t.signOut.confirm} onPress={() => void signOut()} busyLabel={busy ? fmtExecutive(vi.executive.status.loading, {}, address) : null} testID="sign-out-confirm" />
            <SeniorButton variant="secondary" label={t.signOut.keep} onPress={() => setPanel('main')} disabled={busy} testID="sign-out-keep" />
          </>
        }
        testID="screen-sign-out"
      >
        <SeniorText>{t.signOut.body}</SeniorText>
      </AppScreen>
    );
  }

  const briefingMinutes = me ? toMinutes(me.prefs.briefingTime) : 0;

  return (
    <AppScreen title={t.title} back testID="screen-settings">
      <DelegationBanner me={me} />
      {message ? (
        <Notice live testID="settings-message">
          {message}
        </Notice>
      ) : null}
      {meQuery.isPending ? <LoadingText address={address} /> : null}
      {meQuery.isError && !me ? <Notice live>{errorMessage(meQuery.error, address)}</Notice> : null}

      {me ? (
        <>
          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.fontSize.title}</SectionTitle>
            <ChoiceGroup
              label={t.fontSize.title}
              options={[
                { value: 'large', label: t.fontSize.large },
                { value: 'xlarge', label: t.fontSize.xlarge },
                { value: 'xxlarge', label: t.fontSize.xxlarge },
              ]}
              value={me.prefs.fontScale}
              onChange={(fontScale) => void patch({ fontScale })}
              testID="font-scale"
            />
            <SeniorText tone="sub" testID="font-sample">
              {t.fontSize.sample}
            </SeniorText>
          </View>

          {me.uiProfile !== 'senior' ? (
            <View style={{ gap: m.space.md }}>
              <SectionTitle>{t.profile.title}</SectionTitle>
              <ChoiceGroup
                label={t.profile.title}
                options={[
                  { value: 'standard', label: t.profile.standard },
                  { value: 'senior', label: t.profile.senior },
                ]}
                value={profile}
                onChange={(next) => void localProfile.setProfileOverride(next === 'senior' ? 'senior' : null)}
                testID="ui-profile"
              />
            </View>
          ) : null}

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.speechRate.title}</SectionTitle>
            <ChoiceGroup
              label={t.speechRate.title}
              options={[
                { value: 'slow', label: t.speechRate.slow },
                { value: 'normal', label: t.speechRate.normal },
                { value: 'fast', label: t.speechRate.fast },
              ]}
              value={me.prefs.speechRate}
              onChange={(speechRate) => void patch({ speechRate })}
              testID="speech-rate"
            />
          </View>

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.briefingTime.title}</SectionTitle>
            <SeniorText variant="emphasis" testID="briefing-time">
              {fmtExecutive(t.briefingTime.value, { giờ: spoken(me.prefs.briefingTime) })}
            </SeniorText>
            <SeniorButton variant="secondary" label={t.briefingTime.earlier} disabled={briefingMinutes - 30 < EARLIEST} onPress={() => void patch({ briefingTime: fromMinutes(briefingMinutes - 30) })} testID="briefing-earlier" />
            <SeniorButton variant="secondary" label={t.briefingTime.later} disabled={briefingMinutes + 30 > LATEST} onPress={() => void patch({ briefingTime: fromMinutes(briefingMinutes + 30) })} testID="briefing-later" />
          </View>

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.sendSound.title}</SectionTitle>
            <ChoiceGroup
              label={t.sendSound.title}
              options={[
                { value: 'on', label: t.sendSound.on },
                { value: 'off', label: t.sendSound.off },
              ]}
              value={me.prefs.sendSound ? 'on' : 'off'}
              onChange={(v) => void patch({ sendSound: v === 'on' })}
              testID="send-sound"
            />
          </View>

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{vi.executive.delegation.title}</SectionTitle>
            <SeniorButton variant="secondary" label={vi.executive.delegation.title} onPress={() => router.push('/delegation')} testID="settings-delegation" />
          </View>

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.clearHistory.title}</SectionTitle>
            <SeniorText tone="sub">{t.clearHistory.body}</SeniorText>
            <SeniorButton variant="secondary" label={t.clearHistory.title} onPress={() => setPanel('clearHistory')} testID="settings-clear-history" />
          </View>

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.dataRequest.title}</SectionTitle>
            <SeniorButton variant="secondary" label={t.dataRequest.open} onPress={() => setPanel('dataRequest')} testID="settings-data-request" />
          </View>

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.signOut.title}</SectionTitle>
            <SeniorText tone="sub">{fmtExecutive(t.account, { người: fullPersonName(me) })}</SeniorText>
            <SeniorButton variant="secondary" label={t.lockNow} onPress={() => session.lock()} testID="settings-lock" />
            <SeniorButton variant="secondary" label={t.signOut.title} onPress={() => setPanel('signOut')} testID="settings-sign-out" />
          </View>

          {__DEV__ ? (
            <View style={{ gap: m.space.md }}>
              <SectionTitle>{vi.executive.aecLab.title}</SectionTitle>
              <SeniorText tone="sub">{vi.executive.aecLab.entryNote}</SeniorText>
              <SeniorButton variant="secondary" label={vi.executive.aecLab.entry} onPress={() => router.push('/aec-lab')} testID="settings-aec-lab" />
            </View>
          ) : null}

          <SeniorText variant="caption" tone="sub">
            {fmtExecutive(t.version, { 'phiên bản': APP_VERSION })}
          </SeniorText>
        </>
      ) : null}
    </AppScreen>
  );
}
