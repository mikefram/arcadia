import { vi } from '@mihato/i18n';
import { NoticeContent } from '@/features/NoticeContent';
import { Screen } from '@/ui/Screen';

/** S9, mục "Hệ thống ghi nhận gì về tôi" (SPEC 11.7 [QUYẾT ĐỊNH]): xem lại đoạn đã đọc lúc kích hoạt. */
export default function PrivacyScreen() {
  return (
    <Screen title={vi.staff.me.whatIsRecorded} back testID="screen-privacy">
      <NoticeContent />
    </Screen>
  );
}
