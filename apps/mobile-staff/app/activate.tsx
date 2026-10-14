import type { Me, Platform as DevicePlatform } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { errorMessage, isApiError } from '@/api/errors';
import { IS_RELEASE_BUILD, PINNED_API_BASE_URL } from '@/config';
import { keys } from '@/data/queries';
import { NoticeContent } from '@/features/NoticeContent';
import { personName } from '@/features/steps';
import { useSession } from '@/hooks';
import { pushPermission, syncPushToken } from '@/push/push';
import type { PushSyncResult } from '@/push/sync';
import { createPublicApi, queryClient, session, stepUpSigner } from '@/services';
import { parseActivationInput, resolveApiBaseUrl, type ActivationInput } from '@/session/activation-link';
import { biometricsAvailable, promptBiometrics } from '@/session/biometrics';
import type { SessionEndReason, SessionSnapshot } from '@/session/controller';
import { isWeakPin } from '@/session/pin';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { LoadingState } from '@/ui/Blocks';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/Field';
import { PinDots, PinPad } from '@/ui/PinPad';
import { Screen } from '@/ui/Screen';
import { color, profile, space } from '@/ui/theme';

const t = vi.staff.activation;

type Stage = 'code' | 'scan' | 'checking' | 'notice' | 'pin' | 'pinConfirm' | 'biometric' | 'push' | 'done';

/** App bị tắt giữa các bước kích hoạt thì mở lại đúng bước còn dở. */
function initialStage(s: SessionSnapshot): Stage {
  if (s.status !== 'onboarding') return 'code';
  if (!s.noticeRead) return 'notice';
  if (!s.pinSet) return 'pin';
  return 'biometric';
}

const END_REASON: Record<Exclude<SessionEndReason, 'signed_out'>, { title: string; body: string }> = {
  device_revoked: t.revoked,
  pin_attempts: t.pinWiped,
  session_expired: t.sessionEnded,
};

function devicePlatform(): DevicePlatform {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
}

/**
 * S0 Kích hoạt (SPEC 8.2, 10.2, 11.2, 11.7). Vào bằng đường dẫn `mihato://activate?token=…&api=…`, quét mã QR,
 * hoặc dán mã. Sau khi máy chủ nhận mã: đọc "Hệ thống ghi nhận gì về tôi" và bấm "Tôi đã đọc", đặt PIN 6 số,
 * bật sinh trắc học nếu máy có, cho phép thông báo.
 */
