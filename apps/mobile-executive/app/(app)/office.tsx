import { vi } from '@mihato/i18n';
import { useDisplayPrefs } from '@/hooks';
import { AppScreen, goBack } from '@/ui/AppScreen';
import { OfficeCallActions, OfficeCallBody, useOfficeCall } from '@/ui/OfficeCall';

/**
 * Nhờ Văn phòng (SPEC 7.2 điều 10, 7.7): gọi thẳng số Chánh văn phòng (`me.officePhone`).
 * Chưa có số thì màn hình nói rõ; nút Nhờ Văn phòng không bao giờ bị ẩn. Nút **Gọi ngay** dính ở chân màn hình.
 */
export default function OfficeScreen() {
  const { address, officePhone } = useDisplayPrefs();
  const state = useOfficeCall(officePhone);
  return (
    <AppScreen title={vi.executive.office.title} back footer={<OfficeCallActions state={state} onClose={goBack} />} testID="screen-office">
      <OfficeCallBody state={state} address={address} />
    </AppScreen>
  );
}
