import { effectivePermissions, type Action, type DirectoryUser } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { asUser, errorCode, Harness, SYSTEM } from './support/harness';
import { defOf, edge, END, makeCtx, runInput, SEED_USERS, START, task, U, vn } from './support/world';

/**
 * Chỉnh quyền có hiệu lực cả ở engine (docs/DECISIONS.md, 05/10/2026): cột "Ai được phép" của bảng 4.3 theo QUYỀN của người thao
 * tác (`DirectoryUser.permissions`), không theo tên vai trò. Người giao (người khởi chạy) và người nhận việc vẫn có quyền riêng với
 * việc của mình, không cần quyền nào trong bảng.
 */
const LINEAR = defOf({ nodes: [START, task('a', U.LAN), task('b', U.HUNG), END], edges: [edge('start', 'a'), edge('a', 'b'), edge('b', 'end')] });
const T0 = vn('2026-10-05', '09:00');

/** Danh bạ mẫu, trong đó `who` được thêm/bớt quyền riêng. */
function ctxWith(who: string, own: { grants?: Action[]; revokes?: Action[] }) {
  const users: DirectoryUser[] = SEED_USERS.map((u) => (u.id === who ? { ...u, permissions: effectivePermissions(u.roles, {}, own) } : u));
  return makeCtx({ users });
}

const started = (ctx = makeCtx(), initiator: string = U.CHAIRMAN) => {
  const h = new Harness(LINEAR, ctx, runInput(initiator));
  h.dispatch({ type: 'StartRun', actor: asUser(initiator) }, T0);
  return h;
};

const extend = (h: Harness, by: string) =>
  errorCode(() => h.dispatch({ type: 'ExtendDue', actor: asUser(by), stepId: h.step('a').id, newDueAt: vn('2026-10-12', '17:00').toISOString(), reason: 'thử' }, T0));
const skip = (h: Harness, by: string) => errorCode(() => h.dispatch({ type: 'SkipStep', actor: asUser(by), stepId: h.step('b').id, reason: 'thử' }, T0));
const reassign = (h: Harness, by: string) => errorCode(() => h.dispatch({ type: 'Reassign', actor: asUser(by), stepId: h.step('a').id, toUserId: U.TUAN, reason: 'thử' }, T0));
const cancel = (h: Harness, by: string) => errorCode(() => h.dispatch({ type: 'CancelRun', actor: asUser(by), reason: 'thử' }, T0));

describe('bảng mặc định giữ đúng hành vi cũ', () => {
  it('Giám đốc gia hạn, giao lại, huỷ được; Giám đốc không bỏ qua bước; Văn phòng bỏ qua được; nhân viên không làm gì trong số này', () => {
    expect(extend(started(), U.DIRECTOR)).toBeNull();
    expect(reassign(started(), U.DIRECTOR)).toBeNull();
    expect(cancel(started(), U.DIRECTOR)).toBeNull();
    expect(skip(started(), U.DIRECTOR)).toBe('not_allowed');
    expect(skip(started(), U.ADMIN)).toBeNull();
    for (const f of [extend, reassign, cancel, skip]) expect(f(started(), U.TUAN)).toBe('not_allowed');
  });
});

describe('bớt quyền riêng của một người', () => {
  it('Giám đốc bị bớt "gia hạn" thì không gia hạn được người khác giao; vẫn giao lại được vì còn quyền đó', () => {
    const ctx = ctxWith(U.DIRECTOR, { revokes: ['step.extend'] });
    expect(extend(started(ctx), U.DIRECTOR)).toBe('not_allowed');
    expect(reassign(started(ctx), U.DIRECTOR)).toBeNull();
    // Người khác cùng vai trò không bị ảnh hưởng.
    expect(extend(started(ctx), U.HUY)).toBeNull();
  });

  it('người giao vẫn gia hạn, huỷ được lượt do chính mình khởi chạy dù bị bớt quyền', () => {
    const ctx = ctxWith(U.DIRECTOR, { revokes: ['step.extend', 'run.cancel', 'step.reassign'] });
    const h = started(ctx, U.DIRECTOR);
    expect(extend(h, U.DIRECTOR)).toBeNull();
    expect(reassign(started(ctx, U.DIRECTOR), U.DIRECTOR)).toBeNull();
    expect(cancel(started(ctx, U.DIRECTOR), U.DIRECTOR)).toBeNull();
  });

  it('Văn phòng bị bớt "giao lại" và "bỏ qua bước" thì không làm được hai việc đó, các việc khác vẫn làm', () => {
    const ctx = ctxWith(U.ADMIN, { revokes: ['step.reassign', 'step.skip'] });
    expect(reassign(started(ctx), U.ADMIN)).toBe('not_allowed');
    expect(skip(started(ctx), U.ADMIN)).toBe('not_allowed');
    expect(extend(started(ctx), U.ADMIN)).toBeNull();
    expect(cancel(started(ctx), U.ADMIN)).toBeNull();
  });
});

describe('thêm quyền riêng cho một người', () => {
  it('nhân viên được thêm "bỏ qua bước" và "gia hạn" thì làm được; chưa thêm "huỷ lượt" thì vẫn không huỷ được', () => {
    const ctx = ctxWith(U.TUAN, { grants: ['step.skip', 'step.extend'] });
    expect(skip(started(ctx), U.TUAN)).toBeNull();
    expect(extend(started(ctx), U.TUAN)).toBeNull();
    expect(cancel(started(ctx), U.TUAN)).toBe('not_allowed');
    // Người cùng vai trò không được thêm thì vẫn bị từ chối.
    expect(skip(started(ctx), U.NGOCANH)).toBe('not_allowed');
  });

  it('thêm quyền không phá phát lại: phát lại ra đúng trạng thái đã có', () => {
    const ctx = ctxWith(U.TUAN, { grants: ['step.skip'] });
    const h = started(ctx);
    expect(skip(h, U.TUAN)).toBeNull();
    expect(h.replayed()).toEqual(h.run);
  });
});

describe('vô hiệu hoá người dùng (UnassignStep) theo quyền quản lý người dùng', () => {
  it('hệ thống luôn làm được; người có quyền quản lý người dùng làm được; người không có thì không', () => {
    const attempt = (h: Harness, by: 'system' | string) =>
      errorCode(() =>
        h.dispatch({ type: 'UnassignStep', actor: by === 'system' ? SYSTEM : asUser(by), stepId: h.step('a').id, reason: 'người nhận đã nghỉ' } as never, T0),
      );
    expect(attempt(started(), 'system')).toBeNull();
    expect(attempt(started(), U.IT)).toBeNull();
    expect(attempt(started(), U.ADMIN)).toBe('not_allowed');
    expect(attempt(started(ctxWith(U.ADMIN, { grants: ['user.manage'] })), U.ADMIN)).toBeNull();
    expect(attempt(started(ctxWith(U.IT, { revokes: ['user.manage'] })), U.IT)).toBe('not_allowed');
  });
});
