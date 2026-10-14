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
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { APP_VERSION } from '@/config';
import { shouldDehydrateQuery } from '@/features/comments';
import { useSession } from '@/hooks';
import { useAppCovered, useAppLifecycle } from '@/lifecycle';
import { usePushNotifications } from '@/push/push';
import { QUERY_CACHE_MAX_AGE, queryClient, queryPersister } from '@/services';
import { LockScreen } from '@/session/LockScreen';
import { StartupProblem } from '@/session/StartupProblem';
import { AppText } from '@/ui/AppText';
import { FlashHost } from '@/ui/Flash';
import { FONT_FILES, color, setCustomFontsReady } from '@/ui/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * Lớp gốc của app nhân viên.
 * - Chưa kích hoạt (hoặc đang ở giữa các bước kích hoạt): chỉ có màn S0 `activate`.
 * - Đã kích hoạt: nhóm `(app)`; khi đang khoá thì màn khoá phủ lên trên, điều hướng bên dưới vẫn giữ nguyên,
 *   nên chạm thông báo `mihato://step/{id}` rồi mở khoá là tới đúng việc.
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

  const { status, loadFailed } = useSession();
  useAppLifecycle();
  const covered = useAppCovered();

  // Đọc kho an toàn lỗi thì trạng thái ở lại `loading`: vẫn tắt màn chờ và hiện màn thử lại, không kẹt.
  const ready = fontsSettled && (status !== 'loading' || loadFailed);
  const active = status === 'locked' || status === 'unlocked';
  usePushNotifications(ready && active);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) return <View style={styles.fill} />;

  if (loadFailed && status === 'loading') {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <StartupProblem />
      </SafeAreaProvider>
    );
  }

  const locked = status === 'locked';
  return (
    <SafeAreaProvider>
      <PersistQueryClientProvider client={queryClient} persistOptions={{ persister: queryPersister, maxAge: QUERY_CACHE_MAX_AGE, buster: APP_VERSION, dehydrateOptions: { shouldDehydrateQuery } }}>
        <StatusBar style="dark" />
        <View
          style={[styles.fill, locked && styles.hidden]}
          accessibilityElementsHidden={locked}
          importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
        >
          <Stack screenOptions={{ headerShown: false, contentStyle: styles.fill }}>
            <Stack.Protected guard={active}>
              <Stack.Screen name="(app)" />
            </Stack.Protected>
            <Stack.Protected guard={!active}>
              <Stack.Screen name="activate" />
            </Stack.Protected>
          </Stack>
        </View>
        {locked ? <LockScreen /> : null}
        <FlashHost />
        {covered ? (
          <View style={[StyleSheet.absoluteFill, styles.cover]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="privacy-cover">
            <AppText variant="screenTitle" tone="primary">
              {vi.common.appName}
            </AppText>
          </View>
        ) : null}
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  hidden: { display: 'none' },
  cover: { backgroundColor: color.bg, zIndex: 20, alignItems: 'center', justifyContent: 'center' },
});
