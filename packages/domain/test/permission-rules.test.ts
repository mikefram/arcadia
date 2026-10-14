import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_GROUPS,
  LOCKED_ACTIONS,
  POLICY,
  ROLES,
  adjustFromAllowed,
  can,
  defaultPermissions,
  effectivePermissions,
  normalizeAdjust,
  permissionsFromRoles,
  roleAdjustsOf,
  rolePermissions,
  userAdjustsOf,
  type Action,
} from '../src';

/** Chỉnh quyền theo vai trò và riêng từng người (docs/DECISIONS.md, 05/10/2026). */

describe('nhóm quyền cho màn Phân quyền', () => {
  it('mỗi quyền thuộc đúng một nhóm, không thiếu quyền nào', () => {
    const listed = ACTION_GROUPS.flatMap((g) => [...g.actions]);
    expect([...listed].sort()).toEqual([...ACTIONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe('quyền của một vai trò', () => {
  it('chưa chỉnh thì đúng bảng mặc định', () => {
    for (const role of ROLES) expect(rolePermissions(role), role).toEqual(ACTIONS.filter((a) => POLICY[role].includes(a)));
  });

  it('tổ chức thêm hoặc bớt quyền cho vai trò đó, vai trò khác không đổi', () => {
    const adjusts = { employee: { grants: ['report.view' as Action], revokes: ['delegation.self' as Action] } };
    expect(rolePermissions('employee', adjusts)).toEqual(['self.read', 'step.act_own', 'report.view']);
    expect(rolePermissions('director', adjusts)).toEqual(rolePermissions('director'));
  });

  it('quyền bị khoá (đọc hồ sơ của mình) không bớt được, kể cả khi có dòng chỉnh bớt', () => {
    expect(LOCKED_ACTIONS).toContain('self.read');
    expect(rolePermissions('employee', { employee: { grants: [], revokes: ['self.read'] } })).toContain('self.read');
    expect(effectivePermissions(['employee'], {}, { grants: [], revokes: ['self.read'] })).toContain('self.read');
  });
});

describe('quyền hiệu lực của một người', () => {
  it('nhiều vai trò thì hợp quyền các vai; chỉnh của tổ chức áp theo từng vai trước khi hợp', () => {
    const adjusts = { office_admin: { grants: [], revokes: ['step.skip' as Action] } };
    // Người giữ cả Văn phòng và Người vẽ quy trình: Văn phòng bị bớt "bỏ qua bước", vai kia không có quyền này nên mất hẳn.
    expect(permissionsFromRoles(['office_admin', 'process_designer'], adjusts)).not.toContain('step.skip');
    // Chủ tịch vẫn có "bỏ qua bước" dù Văn phòng bị bớt: bảng của từng vai chỉnh độc lập.
    expect(permissionsFromRoles(['office_admin', 'chairman'], adjusts)).toContain('step.skip');
  });

  it('ví dụ của Mike: Josh giữ vai trò A, thêm một quyền và bớt một quyền riêng mà vai trò A và người khác cùng vai không đổi', () => {
    const roleA = rolePermissions('employee'); // 3 quyền
    const josh = effectivePermissions(['employee'], {}, { grants: ['report.view'], revokes: ['delegation.self'] });
    const other = effectivePermissions(['employee'], {}, {});
    expect(roleA).toEqual(['self.read', 'step.act_own', 'delegation.self']);
    expect(josh).toEqual(['self.read', 'step.act_own', 'report.view']);
    expect(other).toEqual(roleA);
  });

  it('BỚT riêng luôn thắng quyền thêm cho vai trò; THÊM riêng luôn được dù vai trò chưa có', () => {
    const adjusts = { employee: { grants: ['report.view' as Action], revokes: [] } };
    expect(effectivePermissions(['employee'], adjusts, {})).toContain('report.view');
    expect(effectivePermissions(['employee'], adjusts, { grants: [], revokes: ['report.view'] })).not.toContain('report.view');
    expect(effectivePermissions(['employee'], {}, { grants: ['user.manage'], revokes: [] })).toContain('user.manage');
  });

  it('đổi vai trò của một người không làm mất chỉnh riêng của họ', () => {
    const own = { grants: ['report.view' as Action], revokes: ['step.act_own' as Action] };
    const asEmployee = effectivePermissions(['employee'], {}, own);
    const asOffice = effectivePermissions(['office_admin'], {}, own);
    expect(asEmployee).toContain('report.view');
    expect(asEmployee).not.toContain('step.act_own');
    expect(asOffice).not.toContain('step.act_own');
    expect(asOffice).toContain('step.reassign');
  });

  it('kết quả luôn theo thứ tự ACTIONS, không trùng', () => {
    const out = effectivePermissions(['director', 'deputy'], {}, { grants: ['template.edit', 'template.edit'], revokes: [] });
    expect(out).toEqual(ACTIONS.filter((a) => out.includes(a)));
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('can() với người đã tính quyền hiệu lực', () => {
  it('theo danh sách hoặc tập quyền của người; theo danh sách vai trò thì chỉ theo bảng mặc định', () => {
    expect(can({ permissions: ['run.start'] }, 'run.start')).toBe(true);
    expect(can({ permissions: new Set<Action>(['run.start']) }, 'run.cancel')).toBe(false);
    expect(can(['director'], 'run.start')).toBe(true);
    expect(can([{ role: 'employee', unitId: null }], 'run.start')).toBe(false);
    expect(defaultPermissions(['employee'])).toEqual(['self.read', 'step.act_own', 'delegation.self']);
  });
});

describe('normalizeAdjust', () => {
  const base = rolePermissions('employee');

  it('bỏ phần không đổi gì: thêm quyền đã có, bớt quyền chưa có', () => {
    const r = normalizeAdjust(base, { grants: ['step.act_own', 'report.view', 'report.view'], revokes: ['run.start', 'delegation.self'] });
    expect(r).toEqual({ ok: true, value: { grants: ['report.view'], revokes: ['delegation.self'] } });
  });

  it('cùng một quyền vừa thêm vừa bớt là lỗi', () => {
    expect(normalizeAdjust(base, { grants: ['report.view'], revokes: ['report.view'] })).toEqual({ ok: false, reason: 'both', actions: ['report.view'] });
  });

  it('bớt quyền bị khoá là lỗi', () => {
    expect(normalizeAdjust(base, { grants: [], revokes: ['self.read'] })).toEqual({ ok: false, reason: 'locked', actions: ['self.read'] });
  });
});

describe('adjustFromAllowed (màn chỉnh vai trò gửi bộ quyền mong muốn)', () => {
  it('chỉ lưu phần khác bảng mặc định; bộ mặc định thì không lưu gì', () => {
    expect(adjustFromAllowed('employee', POLICY.employee)).toEqual({ grants: [], revokes: [] });
    expect(adjustFromAllowed('employee', ['step.act_own', 'report.view'])).toEqual({ grants: ['report.view'], revokes: ['delegation.self'] });
  });

  it('quyền bị khoá luôn được giữ dù bộ mong muốn bỏ sót', () => {
    expect(adjustFromAllowed('employee', []).revokes).not.toContain('self.read');
  });
});

describe('đọc các dòng chỉnh từ CSDL', () => {
  const rows = [
    { subjectType: 'role', subject: 'employee', action: 'report.view', effect: 'grant' },
    { subjectType: 'role', subject: 'employee', action: 'delegation.self', effect: 'revoke' },
    { subjectType: 'role', subject: 'vai_cu_da_bo', action: 'report.view', effect: 'grant' },
    { subjectType: 'role', subject: 'employee', action: 'quyen_cu_da_bo', effect: 'grant' },
    { subjectType: 'user', subject: '0199c000-0000-7000-8000-000000000001', action: 'run.start', effect: 'grant' },
    { subjectType: 'user', subject: '0199c000-0000-7000-8000-000000000001', action: 'step.act_own', effect: 'revoke' },
  ];

  it('gom theo vai trò và theo người; dòng cũ (vai trò hay quyền không còn trong mã) bị bỏ, không làm hỏng cả tổ chức', () => {
    expect(roleAdjustsOf(rows)).toEqual({ employee: { grants: ['report.view'], revokes: ['delegation.self'] } });
    expect(userAdjustsOf(rows).get('0199c000-0000-7000-8000-000000000001')).toEqual({ grants: ['run.start'], revokes: ['step.act_own'] });
    expect(userAdjustsOf(rows).size).toBe(1);
  });
});
