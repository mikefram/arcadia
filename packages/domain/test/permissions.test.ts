import { describe, expect, it } from 'vitest';
import { ACTIONS, POLICY, TEMPLATE_DRAFT_ACTIONS, TEMPLATE_MANAGE_ACTIONS, TEMPLATE_VIEW_ACTIONS, can, canAny, defaultPermissions } from '../src/permissions';

/**
 * Chủ tịch toàn quyền (docs/DECISIONS.md, 04/10/2026), khác bảng 9.1 của SPEC. Test này giữ quyết định đó:
 * thêm một loại việc vào ACTIONS mà quên cho Chủ tịch thì đỏ ở đây.
 */
describe('Chủ tịch toàn quyền', () => {
  it('làm được mọi loại việc, trừ "Trình" (kênh để Văn phòng đưa việc cho người điều hành xác nhận)', () => {
    const missing = ACTIONS.filter((action) => !can(['chairman'], action));
    expect(missing).toEqual(['proposal.create_office']);
  });

  it('gồm cả những việc trước đây chỉ vai khác làm: sửa mẫu, quản lý người dùng, cài đặt, nhật ký, bỏ qua bước', () => {
    for (const action of ['template.edit', 'user.manage', 'unit.manage', 'device.manage', 'delegation.manage', 'org.settings', 'audit.view', 'step.skip', 'step.batch', 'holiday.manage'] as const) {
      expect(can(['chairman'], action), action).toBe(true);
    }
  });

  it('không nới cho vai khác: Giám đốc và Phó giám đốc vẫn không sửa mẫu, quản lý người dùng, đổi cài đặt, bỏ qua bước', () => {
    for (const role of ['director', 'deputy'] as const) {
      for (const action of ['template.edit', 'user.manage', 'org.settings', 'step.skip'] as const) {
        expect(can([role], action), `${role} ${action}`).toBe(false);
      }
    }
    expect(POLICY.employee).toEqual(['self.read', 'step.act_own', 'delegation.self']);
  });
});

/** Quyền về mẫu tách làm ba (docs/DECISIONS.md, 05/10/2026): tạo và sửa, xuất bản, lưu trữ. */
describe('quyền về mẫu quy trình đã tách', () => {
  it('mặc định giữ nguyên hành vi cũ: Nhà thiết kế quy trình và Chủ tịch có đủ ba, vai khác không có quyền nào trong ba', () => {
    for (const action of TEMPLATE_MANAGE_ACTIONS) {
      expect(can(['process_designer'], action), `process_designer ${action}`).toBe(true);
      expect(can(['chairman'], action), `chairman ${action}`).toBe(true);
      for (const role of ['director', 'deputy', 'office_admin', 'it_admin', 'employee'] as const) expect(can([role], action), `${role} ${action}`).toBe(false);
    }
    expect(defaultPermissions(['process_designer'])).toEqual(expect.arrayContaining(['template.read_published', 'template.simulate', 'template.edit', 'template.publish', 'template.archive']));
  });

  it('nhóm "ai thấy gì": nháp cho người sửa và người xuất bản; mẫu đã lưu trữ cho cả ba; xem danh sách thêm người đọc bản xuất bản', () => {
    expect([...TEMPLATE_DRAFT_ACTIONS]).toEqual(['template.edit', 'template.publish']);
    expect([...TEMPLATE_MANAGE_ACTIONS]).toEqual(['template.edit', 'template.publish', 'template.archive']);
    expect([...TEMPLATE_VIEW_ACTIONS]).toEqual(['template.read_published', 'template.edit', 'template.publish', 'template.archive']);
  });

  it('canAny: theo quyền thật của người, không theo vai trò khi đã tính quyền hiệu lực', () => {
    expect(canAny({ permissions: ['template.publish'] }, TEMPLATE_DRAFT_ACTIONS)).toBe(true);
    expect(canAny({ permissions: ['template.archive'] }, TEMPLATE_DRAFT_ACTIONS)).toBe(false);
    expect(canAny({ permissions: new Set(['template.archive'] as const) }, TEMPLATE_MANAGE_ACTIONS)).toBe(true);
    expect(canAny({ permissions: [] }, TEMPLATE_VIEW_ACTIONS)).toBe(false);
  });
});
