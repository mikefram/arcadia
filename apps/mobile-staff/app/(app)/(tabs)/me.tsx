import type { Me } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { errorMessage } from '@/api/errors';
import { APP_VERSION } from '@/config';
import { keys, useMe } from '@/data/queries';
import { OfflineBanner } from '@/features/StatusNotices';
import { personName } from '@/features/steps';
import { useOnline, useQueueItems, useSession } from '@/hooks';
import { removePushToken } from '@/push/push';
import { api, queryClient, session } from '@/services';
import { biometricsAvailable, promptBiometrics } from '@/session/biometrics';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { Card, EmptyState, ErrorState, InfoList, InfoRow, LoadingState, SectionHeading } from '@/ui/Blocks';
import { Button } from '@/ui/Button';
import { ChoiceList } from '@/ui/Field';
import { showFlash } from '@/ui/Flash';
import { Glyph } from '@/ui/Glyph';
import { Screen } from '@/ui/Screen';
import { color, profile, space } from '@/ui/theme';

const t = vi.staff.me;

const DEFAULT_QUIET = { start: '21:00', end: '07:00' } as const;

/** Dịch một giờ `HH:mm` đi 30 phút, quay vòng trong ngày. */
function shiftTime(time: string, deltaMinutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = ((((h ?? 0) * 60 + (m ?? 0) + deltaMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function LinkRow({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]} testID={testID}>
      <AppText style={styles.grow}>{label}</AppText>
      <Glyph name="forward" size={14} tint={color.textSub} />
    </Pressable>
  );
}

/** Chỉnh một mốc giờ bằng hai nút lùi và tiến 30 phút: không cần bàn phím, không cần thư viện chọn giờ. */
function TimeStepper({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  return (
    <View style={styles.stepper}>
      <AppText style={styles.grow}>{label}</AppText>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${t.quietEarlier}`} onPress={() => onChange(shiftTime(value, -30))} style={({ pressed }) => [styles.stepButton, pressed && styles.pressed]}>
        <Glyph name="back" size={14} tint={color.primary} />
      </Pressable>
      <AppText weight="semibold" style={styles.stepValue} accessibilityLabel={`${label}: ${value}`} accessibilityLiveRegion="polite">
        {value}
      </AppText>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${t.quietLater}`} onPress={() => onChange(shiftTime(value, 30))} style={({ pressed }) => [styles.stepButton, pressed && styles.pressed]}>
        <Glyph name="forward" size={14} tint={color.primary} />
      </Pressable>
    </View>
  );
}

/** Giờ yên tĩnh (`PATCH /v1/me/prefs`): theo giờ chung của tổ chức, hoặc giờ riêng của mình. */
function QuietHours({ me }: { me: Me }) {
  const online = useOnline();
  const saved = me.prefs.quietHours;
  const [mode, setMode] = useState<'org' | 'own'>(saved ? 'own' : 'org');
  const [start, setStart] = useState<string>(saved?.start ?? DEFAULT_QUIET.start);
  const [end, setEnd] = useState<string>(saved?.end ?? DEFAULT_QUIET.end);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = mode === 'org' ? saved !== null : saved?.start !== start || saved?.end !== end;

  const save = async () => {
    if (!online) {
      setError(vi.staff.feedback.needNetwork);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.call('me.prefs', { body: { quietHours: mode === 'org' ? null : { start, end } } });
      queryClient.setQueryData(keys.me, next);
      showFlash(vi.staff.feedback.saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <SectionHeading title={t.quietHours} />
      <AppText tone="sub">{t.quietHoursHint}</AppText>
      <ChoiceList
        label={t.quietHours}
        labelHidden
        options={[
          { value: 'org', label: t.quietHoursUseOrg },
          { value: 'own', label: t.quietHoursOwn },
        ]}
        value={mode}
        onChange={setMode}
      />
      {mode === 'own' ? (
        <Card>
          <TimeStepper label={t.quietFrom} value={start} onChange={setStart} />
          <TimeStepper label={t.quietTo} value={end} onChange={setEnd} />
          <AppText variant="caption" tone="sub">
            {fmt(t.quietHoursValue, { từ: start, đến: end })}
          </AppText>
        </Card>
      ) : null}
      {error ? (
        <Banner tone="info" live>
          {error}
        </Banner>
      ) : null}
      {changed ? <Button variant="secondary" label={vi.common.actions.save} busy={busy} onPress={() => void save()} testID="quiet-save" /> : null}
    </View>
  );
}

/** Bảo mật trên máy: đổi mã PIN, bật hoặc tắt mở khoá bằng sinh trắc học. */
function Security() {
  const { biometricsEnabled } = useSession();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    void biometricsAvailable().then(setAvailable);
  }, []);

  const toggle = async (next: boolean) => {
    // Bật thì phải xác nhận bằng chính sinh trắc học đó một lần.
    if (next && !(await promptBiometrics())) return;
    await session.setBiometricsEnabled(next);
  };

  return (
    <View style={styles.section}>
      <SectionHeading title={t.security} />
      <Card style={styles.flush}>
        <LinkRow label={t.changePin} onPress={() => router.push('/pin-change')} testID="me-change-pin" />
        <View style={[styles.linkRow, styles.line]}>
          <View style={styles.grow}>
            <AppText>{t.biometric}</AppText>
            <AppText variant="caption" tone="sub">
              {available ? (biometricsEnabled ? t.on : t.off) : t.biometricUnavailable}
            </AppText>
          </View>
          <Switch
            accessibilityLabel={t.biometric}
            value={biometricsEnabled}
            disabled={!available}
            onValueChange={(next) => void toggle(next)}
            trackColor={{ true: color.primary, false: color.border }}
            thumbColor={color.surface}
          />
        </View>
      </Card>
    </View>
  );
}

/** Đăng xuất: hỏi lại bằng chữ rõ ràng, báo số thao tác chưa gửi sẽ mất. */
function SignOut() {
  const pending = useQueueItems().filter((i) => i.status === 'pending').length;
  const online = useOnline();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    // Xoá push token và thu hồi thiết bị trên máy chủ (SPEC 10.2); mất mạng thì vẫn xoá phiên trên máy.
    await removePushToken();
    try {
      await api.call('auth.logout', {});
    } catch {}
    await session.end('signed_out');
  };

  if (!confirming) return <Button variant="secondary" label={t.signOut} onPress={() => setConfirming(true)} testID="sign-out" />;

  return (
    <Card testID="sign-out-confirm">
      <AppText variant="cardTitle" accessibilityRole="header">
        {t.signOutConfirmTitle}
      </AppText>
      <AppText>{t.signOutConfirmBody}</AppText>
      {pending > 0 ? <AppText weight="semibold">{fmt(t.signOutPendingWarning, { n: pending })}</AppText> : null}
      {!online ? (
        <AppText weight="semibold" testID="sign-out-offline-warning">
          {t.signOutOfflineWarning}
        </AppText>
      ) : null}
      <View style={styles.confirmButtons}>
        <Button label={t.stay} disabled={busy} onPress={() => setConfirming(false)} />
        <Button variant="secondary" label={t.signOutConfirm} busy={busy} onPress={() => void signOut()} testID="sign-out-confirm-button" />
      </View>
    </Card>
  );
}

/** S9 Tôi (SPEC 8.2): thông tin cá nhân, giờ yên tĩnh, bảo mật, ủy quyền khi vắng, dữ liệu được ghi nhận, đăng xuất. */
export default function MeScreen() {
  const query = useMe();
  const me = query.data;

  return (
    <Screen title={t.title} top={<View style={styles.top}>{<OfflineBanner updatedAt={query.dataUpdatedAt || undefined} />}</View>} testID="screen-me">
      {!me ? (
        query.isError ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : query.fetchStatus === 'paused' ? (
          <EmptyState text={vi.staff.feedback.offlineNoData} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          <View style={styles.section}>
            <SectionHeading title={t.profile} />
            <Card style={styles.flush}>
              <InfoList>
                <InfoRow label={t.fullName}>{personName(me) ?? me.fullName}</InfoRow>
                <InfoRow label={t.org}>{me.orgName}</InfoRow>
                {me.unitName ? <InfoRow label={t.unit}>{me.unitName}</InfoRow> : null}
                {me.phone ? <InfoRow label={t.phone}>{me.phone}</InfoRow> : null}
                {me.email ? <InfoRow label={t.mail}>{me.email}</InfoRow> : null}
              </InfoList>
            </Card>
            <AppText variant="caption" tone="sub">
              {t.profileHint}
            </AppText>
          </View>

          <QuietHours key={`${me.prefs.quietHours?.start ?? ''}-${me.prefs.quietHours?.end ?? ''}`} me={me} />
          <Security />

          <View style={styles.section}>
            <SectionHeading title={t.more} />
            <Card style={styles.flush}>
              <LinkRow label={t.delegation.title} onPress={() => router.push('/delegations')} testID="me-delegations" />
              <View style={styles.line}>
                <LinkRow label={t.whatIsRecorded} onPress={() => router.push('/privacy')} testID="me-privacy" />
              </View>
              <View style={styles.line}>
                <LinkRow label={t.dataRequest.title} onPress={() => router.push('/data-request')} testID="me-data-request" />
              </View>
            </Card>
          </View>
        </>
      )}

      <SignOut />
      <AppText variant="caption" tone="sub" style={styles.version}>
        {fmt(t.version, { 'phiên bản': APP_VERSION })}
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: profile.space.screen, gap: space.md },
  section: { gap: space.sm },
  flush: { paddingVertical: space.xs, gap: 0 },
  grow: { flex: 1 },
  linkRow: { minHeight: profile.touch.min, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  line: { borderTopWidth: 1, borderTopColor: color.hairline },
  pressed: { backgroundColor: color.primaryTint },
  stepper: { minHeight: profile.touch.min, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stepButton: {
    width: profile.touch.min,
    height: profile.touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: profile.radius,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  stepValue: { minWidth: 56, textAlign: 'center' },
  confirmButtons: { gap: profile.space.betweenButtons, marginTop: space.sm },
  version: { textAlign: 'center' },
});
