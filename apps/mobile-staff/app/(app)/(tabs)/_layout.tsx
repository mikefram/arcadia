import { fmt, vi } from '@mihato/i18n';
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, View } from 'react-native';
import { useMe, useUnreadCount } from '@/data/queries';
import { AppText } from '@/ui/AppText';
import { Glyph, type GlyphName } from '@/ui/Glyph';
import { color, profile, space } from '@/ui/theme';

const t = vi.staff.nav;

const TABS: Record<string, { label: string; glyph: GlyphName }> = {
  index: { label: t.myWork, glyph: 'work' },
  notifications: { label: t.notifications, glyph: 'bell' },
  team: { label: t.team, glyph: 'group' },
  me: { label: t.me, glyph: 'person' },
};

/**
 * Thanh điều hướng đáy: mỗi mục có hình và chữ, cao 56dp. Mục đang mở có vạch xanh phía trên và chữ đậm,
 * không chỉ khác màu. "Nhóm của tôi" chỉ hiện với trưởng đơn vị (SPEC 8.2 S8).
 */
function TabBar({ state, navigation, insets }: BottomTabBarProps) {
  const me = useMe();
  const unread = useUnreadCount();
  const isUnitHead = me.data?.isUnitHead === true;

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom }]} accessibilityRole="tablist">
      {state.routes.map((route, index) => {
        const tab = TABS[route.name];
        if (!tab || (route.name === 'team' && !isUnitHead)) return null;
        const focused = state.index === index;
        const badge = route.name === 'notifications' && unread > 0 ? unread : 0;
        const label = badge > 0 ? `${tab.label}, ${fmt(t.unreadBadge, { n: badge })}` : tab.label;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: focused }}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
            }}
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
            testID={`tab-${route.name}`}
          >
            <View style={[styles.indicator, focused && styles.indicatorOn]} />
            <View>
              <Glyph name={tab.glyph} size={20} tint={focused ? color.primary : color.textSub} />
              {badge > 0 ? (
                <View style={styles.badge}>
                  <AppText variant="caption" weight="bold" tone="onPrimary" maxFontSizeMultiplier={1.2} style={styles.badgeText}>
                    {badge > 99 ? '99+' : String(badge)}
                  </AppText>
                </View>
              ) : null}
            </View>
            <AppText variant="caption" weight={focused ? 'bold' : 'medium'} tone={focused ? 'primary' : 'sub'} numberOfLines={2} maxFontSizeMultiplier={1.3} style={styles.label}>
              {tab.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg } }}>
      <Tabs.Screen name="index" options={{ title: t.myWork }} />
      <Tabs.Screen name="notifications" options={{ title: t.notifications }} />
      <Tabs.Screen name="team" options={{ title: t.team }} />
      <Tabs.Screen name="me" options={{ title: t.me }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: color.surface,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
  },
  item: {
    flex: 1,
    minHeight: profile.touch.navBar,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingBottom: space.xs + 2,
    paddingHorizontal: 2,
  },
  itemPressed: { backgroundColor: color.primaryTint },
  indicator: { alignSelf: 'stretch', height: 3, marginHorizontal: space.md, marginBottom: space.xs + 2, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  indicatorOn: { backgroundColor: color.primary },
  label: { textAlign: 'center' },
  badge: {
    position: 'absolute',
    top: -6,
    left: 12,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 5,
    borderRadius: 11,
    backgroundColor: color.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { lineHeight: 18 },
});
