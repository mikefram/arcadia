import type { Me, Platform as DevicePlatform } from '@mihato/domain';
import { fmtExecutive, vi } from '@mihato/i18n';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { LoadingText } from '@senior/Loading';
import { lineHeightFor } from '@senior/metrics';
import { Notice } from '@senior/Notice';
import { PinDots, PinPad } from '@senior/PinPad';
import { ResultPanel } from '@senior/ResultPanel';
import { ScreenFrame } from '@senior/ScreenFrame';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorText } from '@senior/SeniorText';
import { color, fontStyle, useSenior } from '@senior/theme';
import { errorMessage, isApiError } from '@/api/errors';
import { IS_RELEASE_BUILD, PINNED_API_BASE_URL } from '@/config';
import { keys } from '@/data/queries';
import { addressForRoles, fullPersonName } from '@/features/address';
import { useSession } from '@/hooks';
import { pushPermission, syncPushToken } from '@/push/push';
import type { PushSyncResult } from '@/push/sync';
import { createPublicApi, localProfile, queryClient, session, stepUpSigner } from '@/services';
import { parseActivationInput, resolveApiBaseUrl, type ActivationInput } from '@/session/activation-link';
import { biometricsAvailable, promptBiometrics } from '@/session/biometrics';
import type { SessionSnapshot } from '@/session/controller';
import { isWeakPin } from '@/session/pin';
import { OfficeCall } from '@/ui/OfficeCall';

const t = vi.executive.activation;

type Stage = 'code' | 'scan' | 'checking' | 'pin' | 'pinConfirm' | 'biometric' | 'push' | 'done';

/** App bị tắt giữa các bước kích hoạt thì mở lại đúng bước còn dở. */
function initialStage(s: SessionSnapshot): Stage {
  if (s.status !== 'onboarding') return 'code';
  return s.pinSet ? 'biometric' : 'pin';
}

function devicePlatform(): DevicePlatform {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
}

/**
 * M0 Kích hoạt lần đầu (SPEC 10.2, 11.2). Vào bằng đường dẫn `mihato-exec://activate?token=…&api=…`, quét mã QR,
 * hoặc dán mã. Sau khi máy chủ nhận mã: đặt PIN 6 số, bật sinh trắc học nếu máy có, cho phép thông báo.
 * Khoá công khai để ký nâng quyền gửi kèm lúc kích hoạt (`stepUpPublicKey`).
 */
