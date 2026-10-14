import { vi } from '@mihato/i18n';
import { useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glyph, type GlyphName } from './Glyph';
import { SeniorText } from './SeniorText';
import { tapFeedback } from './haptics';
import { chromeIsCrowded } from './metrics';
import { color, useSenior } from './theme';

const t = vi.executive.nav;

export type NavTab = 'home' | 'assistant' | 'progress';

/** Trần co giãn của nhãn thanh đáy (các chữ khác co tới `maxFontSizeMultiplier` = 2). */
const NAV_LABEL_MAX_SCALE = 1.5;

const TAB_ICON: Record<NavTab, GlyphName> = { home: 'home', assistant: 'mic', progress: 'progress' };
const TAB_LABEL: Record<NavTab, string> = { home: t.home, assistant: t.assistant, progress: t.progress };

export type ScreenFrameProps = {
  /** tiêu đề màn hình (30sp đậm); bỏ trống khi màn tự vẽ lời chào */
  title?: string;
  children: ReactNode;
  /** nút chính duy nhất và nút phụ, cố định cuối màn hình, phía trên thanh điều hướng */
  footer?: ReactNode;
  /** có thì hiện nút "Quay lại" ở đầu nội dung */
  onBack?: () => void;
  /** nút chữ **Cài đặt** ở góc trên phải; bỏ trống ở màn khoá và màn kích hoạt */
  onSettings?: () => void;
  /** nút **Nhờ Văn phòng** có ở MỌI màn hình (SPEC 7.2 điều 10) */
  onOffice?: () => void;
  /** thanh điều hướng đáy; bỏ trống ở màn khoá và màn kích hoạt */
  nav?: { active: NavTab | null; tabs: readonly NavTab[]; onNavigate: (tab: NavTab) => void };
  /** dải báo tin ngay dưới đầu trang (đang mất mạng, đang ủy quyền) */
  banner?: ReactNode;
  testID?: string;
};

/**
 * Khung của mọi màn hình (SPEC 7.4): góc trên phải luôn có nút chữ **Cài đặt** và nút **Nhờ Văn phòng**;
 * thanh đáy ba nút cao 64dp có chữ và hình: **Trang chủ**, **Trợ lý**, **Tiến độ**. Nút chính nằm cố định cuối màn
 * hình nên luôn trong tầm mắt dù nội dung dài hay cỡ chữ lớn. Chỉ có cuộn dọc, không cử chỉ nào khác.
 */
