import { router, usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { Linking } from 'react-native';
import { ScreenFrame, type NavTab } from '@senior/ScreenFrame';
import { officeAction } from '../features/office';
import { useDisplayPrefs } from '../hooks';

const TAB_PATH: Record<NavTab, '/' | '/assistant' | '/progress'> = { home: '/', assistant: '/assistant', progress: '/progress' };

/** Về một trong ba màn gốc. Luôn rút chồng màn hình về Trang chủ trước, để nút Quay lại không dẫn vòng. */
export function goTab(tab: NavTab): void {
  router.dismissTo('/');
  if (tab !== 'home') router.push(TAB_PATH[tab]);
}

export function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export type AppScreenProps = {
  title?: string;
  /** màn gốc đang mở, để tô nút tương ứng ở thanh đáy */
  tab?: NavTab | null;
  /** màn con: hiện nút "Quay lại"; truyền hàm để tự xử lý (ví dụ thoát bước nhập lý do) */
  back?: boolean | (() => void);
  footer?: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
  testID?: string;
};

/**
 * Khung màn hình đã nối với điều hướng: nút chữ **Cài đặt** và **Nhờ Văn phòng** ở mọi màn hình, thanh đáy
 * **Trang chủ**, **Trợ lý**, **Tiến độ**. Tổ chức tắt AI thì ẩn nút Trợ lý; các nút khác giữ nguyên (SPEC 11.7).
 */
export function AppScreen({ title, tab = null, back = false, footer, banner, children, testID }: AppScreenProps) {
  const { assistantEnabled, officePhone } = useDisplayPrefs();
  const pathname = usePathname();
  const tabs: NavTab[] = assistantEnabled ? ['home', 'assistant', 'progress'] : ['home', 'progress'];
  return (
    <ScreenFrame
      title={title}
      footer={footer}
      banner={banner}
      onBack={back === false ? undefined : typeof back === 'function' ? back : goBack}
      onSettings={() => {
        if (pathname !== '/settings') router.push('/settings');
      }}
      onOffice={() => {
        const action = officeAction(officePhone);
        const explain = () => {
          if (pathname !== '/office') router.push('/office');
        };
        if (action.kind === 'screen') return explain();
        // Gọi thẳng; máy không gọi được (máy tính bảng không có SIM…) thì sang màn hình giải thích và hiện "Gọi không được".
        Linking.openURL(action.url).catch(explain);
      }}
      nav={{
        active: tab,
        tabs,
        onNavigate: (next) => {
          if (next !== tab) goTab(next);
        },
      }}
      testID={testID}
    >
      {children}
    </ScreenFrame>
  );
}
