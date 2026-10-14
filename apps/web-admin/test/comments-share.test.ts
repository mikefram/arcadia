import { ApiError } from '@mihato/api-client';
import { COMMENT_MAX, type PersonRef } from '@mihato/domain';
import { findBannedWords, vi } from '@mihato/i18n';
import { describe, expect, it } from 'vitest';
import { authorLabel, clampComment, commentTime, composerState, deleteErrorMessage, nextAttempt, sendErrorMessage, shouldReuseKey } from '../src/features/runs/comments-model';
import { accessIds, isRetryableShareError, orderAccess, roleLabel, shareErrorMessage, shareErrorNeedsRefresh } from '../src/features/runs/share-model';
import { canResetTotp, needsStepUp, resetDoneMessage, resetErrorMessage, stepUpErrorMessage, stepUpSecretError } from '../src/features/org/totp-reset-model';
import { codeMessage, errorMessage, problemFields } from '../src/lib/errors';

const person = (id: string, fullName: string, givenName: string): PersonRef => ({ id, fullName, givenName, honorific: null });
const lan = person('u-lan', 'Nguyễn Thu Lan', 'Lan');
const an = person('u-an', 'Trần Văn An', 'An');
const binh = person('u-binh', 'Lê Thị Bình', 'Bình');
const duc = person('u-duc', 'Phạm Minh Đức', 'Đức');
const chi = person('u-chi', 'Vũ Kim Chi', 'Chi');
const AT = '2026-10-07T04:00:00.000Z';

function leaves(node: unknown, path: string, out: { path: string; value: string }[] = []): { path: string; value: string }[] {
  if (typeof node === 'string') out.push({ path, value: node });
  else if (Array.isArray(node)) node.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) leaves(v, `${path}.${k}`, out);
  return out;
}

describe('bình luận: cắt độ dài và khoá nút gửi', () => {
  it('cắt đúng 4000 ký tự, giữ nguyên chuỗi ngắn hơn', () => {
    expect(COMMENT_MAX).toBe(4000);
    expect(clampComment('a'.repeat(4000))).toHaveLength(4000);
    expect(clampComment('a'.repeat(4001))).toHaveLength(4000);
    expect(clampComment('a'.repeat(9000))).toHaveLength(4000);
    expect(clampComment('Xin chào')).toBe('Xin chào');
  });

  it('không cắt đôi một ký tự ngoài BMP (cặp thay thế)', () => {
    const text = `${'a'.repeat(3999)}\u{1F600}`;
    const cut = clampComment(text);
    expect(cut).toBe('a'.repeat(3999));
    expect(cut.charCodeAt(cut.length - 1)).toBe(97);
  });

  it('nút gửi: khoá khi trống, chỉ có khoảng trắng, đang gửi, không được phép viết hoặc quá dài', () => {
    const ok = { sending: false, canComment: true };
    expect(composerState('', ok).canSend).toBe(false);
    expect(composerState('   \n  ', ok).canSend).toBe(false);
    expect(composerState('Đã nhận', ok).canSend).toBe(true);
    expect(composerState('Đã nhận', { sending: true, canComment: true }).canSend).toBe(false);
    expect(composerState('Đã nhận', { sending: false, canComment: false }).canSend).toBe(false);
    expect(composerState('a'.repeat(4001), ok)).toMatchObject({ tooLong: true, canSend: false });
    expect(composerState('a'.repeat(4000), ok)).toMatchObject({ tooLong: false, canSend: true });
  });

  it('nút gửi với tệp đính kèm: chỉ có tệp vẫn gửi được; tệp đang tải hoặc quá 5 tệp thì khoá', () => {
    const ok = { sending: false, canComment: true };
    expect(composerState('', { ...ok, files: 1 }).canSend).toBe(true);
    expect(composerState('   ', { ...ok, files: 2 }).canSend).toBe(true);
    expect(composerState('', { ...ok, files: 0 }).canSend).toBe(false);
    expect(composerState('Đã nhận', { ...ok, files: 1, filesBusy: true }).canSend).toBe(false);
    expect(composerState('', { ...ok, files: 5 }).canSend).toBe(true);
    expect(composerState('', { ...ok, files: 6 }).canSend).toBe(false);
    expect(composerState('', { sending: false, canComment: false, files: 1 }).canSend).toBe(false);
  });

  it('nội dung gửi đã bỏ khoảng trắng hai đầu, số ký tự đếm cả khoảng trắng', () => {
    const s = composerState('  xin chào  ', { sending: false, canComment: true });
    expect(s.body).toBe('xin chào');
    expect(s.length).toBe(12);
  });
});

