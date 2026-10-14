# Web quản trị (`apps/web-admin`)

Vite + React 19 + TanStack Router (định tuyến bằng mã) + TanStack Query + Tailwind 4. Cổng dev 5273, proxy `/v1` tới API (`VITE_API_PROXY`, mặc định `http://127.0.0.1:3100`).

## Thêm một màn mới

Chỉ sửa trong `src/features/<tên>/`: thêm route vào mảng ở `routes.tsx` và viết tệp trang. Không đụng `src/app/router.tsx`.

```tsx
// src/features/runs/routes.tsx
import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';

const runDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/luot-chay/$runId',
  beforeLoad: requireAny(['run.view_all']), // thiếu quyền: về /viec-cua-toi kèm thông báo
  component: lazyRouteComponent(() => import('./run-detail-page'), 'RunDetailPage'),
});
export const runsRoutes = [runsListRoute, runNewRoute, runDetailRoute] as const; // giữ `as const`

// src/features/runs/run-detail-page.tsx
const route = getRouteApi('/shell/luot-chay/$runId'); // id route có tiền tố /shell; <Link to> thì không
export function RunDetailPage() {
  const { runId } = route.useParams();
  const run = useApiQuery('runs.get', { params: { id: runId } });
  return <PageHeader title={run.data?.title ?? vi.common.loading} />;
}
```

- Tham số tìm kiếm: thêm `validateSearch` vào route, đọc bằng `route.useSearch()`.
- Tab con: tạo một route cha trong chính `routes.tsx` rồi `addChildren`.
- Hai tệp chung có thể phải đụng: `src/lib/sse.ts` (bảng `AFFECTED`, khi màn mới đọc route chưa có trong bảng) và `src/app/nav.ts` (khi thêm mục thanh bên).

## Chữ ký dùng ngay

```ts
// @/lib/query
useApiQuery(key, args, options?)                 // khoá truy vấn: [routeKey, args]
useApiInfiniteQuery(key, args, options?)         // route phân trang; kết quả có thêm .items
useApiMutation(key, { invalidate?: RouteKey[], toastError?: boolean, callOptions?: (args) => CallOptions })
apiKey(key, args)   apiQueryOptions(key, args)   invalidateRoutes(keys)   queryClient

// @/lib/auth
useMe(): Me            useCan(): (action | action[]) => boolean          <Can action="run.start">…</Can>

// @/components/ui/toast
toast.success(msg, { description?, duration?, action? })   toast.error   toast.info

// @/lib/errors
errorMessage(err)   codeMessage(code)   isApiError(err, 'state_conflict')   nextAllowedAt(err)

// khác
downloadCsv(fileName, rows, columns)   // UTF-8 có BOM để Excel mở đúng (SPEC 9.8)
compareVi(a, b)   sortByVi(items, key)   personName(person, 'full' | 'short')
describeEvent(ev)                       // câu chữ dòng thời gian từ RunEventView / ActivityItem
vnLocalToInstant(date, time)   instantToVnLocal(iso)   vnToday()   vnDayDiff(iso)
```

`errorMessage` tra `vi.errors.admin[code]`, rồi câu chung. Không bao giờ hiện `detail` của lỗi API.

## Thành phần

`src/components/ui/`: `Button` (primary, secondary, ghost, danger, link; sm, md, lg, icon), `Input`, `Textarea`, `Field` + `FieldError`, `Select`, `Checkbox`, `Switch`, `Label`, `Dialog`, `Sheet`, `Tabs`, `DropdownMenu`, `Tooltip`, `Popover`, `Badge`, `Card`, `DataTable` (sắp xếp, chọn nhiều dòng, "Tải thêm", trạng thái rỗng và đang tải), `Skeleton`, `Spinner`, `EmptyState`, `Callout`, `Toaster`, `PageHeader`, `StatGroup` + `StatCard`, `ConfirmDialog`.

`src/components/`: `StatusChip`, `RunStatusChip`, `DueLabel`, `PersonName`, `PersonPicker` (gọi `people.search`), `UnitSelect`, `RunProgress`.

`@/features/dispatch` (điều phối dùng chung, SPEC 9.4): `ReassignDialog`, `ExtendDialog`, `NudgeDialog` (`{ open, onOpenChange, steps, onDone? }`), `SkipDialog`, `CancelRunDialog`, `ExtensionDecisionDialog`, `StepActionsMenu`, `StepActionButtons`, `BulkStepActions`, `StepDispatchProvider`, `useStepDispatch()`. Nút chỉ hiện khi việc có hành động tương ứng trong `allowedActions`.

## Quy ước giao diện

- Màu: bảng màu mặc định của Tailwind đã bị xoá. Chỉ dùng `canvas, surface, surface-alt, ink, ink-sub, primary(-pressed/-tint), on-primary(-tint), gold(-tint), late, late-bg, warn, warn-bg, line, hairline, scrim` (lấy từ `@mihato/ui-tokens`).
- `late` CHỈ dùng cho quá hạn. Thao tác không hoàn tác được dùng `variant="danger"` (nền mực đậm, không đỏ). Trạng thái luôn có chữ, không chỉ màu.
- Chữ: `text-base` 14px, `text-sm` 13px, `text-lg` 16px, `text-xl` 18px, `text-2xl` 22px (tiêu đề trang).
- Bo góc: điều khiển `rounded-lg`, thẻ `rounded-xl`, hộp thoại `rounded-2xl`. Thẻ không có bóng; chỉ lớp nổi có.
- Viền: `border-line` cho thành phần tương tác, `border-hairline` cho thẻ và bảng.
- Hộp thoại có biểu mẫu: đặt biểu mẫu thành component con bên trong `DialogContent` để trạng thái tự xoá mỗi lần mở (mẫu: `features/dispatch/reassign-dialog.tsx`).
- Mở hộp thoại từ mục trình đơn: dùng `useAfterMenuClose()` để focus về nút cũ.
- Bảng nhiều cột: `tableClassName="min-w-[900px] table-fixed"`, đặt độ rộng cột bằng `meta.className` (mẫu: `features/overview/overdue-section.tsx`).
- Nút đóng ghi "Đóng", không ghi "Huỷ". Nút chính nói rõ việc sẽ làm.
- Không dùng "task", "deadline", "dashboard" trên giao diện.

## Chuỗi giao diện

Mọi chữ nằm ở `packages/i18n/src/vi/admin/` (`shell.ts`, `runs.ts`, `designer.ts`, `org.ts`). Mỗi tệp lấy lát cắt ở đầu: `const t = vi.admin.runs.detail;` rồi `fmt(t.asOf, { giờ })`. Tên khoá camelCase, nhóm theo màn hình rồi theo khối. Biến viết tiếng Việt trong ngoặc nhọn: `{n} {tên} {việc} {ngày}`. Nhãn trạng thái, vai trò, hành động, hạn lấy ở `vi.common`; câu dòng thời gian ở `vi.timeline`; câu lỗi ở `vi.errors.admin`.
