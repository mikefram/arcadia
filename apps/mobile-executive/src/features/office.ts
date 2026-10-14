/**
 * Số điện thoại chỉ giữ chữ số và dấu cộng đầu, để dựng đường dẫn `tel:` an toàn cho nút Nhờ Văn phòng.
 * Số do quản trị nhập tay nên có thể có khoảng trắng, dấu chấm, dấu gạch, ngoặc: "0243 123 4567", "(024) 3123.4567".
 * Quá ngắn, quá dài hoặc không phải số thì trả null: màn hình nói rõ là chưa có số, không gọi bừa.
 */
export function telUrl(phone: string): string | null {
  const cleaned = phone.trim().replace(/[^\d+]/g, '');
  const digits = cleaned.startsWith('+') ? `+${cleaned.slice(1).replace(/\+/g, '')}` : cleaned.replace(/\+/g, '');
  return /^\+?\d{3,15}$/.test(digits) ? `tel:${digits}` : null;
}

export type OfficeAction = { kind: 'call'; url: string } | { kind: 'screen' };

/**
 * Việc nút Nhờ Văn phòng làm ở mọi màn hình (SPEC 7.2 điều 10, 7.7: "gọi điện thẳng"): có số gọi được thì gọi thẳng
 * (iOS tự hỏi lại trước khi quay số, Android mở trình quay số đã điền sẵn số nên vẫn còn một bước xác nhận của hệ điều hành);
 * chưa có số hoặc số không dùng được thì mở màn hình nói rõ là chưa có số. Nút không bao giờ bị ẩn.
 */
export function officeAction(phone: string | null | undefined): OfficeAction {
  const url = phone ? telUrl(phone) : null;
  return url ? { kind: 'call', url } : { kind: 'screen' };
}
