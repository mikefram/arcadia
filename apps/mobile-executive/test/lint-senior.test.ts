import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIN_FONT_SIZE, lintProject, lintSource, lintTokens } from '../scripts/lint-senior';

/** Lint tự viết của app Chủ tịch (SPEC 7.8): mỗi luật có mẫu sai bị bắt và mẫu đúng được cho qua. */
const rules = (code: string, file = 'mau.tsx') => lintSource(file, code).map((f) => f.rule);

describe('luật font-size: không có chữ dưới 18', () => {
  it('bắt số viết trực tiếp dưới 18, trong đối tượng kiểu và trong thuộc tính JSX', () => {
    expect(rules('const s = { fontSize: 14 };')).toEqual(['font-size']);
    expect(rules('const s = StyleSheet.create({ a: { fontSize: 17.5, color: "red" } });')).toEqual(['font-size']);
    expect(rules('const x = <Icon fontSize={12} />;')).toEqual(['font-size']);
    expect(lintSource('mau.tsx', '\nconst s = { fontSize: 16 };')[0]).toMatchObject({ line: 2, rule: 'font-size' });
  });

  it('bắt cỡ chữ lấy thẳng từ hồ sơ standard, và phép tính làm chữ nhỏ đi', () => {
    expect(rules('const s = { fontSize: profiles.standard.font.caption };')).toEqual(['font-size']);
    expect(rules('const s = { fontSize: m.font.body * 0.8 };')).toEqual(['font-size']);
    expect(rules('const s = { fontSize: m.font.body - 4 };')).toEqual(['font-size']);
    expect(rules('const s = { fontSize: size / 2 };')).toEqual(['font-size']);
  });

  it('cho qua số từ 18 trở lên, cỡ chữ từ useSenior(), và phép nhân làm chữ lớn lên', () => {
    expect(MIN_FONT_SIZE).toBe(18);
    expect(rules('const s = { fontSize: 18 };')).toEqual([]);
    expect(rules('const s = { fontSize: 30 };')).toEqual([]);
    expect(rules('const s = { fontSize: m.font.body };')).toEqual([]);
    expect(rules('const s = { fontSize: m.font.body * webFontScale(2) };')).toEqual([]);
    expect(rules('const s = { fontSize: size, lineHeight: 12 };')).toEqual([]);
  });

  it('token của hồ sơ senior đạt ở mọi mức cỡ chữ', () => {
    expect(lintTokens()).toEqual([]);
  });
});

describe('luật a11y: nút phải có nhãn và vai trò', () => {
  it('bắt Pressable và TouchableOpacity thiếu accessibilityLabel hoặc accessibilityRole', () => {
    expect(rules('const x = <Pressable onPress={go}><Text>Gửi</Text></Pressable>;')).toEqual(['a11y', 'a11y']);
    expect(rules('const x = <Pressable accessibilityRole="button" onPress={go} />;')).toEqual(['a11y']);
    expect(rules('const x = <TouchableOpacity accessibilityLabel="Gửi" onPress={go} />;')).toEqual(['a11y']);
    expect(rules('const x = <RN.Pressable onPress={go} />;')).toEqual(['a11y', 'a11y']);
  });

  it('thuộc tính trải {...props} không được tính là có nhãn', () => {
    expect(rules('const x = <Pressable {...rest} />;')).toEqual(['a11y', 'a11y']);
  });

  it('cho qua khi đủ cả hai', () => {
    expect(rules('const x = <Pressable accessibilityRole="button" accessibilityLabel="Đồng ý gửi" onPress={go} />;')).toEqual([]);
    expect(rules('const x = <View><Text>không phải nút</Text></View>;')).toEqual([]);
  });
});

describe('luật no-toast: không có gì tự biến mất', () => {
  it('bắt thư viện toast, snackbar và ToastAndroid', () => {
    expect(rules("import Toast from 'react-native-toast-message';")).toEqual(['no-toast']);
    expect(rules("import { Snackbar } from 'react-native-snackbar';")).toEqual(['no-toast']);
    expect(rules("import { toast } from 'sonner-native/toast';")).toEqual(['no-toast']);
    expect(rules("import { ToastAndroid, View } from 'react-native';")).toEqual(['no-toast']);
  });
  it('cho qua thư viện thường', () => {
    expect(rules("import { View, Text, ScrollView } from 'react-native';")).toEqual([]);
  });
});

describe('luật no-gesture: chỉ cuộn được dùng vuốt', () => {
  it('bắt bộ nhận cử chỉ: pan, long press, pinch, swipe', () => {
    expect(rules("import { PanGestureHandler } from 'react-native-gesture-handler';")).toEqual(['no-gesture']);
    expect(rules("import { Gesture, GestureDetector } from 'react-native-gesture-handler';")).toEqual(['no-gesture', 'no-gesture']);
    expect(rules("import Swipeable from 'react-native-gesture-handler/Swipeable';")).toEqual(['no-gesture']);
    expect(rules("import { PanResponder } from 'react-native';")).toEqual(['no-gesture']);
  });

  it('bắt nhấn giữ, chạm đúp, kéo để làm mới, lật trang bằng vuốt', () => {
    expect(rules('const x = <Pressable accessibilityRole="button" accessibilityLabel="a" onLongPress={hold} />;')).toEqual(['no-gesture']);
    expect(rules('const x = <View onResponderMove={drag} />;')).toEqual(['no-gesture']);
    expect(rules('const x = <ScrollView pagingEnabled />;')).toEqual(['no-gesture']);
    expect(rules('const x = <FlatList onRefresh={reload} refreshing={false} />;')).toEqual(['no-gesture']);
    expect(rules("import { RefreshControl } from 'react-native';")).toEqual(['no-gesture']);
  });

  it('cho qua cuộn và một chạm', () => {
    expect(rules("import { ScrollView, GestureHandlerRootView } from 'react-native-gesture-handler';")).toEqual([]);
    expect(rules('const x = <ScrollView keyboardShouldPersistTaps="handled"><Pressable accessibilityRole="button" accessibilityLabel="a" onPress={go} /></ScrollView>;')).toEqual([]);
  });
});

describe('luật no-floating: không cửa sổ nổi', () => {
  it('bắt Modal và Alert', () => {
    expect(rules("import { Modal } from 'react-native';")).toEqual(['no-floating']);
    expect(rules("import { Alert, View } from 'react-native';")).toEqual(['no-floating']);
  });
});

describe('mã nguồn của app', () => {
  it('toàn bộ app/, components/, src/ đạt mọi luật', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const { files, findings } = lintProject(root);
    expect(files).toBeGreaterThan(40);
    expect(findings).toEqual([]);
    // Quét mọi tệp của app nên chậm khi cả bộ test chạy song song trên máy tải cao (đã hết 5 giây mặc định một lần): cho thời gian chờ riêng.
  }, 30_000);
});
