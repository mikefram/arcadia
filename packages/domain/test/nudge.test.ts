import { describe, expect, it } from 'vitest';
import { DEFAULT_NUDGE_TEMPLATES, type NudgeTemplates } from '../src/api/org';
import type { DirectoryUser } from '../src/engine';
import type { Role } from '../src/enums';
import { composeNudge, nudgeTemplateFor, relationOf, renderNudge } from '../src/nudge';

function user(id: string, roles: Role[], managerId: string | null = null, unitId: string | null = null): DirectoryUser {
  return { id, unitId, managerId, status: 'active', roles: roles.map((role) => ({ role, unitId: null })) };
}

/**
 * Sơ đồ mẫu:
 *   chairman ── director ── deputy ── head (trưởng phòng) ── staffA, staffB
 *   office (Văn phòng, office_admin, cấp trên là chief)      chief (Chánh văn phòng, office_admin, cấp trên là chairman)
 *   other (nhân viên phòng khác, không có cấp trên)
 */
const users: DirectoryUser[] = [
  user('chairman', ['chairman']),
  user('director', ['director'], 'chairman'),
  user('deputy', ['deputy'], 'director'),
  user('deputy2', ['deputy'], 'director'),
  user('head', ['employee'], 'deputy', 'unit-kd'),
  user('staffA', ['employee'], 'head', 'unit-kd'),
  user('staffB', ['employee'], 'head', 'unit-kd'),
  user('chief', ['office_admin'], 'chairman', 'unit-vp'),
  user('office', ['office_admin'], 'chief', 'unit-vp'),
  user('other', ['employee'], null, 'unit-kt'),
  user('designer', ['process_designer']),
];

describe('relationOf', () => {
  const cases: [string, string, 'down' | 'peer' | 'up'][] = [
    // theo chuỗi cấp trên
    ['head', 'staffA', 'down'],
    ['staffA', 'head', 'up'],
    ['deputy', 'staffA', 'down'],
    ['staffA', 'deputy', 'up'],
    ['chairman', 'staffB', 'down'],
    ['staffB', 'chairman', 'up'],
    ['chief', 'office', 'down'],
    ['office', 'chief', 'up'],
    // theo thứ bậc vai trò khi không cùng chuỗi
    ['chairman', 'director', 'down'],
    ['director', 'chairman', 'up'],
    ['director', 'deputy2', 'down'],
    ['deputy', 'director', 'up'],
    ['deputy', 'other', 'down'],
    ['other', 'deputy', 'up'],
    ['chairman', 'other', 'down'],
    ['deputy', 'deputy2', 'peer'],
    ['deputy2', 'deputy', 'peer'],
    // ngang cấp
    ['staffA', 'staffB', 'peer'],
    ['staffA', 'other', 'peer'],
    ['head', 'other', 'peer'],
    ['other', 'designer', 'peer'],
    // Văn phòng nhắc thay Văn phòng Chủ tịch
    ['office', 'staffA', 'down'],
    ['office', 'head', 'down'],
    ['office', 'other', 'down'],
    ['chief', 'staffA', 'down'],
    ['office', 'deputy', 'up'],
    ['office', 'director', 'up'],
    ['office', 'chairman', 'up'],
    ['chief', 'chairman', 'up'],
    // nhân viên nhắc Văn phòng: ngang cấp
    ['staffA', 'office', 'peer'],
    // điều hành nhắc Văn phòng: cấp dưới
    ['deputy', 'office', 'down'],
    ['chairman', 'chief', 'down'],
  ];

  it.each(cases)('%s nhắc %s → %s', (from, to, expected) => {
    expect(relationOf(from, to, users)).toBe(expected);
  });

  it('không tìm thấy người trong danh bạ, hoặc tự nhắc mình: ngang cấp', () => {
    expect(relationOf('ghost', 'staffA', users)).toBe('peer');
    expect(relationOf('staffA', 'ghost', users)).toBe('peer');
    expect(relationOf('staffA', 'staffA', users)).toBe('peer');
    expect(relationOf('a', 'b', [])).toBe('peer');
  });

  it('người có nhiều vai trò lấy vai trò cao nhất', () => {
    const multi = [...users, user('both', ['employee', 'deputy'])];
    expect(relationOf('both', 'other', multi)).toBe('down');
    expect(relationOf('both', 'director', multi)).toBe('up');
    expect(relationOf('both', 'deputy', multi)).toBe('peer');
  });

  it('điều hành kiêm Văn phòng vẫn theo thứ bậc điều hành', () => {
    const multi = [...users, user('depOffice', ['deputy', 'office_admin'])];
    expect(relationOf('depOffice', 'deputy', multi)).toBe('peer');
    expect(relationOf('depOffice', 'staffA', multi)).toBe('down');
  });

  it('chuỗi cấp trên bị vòng do dữ liệu sai thì không treo', () => {
    const loop = [user('a', ['employee'], 'b'), user('b', ['employee'], 'c'), user('c', ['employee'], 'a'), user('d', ['employee'])];
    expect(relationOf('d', 'a', loop)).toBe('peer');
    expect(relationOf('a', 'd', loop)).toBe('peer');
    // trong vòng thì ai cũng nằm trên ai: lấy chiều xét trước
    expect(relationOf('b', 'a', loop)).toBe('down');
  });

  it('cấp trên trỏ tới người không có trong danh bạ thì dừng ở đó', () => {
    const broken = [user('x', ['employee'], 'missing'), user('y', ['employee'])];
    expect(relationOf('y', 'x', broken)).toBe('peer');
  });
});

