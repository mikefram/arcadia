import { Stack } from 'expo-router';
import { color } from '@senior/theme';

/**
 * Các màn sau khi đã kích hoạt, xếp chồng trên Trang chủ. Không có cử chỉ vuốt để quay lại (SPEC 7.6):
 * quay lại bằng nút chữ "Quay lại" hoặc ba nút ở thanh đáy.
 */
export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false, animation: 'fade', contentStyle: { flex: 1, backgroundColor: color.bg } }} />;
}