export function ScreenFrame({ title, children, footer, onBack, onSettings, onOffice, nav, banner, testID }: ScreenFrameProps) {
  const m = useSenior();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // Chiều cao tự nhiên của đầu trang, chân màn hình và thanh đáy; chân màn hình đo ở đâu (dính đáy hay trong nội dung) cũng được
  // vì rộng như nhau, nên không có chuyện nhảy qua lại.
  const [chrome, setChrome] = useState({ header: 0, footer: 0, nav: 0 });
  const measure = (key: 'header' | 'footer' | 'nav') => (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setChrome((prev) => (prev[key] === h ? prev : { ...prev, [key]: h }));
  };
  const crowded = !!footer && chromeIsCrowded(chrome, windowHeight);

  const headerButton = (label: string, onPress: () => void, id: string, icon?: GlyphName, a11y?: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: m.touch.headerButton,
        borderRadius: m.radius,
        borderWidth: m.borderWidth,
        borderColor: color.border,
        backgroundColor: pressed ? color.primaryTint : color.surface,
        paddingHorizontal: m.space.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: m.space.sm,
        flexShrink: 1,
      })}
      testID={id}
    >
      {icon ? <Glyph name={icon} size={Math.round(m.font.caption)} tint={color.primary} /> : null}
      <SeniorText variant="caption" weight="semibold" tone="primary" style={{ flexShrink: 1 }}>
        {label}
      </SeniorText>
    </Pressable>
  );

  const footerEl = footer ? (
    <View
      onLayout={measure('footer')}
      style={{
        paddingHorizontal: m.space.screen,
        paddingTop: m.space.md,
        paddingBottom: nav ? m.space.md : insets.bottom + m.space.md,
        gap: m.space.betweenButtons,
        borderTopWidth: 1,
        borderTopColor: color.hairline,
        backgroundColor: color.bg,
      }}
      testID="screen-footer"
    >
      {footer}
    </View>
  ) : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} testID={testID}>
      <View
        onLayout={measure('header')}
        style={{
          paddingTop: insets.top + m.space.sm,
          paddingBottom: m.space.sm,
          paddingHorizontal: m.space.screen,
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
          gap: m.space.md,
        }}
      >
        {onSettings ? headerButton(t.settings, onSettings, 'header-settings') : null}
        {onOffice ? headerButton(t.askOffice, onOffice, 'header-office', 'phone', vi.executive.office.a11y) : null}
      </View>

      {banner ? <View style={{ paddingHorizontal: m.space.screen, paddingBottom: m.space.sm }}>{banner}</View> : null}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: m.space.screen, paddingTop: m.space.sm, paddingBottom: m.space.screen, gap: m.space.betweenCards }}
        keyboardShouldPersistTaps="handled"
      >
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.back}
            onPress={() => {
              tapFeedback();
              onBack();
            }}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              minHeight: m.touch.min,
              borderRadius: m.radius,
              paddingRight: m.space.md,
              flexDirection: 'row',
              alignItems: 'center',
              gap: m.space.sm,
              backgroundColor: pressed ? color.primaryTint : 'transparent',
            })}
            testID="screen-back"
          >
            <Glyph name="back" size={Math.round(m.font.body)} tint={color.primary} />
            <SeniorText variant="emphasis" tone="primary">
              {t.back}
            </SeniorText>
          </Pressable>
        ) : null}
        {title ? (
          <SeniorText variant="screenTitle" accessibilityRole="header" testID="screen-title">
            {title}
          </SeniorText>
        ) : null}
        {children}
        {crowded ? <View style={{ marginHorizontal: -m.space.screen, marginTop: m.space.md }}>{footerEl}</View> : null}
      </ScrollView>

      {footer && !crowded ? footerEl : null}

      {nav ? (
        <View
          accessibilityRole="tablist"
          onLayout={measure('nav')}
          style={{
            flexDirection: 'row',
            paddingBottom: insets.bottom,
            borderTopWidth: m.borderWidth,
            borderTopColor: color.border,
            backgroundColor: color.surface,
          }}
          testID="nav-bar"
        >
          {nav.tabs.map((tab) => {
            const active = nav.active === tab;
            return (
              <Pressable
                key={tab}
                accessibilityRole="tab"
                accessibilityLabel={TAB_LABEL[tab]}
                accessibilityState={{ selected: active }}
                onPress={() => {
                  tapFeedback();
                  nav.onNavigate(tab);
                }}
                style={({ pressed }) => ({
                  flex: 1,
                  minHeight: m.touch.navBar,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 2,
                  paddingVertical: m.space.xs + 2,
                  paddingHorizontal: m.space.xs,
                  backgroundColor: pressed || active ? color.primaryTint : color.surface,
                  borderTopWidth: 4,
                  borderTopColor: active ? color.gold : 'transparent',
                })}
                testID={`nav-${tab}`}
              >
                <Glyph name={TAB_ICON[tab]} size={Math.round(m.font.caption * 1.2)} tint={active ? color.primary : color.textSub} />
                {/* Ba nút chia đều chiều ngang; chữ "Trang" ở cỡ 200% của Cực lớn rộng hơn một nút, nên nhãn đáy chỉ co tới 1,5 lần. */}
                <SeniorText variant="caption" weight={active ? 'bold' : 'medium'} tone={active ? 'primary' : 'sub'} center maxFontSizeMultiplier={NAV_LABEL_MAX_SCALE}>
                  {TAB_LABEL[tab]}
                </SeniorText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
