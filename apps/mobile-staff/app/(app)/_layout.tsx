import { Stack } from 'expo-router';
import { color } from '@/ui/theme';

/** Các màn sau khi đã kích hoạt: bốn tab, rồi các màn của một việc xếp chồng lên trên. */
export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { flex: 1, backgroundColor: color.bg } }} />;
}
