import { BeVietnamPro_400Regular } from '@expo-google-fonts/be-vietnam-pro/400Regular';
import { BeVietnamPro_500Medium } from '@expo-google-fonts/be-vietnam-pro/500Medium';
import { BeVietnamPro_600SemiBold } from '@expo-google-fonts/be-vietnam-pro/600SemiBold';
import { BeVietnamPro_700Bold } from '@expo-google-fonts/be-vietnam-pro/700Bold';
import { vi } from '@mihato/i18n';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ScreenFrame } from '@senior/ScreenFrame';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorText } from '@senior/SeniorText';
import { FONT_FILES, SeniorThemeProvider, color, setCustomFontsReady } from '@senior/theme';
import { APP_VERSION } from '@/config';
import { useDisplayPrefs, useSession } from '@/hooks';
import { useAppCovered, useAppLifecycle } from '@/lifecycle';
import { usePushNotifications } from '@/push/push';
import { shouldPersistQuery } from '@/data/persist';
import { QUERY_CACHE_MAX_AGE, queryClient, queryPersister, session } from '@/services';
import { LockScreen } from '@/ui/LockScreen';
import { ReauthHost } from '@/ui/ReauthHost';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * Lớp gốc của app Chủ tịch.
 * - Chưa kích hoạt (hoặc đang ở giữa các bước kích hoạt): chỉ có màn `activate`.
 * - Đã kích hoạt: nhóm `(app)`; khi đang khoá thì M0 Mở khoá phủ lên trên, điều hướng bên dưới vẫn giữ nguyên,
 *   nên chạm thông báo rồi mở khoá là tới đúng màn hình.
 * - Chỉ bản tiến độ gần nhất được lưu xuống máy (`shouldPersistQuery`); bản chép hội thoại thì không.
 */
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    [FONT_FILES.regular]: BeVietnamPro_400Regular,
    [FONT_FILES.medium]: BeVietnamPro_500Medium,
    [FONT_FILES.semibold]: BeVietnamPro_600SemiBold,
    [FONT_FILES.bold]: BeVietnamPro_700Bold,
  });
  // Nạp phông hỏng thì dùng phông hệ thống, không chặn app.
  const fontsSettled = fontsLoaded || fontError !== null;
  if (fontsSettled) setCustomFontsReady(fontsLoaded);

  return (
    <SafeAreaProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: queryPersister, maxAge: QUERY_CACHE_MAX_AGE, buster: APP_VERSION, dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery } }}
      >
        <Shell fontsSettled={fontsSettled} />
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}

/** Mở app mà không đọc được kho an toàn: thử lại, hoặc kích hoạt lại sau một lần xác nhận (kích hoạt lại xoá dữ liệu trên máy). */
function StartupProblem() {
  const t = vi.executive.startup;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <ScreenFrame
      title={t.title}
      footer={
        <>
          <SeniorButton
            label={t.retry}
            busyLabel={busy ? t.retry : null}
            onPress={() => {
              setBusy(true);
              void session.load().finally(() => setBusy(false));
            }}
            testID="startup-retry"
          />
          <SeniorButton
            variant="secondary"
            label={t.reset}
            disabled={busy}
            onPress={() => {
              if (!confirming) setConfirming(true);
              else void session.end('session_expired');
            }}
            testID="startup-reset"
          />
        </>
      }
      testID="screen-startup-problem"
    >
      <SeniorText>{t.body}</SeniorText>
      {confirming ? (
        <SeniorText weight="semibold" accessibilityRole="alert" testID="startup-reset-warning">
          {t.resetWarning}
        </SeniorText>
      ) : null}
    </ScreenFrame>
  );
}

function Shell({ fontsSettled }: { fontsSettled: boolean }) {
  const { status, loadFailed } = useSession();
  const prefs = useDisplayPrefs();
  const covered = useAppCovered();
  useAppLifecycle();

  // Đọc kho an toàn lỗi thì trạng thái ở lại `loading`: vẫn tắt màn chờ và hiện màn thử lại, không kẹt (rà soát 07/10/2026, staff-5).
  const ready = fontsSettled && (status !== 'loading' || loadFailed);
  const active = status === 'locked' || status === 'unlocked';
  usePushNotifications(ready && active);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) return <View style={styles.fill} />;

  if (loadFailed && status === 'loading') {
    return (
      <SeniorThemeProvider profile={prefs.profile} fontScale={prefs.fontScale}>
        <StatusBar style="dark" />
        <StartupProblem />
      </SeniorThemeProvider>
    );
  }

  const locked = status === 'locked';
  return (
    <SeniorThemeProvider profile={prefs.profile} fontScale={prefs.fontScale}>
      <StatusBar style="dark" />
      {/* Mỗi lần chạm vào màn hình là một lần "đang dùng": tính lại 2 phút tự khoá. Không giành quyền xử lý chạm. */}
      <View
        style={styles.fill}
        onStartShouldSetResponderCapture={() => {
          session.noteActivity();
          return false;
        }}
      >
        <View style={[styles.fill, locked && styles.hidden]} accessibilityElementsHidden={locked} importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}>
          <Stack screenOptions={{ headerShown: false, gestureEnabled: false, animation: 'fade', contentStyle: styles.fill }}>
            <Stack.Protected guard={active}>
              <Stack.Screen name="(app)" />
            </Stack.Protected>
            <Stack.Protected guard={!active}>
              <Stack.Screen name="activate" />
            </Stack.Protected>
          </Stack>
        </View>
        {locked ? <LockScreen /> : null}
        <ReauthHost />
        {covered ? (
          <View style={[StyleSheet.absoluteFill, styles.cover]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="privacy-cover">
            <SeniorText variant="screenTitle" tone="primary">
              {vi.common.appName}
            </SeniorText>
          </View>
        ) : null}
      </View>
    </SeniorThemeProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  hidden: { display: 'none' },
  cover: { backgroundColor: color.bg, zIndex: 20, alignItems: 'center', justifyContent: 'center' },
});
