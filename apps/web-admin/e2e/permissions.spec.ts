/**
 * Phân quyền trên giao diện (docs/DECISIONS.md, 05/10/2026), chạy trên API thật với dữ liệu mẫu.
 *
 * Chuẩn bị: API ở cổng 3100 và web quản trị đang chạy (pnpm dev). Chạy (từ apps/web-admin):
 *   npx playwright test e2e/permissions.spec.ts          (WEB_URL=... nếu web ở cổng khác)
 * Kịch bản tự trả lại cấu hình cũ khi xong, kể cả khi đỏ giữa chừng (khối finally): bảng quyền của vai trò Nhân viên, Chủ tịch,
 * Quản trị hệ thống và quyền riêng của chị Lan về đúng mặc định.
 *   1. Quản trị hệ thống mở tab Phân quyền, thêm "Xem báo cáo" cho vai trò Nhân viên, lưu; chị Lan có quyền đó ngay; khôi phục mặc định.
 *   2. Quyền riêng của chị Lan: thêm "Xem báo cáo", bớt "Ủy quyền cho người khác khi vắng"; vai trò Nhân viên và anh Hùng không đổi; bỏ chỉnh riêng.
 *   3. Không tự khoá mình ra: bớt "Chỉnh quyền" khỏi cả Chủ tịch lẫn Quản trị hệ thống thì lần lưu thứ hai bị từ chối, nói rõ lý do.
 *   4. Người không có quyền Chỉnh quyền (Văn phòng) không thấy tab, mở thẳng đường dẫn thì bị chuyển đi.
 *   5. Quyền về quy trình tách làm ba (tạo và sửa, xuất bản, lưu trữ): bảng có đủ ba hàng; Văn phòng chỉ có quyền xuất bản thì mở bản
 *      nháp ở chế độ chỉ xem và xuất bản được; Nhà thiết kế bị bớt quyền xuất bản thì không thấy nút Xuất bản. Mẫu do kịch bản tạo
 *      mang tên bắt đầu bằng "Kiểm thử phân quyền quy trình" và được lưu trữ ở cuối.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5273';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'mihato-demo-2026';
const ADDRESS = (user: string) => `${user}@demo.mihato.local`;

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEB_URL, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });

type Opened = { context: BrowserContext; page: Page };
type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
/** Phiên đã đăng nhập của từng người: mỗi tài khoản chỉ đăng nhập một lần, vì API giới hạn số lần đăng nhập mỗi phút. */
const sessions = new Map<string, Session>();