describe('renderNudge với mẫu mặc định (SPEC 4.7)', () => {
  const vars = { honorific: 'chi', givenName: 'Lan', stepTitle: 'Lập chương trình đón đoàn', lateDays: 2 };

  it('gửi cấp dưới', () => {
    expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.down, vars)).toBe(
      'Văn phòng Chủ tịch nhắc chị Lan: việc ‘Lập chương trình đón đoàn’ đã quá hạn 2 ngày. Chị cho biết khi nào hoàn thành.',
    );
  });

  it('gửi ngang cấp', () => {
    expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.peer, vars)).toBe(
      'Nhắc nhẹ chị Lan: việc ‘Lập chương trình đón đoàn’ đã quá hạn 2 ngày. Cần hỗ trợ gì chị cứ báo.',
    );
  });

  it('gửi cấp trên', () => {
    expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.up, { ...vars, honorific: 'ong', givenName: 'Huy' })).toBe(
      'Kính nhắc ông Huy: việc ‘Lập chương trình đón đoàn’ đang chờ ông xử lý, đã quá hạn 2 ngày.',
    );
  });

  it.each([
    ['anh', 'anh', 'Anh'],
    ['chi', 'chị', 'Chị'],
    ['ong', 'ông', 'Ông'],
    ['ba', 'bà', 'Bà'],
    ['co', 'cô', 'Cô'],
    ['chu', 'chú', 'Chú'],
    ['bac', 'bác', 'Bác'],
  ])('xưng hô %s hiện là "%s" và "%s"', (code, lower, upper) => {
    const out = renderNudge('{Honorific} ơi, nhắc {honorific} {tên}.', { ...vars, honorific: code });
    expect(out).toBe(`${upper} ơi, nhắc ${lower} Lan.`);
  });

  it('nhận xưng hô đã ở dạng có dấu, hoặc viết hoa', () => {
    expect(renderNudge('{Honorific} {tên}', { ...vars, honorific: 'chị' })).toBe('Chị Lan');
    expect(renderNudge('{honorific} {tên}', { ...vars, honorific: 'CHI' })).toBe('chị Lan');
  });

  describe('người không có xưng hô: bỏ chỗ trống gọn gàng', () => {
    const noHonorific = { honorific: null, givenName: 'Văn phòng', stepTitle: 'Đặt xe', lateDays: 3 };

    it('gửi cấp dưới: câu thứ hai mở bằng "Xin"', () => {
      expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.down, noHonorific)).toBe(
        'Văn phòng Chủ tịch nhắc Văn phòng: việc ‘Đặt xe’ đã quá hạn 3 ngày. Xin cho biết khi nào hoàn thành.',
      );
    });

    it('gửi ngang cấp', () => {
      expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.peer, noHonorific)).toBe('Nhắc nhẹ Văn phòng: việc ‘Đặt xe’ đã quá hạn 3 ngày. Cần hỗ trợ gì cứ báo.');
    });

    it('gửi cấp trên', () => {
      expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.up, noHonorific)).toBe('Kính nhắc Văn phòng: việc ‘Đặt xe’ đang chờ xử lý, đã quá hạn 3 ngày.');
    });

    it('không để lại khoảng trắng kép, khoảng trắng trước dấu câu hay chỗ giữ chỗ', () => {
      for (const key of ['down', 'peer', 'up'] as const) {
        const out = renderNudge(DEFAULT_NUDGE_TEMPLATES[key], noHonorific);
        expect(out).not.toMatch(/ {2}/);
        expect(out).not.toMatch(/ [,.:;]/);
        expect(out).not.toMatch(/[{}]/);
        expect(out).toMatch(/^\p{Lu}/u);
      }
    });

    it('chuỗi rỗng cũng coi là không có xưng hô', () => {
      expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.peer, { ...noHonorific, honorific: '' })).toBe(
        'Nhắc nhẹ Văn phòng: việc ‘Đặt xe’ đã quá hạn 3 ngày. Cần hỗ trợ gì cứ báo.',
      );
    });

    it('mẫu mở đầu bằng xưng hô: viết hoa lại chữ đầu', () => {
      expect(renderNudge('{Honorific} {tên} ơi, việc ‘{việc}’ đã quá hạn {n} ngày.', noHonorific)).toBe('Văn phòng ơi, việc ‘Đặt xe’ đã quá hạn 3 ngày.');
      expect(renderNudge('{honorific} xem giúp việc ‘{việc}’.', noHonorific)).toBe('Xem giúp việc ‘Đặt xe’.');
    });
  });

  describe('lateDays bằng 0: câu vẫn tự nhiên', () => {
    const due = { ...vars, lateDays: 0 };

    it('gửi cấp dưới', () => {
      expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.down, due)).toBe(
        'Văn phòng Chủ tịch nhắc chị Lan: việc ‘Lập chương trình đón đoàn’ đã đến hạn. Chị cho biết khi nào hoàn thành.',
      );
    });

    it('gửi ngang cấp', () => {
      expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.peer, due)).toBe('Nhắc nhẹ chị Lan: việc ‘Lập chương trình đón đoàn’ đã đến hạn. Cần hỗ trợ gì chị cứ báo.');
    });

    it('gửi cấp trên', () => {
      expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.up, due)).toBe('Kính nhắc chị Lan: việc ‘Lập chương trình đón đoàn’ đang chờ chị xử lý, đã đến hạn.');
    });

    it('không bao giờ in "0 ngày" với mẫu mặc định; số âm và số lẻ được làm tròn xuống, không âm', () => {
      for (const key of ['down', 'peer', 'up'] as const) {
        expect(renderNudge(DEFAULT_NUDGE_TEMPLATES[key], due)).not.toContain('0 ngày');
        expect(renderNudge(DEFAULT_NUDGE_TEMPLATES[key], { ...vars, lateDays: -3 })).toContain('đã đến hạn');
        expect(renderNudge(DEFAULT_NUDGE_TEMPLATES[key], { ...vars, lateDays: 2.9 })).toContain('đã quá hạn 2 ngày');
        expect(renderNudge(DEFAULT_NUDGE_TEMPLATES[key], { ...vars, lateDays: Number.NaN })).toContain('đã đến hạn');
      }
    });

    it('mẫu của tổ chức viết kiểu khác vẫn đổi được', () => {
      expect(renderNudge('Đã quá hạn {n} ngày làm việc: ‘{việc}’.', due)).toBe('Đã đến hạn: ‘Lập chương trình đón đoàn’.');
      expect(renderNudge('Việc ‘{việc}’ đang chậm {n} ngày.', due)).toBe('Việc ‘Lập chương trình đón đoàn’ đã đến hạn.');
      expect(renderNudge('Số ngày trễ: {n}.', due)).toBe('Số ngày trễ: 0.');
    });
  });

  it('không đụng vào chữ trong tên việc và tên người', () => {
    const out = renderNudge(DEFAULT_NUDGE_TEMPLATES.down, {
      honorific: null,
      givenName: 'Lan',
      stepTitle: 'báo cáo  quý 3 : bản nháp. xem lại {n} $& {tên}',
      lateDays: 1,
    });
    expect(out).toBe('Văn phòng Chủ tịch nhắc Lan: việc ‘báo cáo  quý 3 : bản nháp. xem lại {n} $& {tên}’ đã quá hạn 1 ngày. Xin cho biết khi nào hoàn thành.');
  });

  it('mẫu ở dạng tổ hợp (NFD) vẫn điền được', () => {
    expect(renderNudge(DEFAULT_NUDGE_TEMPLATES.peer.normalize('NFD'), vars)).toBe(renderNudge(DEFAULT_NUDGE_TEMPLATES.peer, vars));
  });
});

