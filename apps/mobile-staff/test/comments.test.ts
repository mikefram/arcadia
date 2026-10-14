import { ApiError, COMMENT_MAX, type StepComment, type StepCommentList } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { QueryClient, dehydrate } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  CommentKeyRing,
  appendComment,
  canCommentOf,
  commentCountText,
  commentErrorMessage,
  commentLength,
  composerState,
  mergeCommentPages,
  removeComment,
  shouldDehydrateQuery,
  shouldPersistQuery,
  stepBadges,
} from '../src/features/comments';
import { notificationDestination } from '../src/features/notifications';
import { focusFromParam, notificationTarget, stepRouteParams } from '../src/push/link';

/** Thảo luận theo việc (docs/DECISIONS.md, 07/10/2026 điểm a): phần logic thuần của app nhân viên. */

const STEP = '0199f000-0000-7000-8000-00000000000a';
const author = { id: '0199f000-0000-7000-8000-0000000000aa', fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: null } as const;
const comment = (id: string, over: Partial<StepComment> = {}): StepComment => ({ id, stepId: STEP, author, body: `nội dung ${id}`, createdAt: '2026-10-15T01:00:00Z', mine: false, files: [], ...over });
const page = (ids: string[], nextCursor: string | null, canComment = true): StepCommentList => ({ items: ids.map((i) => comment(i)), nextCursor, canComment });
const counter = () => {
  let n = 0;
  return () => `key-${++n}`;
};

describe('đếm ký tự và khoá nút gửi', () => {
  it('đếm sau khi bỏ khoảng trắng hai đầu, như máy chủ', () => {
    expect(commentLength('  chào  ')).toBe(4);
    expect(commentLength('   ')).toBe(0);
  });

  it('khoá khi trống, đang gửi hoặc quá 4000 ký tự', () => {
    expect(composerState({ draft: '', sending: false, online: true }).disabled).toBe(true);
    expect(composerState({ draft: '   \n ', sending: false, online: true }).disabled).toBe(true);
    expect(composerState({ draft: 'xin chào', sending: true, online: true }).disabled).toBe(true);
    expect(composerState({ draft: 'a'.repeat(COMMENT_MAX), sending: false, online: true })).toMatchObject({ disabled: false, overLimit: false });
    expect(composerState({ draft: 'a'.repeat(COMMENT_MAX + 1), sending: false, online: true })).toMatchObject({ disabled: true, overLimit: true });
    expect(composerState({ draft: 'xin chào', sending: false, online: true }).disabled).toBe(false);
  });

  it('mất mạng không khoá nút (bấm thì báo cần có mạng, nội dung giữ nguyên) nhưng đánh dấu offline', () => {
    const state = composerState({ draft: 'xin chào', sending: false, online: false });
    expect(state.disabled).toBe(false);
    expect(state.offline).toBe(true);
  });

  it('chữ đếm ghi số ký tự và mức tối đa', () => {
    expect(composerState({ draft: 'abc', sending: false, online: true }).counter).toBe('3 trên 4000 ký tự');
  });
});

describe('ánh xạ lỗi gửi bình luận', () => {
  const fallback = () => 'chung';
  it('không tới được máy chủ: cần có mạng và nội dung được giữ', () => {
    expect(commentErrorMessage(new TypeError('Network request failed'), fallback)).toBe(vi.staff.comments.needNetworkKept);
    expect(vi.staff.comments.needNetworkKept).toContain('Cần có mạng để gửi bình luận');
  });

  it('429, 403, 404 có câu riêng; còn lại dùng bảng lỗi chung và không bao giờ hiện chữ của máy chủ', () => {
    expect(commentErrorMessage(new ApiError('rate_limited', { status: 429 }), fallback)).toBe(vi.staff.comments.rateLimited);
    expect(commentErrorMessage(new ApiError('forbidden', { status: 403 }), fallback)).toBe(vi.staff.comments.forbidden);
    expect(commentErrorMessage(new ApiError('not_found', { status: 404 }), fallback)).toBe(vi.staff.comments.notFound);
    expect(commentErrorMessage(new ApiError('internal_error', { status: 500 }), fallback)).toBe('chung');
    expect(commentErrorMessage(new Error('x'), fallback)).toBe('chung');
  });
});

describe('khoá chống lặp khi gửi bình luận', () => {
  it('lỗi mạng và 5xx giữ khoá: gửi lại cùng nội dung dùng cùng khoá', () => {
    const ring = new CommentKeyRing(counter());
    const first = ring.keyFor('xin chào');
    expect(ring.settle({ ok: false, error: new TypeError('x') })).toBe(false);
    expect(ring.keyFor('xin chào')).toBe(first);
    expect(ring.settle({ ok: false, error: new ApiError('internal_error', { status: 503 }) })).toBe(false);
    expect(ring.keyFor('xin chào')).toBe(first);
  });

  it('phản hồi 4xx hoặc thành công đổi khoá', () => {
    const ring = new CommentKeyRing(counter());
    const first = ring.keyFor('xin chào');
    expect(ring.settle({ ok: false, error: new ApiError('rate_limited', { status: 429 }) })).toBe(true);
    const second = ring.keyFor('xin chào');
    expect(second).not.toBe(first);
    expect(ring.settle({ ok: true })).toBe(true);
    expect(ring.keyFor('bình luận khác')).not.toBe(second);
  });

  it('sửa nội dung sau lần lỗi mạng thì dùng khoá khác (tránh idempotency_key_reuse)', () => {
    const ring = new CommentKeyRing(counter());
    const first = ring.keyFor('xin chào');
    ring.settle({ ok: false, error: new TypeError('x') });
    expect(ring.keyFor('xin chào các anh chị')).not.toBe(first);
  });
});