async function login(browser: Browser, user: string): Promise<Opened> {
  const options = { baseURL: WEB_URL, viewport: { width: 1440, height: 900 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' };
  const saved = sessions.get(user);
  if (saved) {
    const context = await browser.newContext({ ...options, storageState: saved });
    return { context, page: await context.newPage() };
  }
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto('/dang-nhap');
  const email = page.getByLabel('Email');
  await expect(async () => {
    await email.fill(ADDRESS(user));
    await page.getByLabel('Mật khẩu', { exact: true }).fill(PASSWORD);
    await expect(email).toHaveValue(ADDRESS(user), { timeout: 500 });
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/dang-nhap'), { timeout: 8_000 });
  }).toPass({ timeout: 100_000, intervals: [1_000, 5_000, 15_000, 20_000] });
  sessions.set(user, await context.storageState());
  return { context, page };
}

async function csrf(page: Page): Promise<string> {
  return (await page.context().cookies()).find((c) => c.name === 'mihato_csrf')?.value ?? '';
}
async function send(page: Page, method: 'PUT' | 'POST', path: string, data: unknown = {}) {
  return page.request.fetch(path, { method, headers: { 'X-CSRF-Token': await csrf(page), 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' }, data });
}
async function permissionsOf(browser: Browser, user: string): Promise<string[]> {
  const { context, page } = await login(browser, user);
  try {
    return ((await (await page.request.get('/v1/me')).json()) as { permissions: string[] }).permissions;
  } finally {
    await context.close();
  }
}

const ROLE_CELL = (role: string, action: string) => `[data-testid="cell-${role}-${action}"]`;

const TEMPLATE_PREFIX = 'Kiểm thử phân quyền quy trình';

async function userIdOf(page: Page, user: string): Promise<string | null> {
  const users = (await (await page.request.get(`/v1/users?q=${ADDRESS(user)}&limit=5`)).json()) as { items: { id: string; email: string | null }[] };
  return users.items.find((u) => u.email === ADDRESS(user))?.id ?? null;
}
async function setOverride(itPage: Page, user: string, grants: string[], revokes: string[]): Promise<void> {
  const id = await userIdOf(itPage, user);
  expect(id, user).not.toBeNull();
  expect((await send(itPage, 'PUT', `/v1/users/${id}/permissions`, { grants, revokes })).status()).toBe(200);
}
/** Nhân bản mẫu "Đón đoàn" thành một mẫu mới (bản nháp đầu đã hợp lệ), bằng quyền của `page`. */
async function cloneDonDoan(page: Page, name: string): Promise<string> {
  const found = (await (await page.request.get('/v1/templates?q=%C4%91%C3%B3n%20%C4%91o%C3%A0n')).json()) as { items: { id: string; name: string; archivedAt: string | null }[] };
  const source = found.items.find((x) => x.archivedAt === null && !x.name.startsWith(TEMPLATE_PREFIX));
  expect(source, 'mẫu Đón đoàn').toBeDefined();
  const res = await send(page, 'POST', '/v1/templates', { name, cloneFromTemplateId: source!.id });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Trả cấu hình về mặc định bằng API (dùng ở finally): khôi phục ba vai trò, xoá chỉnh riêng của chị Lan, Nhà thiết kế và Văn phòng, lưu trữ mẫu thử. */
async function restore(browser: Browser): Promise<void> {
  const it = await login(browser, 'it');
  try {
    for (const role of ['employee', 'chairman', 'it_admin']) await send(it.page, 'POST', `/v1/permissions/roles/${role}/reset`);
    for (const user of ['lan', 'thietke', 'vanphong']) {
      const id = await userIdOf(it.page, user);
      if (id) await send(it.page, 'PUT', `/v1/users/${id}/permissions`, { grants: [], revokes: [] });
    }
  } finally {
    await it.context.close();
  }
  const designer = await login(browser, 'thietke');
  try {
    const all = (await (await designer.page.request.get('/v1/templates')).json()) as { items: { id: string; name: string; archivedAt: string | null }[] };
    for (const x of all.items.filter((t) => t.name.startsWith(TEMPLATE_PREFIX) && t.archivedAt === null)) await send(designer.page, 'POST', `/v1/templates/${x.id}/archive`, { archived: true });
  } finally {
    await designer.context.close();
  }
}

test.afterAll(async ({ browser }) => {
  await restore(browser);
});

test('1. Chỉnh quyền của vai trò Nhân viên: lưu thì chị Lan có quyền ngay; khôi phục mặc định thì mất', async ({ browser }) => {
  test.setTimeout(150_000);
  const it = await login(browser, 'it');
  const { page } = it;
  try {
    await page.goto('/to-chuc');
    await page.getByRole('link', { name: 'Phân quyền' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Phân quyền' })).toBeVisible();
    const table = page.getByTestId('permission-matrix');
    await expect(table.getByRole('columnheader')).toHaveCount(8); // 1 cột quyền + 7 vai trò

    // Quyền đọc hồ sơ của mình không bớt được.
    await expect(page.locator(ROLE_CELL('employee', 'self.read'))).toBeDisabled();

    const cell = page.locator(ROLE_CELL('employee', 'report.view'));
    await expect(cell).not.toBeChecked();
    await cell.click();
    await expect(cell).toBeChecked();
    await expect(page.getByText('Có 1 vai trò chỉnh chưa lưu.')).toBeVisible();
    await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
    await expect(page.getByText('Đã lưu quyền của 1 vai trò.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Khôi phục quyền mặc định của vai trò Nhân viên' })).toBeVisible();
    expect(await permissionsOf(browser, 'lan')).toContain('report.view');
    expect(await permissionsOf(browser, 'hung')).toContain('report.view');
    expect(await permissionsOf(browser, 'chutich')).toContain('report.view'); // vai trò khác không đổi

    // Bỏ tích rồi bỏ thay đổi: không ghi gì.
    await page.locator(ROLE_CELL('employee', 'report.view')).click();
    await expect(page.getByText('Có 1 vai trò chỉnh chưa lưu.')).toBeVisible();
    await page.getByRole('button', { name: 'Bỏ thay đổi' }).click();
    await expect(page.locator(ROLE_CELL('employee', 'report.view'))).toBeChecked();

    await page.getByRole('button', { name: 'Khôi phục quyền mặc định của vai trò Nhân viên' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Khôi phục mặc định' }).click();
    await expect(page.getByText('Đã khôi phục quyền mặc định của vai trò Nhân viên.')).toBeVisible();
    await expect(page.locator(ROLE_CELL('employee', 'report.view'))).not.toBeChecked();
    expect(await permissionsOf(browser, 'lan')).not.toContain('report.view');
  } finally {
    await it.context.close();
    await restore(browser);
  }
});

test('2. Quyền riêng của chị Lan: thêm một quyền, bớt một quyền; vai trò và người cùng vai trò không đổi', async ({ browser }) => {
  test.setTimeout(150_000);
  const it = await login(browser, 'it');
  const { page } = it;
  try {
    await page.goto('/to-chuc/nguoi-dung');
    await page.getByLabel('Tìm người dùng theo tên').fill('Nguyễn Thu Lan');
    const row = page.getByRole('row').filter({ hasText: ADDRESS('lan') });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: /Thao tác với/ }).click();
    await page.getByRole('menuitem', { name: 'Quyền riêng' }).click();
    const sheet = page.getByRole('dialog', { name: /Quyền riêng của/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('own-summary')).toHaveText('Chưa có chỉnh riêng nào: quyền đúng như vai trò.');

    await sheet.locator('[data-testid="own-report.view"]').click();
    await sheet.locator('[data-testid="own-delegation.self"]').click();
    await expect(sheet.getByTestId('own-summary')).toHaveText('Đang thêm riêng 1 quyền và bớt riêng 1 quyền.');
    await expect(sheet.locator('li').filter({ hasText: 'Xem báo cáo' }).getByText('Thêm riêng')).toBeVisible();
    await expect(sheet.locator('li').filter({ hasText: 'Ủy quyền cho người khác khi vắng' }).getByText('Bớt riêng')).toBeVisible();
    // Quyền đọc hồ sơ không tắt được.
    await expect(sheet.locator('[data-testid="own-self.read"]')).toBeDisabled();
    await sheet.getByRole('button', { name: 'Lưu quyền riêng' }).click();
    await expect(page.getByText(/Đã lưu quyền riêng của/)).toBeVisible();

    const lan = await permissionsOf(browser, 'lan');
    expect(lan).toContain('report.view');
    expect(lan).not.toContain('delegation.self');
    const hung = await permissionsOf(browser, 'hung');
    expect(hung).not.toContain('report.view');
    expect(hung).toContain('delegation.self');

    // Mở lại: thấy đúng chỉnh riêng; bỏ hết rồi lưu thì về đúng vai trò.
    await row.getByRole('button', { name: /Thao tác với/ }).click();
    await page.getByRole('menuitem', { name: 'Quyền riêng' }).click();
    const again = page.getByRole('dialog', { name: /Quyền riêng của/ });
    await expect(again.getByTestId('own-summary')).toHaveText('Đang thêm riêng 1 quyền và bớt riêng 1 quyền.');
    await again.getByRole('button', { name: 'Bỏ mọi chỉnh riêng' }).click();
    await again.getByRole('button', { name: 'Lưu quyền riêng' }).click();
    await expect(page.getByText(/Đã lưu quyền riêng của/)).toBeVisible();
    expect(await permissionsOf(browser, 'lan')).toEqual(await permissionsOf(browser, 'hung'));
  } finally {
    await it.context.close();
    await restore(browser);
  }
});

test('3. Không tự khoá mình ra: bớt "Chỉnh quyền" khỏi cả Chủ tịch lẫn Quản trị hệ thống thì lần lưu thứ hai bị từ chối', async ({ browser }) => {
  test.setTimeout(150_000);
  const it = await login(browser, 'it');
  const { page } = it;
  try {
    await page.goto('/to-chuc/phan-quyen');
    await expect(page.getByTestId('permission-matrix')).toBeVisible();
    await page.locator(ROLE_CELL('chairman', 'permission.manage')).click();
    await page.locator(ROLE_CELL('it_admin', 'permission.manage')).click();
    await expect(page.getByText('Có 2 vai trò chỉnh chưa lưu.')).toBeVisible();
    await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
    await expect(page.getByText(/sẽ không còn ai được chỉnh quyền nữa/)).toBeVisible();
    // Vai trò đầu đã lưu, vai trò sau bị chặn nên vẫn còn là thay đổi chưa lưu.
    await expect(page.getByText('Có 1 vai trò chỉnh chưa lưu.')).toBeVisible();
    expect(await permissionsOf(browser, 'it')).toContain('permission.manage');
  } finally {
    await it.context.close();
    await restore(browser);
  }
});

test('4. Văn phòng không có quyền Chỉnh quyền: không thấy tab, mở thẳng đường dẫn thì bị chuyển đi', async ({ browser }) => {
  const office = await login(browser, 'vanphong');
  try {
    await office.page.goto('/to-chuc');
    await expect(office.page.getByRole('link', { name: 'Phân quyền' })).toHaveCount(0);
    await office.page.goto('/to-chuc/phan-quyen');
    await expect(office.page).not.toHaveURL(/phan-quyen/);
    expect((await office.page.request.get('/v1/permissions')).status()).toBe(403);
  } finally {
    await office.context.close();
  }
});

test('5. Quyền về quy trình tách ba: người chỉ xuất bản duyệt nháp rồi xuất bản; người bị bớt quyền xuất bản không thấy nút Xuất bản', async ({ browser }) => {
  test.setTimeout(240_000);
  const it = await login(browser, 'it');
  const designer = await login(browser, 'thietke');
  const office = await login(browser, 'vanphong');
  try {
    // Bảng phân quyền có đủ ba hàng, nhóm đổi tên; mặc định Nhà thiết kế có cả ba, Văn phòng không có.
    await it.page.goto('/to-chuc');
    await it.page.getByRole('link', { name: 'Phân quyền' }).click();
    const table = it.page.getByTestId('permission-matrix');
    await expect(table.getByText('Tạo, xuất bản và lưu trữ quy trình', { exact: true })).toBeVisible();
    for (const label of ['Tạo và sửa quy trình', 'Xuất bản quy trình', 'Lưu trữ quy trình']) await expect(table.getByText(label, { exact: true })).toBeVisible();
    for (const action of ['template.edit', 'template.publish', 'template.archive']) {
      await expect(it.page.locator(ROLE_CELL('process_designer', action))).toBeChecked();
      await expect(it.page.locator(ROLE_CELL('office_admin', action))).not.toBeChecked();
    }

    // Văn phòng chỉ có quyền xuất bản: mở bản nháp ở chế độ chỉ xem, xuất bản được.
    const first = await cloneDonDoan(designer.page, `${TEMPLATE_PREFIX} A`);
    await setOverride(it.page, 'vanphong', ['template.publish'], []);
    await office.page.goto(`/quy-trinh/${first}`);
    const room = office.page.getByTestId('designer');
    await expect(room).toHaveAttribute('data-mode', 'review');
    await expect(office.page.getByTestId('review-note')).toBeVisible();
    await expect(office.page.getByTestId('save-draft')).toHaveCount(0);
    await expect(office.page.getByTestId('validate')).toHaveCount(0);
    await office.page.getByTestId('publish').click();
    await office.page.getByRole('button', { name: 'Xuất bản phiên bản 1' }).click();
    await expect(office.page.getByTestId('published-dialog')).toBeVisible();
    await setOverride(it.page, 'vanphong', [], []);

    // Nhà thiết kế bị bớt quyền xuất bản: vẫn sửa được, không có nút Xuất bản, có lời giải thích.
    await setOverride(it.page, 'thietke', [], ['template.publish']);
    const second = await cloneDonDoan(designer.page, `${TEMPLATE_PREFIX} B`);
    await designer.page.goto(`/quy-trinh/${second}`);
    await expect(designer.page.getByTestId('designer')).toHaveAttribute('data-mode', 'edit');
    await expect(designer.page.getByTestId('save-draft')).toBeVisible();
    await expect(designer.page.getByTestId('publish')).toHaveCount(0);
    await expect(designer.page.getByTestId('no-publish')).toBeVisible();
  } finally {
    await it.context.close();
    await designer.context.close();
    await office.context.close();
    await restore(browser);
  }
});
