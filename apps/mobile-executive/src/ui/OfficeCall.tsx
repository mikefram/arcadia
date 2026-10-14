import { fmtExecutive, vi } from '@mihato/i18n';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Notice } from '@senior/Notice';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorText } from '@senior/SeniorText';
import { useSenior } from '@senior/theme';
import { telUrl } from '../features/office';

const t = vi.executive.office;

/**
 * Trạng thái của nút Nhờ Văn phòng: có số gọi được hay chưa, gọi hỏng hay không. Dùng chung cho phần chữ
 * (`OfficeCallBody`) và phần nút (`OfficeCallActions`), để nút có thể dính ở chân màn hình.
 */
export function useOfficeCall(phone: string | null) {
  const [failed, setFailed] = useState(false);
  const url = phone ? telUrl(phone) : null;
  const call = () => {
    if (!url) return;
    setFailed(false);
    Linking.openURL(url).catch(() => setFailed(true));
  };
  return { phone, url, failed, call };
}
export type OfficeCallState = ReturnType<typeof useOfficeCall>;

/** Phần chữ: chưa có số thì nói rõ; có số thì hiện số điện thoại. */
export function OfficeCallBody({ state, address }: { state: OfficeCallState; address: string }) {
  const m = useSenior();
  if (!state.phone || !state.url) {
    return (
      <View style={{ gap: m.space.betweenCards }} testID="office-no-phone">
        <Notice>{fmtExecutive(t.noPhone, {}, address)}</Notice>
      </View>
    );
  }
  return (
    <View style={{ gap: m.space.betweenCards }} testID="office-call">
      <SeniorText>{t.body}</SeniorText>
      <SeniorText variant="cardTitle" testID="office-phone">
        {fmtExecutive(t.phone, { n: state.phone })}
      </SeniorText>
      {state.failed ? <Notice live>{fmtExecutive(t.callFailed, {}, address)}</Notice> : null}
    </View>
  );
}

/** Phần nút: **Gọi ngay** (nút chính) và **Chưa gọi**; chưa có số thì chỉ có **Đã rõ**. */
export function OfficeCallActions({ state, onClose }: { state: OfficeCallState; onClose: () => void }) {
  if (!state.phone || !state.url) return <SeniorButton label={vi.executive.nav.understood} onPress={onClose} testID="office-understood" />;
  return (
    <>
      <SeniorButton icon="phone" label={t.call} onPress={state.call} testID="office-call-now" />
      <SeniorButton variant="secondary" label={t.notNow} onPress={onClose} testID="office-not-now" />
    </>
  );
}

/**
 * Nhờ Văn phòng (SPEC 7.2 điều 10, 7.7): gọi thẳng số Chánh văn phòng do quản trị cấu hình.
 * Chưa có số thì nói rõ, không ẩn nút. Bản gộp chữ và nút, dùng ở màn khoá và màn kích hoạt;
 * màn Nhờ Văn phòng riêng dùng hai phần để đặt nút ở chân màn hình.
 */
export function OfficeCall({ phone, address, onClose }: { phone: string | null; address: string; onClose: () => void }) {
  const m = useSenior();
  const state = useOfficeCall(phone);
  return (
    <View style={{ gap: m.space.betweenCards }}>
      <OfficeCallBody state={state} address={address} />
      <OfficeCallActions state={state} onClose={onClose} />
    </View>
  );
}
