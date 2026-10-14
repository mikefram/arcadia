import { newId } from '@mihato/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signToken } from '../src/auth/crypto';
import { closeDb, schema } from '../src/db/client';
import {
  createDelegation,
  createUnit,
  createUser,
  createUserActivation,
  createUserPasswordLink,
  deleteDelegation,
  deleteHoliday,
  enableUser,
  getOrgSettings,
  getUser,
  holidaySuggestions,
  importUsers,
  listDelegations,
  listDevices,
  listHolidays,
  listUnits,
  listUsers,
  parseCsv,
  patchOrgSettings,
  putHoliday,
  searchPeople,
  setUserRoles,
  updateUnit,
  updateUser,
} from '../src/services/org';
import { revokeDevice } from '../src/auth/service';
import { checkNudgeThrottle, quietUntil } from '../src/services/nudges';
import { createTestOrg, type TestOrg } from '../src/testing';
import { auditRows, expectApiError } from './helpers';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg({ settings: { officePhone: '0900000001' } });
});
afterAll(closeDb);

const HOUR = 3_600_000;

describe('người dùng và vai trò', () => {
  it('tạo người dùng ở trạng thái invited, ghi vai trò và nhật ký không chứa tên', async () => {
    const it_ = org.viewer('it_admin');
    const created = await org.run((tx) =>
      createUser(tx, it_, {
        fullName: '  Hoàng Ngọc Ánh ',
        givenName: 'Ngọc Ánh',
        honorific: 'chi',
        email: 'Ngoc.Anh@Example.test',
        phone: '0901234567',
        unitId: org.units.sales,
        managerId: org.users.head,
        uiProfile: 'standard',
        displayOrder: 20,
        roles: [
          { role: 'employee', unitId: null },
          { role: 'employee', unitId: null },
        ],
      }),
    );
    expect(created).toMatchObject({
      fullName: 'Hoàng Ngọc Ánh',
      email: 'ngoc.anh@example.test',
      status: 'invited',
      unitName: 'Phòng Kinh doanh',
      managerName: 'Đặng Quốc Bảo',
      roles: [{ role: 'employee', unitId: null }],
      hasPassword: false,
      mfaEnabled: false,
      deviceCount: 0,
    });
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const fetched = await org.run((tx) => getUser(tx, created.id));
    expect(fetched).toEqual(created);

    const [entry] = await org.run((tx) => auditRows(tx, 'user_created'));
    expect(entry).toMatchObject({ actorUserId: it_.id, targetType: 'user', targetId: created.id });
    expect(JSON.stringify(entry!.detail)).not.toMatch(/Hoàng|Ánh|example|090/);
  });

  it('không cho trùng email, kể cả khác hoa thường', async () => {
    const err = await expectApiError(
      org.run((tx) =>
        createUser(tx, org.viewer('it_admin'), {
          fullName: 'Người Trùng',
          givenName: 'Trùng',
          honorific: null,
          email: `EMPLOYEE@${org.code}.test`,
          phone: null,
          unitId: null,
          managerId: null,
          uiProfile: 'standard',
          displayOrder: 0,
          roles: [{ role: 'employee', unitId: null }],
        }),
      ),
      'input_invalid',
    );
    expect(err.extra.errors).toEqual([{ path: 'body.email', code: 'duplicate' }]);
  });

  it('sửa hồ sơ chỉ áp khoá có trong thân yêu cầu thô', async () => {
    const it_ = org.viewer('it_admin');
    // Zod 4 điền mặc định cho khoá vắng: body có unitId = null, managerId = null dù người gọi chỉ gửi phone.
    const body = { phone: '0911222333', honorific: null, email: null, unitId: null, managerId: null, uiProfile: 'standard' as const, displayOrder: 0 };
    const updated = await org.run((tx) => updateUser(tx, it_, org.users.employee2, body, { phone: '0911222333' }));
    expect(updated).toMatchObject({ phone: '0911222333', unitId: org.units.sales, managerId: org.users.head, honorific: 'anh', displayOrder: 8 });
    expect(updated.email).toBe(`employee2@${org.code}.test`);

    const [entry] = await org.run((tx) => auditRows(tx, 'user_updated'));
    expect(entry!.detail).toEqual({ fields: ['phone'] });

    // Gửi rõ unitId = null thì mới bỏ đơn vị.
    const cleared = await org.run((tx) => updateUser(tx, it_, org.users.employee2, body, { unitId: null }));
    expect(cleared.unitId).toBeNull();
    await org.run((tx) => updateUser(tx, it_, org.users.employee2, { ...body, unitId: org.units.sales }, { unitId: org.units.sales }));
  });

  it('chặn vòng trong chuỗi quản lý', async () => {
    // head quản lý employee; đặt employee làm quản lý của head là vòng.
    const err = await expectApiError(
      org.run((tx) => updateUser(tx, org.viewer('it_admin'), org.users.head, { managerId: org.users.employee }, { managerId: org.users.employee })),
      'input_invalid',
    );
    expect(err.extra.errors).toEqual([{ path: 'body.managerId', code: 'cycle' }]);
  });

  it('đặt vai trò, ghi role_changed, và không cho xoá it_admin cuối cùng', async () => {
    const it_ = org.viewer('it_admin');
    const view = await org.run((tx) =>
      setUserRoles(tx, it_, org.users.head, [
        { role: 'employee', unitId: null },
        { role: 'office_admin', unitId: org.units.sales },
      ]),
    );
    expect(view.roles).toEqual([
      { role: 'office_admin', unitId: org.units.sales },
      { role: 'employee', unitId: null },
    ]);
    const [entry] = await org.run((tx) => auditRows(tx, 'role_changed'));
    expect(entry).toMatchObject({ targetId: org.users.head, actorUserId: it_.id });
    expect(entry!.detail).toEqual({
      before: [{ role: 'employee', unitId: null }],
      after: [
        { role: 'office_admin', unitId: org.units.sales },
        { role: 'employee', unitId: null },
      ],
    });

    const err = await expectApiError(org.run((tx) => setUserRoles(tx, it_, org.users.itAdmin, [{ role: 'employee', unitId: null }])), 'input_invalid');
    expect(err.extra.errors).toEqual([{ path: 'body.roles', code: 'last_it_admin' }]);

    // Có it_admin thứ hai thì người đầu bỏ vai được.
    await org.run((tx) => setUserRoles(tx, it_, org.users.designer, [{ role: 'process_designer', unitId: null }, { role: 'it_admin', unitId: null }]));
    const demoted = await org.run((tx) => setUserRoles(tx, it_, org.users.itAdmin, [{ role: 'employee', unitId: null }]));
    expect(demoted.roles).toEqual([{ role: 'employee', unitId: null }]);
    await org.run((tx) => setUserRoles(tx, it_, org.users.itAdmin, [{ role: 'it_admin', unitId: null }]));
    await org.run((tx) => setUserRoles(tx, it_, org.users.designer, [{ role: 'process_designer', unitId: null }]));
    await org.run((tx) => setUserRoles(tx, it_, org.users.head, [{ role: 'employee', unitId: null }]));
  });

  it('danh sách: lọc không dấu, theo đơn vị, theo trạng thái, phân trang con trỏ', async () => {
    const byName = await org.run((tx) => listUsers(tx, { limit: 50, q: 'nguyen thu' }));
    expect(byName.items.map((u) => u.fullName)).toEqual(['Nguyễn Thu Lan']);

    const sales = await org.run((tx) => listUsers(tx, { limit: 50, unitId: org.units.sales, status: 'active' }));
    expect(sales.items.map((u) => u.givenName)).toEqual(['Bảo', 'Lan', 'Tuấn']);

    const invited = await org.run((tx) => listUsers(tx, { limit: 50, status: 'invited' }));
    expect(invited.items.map((u) => u.fullName)).toEqual(['Hoàng Ngọc Ánh']);

    const all = await org.run((tx) => listUsers(tx, { limit: 200 }));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await org.run((tx) => listUsers(tx, { limit: 4, cursor }));
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((u) => u.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.items.map((u) => u.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('bật lại chỉ áp cho người đang bị vô hiệu hoá', async () => {
    await expectApiError(org.run((tx) => enableUser(tx, org.viewer('it_admin'), org.users.employee)), 'state_conflict');
  });
});

describe('tìm người', () => {
  it('không phân biệt dấu, nhận cách gọi có xưng hô, khớp mờ, kèm đơn vị và chức danh', async () => {
    const find = (q: string, limit = 20) => org.run(async (_tx, ctx) => searchPeople(ctx, q, limit));

    expect((await find('lan'))[0]).toMatchObject({ fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi', unitName: 'Phòng Kinh doanh', roleTitle: 'Nhân viên' });
    expect((await find('chị Lan'))[0]!.id).toBe(org.users.employee);
    expect((await find('TUAN'))[0]!.id).toBe(org.users.employee2);
    // gõ dở vài chữ đầu của một tiếng trong họ tên
    expect((await find('ngu')).map((p) => p.id)).toContain(org.users.employee);
    // gõ lệch một ký tự
    expect((await find('tuaan')).map((p) => p.id)).toContain(org.users.employee2);
    expect((await find('minh'))[0]).toMatchObject({ id: org.users.chairman, roleTitle: 'Chủ tịch', unitName: 'Ban Giám đốc' });
    expect(await find('khongcoai')).toEqual([]);

    const everyone = await find('', 100);
    expect(everyone.length).toBeGreaterThanOrEqual(9);
    expect(await find('', 3)).toHaveLength(3);
  });
});

describe('nhập CSV', () => {
  it('đọc BOM, ô trong nháy kép có dấu phẩy và nháy lặp', () => {
    const rows = parseCsv('﻿fullName,unit\r\n"Nguyễn, Văn ""Tèo""",Văn phòng\r\n\r\n"Hai\ndòng",x\n');
    expect(rows).toEqual([
      { line: 1, cells: ['fullName', 'unit'] },
      { line: 2, cells: ['Nguyễn, Văn "Tèo"', 'Văn phòng'] },
      { line: 4, cells: ['Hai\ndòng', 'x'] },
    ]);
  });

  it('dryRun báo lỗi từng dòng và không ghi; chạy thật thì tạo, nối người quản lý trong chính tệp', async () => {
    const it_ = org.viewer('it_admin');
    const before = (await org.run((tx) => listUsers(tx, { limit: 200 }))).items.length;
    const bad = [
      '﻿fullName,givenName,honorific,email,phone,unit,manager,roles,uiProfile',
      `"Trịnh, Văn Nam",Nam,anh,nam@${org.code}.test,0902,Phòng Kinh doanh,head@${org.code}.test,employee,standard`,
      `,,ngài,khong-phai-email,,Phòng Không Có,ai@${org.code}.test,vua,to`,
      `Lý Thị Mai,,chị,employee@${org.code}.test,,,,,`,
    ].join('\r\n');
    const dry = await org.run((tx) => importUsers(tx, it_, bad, true));
    expect(dry).toMatchObject({ dryRun: true, total: 3, created: 0 });
    expect(dry.rows[0]).toEqual({ line: 2, ok: true, errors: [] });
    expect(dry.rows[1]!.line).toBe(3);
    expect(dry.rows[1]!.errors.sort()).toEqual(['email_invalid', 'fullName_required', 'honorific_invalid', 'manager_not_found', 'role_invalid', 'uiProfile_invalid', 'unit_not_found']);
    expect(dry.rows[2]).toEqual({ line: 4, ok: false, errors: ['email_duplicate'] });

    // Chạy thật với tệp còn lỗi: không ghi dòng nào.
    const refused = await org.run((tx) => importUsers(tx, it_, bad, false));
    expect(refused.created).toBe(0);
    expect((await org.run((tx) => listUsers(tx, { limit: 200 }))).items.length).toBe(before);

    const good = [
      'fullName,givenName,honorific,email,phone,unit,manager,roles,uiProfile',
      `Trịnh Văn Nam,,anh,nam@${org.code}.test,0902,phong kinh doanh,sep@${org.code}.test,Nhân viên,`,
      `Lý Thị Mai,Mai,chị,sep@${org.code}.test,,Văn phòng,,office_admin|employee,senior`,
    ].join('\n');
    const done = await org.run((tx) => importUsers(tx, it_, good, false));
    expect(done).toMatchObject({ dryRun: false, total: 2, created: 2 });

    const nam = (await org.run((tx) => listUsers(tx, { limit: 10, q: 'trinh van nam' }))).items[0]!;
    expect(nam).toMatchObject({ givenName: 'Nam', honorific: 'anh', status: 'invited', unitId: org.units.sales, managerName: 'Lý Thị Mai', roles: [{ role: 'employee', unitId: null }], uiProfile: 'standard' });
    const mai = (await org.run((tx) => listUsers(tx, { limit: 10, q: 'ly thi mai' }))).items[0]!;
    expect(mai).toMatchObject({ honorific: 'chi', unitId: org.units.office, uiProfile: 'senior' });
    expect(mai.roles.map((r) => r.role)).toEqual(['office_admin', 'employee']);
  });
});

describe('đơn vị', () => {
  it('liệt kê kèm trưởng đơn vị và số người; tạo, sửa, chặn vòng cha con', async () => {
    const it_ = org.viewer('it_admin');
    const units = await org.run((tx) => listUnits(tx));
    const board = units.find((u) => u.id === org.units.board)!;
    expect(board).toMatchObject({ name: 'Ban Giám đốc', headUserId: org.users.director, headName: 'Lê Thanh Sơn', memberCount: 3, parentId: null });

    const child = await org.run((tx) => createUnit(tx, it_, { name: 'Tổ Dự án', parentId: org.units.sales, headUserId: org.users.employee }));
    expect(child).toMatchObject({ name: 'Tổ Dự án', parentId: org.units.sales, headName: 'Nguyễn Thu Lan', memberCount: 0 });

    // sales là cha của child: đặt child làm cha của sales là vòng.
    const cycle = await expectApiError(org.run((tx) => updateUnit(tx, it_, org.units.sales, { parentId: child.id }, { parentId: child.id })), 'input_invalid');
    expect(cycle.extra.errors).toEqual([{ path: 'body.parentId', code: 'cycle' }]);
    await expectApiError(org.run((tx) => updateUnit(tx, it_, child.id, { parentId: child.id }, { parentId: child.id })), 'input_invalid');

    // Chỉ đổi tên: parentId và headUserId (Zod điền null) không bị áp.
    const renamed = await org.run((tx) => updateUnit(tx, it_, child.id, { name: 'Tổ Dự án KCN', parentId: null, headUserId: null }, { name: 'Tổ Dự án KCN' }));
    expect(renamed).toMatchObject({ name: 'Tổ Dự án KCN', parentId: org.units.sales, headUserId: org.users.employee });
  });
});

describe('thiết bị và kích hoạt', () => {
  it('liệt kê, thu hồi thiết bị; tạo mã kích hoạt và đường dẫn đặt mật khẩu', async () => {
    const it_ = org.viewer('it_admin');
    const deviceId = newId();
    await org.run((tx) => tx.insert(schema.devices).values({ id: deviceId, orgId: org.orgId, userId: org.users.employee, platform: 'android', name: 'Máy thử', pushToken: 'ExponentPushToken[x]' }));

    const mine = await org.run((tx) => listDevices(tx, { userId: org.users.employee }));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: deviceId, userName: 'Nguyễn Thu Lan', platform: 'android', hasPushToken: true, revokedAt: null });
    expect((await org.run((tx) => getUser(tx, org.users.employee))).deviceCount).toBe(1);

    await org.run((tx) => revokeDevice(tx, it_, deviceId, {}));
    const after = await org.run((tx) => listDevices(tx));
    expect(after.find((d) => d.id === deviceId)).toMatchObject({ hasPushToken: false });
    expect(after.find((d) => d.id === deviceId)!.revokedAt).not.toBeNull();
    expect((await org.run((tx) => getUser(tx, org.users.employee))).deviceCount).toBe(0);
    expect((await org.run((tx) => auditRows(tx, 'device_revoked')))[0]).toMatchObject({ targetId: deviceId });

    const activation = await org.run((tx) => createUserActivation(tx, it_, org.users.employee));
    expect(activation.url).toContain('activate?token=');
    expect(activation.qrPayload).toBe(activation.url);
    expect(Date.parse(activation.expiresAt) - Date.now()).toBeGreaterThan(71 * HOUR);

    const link = await org.run((tx) => createUserPasswordLink(tx, it_, org.users.officeAdmin));
    expect(link.url).toContain('token=');

    const noEmail = await org.run((tx) =>
      createUser(tx, it_, { fullName: 'Không Thư', givenName: 'Thư', honorific: null, email: null, phone: null, unitId: null, managerId: null, uiProfile: 'standard', displayOrder: 0, roles: [{ role: 'employee', unitId: null }] }),
    );
    await expectApiError(org.run((tx) => createUserPasswordLink(tx, it_, noEmail.id)), 'input_invalid');
  });
});

describe('ủy quyền', () => {
  const range = () => ({ validFrom: new Date(Date.now() - HOUR).toISOString(), validTo: new Date(Date.now() + 48 * HOUR).toISOString() });

  it('người thường chỉ tạo cho chính mình; quản trị tạo cho người khác; danh sách theo tầm nhìn', async () => {
    const employee = org.viewer('employee');
    const mine = await org.run((tx, ctx) => createDelegation(tx, ctx, employee, { fromUserId: employee.id, toUserId: org.users.employee2, ...range(), scope: 'all', scopeRef: null }));
    expect(mine).toMatchObject({ scope: 'all', scopeRef: null, active: true });
    expect(mine.fromUser.fullName).toBe('Nguyễn Thu Lan');
    expect(mine.toUser.fullName).toBe('Bùi Quốc Tuấn');

    await expectApiError(
      org.run((tx, ctx) => createDelegation(tx, ctx, employee, { fromUserId: org.users.head, toUserId: employee.id, ...range(), scope: 'all', scopeRef: null })),
      'forbidden',
    );
    await expectApiError(
      org.run((tx, ctx) => createDelegation(tx, ctx, employee, { fromUserId: employee.id, toUserId: employee.id, ...range(), scope: 'all', scopeRef: null })),
      'input_invalid',
    );
    await expectApiError(
      org.run((tx, ctx) => createDelegation(tx, ctx, employee, { fromUserId: employee.id, toUserId: org.users.head, validFrom: range().validTo, validTo: range().validFrom, scope: 'all', scopeRef: null })),
      'input_invalid',
    );

    const it_ = org.viewer('it_admin');
    const future = { validFrom: new Date(Date.now() + 24 * HOUR).toISOString(), validTo: new Date(Date.now() + 72 * HOUR).toISOString() };
    const byAdmin = await org.run((tx, ctx) => createDelegation(tx, ctx, it_, { fromUserId: org.users.head, toUserId: org.users.deputy, ...future, scope: 'role', scopeRef: 'employee' }));
    expect(byAdmin).toMatchObject({ scope: 'role', scopeRef: 'employee', active: false });

    const [entry] = await org.run((tx) => auditRows(tx, 'delegation_created'));
    expect(entry).toMatchObject({ targetId: byAdmin.id, actorUserId: it_.id });
    expect(entry!.detail).toMatchObject({ fromUserId: org.users.head, toUserId: org.users.deputy, scope: 'role' });

    expect((await org.run((tx, ctx) => listDelegations(tx, ctx, it_))).map((d) => d.id).sort()).toEqual([mine.id, byAdmin.id].sort());
    expect((await org.run((tx, ctx) => listDelegations(tx, ctx, employee))).map((d) => d.id)).toEqual([mine.id]);
    // người nhận ủy quyền cũng thấy
    expect((await org.run((tx, ctx) => listDelegations(tx, ctx, org.viewer('employee2')))).map((d) => d.id)).toEqual([mine.id]);
    expect(await org.run((tx, ctx) => listDelegations(tx, ctx, org.viewer('designer')))).toEqual([]);

    // Người ngoài: 404. Người nhận: thấy nhưng không được xoá. Người giao: xoá được.
    await expectApiError(org.run((tx) => deleteDelegation(tx, org.viewer('designer'), mine.id)), 'not_found');
    await expectApiError(org.run((tx) => deleteDelegation(tx, org.viewer('employee2'), mine.id)), 'forbidden');
    await org.run((tx) => deleteDelegation(tx, employee, mine.id));
    await org.run((tx) => deleteDelegation(tx, it_, byAdmin.id));
    expect(await org.run((tx, ctx) => listDelegations(tx, ctx, it_))).toEqual([]);
    expect(await org.run((tx) => auditRows(tx, 'delegation_deleted'))).toHaveLength(2);
    await expectApiError(org.run((tx) => deleteDelegation(tx, it_, mine.id)), 'not_found');
  });

  it('điều hành tự ủy quyền phải có mã nâng quyền', async () => {
    const chairman = org.viewer('chairman');
    const body = { fromUserId: chairman.id, toUserId: org.users.deputy, ...range(), scope: 'all' as const, scopeRef: null };
    await expectApiError(org.run((tx, ctx) => createDelegation(tx, ctx, chairman, body)), 'step_up_required');
    await expectApiError(org.run((tx, ctx) => createDelegation(tx, ctx, chairman, body, { stepUpToken: 'khong-hop-le' })), 'step_up_required');

    // Mã của người khác không dùng được.
    const foreign = await signToken('stepup', { sub: org.users.director, org: org.orgId }, 60);
    await expectApiError(org.run((tx, ctx) => createDelegation(tx, ctx, chairman, body, { stepUpToken: foreign.token })), 'step_up_required');

    const own = await signToken('stepup', { sub: chairman.id, org: org.orgId }, 60);
    const created = await org.run((tx, ctx) => createDelegation(tx, ctx, chairman, body, { stepUpToken: own.token }));
    expect(created.fromUser.id).toBe(chairman.id);
    expect(created.active).toBe(true);
    await org.run((tx) => deleteDelegation(tx, chairman, created.id));
  });
});

describe('ngày nghỉ', () => {
  it('ghi, liệt kê theo năm, gợi ý đánh dấu đã thêm, xoá', async () => {
    const office = org.viewer('office_admin');
    await org.run((tx) => putHoliday(tx, office, '2027-01-01', { name: 'Tết Dương lịch', kind: 'public' }));
    await org.run((tx) => putHoliday(tx, office, '2027-04-30', { name: 'Ngày Chiến thắng', kind: 'public' }));
    await org.run((tx) => putHoliday(tx, office, '2028-01-01', { name: 'Tết Dương lịch', kind: 'public' }));
    // ghi đè cùng ngày
    const replaced = await org.run((tx) => putHoliday(tx, office, '2027-04-30', { name: 'Nghỉ 30/4', kind: 'company' }));
    expect(replaced).toEqual({ day: '2027-04-30', name: 'Nghỉ 30/4', kind: 'company' });

    expect(await org.run((tx) => listHolidays(tx, 2027))).toEqual([
      { day: '2027-01-01', name: 'Tết Dương lịch', kind: 'public' },
      { day: '2027-04-30', name: 'Nghỉ 30/4', kind: 'company' },
    ]);

    const suggestions = await org.run((tx) => holidaySuggestions(tx, 2027));
    const flag = (day: string) => suggestions.find((s) => s.day === day)?.alreadyAdded;
    expect(flag('2027-01-01')).toBe(true);
    expect(flag('2027-04-30')).toBe(true);
    expect(flag('2027-05-01')).toBe(false);
    expect(flag('2027-09-02')).toBe(false);
    // Tết Nguyên đán 2027 rơi vào 06/02/2027; ngày lễ theo âm lịch có nhãn ngày âm.
    expect(suggestions.find((s) => s.day === '2027-02-06')).toMatchObject({ kind: 'public', alreadyAdded: false });
    expect(suggestions.find((s) => s.day === '2027-02-06')!.lunarLabel).toMatch(/Giêng/);

    // Lịch của tổ chức nạp ở giao dịch sau đã có ngày nghỉ.
    expect(await org.run(async (_tx, ctx) => ctx.calendar.holidays.some((h) => h.day === '2027-04-30' && h.kind === 'company'))).toBe(true);

    await org.run((tx) => deleteHoliday(tx, office, '2027-04-30'));
    expect((await org.run((tx) => listHolidays(tx, 2027))).map((h) => h.day)).toEqual(['2027-01-01']);
    await expectApiError(org.run((tx) => deleteHoliday(tx, office, '2027-04-30')), 'not_found');

    const entries = await org.run((tx) => auditRows(tx, 'holiday_changed'));
    expect(entries).toHaveLength(5);
    expect(entries[0]!.detail).toEqual({ op: 'delete', day: '2027-04-30' });
  });
});

describe('cấu hình tổ chức', () => {
  it('patch gộp sâu một cấp, không làm mất khoá khác, nhật ký chỉ ghi tên khoá', async () => {
    const it_ = org.viewer('it_admin');
    const before = await org.run(async (_tx, ctx) => getOrgSettings(ctx));
    expect(before.officePhone).toBe('0900000001');
    // Mặc định KHÔNG có giờ yên tĩnh (Mike, 04/10/2026): giao việc và đi thúc lúc nào cũng được.
    expect(before.quietHours).toBeNull();
    expect(before.ai).toMatchObject({ enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'vbee', dailyCallLimit: 200 });

    const first = await org.run((tx) => patchOrgSettings(tx, it_, { ai: { enabled: false, tts: 'device' }, greeting: 'Chúc mừng năm mới', workdays: [1, 2, 3, 4, 5, 6], quietHours: { start: '21:00', end: '07:00' } }));
    expect(first.quietHours).toEqual({ start: '21:00', end: '07:00' });
    expect(first.ai).toEqual({ ...before.ai, enabled: false, tts: 'device' });
    expect(first.greeting).toBe('Chúc mừng năm mới');
    expect(first.workdays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(first.officePhone).toBe('0900000001');
    expect(first.nudgeTemplates).toEqual(before.nudgeTemplates);

    const second = await org.run((tx) => patchOrgSettings(tx, it_, { nudgeTemplates: { senderName: 'Văn phòng Tổng Giám đốc' }, quietHours: { start: '22:00' }, retention: { transcriptDays: 30 } }));
    expect(second.nudgeTemplates).toEqual({ ...before.nudgeTemplates, senderName: 'Văn phòng Tổng Giám đốc' });
    expect(second.quietHours).toEqual({ start: '22:00', end: '07:00' });
    expect(second.retention).toEqual({ ...before.retention, transcriptDays: 30 });
    // các khoá của lần patch trước vẫn còn
    expect(second.ai).toEqual(first.ai);
    expect(second.greeting).toBe('Chúc mừng năm mới');
    expect(second.workdays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(second.officePhone).toBe('0900000001');

    // Đọc lại từ CSDL ở giao dịch khác: đúng như phản hồi.
    expect(await org.run(async (_tx, ctx) => getOrgSettings(ctx))).toEqual(second);

    const entries = await org.run((tx) => auditRows(tx, 'org_settings_changed'));
    expect(entries).toHaveLength(2);
    expect(entries[1]!.detail).toEqual({ keys: ['workdays', 'quietHours', 'greeting', 'ai.enabled', 'ai.tts'] });
    expect(entries[0]!.detail).toEqual({ keys: ['quietHours.start', 'nudgeTemplates.senderName', 'retention.transcriptDays'] });
    expect(JSON.stringify(entries.map((e) => e.detail))).not.toMatch(/Chúc mừng|Tổng Giám đốc|22:00/);

    // Patch không đổi gì: không ghi nhật ký.
    await org.run((tx) => patchOrgSettings(tx, it_, { greeting: 'Chúc mừng năm mới' }));
    expect(await org.run((tx) => auditRows(tx, 'org_settings_changed'))).toHaveLength(2);
  });

  it('giá trị sai thì 422 và không ghi', async () => {
    const it_ = org.viewer('it_admin');
    const before = await org.run(async (_tx, ctx) => getOrgSettings(ctx));
    const err = await expectApiError(org.run((tx) => patchOrgSettings(tx, it_, { ai: { stt: 'khong-co' }, workStart: '25:00' })), 'input_invalid');
    expect(err.extra.errors!.map((e) => e.path).sort()).toEqual(['body.ai.stt', 'body.workStart']);
    await expectApiError(org.run((tx) => patchOrgSettings(tx, it_, { workStart: '18:00' })), 'input_invalid');
    // Giờ yên tĩnh có đầu trùng cuối là mơ hồ (không có, hay cả ngày): từ chối. Muốn tắt thì gửi `quietHours: null`.
    const same = await expectApiError(org.run((tx) => patchOrgSettings(tx, it_, { quietHours: { start: '22:00', end: '22:00' } })), 'input_invalid');
    expect(same.extra.errors!.map((e) => e.path)).toEqual(['body.quietHours.end']);
    expect(await org.run(async (_tx, ctx) => getOrgSettings(ctx))).toEqual(before);
  });
});

describe('RLS', () => {
  it('giao dịch của tổ chức này không thấy dòng của tổ chức khác', async () => {
    const other = await createTestOrg();
    const rows = await org.run((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, other.users.employee)));
    expect(rows).toEqual([]);
    const orgs = await org.run((tx) => tx.select({ id: schema.organizations.id }).from(schema.organizations));
    expect(orgs.map((o) => o.id)).toEqual([org.orgId]);
    // Ghi dòng mang org_id của tổ chức khác bị chính sách WITH CHECK chặn.
    await expect(org.run((tx) => tx.insert(schema.units).values({ id: newId(), orgId: other.orgId, name: 'Lén' }))).rejects.toThrow();
    const leaked = await other.run((tx) => tx.select().from(schema.units).where(and(eq(schema.units.orgId, other.orgId), eq(schema.units.name, 'Lén'))));
    expect(leaked).toEqual([]);
  });
});

describe('giờ yên tĩnh: mặc định không có (Mike, 04/10/2026)', () => {
  // Thứ Sáu 2026-10-02, múi giờ Việt Nam (UTC+7)
  const FRI_12H = new Date('2026-10-02T05:00:00Z');
  const FRI_22H = new Date('2026-10-02T15:00:00Z');
  const SAT_02H = new Date('2026-10-02T19:00:00Z');
  const SAT_07H = new Date('2026-10-03T00:00:00Z');
  const step = { state: 'in_progress', assigneeId: 'u1', lastNudgedAt: null, dueAt: new Date('2026-10-01T03:00:00Z') } as never;
  const run = { state: 'running' } as never;

  it('chưa cấu hình thì không chặn lúc nào, kể cả 2 giờ sáng: đi thúc và hoãn thông báo đều không áp dụng', async () => {
    const it_ = org.viewer('it_admin');
    await org.run((tx) => patchOrgSettings(tx, it_, { quietHours: null }));
    await org.run(async (_tx, ctx) => {
      expect(ctx.settings.quietHours).toBeNull();
      for (const at of [FRI_12H, FRI_22H, SAT_02H]) {
        expect(quietUntil(ctx, at)).toBeNull();
        expect(checkNudgeThrottle(ctx, step, run, false, at)).toEqual({ throttled: false, reason: null, nextAllowedAt: null });
      }
    });
  });

  it('bật lên thì chặn trong khoảng và trả mốc được phép gửi lại; ngoài khoảng thì không chặn', async () => {
    const it_ = org.viewer('it_admin');
    await org.run((tx) => patchOrgSettings(tx, it_, { quietHours: { start: '21:00', end: '07:00' } }));
    await org.run(async (_tx, ctx) => {
      expect(quietUntil(ctx, FRI_22H)).toEqual(new Date('2026-10-03T00:00:00Z'));
      expect(quietUntil(ctx, SAT_02H)).toEqual(SAT_07H);
      expect(quietUntil(ctx, FRI_12H)).toBeNull();
      expect(checkNudgeThrottle(ctx, step, run, false, FRI_22H)).toEqual({ throttled: true, reason: 'quiet_hours', nextAllowedAt: new Date('2026-10-03T00:00:00Z') });
      expect(checkNudgeThrottle(ctx, step, run, false, FRI_12H).throttled).toBe(false);
      // giờ riêng của người nhận (prefs) vẫn ưu tiên khi truyền vào
      expect(quietUntil(ctx, FRI_12H, { start: '12:00', end: '13:00' })).toEqual(new Date('2026-10-02T06:00:00Z'));
      expect(quietUntil(ctx, FRI_22H, null)).toBeNull();
    });
  });

  it('tắt lại bằng null; nhật ký chỉ ghi tên khoá; đã tắt rồi thì gửi null nữa không ghi gì', async () => {
    const it_ = org.viewer('it_admin');
    const off = await org.run((tx) => patchOrgSettings(tx, it_, { quietHours: null }));
    expect(off.quietHours).toBeNull();
    const latest = (await org.run((tx) => auditRows(tx, 'org_settings_changed')))[0]!;
    expect(latest.detail).toEqual({ keys: ['quietHours'] });
    const count = (await org.run((tx) => auditRows(tx, 'org_settings_changed'))).length;
    await org.run((tx) => patchOrgSettings(tx, it_, { quietHours: null }));
    expect(await org.run((tx) => auditRows(tx, 'org_settings_changed'))).toHaveLength(count);
    await org.run(async (_tx, ctx) => expect(quietUntil(ctx, SAT_02H)).toBeNull());
  });

  it('đang tắt mà chỉ gửi nửa khoảng giờ thì từ chối (phải đủ giờ bắt đầu và kết thúc), cấu hình không đổi', async () => {
    const it_ = org.viewer('it_admin');
    await org.run((tx) => patchOrgSettings(tx, it_, { quietHours: null }));
    const err = await expectApiError(org.run((tx) => patchOrgSettings(tx, it_, { quietHours: { start: '22:00' } })), 'input_invalid');
    expect(err.extra.errors!.map((e) => e.path)).toContain('body.quietHours.end');
    expect(await org.run(async (_tx, ctx) => getOrgSettings(ctx).quietHours)).toBeNull();
  });

  it('đã đi thúc hôm nay thì lần kế vào ngày làm việc sau, đúng giờ bắt đầu làm việc khi không có giờ yên tĩnh', async () => {
    const it_ = org.viewer('it_admin');
    // đặt rõ tuần làm việc: test trước trong file này đã bật Thứ Bảy
    await org.run((tx) => patchOrgSettings(tx, it_, { quietHours: null, workdays: [1, 2, 3, 4, 5] }));
    const nudged = { ...(step as object), lastNudgedAt: new Date('2026-10-02T03:00:00Z') } as never;
    await org.run(async (_tx, ctx) => {
      // Thứ Sáu đã nhắc lúc 10:00; lần kế là Thứ Hai 08:00 (giờ bắt đầu làm việc), không phải 07:00
      expect(checkNudgeThrottle(ctx, nudged, run, false, FRI_12H)).toEqual({ throttled: true, reason: 'already_nudged_today', nextAllowedAt: new Date('2026-10-05T01:00:00Z') });
    });
  });
});
