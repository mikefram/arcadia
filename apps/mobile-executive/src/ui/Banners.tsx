import type { Me } from '@mihato/domain';
import { fmtExecutive, formatDateFull, formatTimeSpoken, vi } from '@mihato/i18n';
import { Notice } from '@senior/Notice';
import { SeniorText } from '@senior/SeniorText';
import { shortPersonName } from '../features/address';

/**
 * Dòng "Đang ủy quyền cho ông Huy đến ngày …" (SPEC 7.7), hiện ở mọi màn liên quan: Trang chủ, Việc cần quyết,
 * Cài đặt, Ủy quyền. Lấy từ `me.activeDelegations`, chiều người dùng là người ủy quyền.
 */
export function DelegationBanner({ me }: { me: Me | undefined }) {
  if (!me) return null;
  const outgoing = me.activeDelegations.filter((d) => d.active && d.fromUser.id === me.id);
  const incoming = me.activeDelegations.filter((d) => d.active && d.toUser.id === me.id);
  if (outgoing.length === 0 && incoming.length === 0) return null;
  return (
    <Notice testID="delegation-banner">
      {outgoing.map((d) => (
        <SeniorText key={d.id} weight="semibold">
          {fmtExecutive(vi.executive.delegation.banner, { người: shortPersonName(d.toUser), ngày: formatDateFull(d.validTo) })}
        </SeniorText>
      ))}
      {incoming.map((d) => (
        <SeniorText key={d.id} weight="semibold">
          {fmtExecutive(vi.executive.delegation.incoming, { người: shortPersonName(d.fromUser), ngày: formatDateFull(d.validTo) })}
        </SeniorText>
      ))}
    </Notice>
  );
}

/** "Đang không có mạng. Số liệu lúc 9 giờ 15 sáng." (SPEC 6.11): hiện bản lưu gần nhất kèm giờ cập nhật. */
export function OfflineBanner({ online, updatedAt }: { online: boolean; updatedAt: number }) {
  if (online || !updatedAt) return null;
  return (
    <Notice live testID="offline-banner">
      {fmtExecutive(vi.executive.status.offline, { giờ: formatTimeSpoken(updatedAt) })}
    </Notice>
  );
}
