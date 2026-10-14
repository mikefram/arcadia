import { vi } from '@mihato/i18n';
import { useState } from 'react';
import { session } from '@/services';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Screen } from '@/ui/Screen';

const t = vi.staff.startup;

/**
 * Mở app mà không đọc được kho an toàn của máy (rà soát 07/10/2026, staff-5). Trước đây app đứng mãi ở màn chờ,
 * không có nút nào. Giờ: thử lại (lỗi có thể chỉ là tạm thời, ví dụ máy đang khoá), hoặc kích hoạt lại sau một lần xác nhận,
 * vì kích hoạt lại xoá dữ liệu của app trên máy này.
 */
export function StartupProblem() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Screen
      title={t.title}
      footer={
        <>
          <Button
            label={t.retry}
            busy={busy}
            onPress={() => {
              setBusy(true);
              void session.load().finally(() => setBusy(false));
            }}
            testID="startup-retry"
          />
          <Button
            variant="secondary"
            label={t.reset}
            disabled={busy}
            onPress={() => {
              if (!confirming) setConfirming(true);
              else void session.end('session_expired');
            }}
            testID="startup-reset"
          />
        </>
      }
      testID="screen-startup-problem"
    >
      <AppText>{t.body}</AppText>
      {confirming ? (
        <Banner tone="info" live testID="startup-reset-warning">
          {t.resetWarning}
        </Banner>
      ) : null}
    </Screen>
  );
}