describe('nudgeTemplateFor và composeNudge', () => {
  it('mặc định lấy mẫu ở DEFAULT_NUDGE_TEMPLATES', () => {
    expect(nudgeTemplateFor('down')).toBe(DEFAULT_NUDGE_TEMPLATES.down);
    expect(nudgeTemplateFor('peer')).toBe(DEFAULT_NUDGE_TEMPLATES.peer);
    expect(nudgeTemplateFor('up')).toBe(DEFAULT_NUDGE_TEMPLATES.up);
  });

  it('dùng mẫu của tổ chức khi có', () => {
    const custom: NudgeTemplates = { ...DEFAULT_NUDGE_TEMPLATES, peer: 'Nhắc {honorific} {tên} việc ‘{việc}’.' };
    expect(nudgeTemplateFor('peer', custom)).toBe('Nhắc {honorific} {tên} việc ‘{việc}’.');
    expect(nudgeTemplateFor('up', custom)).toBe(DEFAULT_NUDGE_TEMPLATES.up);
  });

  it('soạn lời nhắc theo quan hệ suy từ danh bạ', () => {
    const down = composeNudge({
      senderId: 'chairman',
      recipientId: 'staffA',
      users,
      recipient: { honorific: 'chi', givenName: 'Lan' },
      stepTitle: 'Đặt xe',
      lateDays: 2,
    });
    expect(down.tone).toBe('down');
    expect(down.message).toBe('Văn phòng Chủ tịch nhắc chị Lan: việc ‘Đặt xe’ đã quá hạn 2 ngày. Chị cho biết khi nào hoàn thành.');

    const up = composeNudge({
      senderId: 'office',
      recipientId: 'deputy',
      users,
      recipient: { honorific: 'ong', givenName: 'Huy' },
      stepTitle: 'Duyệt tạm ứng',
      lateDays: 1,
    });
    expect(up.tone).toBe('up');
    expect(up.message).toBe('Kính nhắc ông Huy: việc ‘Duyệt tạm ứng’ đang chờ ông xử lý, đã quá hạn 1 ngày.');
  });

  it('ép giọng qua tham số tone', () => {
    const out = composeNudge({
      senderId: 'chairman',
      recipientId: 'staffA',
      users,
      recipient: { honorific: 'anh', givenName: 'Tuấn' },
      stepTitle: 'Đặt xe',
      lateDays: 0,
      tone: 'peer',
    });
    expect(out.tone).toBe('peer');
    expect(out.message).toBe('Nhắc nhẹ anh Tuấn: việc ‘Đặt xe’ đã đến hạn. Cần hỗ trợ gì anh cứ báo.');
  });
});
