import * as ScreenCapture from 'expo-screen-capture';
import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Đặt vào màn có số tiền (S6 Duyệt khi `amountVnd` khác null): trong lúc màn mở, chặn chụp và quay màn hình, và làm ảnh thu nhỏ
 * ở màn đa nhiệm đen (FLAG_SECURE trên Android; iOS che nội dung khi chụp hoặc quay). Rà soát 07/10/2026, staff-8; SPEC 11.2 điều 5.
 * Mỗi màn có khoá riêng nên hai màn chồng lên nhau không tắt nhầm lẫn nhau.
 */
export function ScreenCaptureGuard({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active || Platform.OS === 'web') return;
    const key = 'mihato-staff-amount';
    void ScreenCapture.preventScreenCaptureAsync(key).catch(() => undefined);
    return () => {
      void ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
    };
  }, [active]);
  return null;
}