export default function ActivateScreen() {
  const m = useSenior();
  const params = useLocalSearchParams<{ token?: string; api?: string }>();
  const snapshot = useSession();
  const [stage, setStage] = useState<Stage>(() => initialStage(snapshot));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(() => queryClient.getQueryData<Me>(keys.me) ?? null);
  const [pin, setPin] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [hasBiometrics, setHasBiometrics] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushProblem, setPushProblem] = useState<'denied' | 'noProject' | 'failed' | null>(null);
  const [office, setOffice] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const linkTried = useRef(false);
  const scanned = useRef(false);

  const address = me ? addressForRoles(me.roles) : localProfile.getSnapshot().address;

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
      await localProfile.rememberMe(result.me);
      setMe(result.me);
      setStage('pin');
    } catch (err) {
      setStage('code');
      // Mã sai, đã dùng hoặc hết hạn: máy chủ trả cùng một mã lỗi; nói rõ cách xử lý.
      setError(isApiError(err, 'invalid_credentials') || isApiError(err, 'input_invalid') ? t.codeInvalid : errorMessage(err, localProfile.getSnapshot().address));
    }
  }, []);

  // Mở app bằng đường dẫn kích hoạt: kiểm mã ngay, không bắt người dùng bấm thêm.
  useEffect(() => {
    if (linkTried.current || snapshot.status !== 'signedOut' || !params.token) return;
    linkTried.current = true;
    const input = parseActivationInput(`mihato-exec://activate?token=${encodeURIComponent(params.token)}${params.api ? `&api=${encodeURIComponent(params.api)}` : ''}`);
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
    if (await promptBiometrics(address)) await session.setBiometricsEnabled(true);
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

  const endReason = snapshot.endReason && snapshot.endReason !== 'signed_out' ? t.ended[snapshot.endReason] : null;
  // Sau khi kích hoạt đã biết số Văn phòng: nút Nhờ Văn phòng có mặt ở các bước còn lại.
  const onOffice = me ? () => setOffice(true) : undefined;

  if (office && me) {
    return (
      <ScreenFrame title={vi.executive.office.title} onBack={() => setOffice(false)} testID="screen-activate-office">
        <OfficeCall phone={me.officePhone} address={address} onClose={() => setOffice(false)} />
      </ScreenFrame>
    );
  }

  switch (stage) {
    case 'code':
      return (
        <ScreenFrame title={t.title} footer={<SeniorButton label={t.continue} disabled={code.trim() === ''} onPress={submitCode} testID="activate-continue" />} testID="screen-activate">
          {endReason ? (
            <Notice live testID="activate-ended">
              {endReason}
            </Notice>
          ) : null}
          <SeniorText>{t.intro}</SeniorText>
          <SeniorButton variant="secondary" label={t.scanQr} onPress={() => void openScanner()} testID="activate-scan" />
          <View style={{ gap: m.space.sm }}>
            <SeniorText variant="emphasis" tone="sub">
              {t.enterCode}
            </SeniorText>
            {/* Ô này không có nút Nói: mã kích hoạt là chuỗi ký tự ngẫu nhiên, không đọc thành lời được. */}
            <TextInput
              accessibilityLabel={t.codeLabel}
              value={code}
              onChangeText={(v) => {
                setCode(v);
                setError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              maxFontSizeMultiplier={m.maxFontSizeMultiplier}
              textAlignVertical="top"
              style={[
                {
                  minHeight: m.touch.input * 2,
                  borderRadius: m.radius,
                  borderWidth: m.borderWidth,
                  borderColor: color.border,
                  backgroundColor: color.surface,
                  paddingHorizontal: m.space.cardPadding,
                  paddingVertical: m.space.md,
                  fontSize: m.font.body,
                  lineHeight: lineHeightFor(m.font.body, m.tokens),
                  color: color.text,
                },
                fontStyle('regular'),
              ]}
              testID="activate-code"
            />
            <SeniorText tone="sub">{t.codeHint}</SeniorText>
          </View>
          {error ? (
            <Notice live testID="activate-error">
              {error}
            </Notice>
          ) : null}
        </ScreenFrame>
      );

    case 'scan':
      return (
        <ScreenFrame title={t.scanQr} footer={<SeniorButton variant="secondary" label={t.typeCode} onPress={() => setStage('code')} testID="activate-type-code" />} testID="screen-activate-scan">
          <SeniorText>{t.scanHint}</SeniorText>
          <View style={[styles.camera, { borderRadius: m.radius, borderWidth: m.borderWidth }]}>
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(result) => onScanned(result.data)} />
          </View>
        </ScreenFrame>
      );

    case 'checking':
      return (
        <ScreenFrame title={t.title} testID="screen-activate-checking">
          <LoadingText text={t.checking} />
        </ScreenFrame>
      );

    case 'pin':
    case 'pinConfirm':
      return (
        <ScreenFrame title={stage === 'pin' ? t.pin.title : t.pin.confirmTitle} onOffice={onOffice} testID="screen-activate-pin">
          {me && stage === 'pin' ? <SeniorText variant="emphasis">{fmtExecutive(t.welcome, { người: fullPersonName(me) })}</SeniorText> : null}
          <SeniorText tone="sub">{t.pin.hint}</SeniorText>
          <PinDots length={pin.length} />
          <View style={{ minHeight: m.touch.min, justifyContent: 'center' }}>
            {pinMessage ? (
              <SeniorText weight="semibold" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="pin-message">
                {pinMessage}
              </SeniorText>
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
        </ScreenFrame>
      );

    case 'biometric':
      return (
        <ScreenFrame
          title={t.biometric.title}
          onOffice={onOffice}
          footer={
            hasBiometrics ? (
              <>
                <SeniorButton label={t.biometric.enable} busyLabel={busy ? t.biometric.enable : null} onPress={() => void enableBiometrics()} testID="biometric-enable" />
                <SeniorButton variant="secondary" label={t.biometric.skip} disabled={busy} onPress={() => void afterBiometric()} testID="biometric-skip" />
              </>
            ) : (
              <SeniorButton label={t.continue} disabled={hasBiometrics === null} onPress={() => void afterBiometric()} testID="biometric-continue" />
            )
          }
          testID="screen-activate-biometric"
        >
          <SeniorText>{hasBiometrics === false ? t.biometric.unavailable : t.biometric.body}</SeniorText>
        </ScreenFrame>
      );

    case 'push':
      return (
        <ScreenFrame
          title={t.push.title}
          onOffice={onOffice}
          footer={
            pushProblem === null || pushProblem === 'failed' ? (
              <>
                <SeniorButton label={pushProblem === 'failed' ? t.push.retry : t.push.enable} busyLabel={busy ? t.push.enable : null} onPress={() => void enablePush()} testID="push-enable" />
                <SeniorButton variant="secondary" label={pushProblem === 'failed' ? t.push.continueWithout : t.push.skip} disabled={busy} onPress={() => setStage('done')} testID="push-skip" />
              </>
            ) : (
              <SeniorButton label={t.push.continueWithout} onPress={() => setStage('done')} testID="push-skip" />
            )
          }
          testID="screen-activate-push"
        >
          <SeniorText>{fmtExecutive(t.push.body, {}, address)}</SeniorText>
          {pushProblem ? (
            <Notice live testID="push-problem">
              {fmtExecutive(t.push.problem[pushProblem], {}, address)}
            </Notice>
          ) : null}
        </ScreenFrame>
      );

    case 'done':
      return (
        <ScreenFrame onOffice={onOffice} testID="screen-activate-done">
          <ResultPanel title={t.done.title} body={t.done.body} understoodLabel={t.done.start} onUnderstood={() => session.finishOnboarding()} />
        </ScreenFrame>
      );
  }
}

const styles = StyleSheet.create({
  camera: { aspectRatio: 1, overflow: 'hidden', borderColor: color.border, backgroundColor: color.text },
});
