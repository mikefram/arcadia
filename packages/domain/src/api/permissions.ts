import { z } from 'zod';
import { RoleSchema } from '../enums';
import { ActionSchema, AdjustSchema } from '../permission-rules';

/**
 * Chỉnh quyền (docs/DECISIONS.md, 05/10/2026): màn Phân quyền của web quản trị.
 * `allowed` / `fromRoles` / `effective` luôn theo thứ tự ACTIONS và không trùng.
 */

/** Một vai trò trong bảng quyền: mặc định của mã, quyền thật sau chỉnh của tổ chức, và số người đang giữ. */
export const PermissionRoleViewSchema = z.object({
  role: RoleSchema,
  defaults: z.array(ActionSchema),
  allowed: z.array(ActionSchema),
  /** quyền thật khác bảng mặc định */
  customized: z.boolean(),
  /** số người đang dùng được (không bị vô hiệu hoá) giữ vai trò này */
  holders: z.number().int(),
});
export type PermissionRoleView = z.infer<typeof PermissionRoleViewSchema>;

export const PermissionMatrixSchema = z.object({
  groups: z.array(z.object({ id: z.string(), actions: z.array(ActionSchema) })),
  /** quyền không ai bị bớt */
  locked: z.array(ActionSchema),
  /** những quyền mà tổ chức luôn phải còn ít nhất một người đang dùng được giữ (chống tự khoá mình ra) */
  required: z.array(ActionSchema),
  roles: z.array(PermissionRoleViewSchema),
});
export type PermissionMatrix = z.infer<typeof PermissionMatrixSchema>;

/** Màn chỉnh vai trò gửi bộ quyền MONG MUỐN; máy chủ chỉ lưu phần khác bảng mặc định. */
export const RolePermissionsSetSchema = z.object({ allowed: z.array(ActionSchema) });
export const RoleParamSchema = z.object({ role: RoleSchema });

/** Quyền của một người: từ vai trò, chỉnh riêng và kết quả. `grants` và `revokes` là chỉnh riêng đang lưu. */
export const UserPermissionsViewSchema = z.object({
  fromRoles: z.array(ActionSchema),
  grants: z.array(ActionSchema),
  revokes: z.array(ActionSchema),
  effective: z.array(ActionSchema),
  locked: z.array(ActionSchema),
});
export type UserPermissionsView = z.infer<typeof UserPermissionsViewSchema>;

/** Chỉnh riêng mong muốn so với quyền từ vai trò. Gửi cả hai mảng rỗng là bỏ hết chỉnh riêng. */
export const UserPermissionsSetSchema = AdjustSchema;