describe('ghép trang bình luận', () => {
  it('gộp các trang theo thứ tự, bỏ bản trùng', () => {
    const merged = mergeCommentPages([page(['a', 'b'], 'c1'), page(['b', 'c'], null)]);
    expect(merged.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(mergeCommentPages(undefined)).toEqual([]);
  });

  it('canComment lấy từ trang đầu', () => {
    expect(canCommentOf([page(['a'], null, false)])).toBe(false);
    expect(canCommentOf([page(['a'], null, true)])).toBe(true);
    expect(canCommentOf(undefined)).toBe(false);
  });

  it('bình luận mới nối vào trang cuối chỉ khi đã tải hết; không nối hai lần', () => {
    const done = { pages: [page(['a'], null)] };
    expect(appendComment(done, comment('b')).pages[0]?.items.map((c) => c.id)).toEqual(['a', 'b']);
    expect(appendComment(appendComment(done, comment('b')), comment('b')).pages[0]?.items).toHaveLength(2);
    const more = { pages: [page(['a'], 'c1')] };
    expect(appendComment(more, comment('b'))).toBe(more);
  });

  it('xoá bình luận khỏi mọi trang', () => {
    const data = { pages: [page(['a', 'b'], 'c1'), page(['c'], null)] };
    expect(mergeCommentPages(removeComment(data, 'b').pages).map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('bộ nhớ đệm: bình luận không ghi xuống đĩa và bị xoá cùng phiên', () => {
  it('shouldPersistQuery loại khoá bình luận, giữ các khoá khác', () => {
    expect(shouldPersistQuery(['comments', STEP])).toBe(false);
    expect(shouldPersistQuery(['step', STEP])).toBe(true);
    expect(shouldPersistQuery(['steps', 'mine', 'todo'])).toBe(true);
    expect(shouldPersistQuery(['run', STEP])).toBe(true);
  });

  it('dehydrate (cái ghi xuống đĩa) không chứa bình luận; xoá phiên dọn sạch bộ nhớ', () => {
    const client = new QueryClient();
    client.setQueryData(['comments', STEP], { pages: [page(['a'], null)], pageParams: [undefined] });
    client.setQueryData(['step', STEP], { id: STEP, commentCount: 1 });
    const persisted = dehydrate(client, { shouldDehydrateQuery }).queries.map((q) => q.queryKey[0]);
    expect(persisted).toEqual(['step']);
    expect(JSON.stringify(dehydrate(client, { shouldDehydrateQuery }))).not.toContain('nội dung a');
    // đăng xuất: services.ts gọi queryClient.clear()
    client.clear();
    expect(client.getQueryData(['comments', STEP])).toBeUndefined();
    expect(dehydrate(client).queries).toHaveLength(0);
  });
});

describe('số bình luận và huy hiệu "Mật"', () => {
  it('chỉ hiện số khi có bình luận', () => {
    expect(commentCountText(0)).toBeNull();
    expect(commentCountText(undefined)).toBeNull();
    expect(commentCountText(3)).toBe('3 bình luận');
  });

  it('"Mật" chỉ khi lượt mật; chưa có dữ liệu lượt thì không hiện', () => {
    expect(stepBadges({ commentCount: 2 }, 'restricted').map((b) => b.key)).toEqual(['comments', 'restricted']);
    expect(stepBadges({ commentCount: 0 }, 'restricted').map((b) => b.key)).toEqual(['restricted']);
    expect(stepBadges({ commentCount: 2 }, 'normal').map((b) => b.key)).toEqual(['comments']);
    expect(stepBadges({}, undefined)).toEqual([]);
    expect(stepBadges({}, 'restricted')[0]?.label).toBe('Mật');
  });
});

describe('thông báo comment_new mở đúng chi tiết việc, mục Thảo luận', () => {
  const link = `mihato://step/${STEP}`;
  it('tin đẩy: type comment_new thì có focus comments, loại khác thì không', () => {
    expect(notificationTarget({ type: 'comment_new', link })).toEqual({ stepId: STEP, focus: 'comments' });
    expect(notificationTarget({ type: 'assigned', link })).toEqual({ stepId: STEP, focus: null });
    expect(notificationTarget({ type: 'comment_new', link: 'mihato://run/abc' })).toBeNull();
    expect(notificationTarget({ type: 'comment_new', link: undefined })).toBeNull();
  });

  it('tin trong danh sách: lấy loại từ kind, việc từ stepId hoặc liên kết', () => {
    const base = { stepId: null, payload: {} as Record<string, unknown> };
    expect(notificationDestination({ ...base, kind: 'comment_new', stepId: STEP })).toEqual({ stepId: STEP, focus: 'comments' });
    expect(notificationDestination({ ...base, kind: 'comment_new', payload: { link } })).toEqual({ stepId: STEP, focus: 'comments' });
    expect(notificationDestination({ ...base, kind: 'assigned', stepId: STEP })).toEqual({ stepId: STEP, focus: null });
  });

  it('tham số đường dẫn: có focus chỉ khi cần; chỉ nhận giá trị đã biết', () => {
    expect(stepRouteParams({ stepId: STEP, focus: 'comments' })).toEqual({ id: STEP, focus: 'comments' });
    expect(stepRouteParams({ stepId: STEP, focus: null })).toEqual({ id: STEP });
    expect(focusFromParam('comments')).toBe('comments');
    expect(focusFromParam(['comments'])).toBe('comments');
    expect(focusFromParam('khác')).toBeNull();
    expect(focusFromParam(undefined)).toBeNull();
  });
});
