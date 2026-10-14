import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useSession } from '../hooks';
import { PinConfirm } from './PinConfirm';
import { promptBiometrics } from './biometrics';

/**
 * Xác thực lại ngay trên máy trước một việc quan trọng: sinh trắc học nếu đã bật, không thì (hoặc khi người dùng
 * bỏ qua sinh trắc học) nhập PIN của app. `confirm()` trả true khi người dùng đã xác thực xong.
 * Đặt `element` vào cây giao diện của màn hình để hộp nhập PIN hiện được.
 */
export function useReauth(title: string): { confirm: () => Promise<boolean>; element: ReactElement } {
  const { biometricsEnabled, status } = useSession();
  const [visible, setVisible] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    setVisible(false);
    pending.current?.(ok);
    pending.current = null;
  }, []);

  // App bị khoá hoặc phiên kết thúc giữa chừng: đóng hộp nhập PIN, coi như chưa xác thực.
  useEffect(() => {
    if (status !== 'unlocked' && pending.current) settle(false);
  }, [status, settle]);

  const confirm = useCallback(async () => {
    if (biometricsEnabled && (await promptBiometrics(title))) return true;
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setVisible(true);
    });
  }, [biometricsEnabled, title]);

  return {
    confirm,
    element: <PinConfirm visible={visible} title={title} onConfirmed={() => settle(true)} onClose={() => settle(false)} />,
  };
}
