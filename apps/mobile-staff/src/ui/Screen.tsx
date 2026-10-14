import { vi } from '@mihato/i18n';
import { router } from 'expo-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from './AppText';
import { Glyph } from './Glyph';
import { color, profile, space } from './theme';

type ScreenProps = {
  title: string;
  /** hiện nút Quay lại ở đầu màn */
  back?: boolean;
  /** dòng nhỏ dưới tiêu đề: ngày hôm nay, giờ cập nhật… */
  subtitle?: string;
  /** phần cố định dưới tiêu đề: dải mất mạng, hai tab… */
  top?: ReactNode;
  /** thanh nút cố định ở đáy: nút chính luôn nằm trong màn hình đầu tiên */
  footer?: ReactNode;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** màn có ô nhập: đẩy nội dung lên khi bàn phím mở */
  keyboard?: boolean;
  /** cuộn tới vị trí này (so với đầu nội dung) khi giá trị đổi; thôi tự cuộn khi người dùng đã tự kéo */
  scrollToY?: number | null;
  testID?: string;
};

/** Khung một màn hình: tiêu đề 22sp đậm, lề 16dp, nền ngà, vùng cuộn và thanh nút đáy. */
export function Screen({ title, back = false, subtitle, top, footer, children, refreshing, onRefresh, keyboard = false, scrollToY = null, testID }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const userScrolled = useRef(false);
  useEffect(() => {
    if (scrollToY !== null && !userScrolled.current) scroll.current?.scrollTo({ y: Math.max(0, scrollToY - space.sm), animated: false });
  }, [scrollToY]);
  const body = (
    <>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={vi.common.actions.back}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            hitSlop={8}
            style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
            testID="nav-back"
          >
            <Glyph name="back" size={18} tint={color.primary} />
          </Pressable>
        ) : null}
        <View style={styles.titles}>
          <AppText variant="screenTitle" accessibilityRole="header">
            {title}
          </AppText>
          {subtitle ? (
            <AppText variant="caption" tone="sub">
              {subtitle}
            </AppText>
          ) : null}
        </View>
      </View>
      {top}
      <ScrollView
        ref={scroll}
        onScrollBeginDrag={() => {
          userScrolled.current = true;
        }}
        style={styles.scroll}
        contentContainerStyle={[styles.content, !footer && { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} tintColor={color.primary} colors={[color.primary]} /> : undefined}
      >
        {children}
      </ScrollView>
      {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>{footer}</View> : null}
    </>
  );

  return keyboard ? (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined} testID={testID}>
      {body}
    </KeyboardAvoidingView>
  ) : (
    <View style={styles.root} testID={testID}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: profile.space.screen,
    paddingBottom: space.md,
  },
  back: {
    width: profile.touch.min,
    height: profile.touch.min,
    marginLeft: -space.md,
    marginTop: -space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: profile.touch.min / 2,
  },
  backPressed: { backgroundColor: color.primaryTint },
  titles: { flex: 1, gap: 2 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: profile.space.screen, paddingBottom: space.lg, gap: profile.space.betweenCards },
  footer: {
    paddingHorizontal: profile.space.screen,
    paddingTop: space.md,
    gap: profile.space.betweenButtons,
    backgroundColor: color.bg,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
  },
});
