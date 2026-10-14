import { ACTIONS, ACTION_GROUPS } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { actionHint, actionLabel, groupLabel, permissionErrorText } from '../src/features/org/permission-text';
import { ORG_TABS } from '../src/features/org/tabs';

/** Màn Phân quyền (docs/DECISIONS.md, 05/10/2026): mọi quyền trong mã đều có nhãn tiếng Việt để người quản trị hiểu mình đang bật gì. */
describe('nhãn của quyền', () => {
  it('mọi quyền có nhãn và mô tả, nhãn không trùng nhau', () => {
    const labels = ACTIONS.map(actionLabel);
    for (const action of ACTIONS) {
      expect(actionLabel(action), action).not.toBe('');
      expect(actionHint(action), action).not.toBe('');
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('mọi nhóm có nhãn', () => {
    for (const group of ACTION_GROUPS) expect(groupLabel(group.id), group.id).not.toBe(group.id);
  });

  it('tab Phân quyền có trong màn Người dùng và tổ chức, gác bằng quyền Chỉnh quyền', () => {
    expect(ORG_TABS.find((t) => t.to === '/to-chuc/phan-quyen')).toMatchObject({ label: 'Phân quyền', action: 'permission.manage' });
  });

  it('lỗi lạ thì dùng câu chung, không lộ mã của máy chủ', () => {
    expect(permissionErrorText(new Error('boom'))).not.toContain('boom');
  });
});