describe('bình luận: giờ và tên tác giả', () => {
  it('giờ theo múi giờ Việt Nam (UTC+7), không theo máy người xem', () => {
    expect(commentTime('2026-10-07T04:00:00.000Z')).toBe('07/10/2026 11:00');
    expect(commentTime('2026-10-07T17:30:00.000Z')).toBe('08/10/2026 00:30');
  });

  it('bình luận của mình có "(bạn)", của người khác thì không', () => {
    expect(authorLabel({ author: lan, mine: true }, 'chị Lan')).toBe('chị Lan (bạn)');
    expect(authorLabel({ author: an, mine: false }, 'anh An')).toBe('anh An');
  });
});

describe('bình luận: gửi lại giữ cùng khoá chống gửi trùng', () => {
  let n = 0;
  const makeKey = () => `khoa-${(n += 1)}`;

  it('cùng nội dung thì giữ khoá; nội dung khác thì khoá mới', () => {
    n = 0;
    const first = nextAttempt(null, 'Đã nhận', makeKey);
    expect(first).toEqual({ key: 'khoa-1', body: 'Đã nhận' });
    expect(nextAttempt(first, 'Đã nhận', makeKey)).toBe(first);
    expect(nextAttempt(first, 'Đã nhận, sẽ làm', makeKey)).toEqual({ key: 'khoa-2', body: 'Đã nhận, sẽ làm' });
  });

  it('lỗi mạng, 5xx và "đang xử lý" giữ khoá; lỗi 4xx đổi khoá', () => {
    expect(shouldReuseKey(new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldReuseKey(new ApiError('internal_error'))).toBe(true);
    expect(shouldReuseKey(new ApiError('request_in_progress'))).toBe(true);
    expect(shouldReuseKey(new ApiError('rate_limited'))).toBe(false);
    expect(shouldReuseKey(new ApiError('forbidden'))).toBe(false);
    expect(shouldReuseKey(new ApiError('not_found'))).toBe(false);
    expect(shouldReuseKey(new ApiError('input_invalid'))).toBe(false);
  });
});

describe('bình luận: câu báo lỗi', () => {
  it('403, 429, 404 có câu riêng; mạng và lỗi khác dùng câu chung của khung', () => {
    expect(sendErrorMessage(new ApiError('forbidden'))).toContain(vi.admin.runs.comments.forbidden);
    expect(sendErrorMessage(new ApiError('rate_limited'))).toContain(vi.admin.runs.comments.rateLimited);
    expect(sendErrorMessage(new ApiError('not_found'))).toContain(vi.admin.runs.comments.notFound);
    expect(sendErrorMessage(new TypeError('x'))).toContain(vi.admin.shell.errors.network);
    expect(sendErrorMessage(new ApiError('internal_error'))).toContain('Chưa gửi được bình luận.');
    expect(deleteErrorMessage(new ApiError('not_found'))).toContain('Chưa xoá được bình luận.');
  });

  it('không hiện `detail` của máy chủ', () => {
    const err = new ApiError('forbidden', { detail: 'user abc không có quyền' });
    expect(sendErrorMessage(err)).not.toContain('abc');
  });
});

describe('chia sẻ: sắp xếp và hiển thị danh sách', () => {
  const data = {
    fixed: [
      { person: duc, role: 'participant' as const },
      { person: lan, role: 'owner' as const },
      { person: an, role: 'participant' as const },
    ],
    shares: [
      { person: chi, role: 'viewer' as const, grantedBy: lan, createdAt: AT },
      { person: binh, role: 'viewer' as const, grantedBy: lan, createdAt: AT },
      { person: person('u-tu', 'Hồ Anh Tú', 'Tú'), role: 'commenter' as const, grantedBy: null, createdAt: AT },
    ],
  };

  it('cố định trước (chủ sở hữu, rồi người tham gia theo tên), rồi người được chia sẻ (Bình luận trước Xem, theo tên)', () => {
    const rows = orderAccess(data);
    expect(rows.map((r) => `${r.kind}:${r.role}:${r.person.givenName}`)).toEqual([
      'fixed:owner:Lan',
      'fixed:participant:An',
      'fixed:participant:Đức',
      'shared:commenter:Tú',
      'shared:viewer:Bình',
      'shared:viewer:Chi',
    ]);
  });

  it('xếp tên có dấu theo thứ tự chữ cái tiếng Việt (Đ sau D)', () => {
    const rows = orderAccess({ fixed: [], shares: [duc, person('u-d', 'Hoàng Văn Dũng', 'Dũng'), an].map((p) => ({ person: p, role: 'viewer' as const, grantedBy: null, createdAt: AT })) });
    expect(rows.map((r) => r.person.givenName)).toEqual(['An', 'Dũng', 'Đức']);
  });

  it('không đổi dữ liệu gốc; danh sách trống cho ra mảng trống', () => {
    const copy = JSON.stringify(data);
    orderAccess(data);
    expect(JSON.stringify(data)).toBe(copy);
    expect(orderAccess({ fixed: [], shares: [] })).toEqual([]);
  });

  it('accessIds gom mọi người đã có quyền, để ô tìm không gợi ý lại', () => {
    expect(accessIds(data).sort()).toEqual(['u-an', 'u-binh', 'u-chi', 'u-duc', 'u-lan', 'u-tu'].sort());
  });

  it('nhãn mức: chủ sở hữu, người tham gia, xem, bình luận', () => {
    expect(roleLabel('owner')).toBe('Chủ sở hữu');
    expect(roleLabel('participant')).toBe('Người tham gia');
    expect(roleLabel('viewer')).toBe('Xem');
    expect(roleLabel('commenter')).toBe('Bình luận');
  });
});

describe('chia sẻ: mã lỗi con sang câu tiếng Việt', () => {
  const sub = (code: string) => new ApiError('input_invalid', { errors: [{ path: 'params.userId', code }] });

  it('ba mã con 422 có câu riêng, khác câu chung của input_invalid', () => {
    for (const code of ['already_has_access', 'cannot_remove_participant', 'user_unavailable']) {
      const text = errorMessage(sub(code));
      expect(text, code).not.toBe(codeMessage('input_invalid'));
      expect(shareErrorMessage(sub(code)), code).toContain(text);
    }
    expect(errorMessage(sub('already_has_access'))).toContain('đã có quyền truy cập');
    expect(errorMessage(sub('cannot_remove_participant'))).toContain('không gỡ được');
    expect(errorMessage(sub('user_unavailable'))).toContain('vô hiệu hoá');
  });

  it('403 nói không được quản lý chia sẻ, 404 nói không tìm thấy người hoặc lượt chạy', () => {
    expect(shareErrorMessage(new ApiError('forbidden'))).toContain(vi.admin.runs.share.forbidden);
    expect(shareErrorMessage(new ApiError('not_found'))).toContain(vi.admin.runs.share.peopleNotFound);
  });

  it('các mã con khác đã thêm vào bảng: sổ đã cấp số, nội dung quá dài, hạn quá gần', () => {
    const conflict = new ApiError('state_conflict', { errors: [{ path: 'body.resetPolicy', code: 'register_has_numbers' }] });
    expect(problemFields(conflict)).toEqual([{ path: 'body.resetPolicy', code: 'register_has_numbers' }]);
    expect(errorMessage(conflict)).toContain('đã cấp số');
    expect(errorMessage(new ApiError('input_invalid', { errors: [{ path: 'body.body', code: 'too_long' }] }))).toBe('Nội dung dài hơn mức cho phép.');
    expect(errorMessage(new ApiError('input_invalid', { errors: [{ path: 'inputs.han', code: 'target_too_soon' }] }))).toContain('3 ngày làm việc');
    // 409 không kèm mã con vẫn là câu chung của state_conflict
    expect(errorMessage(new ApiError('state_conflict'))).toBe(codeMessage('state_conflict'));
  });

  it('lỗi nào thử lại được, lỗi nào cần làm mới danh sách', () => {
    expect(isRetryableShareError(new TypeError('x'))).toBe(true);
    expect(isRetryableShareError(new ApiError('internal_error'))).toBe(true);
    expect(isRetryableShareError(new ApiError('rate_limited'))).toBe(true);
    expect(isRetryableShareError(new ApiError('forbidden'))).toBe(false);
    expect(isRetryableShareError(sub('already_has_access'))).toBe(false);
    expect(shareErrorNeedsRefresh(sub('already_has_access'))).toBe(true);
    expect(shareErrorNeedsRefresh(new ApiError('not_found'))).toBe(true);
    expect(shareErrorNeedsRefresh(new TypeError('x'))).toBe(false);
    expect(shareErrorNeedsRefresh(new ApiError('internal_error'))).toBe(false);
  });
});

describe('đặt lại TOTP', () => {
  it('nút chỉ hiện cho người có quyền, ở người đã bật TOTP, không bao giờ ở chính mình', () => {
    const user = { id: 'u-an', mfaEnabled: true };
    expect(canResetTotp({ canManage: true, meId: 'u-lan', user })).toBe(true);
    expect(canResetTotp({ canManage: false, meId: 'u-lan', user })).toBe(false);
    expect(canResetTotp({ canManage: true, meId: 'u-an', user })).toBe(false);
    expect(canResetTotp({ canManage: true, meId: 'u-lan', user: { ...user, mfaEnabled: false } })).toBe(false);
  });

  it('ô xác nhận danh tính: đúng 6 chữ số khi dùng TOTP, không rỗng khi dùng mật khẩu', () => {
    expect(stepUpSecretError('123456', true)).toBeNull();
    expect(stepUpSecretError('12345', true)).toBe(vi.admin.runs.myTasks.stepUp.totpInvalid);
    expect(stepUpSecretError('12345a', true)).not.toBeNull();
    expect(stepUpSecretError('matkhau', false)).toBeNull();
    expect(stepUpSecretError('', false)).toBe(vi.admin.runs.myTasks.stepUp.passwordRequired);
  });

  it('câu báo lỗi: tự đặt cho mình (403), không thấy người (404), tài khoản khoá (423), thiếu mã nâng quyền', () => {
    expect(resetErrorMessage(new ApiError('forbidden'))).toBe(vi.admin.org.users.totpReset.forbidden);
    expect(resetErrorMessage(new ApiError('not_found'))).toBe(vi.admin.org.users.totpReset.notFound);
    expect(resetErrorMessage(new ApiError('account_locked'))).toBe(vi.admin.org.users.totpReset.locked);
    expect(resetErrorMessage(new ApiError('rate_limited'))).toBe(codeMessage('rate_limited'));
    expect(needsStepUp(new ApiError('step_up_required'))).toBe(true);
    expect(needsStepUp(new ApiError('forbidden'))).toBe(false);
    expect(stepUpErrorMessage(new ApiError('invalid_credentials'), true)).toBe(vi.admin.runs.myTasks.stepUp.wrongTotp);
    expect(stepUpErrorMessage(new ApiError('invalid_credentials'), false)).toBe(vi.admin.runs.myTasks.stepUp.wrongPassword);
    expect(stepUpErrorMessage(new ApiError('account_locked'), false)).toBe(vi.admin.org.users.totpReset.locked);
    expect(resetDoneMessage('chị Lan')).toContain('chị Lan');
  });
});

describe('chuỗi mới: không từ vay mượn bị cấm, không biểu tượng cảm xúc, biến đúng', () => {
  const trees = {
    'vi.admin.runs.comments': vi.admin.runs.comments,
    'vi.admin.runs.share': vi.admin.runs.share,
    'vi.admin.runs.confidential': vi.admin.runs.confidential,
    'vi.admin.org.users.totpReset': vi.admin.org.users.totpReset,
    'vi.admin.shell.errors.byCode': vi.admin.shell.errors.byCode,
  };
  for (const [name, tree] of Object.entries(trees)) {
    it(name, () => {
      const strings = leaves(tree, name);
      expect(strings.length).toBeGreaterThan(0);
      for (const { path, value } of strings) {
        expect(value.trim(), path).not.toBe('');
        expect(findBannedWords(value), path).toEqual([]);
        expect(value, path).not.toMatch(/\p{Extended_Pictographic}/u);
        expect((value.match(/\{/g) ?? []).length, path).toBe((value.match(/\}/g) ?? []).length);
      }
    });
  }

  it('mọi mã con của đợt chia sẻ và bình luận đều có câu ở bảng mã lỗi của khung', () => {
    const table: Record<string, string> = vi.admin.shell.errors.byCode;
    for (const code of ['already_has_access', 'cannot_remove_participant', 'user_unavailable', 'register_has_numbers', 'too_long', 'target_too_soon']) {
      expect(table[code]?.trim().length, code).toBeGreaterThan(0);
    }
  });

  it('câu của văn bản mật nói rõ quyền xem mọi lượt chạy không đủ', () => {
    expect(vi.admin.runs.share.restrictedTitle).toBe('Văn bản mật: chỉ những người dưới đây xem được');
    expect(vi.admin.runs.share.restrictedBody).toMatch(/xem mọi lượt chạy không đủ/);
  });
});
