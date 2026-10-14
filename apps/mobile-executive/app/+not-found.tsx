import { fmtExecutive, vi } from '@mihato/i18n';
import { router } from 'expo-router';
import { Notice } from '@senior/Notice';
import { ScreenFrame } from '@senior/ScreenFrame';
import { SeniorButton } from '@senior/SeniorButton';
import { useDisplayPrefs } from '@/hooks';

/** Đường dẫn lạ: nói rõ và cho về Trang chủ. */
export default function NotFoundScreen() {
  const { address } = useDisplayPrefs();
  return (
    <ScreenFrame footer={<SeniorButton label={vi.executive.nav.home} onPress={() => router.replace('/')} testID="not-found-home" />} testID="screen-not-found">
      <Notice>{fmtExecutive(vi.errors.executive.not_found, {}, address)}</Notice>
    </ScreenFrame>
  );
}