export default function ActivateScreen() {
  const params = useLocalSearchParams<{ token?: string; api?: string }>();
  const snapshot = useSession();
  const [stage, setStage] = useState<Stage>(() => initialStage(snapshot));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [pin, setPin] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [hasBiometrics, setHasBiometrics] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushProblem, setPushProblem] = useState<'denied' | 'noProject' | 'failed' | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const linkTried = useRef(false);
  const scanned = useRef(false);

  const activate = useCallback(async (input: ActivationInput) => {
    const apiBaseUrl = resolveApiBaseUrl(input.apiBaseUrl, PINNED_API_BASE_URL, IS_RELEASE_BUILD);
    if (!apiBaseUrl) {
      setStage('code');
      // Bản phân phối thiếu địa chỉ ghim là lỗi dựng bản, không phải lỗi của người dùng.
      setError(IS_RELEASE_BUILD ? t.serverNotConfigured : input.apiBaseUrl ? t.codeInvalid : t.needFullLink);
      return;
    }
    setError(null);
    setStage('checking');
    try {
      const stepUpPublicKey = (await stepUpSigner.publicJwk().catch(() => null)) ?? undefined;
      const result = await createPublicApi(apiBaseUrl).call('devices.activate', {
        body: {
          activationToken: input.token,
          deviceName: (Device.deviceName ?? Device.modelName ?? Platform.OS).slice(0, 80),
          platform: devicePlatform(),
          stepUpPublicKey,
        },
      });
      // Mã kích hoạt chỉ dùng được một lần: lưu token vào kho an toàn ngay.
      await session.activate({ accessToken: result.accessToken, refreshToken: result.refreshToken, apiBaseUrl, deviceId: result.device.id });
      queryClient.setQueryData(keys.me, result.me);
      setMe(result.me);
      setStage('notice');
    } catch (err) {
      setStage('code');
      // Mã sai, đã dùng hoặc hết hạn: máy chủ trả cùng một mã lỗi; nói rõ cách xử lý.
      setError(isApiError(err, 'invalid_credentials') || isApiError(err, 'input_invalid') ? t.codeInvalid : errorMessage(err));
    }
  }, []);

  // Mở app bằng đường dẫn kích hoạt: kiểm mã ngay, không bắt người dùng bấm thêm.
  useEffect(() => {
    if (linkTried.current || snapshot.status !== 'signedOut' || !params.token) return;
    linkTried.current = true;
    const input = parseActivationInput(`mihato://activate?token=${encodeURIComponent(params.token)}${params.api ? `&api=${encodeURIComponent(params.api)}` : ''}`);
    if (input) void activate(input);
    else setError(t.codeInvalid);
  }, [params.token, params.api, snapshot.status, activate]);

  useEffect(() => {
    if (stage === 'biometric' && hasBiometrics === null) void biometricsAvailable().then(setHasBiometrics);
  }, [stage, hasBiometrics]);

  const submitCode = () => {
    const input = parseActivationInput(code);
    if (!input) {
      setError(t.codeInvalid);
      return;
    }
    void activate(input);
  };

  const openScanner = async () => {
    setError(null);
    const granted = permission?.granted ? true : (await requestPermission()).granted;
    if (!granted) {
      setError(t.cameraDenied);
      return;
    }
    scanned.current = false;
    setStage('scan');
  };

  const onScanned = (data: string) => {
    if (scanned.current) return;
    scanned.current = true;
    const input = parseActivationInput(data);
    if (input) void activate(input);
    else {
      setStage('code');
      setError(t.codeInvalid);
    }
  };

  const onPinComplete = async (value: string) => {
    setPin('');
    if (stage === 'pin') {
      if (isWeakPin(value)) {
        setPinMessage(t.pin.tooSimple);
        return;
      }
      setFirstPin(value);
      setPinMessage(null);
      setStage('pinConfirm');
      return;
    }
    if (value !== firstPin) {
      setPinMessage(t.pin.mismatch);
      setStage('pin');
      return;
    }
    await session.setPin(value);
    setPinMessage(null);
    setStage('biometric');
  };

  /** Sau bước sinh trắc học: hỏi quyền thông báo nếu máy hỗ trợ, không thì xong. */
  const afterBiometric = async () => {
    setStage((await pushPermission(false)) === 'unavailable' ? 'done' : 'push');
  };

  const enableBiometrics = async () => {
    setBusy(true);
    if (await promptBiometrics()) await session.setBiometricsEnabled(true);
    setBusy(false);
    await afterBiometric();
  };

  const enablePush = async () => {
    setBusy(true);
    setPushProblem(null);
    const result: PushSyncResult = await syncPushToken(true);
    setBusy(false);
    // Chỉ sang bước cuối khi thật sự đã đăng ký (hoặc máy không hỗ trợ). Chưa được thì nói rõ vì sao: thử lại hoặc bỏ qua có chủ đích.
    if (result === 'granted' || result === 'unavailable') setStage('done');
    else setPushProblem(result === 'denied' ? 'denied' : result === 'no_project' ? 'noProject' : 'failed');
  };

  const endReason = snapshot.endReason && snapshot.endReason !== 'signed_out' ? END_REASON[snapshot.endReason] : null;
  const name = personName(me);

  switch (stage) {
    case 'code':
      return (
        <Screen title={t.title} keyboard footer={<Button label={t.continue} disabled={code.trim() === ''} onPress={submitCode} testID="activate-continue" />} testID="screen-activate">
          {endReason ? (
            <Banner tone="info" title={endReason.title} live testID="activate-ended">
              {endReason.body}
            </Banner>
          ) : null}
          <AppText>{t.intro}</AppText>
          <Button variant="secondary" label={t.scanQr} onPress={() => void openScanner()} testID="activate-scan" />
          <TextField
            label={t.enterCode}
            value={code}
            onChangeText={(v) => {
              setCode(v);
              setError(null);
            }}
            hint={t.codeHint}
            error={error}
            accessibilityLabel={t.codeLabel}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            testID="activate-code"
          />
        </Screen>
      );

    case 'scan':
      return (
        <Screen title={t.scanQr} footer={<Button variant="secondary" label={t.enterCode} onPress={() => setStage('code')} />} testID="screen-activate-scan">
          <AppText>{t.scanHint}</AppText>
          <View style={styles.camera}>
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(result) => onScanned(result.data)} />
          </View>
        </Screen>
      );

    case 'checking':
      return (
        <Screen title={t.title} testID="screen-activate-checking">
          <LoadingState />
          <AppText style={styles.center} accessibilityLiveRegion="polite">
            {t.checking}
          </AppText>
        </Screen>
      );

    case 'notice':
      return (
        <Screen
          title={t.notice.title}
          subtitle={t.steps.notice}
          footer={
            <Button
              label={t.notice.confirm}
              onPress={() => {
                void session.acknowledgeNotice().then(() => setStage('pin'));
              }}
              testID="notice-confirm"
            />
          }
          testID="screen-activate-notice"
        >
          {name && me ? (
            <View>
              <AppText variant="cardTitle">{fmt(t.welcome, { tên: name })}</AppText>
              <AppText tone="sub">{fmt(t.orgLine, { 'tổ chức': me.orgName })}</AppText>
            </View>
          ) : null}
          <AppText>{t.notice.intro}</AppText>
          <NoticeContent />
        </Screen>
      );

    case 'pin':
    case 'pinConfirm':
      return (
        <Screen title={stage === 'pin' ? t.pin.title : t.pin.confirmTitle} subtitle={t.steps.pin} testID="screen-activate-pin">
          <AppText tone="sub" style={styles.center}>
            {t.pin.hint}
          </AppText>
          <PinDots length={pin.length} />
          <View style={styles.message}>
            {pinMessage ? (
              <AppText weight="medium" style={styles.center} accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="pin-message">
                {pinMessage}
              </AppText>
            ) : null}
          </View>
          <PinPad
            value={pin}
            onChange={(next) => {
              setPin(next);
              if (next.length > 0) setPinMessage(null);
            }}
            onComplete={(value) => void onPinComplete(value)}
          />
        </Screen>
      );

    case 'biometric':
      return (
        <Screen
          title={t.biometric.title}
          subtitle={t.steps.biometric}
          footer={
            hasBiometrics ? (
              <>
                <Button label={t.biometric.enable} busy={busy} onPress={() => void enableBiometrics()} testID="biometric-enable" />
                <Button variant="secondary" label={t.biometric.skip} disabled={busy} onPress={() => void afterBiometric()} testID="biometric-skip" />
              </>
            ) : (
              <Button label={t.continue} disabled={hasBiometrics === null} onPress={() => void afterBiometric()} testID="biometric-continue" />
            )
          }
          testID="screen-activate-biometric"
        >
          <AppText>{hasBiometrics === false ? t.biometric.unavailable : t.biometric.body}</AppText>
        </Screen>
      );

    case 'push':
      return (
        <Screen
          title={t.push.title}
          subtitle={t.steps.push}
          footer={
            pushProblem === null || pushProblem === 'failed' ? (
              <>
                <Button label={pushProblem === 'failed' ? t.push.retry : t.push.enable} busy={busy} onPress={() => void enablePush()} testID="push-enable" />
                <Button variant="secondary" label={pushProblem === 'failed' ? t.push.continueWithout : t.push.skip} disabled={busy} onPress={() => setStage('done')} testID="push-skip" />
              </>
            ) : (
              <Button label={t.push.continueWithout} onPress={() => setStage('done')} testID="push-skip" />
            )
          }
          testID="screen-activate-push"
        >
          <AppText>{t.push.body}</AppText>
          {pushProblem ? (
            <Banner tone="info" live testID="push-problem">
              {t.push.problem[pushProblem]}
            </Banner>
          ) : null}
        </Screen>
      );

    case 'done':
      return (
        <Screen title={t.done.title} footer={<Button label={t.done.start} onPress={() => session.finishOnboarding()} testID="activate-start" />} testID="screen-activate-done">
          <Banner tone="done">{t.done.body}</Banner>
        </Screen>
      );
  }
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  message: { minHeight: 48, justifyContent: 'center' },
  camera: {
    aspectRatio: 1,
    borderRadius: profile.radius,
    overflow: 'hidden',
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    backgroundColor: color.text,
    marginTop: space.sm,
  },
});
