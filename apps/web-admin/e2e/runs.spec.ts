/**
 * Kịch bản vàng rút gọn của các màn Lượt chạy, Công việc và Việc của tôi, chạy trên API thật với dữ liệu mẫu (SPEC 13.2, 15.4).
 *
 * Chuẩn bị: API ở cổng 3100 (pnpm db:seed rồi pnpm --filter @mihato/api dev) và web quản trị đang chạy.
 * Chạy (từ apps/web-admin):
 *   npx playwright test e2e/runs.spec.ts                                   (web ở cổng 5273)
 *   WEB_URL=http://127.0.0.1:5275 npx playwright test e2e/runs.spec.ts     (web ở cổng khác)
 * Biến môi trường: WEB_URL, DEMO_PASSWORD, SHOTS_DIR (nơi lưu ảnh chụp từng màn, mặc định test-results/runs-shots).
 *
 * Các bước chạy nối tiếp và dùng chung một lượt chạy do bước 1 tạo ra:
 *   1. Văn phòng khởi chạy "Đón đoàn": cảnh báo hạn đã qua, bản xem trước 6 việc (không còn chỗ đổi người), khởi chạy.
 *   2. Lan báo hoàn thành ở Việc của tôi (điện thoại 390×844); tab Nhóm của tôi.
 *   3. Phương nhập số tiền 20.000.000 và báo hoàn thành.
 *   4. Huy duyệt việc có tiền: 403 step_up_required, hỏi lại mật khẩu, duyệt được.
 *   5. Tuấn bấm Đã nhận; lỗi 409 khi việc đổi trạng thái giữa chừng, ghi chú vẫn giữ.
 *   6. Ngọc Anh nhận lời đi thúc, trả lời nhanh bằng Báo vướng (nudgeId), rồi Xin thêm thời gian.
 *   7. Văn phòng: chi tiết lượt chạy (tiến độ, sơ đồ, dòng thời gian), duyệt gia hạn, giao lại, gia hạn, ghi chú,
 *      tự làm mới qua SSE, đi thúc lượt mẫu, lọc và xuất CSV (kiểm BOM), huỷ lượt chạy bằng cách gõ lại tên.
 *   8. Lượt chạy thứ hai: gia hạn và giao lại hàng loạt, bỏ qua bước, Huy chưa đồng ý.
 *   9. Việc của tôi ở 1280, 390 và 360: không tràn ngang.
 *  10. Giao một việc ngoài quy trình: Văn phòng giao cho tuỳ ý, giao lại cho ai cũng được, người nhận thấy "Việc giao riêng".
 *
 * Việc trong quy trình chỉ giao lại được cho người được bổ nhiệm hoặc người được ủy quyền (docs/DECISIONS.md, 05/10/2026), nên các bước
 * giao lại ở 7 và 8 dựng ủy quyền tạm bằng tài khoản IT rồi gỡ ngay sau khi giao lại.
 *
 * Kịch bản tự khởi chạy lượt "Đón đoàn" mới để thử các thao tác (kể cả huỷ, bỏ qua), không huỷ ba lượt mẫu; mỗi lần chạy
 * để lại hai lượt "Đón đoàn kiểm thử …" ở trạng thái đã huỷ. Riêng bước đi thúc dùng việc đang chậm của lượt mẫu
 * "Đón đoàn nhà đầu tư Nhật Bản"; nếu bị chặn làm phiền (đã nhắc hôm nay…) thì ghi lại lý do và coi là đạt.
 * Kịch bản dời giờ yên tĩnh của tổ chức ra khỏi giờ chạy (cần tài khoản it@) rồi trả lại khi xong, để chạy lúc nào cũng được.
 * Mỗi tài khoản chỉ đăng nhập một lần rồi dùng lại phiên, vì API giới hạn 10 lần đăng nhập mỗi phút.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** Cùng quy ước với playwright.config.ts: WEB_URL khi web chạy ở cổng khác 5273. */
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5273';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'mihato-demo-2026';
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/runs-shots';

const TEMPLATE = 'Đón đoàn nhà đầu tư thăm KCN';
const SAMPLE_LATE_RUN = 'Đón đoàn nhà đầu tư Nhật Bản';
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

type User = 'vanphong' | 'lan' | 'phuong' | 'huy' | 'tuan' | 'ngocanh' | 'it';

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEB_URL, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });

/** Tên lượt chạy riêng cho mỗi lần chạy kịch bản, để tìm đúng việc giữa dữ liệu mẫu. */
const stamp = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(5, 19).replace(/[-:]/g, '').replace('T', '-');
const runTitle = `Đón đoàn kiểm thử ${stamp}`;
let runId = '';

/** Ngày 'YYYY-MM-DD' (giờ Việt Nam) cách hôm nay `n` ngày làm việc, coi thứ Hai đến thứ Sáu là ngày làm việc. */
function workingDaysFromToday(n: number): string {
  const d = new Date(Date.now() + 7 * 3_600_000);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
/** Phiên đã đăng nhập của từng người: mỗi tài khoản chỉ đăng nhập một lần, vì API giới hạn số lần đăng nhập mỗi phút. */
const sessions = new Map<User, Session>();

/**
 * Mở một ngữ cảnh trình duyệt đã đăng nhập. `fresh` buộc đăng nhập lại để có phiên mới: API giới hạn 120 yêu cầu
 * mỗi phút cho mỗi phiên, nên bước nào gọi dồn dập thì dùng phiên riêng.
 */
async function login(browser: Browser, user: User, viewport = DESKTOP, fresh = false): Promise<{ context: BrowserContext; page: Page }> {
  const options = { baseURL: WEB_URL, viewport, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', hasTouch: viewport.width < 500, acceptDownloads: true };
  const saved = fresh ? undefined : sessions.get(user);
  if (saved) {
    const context = await browser.newContext({ ...options, storageState: saved });
    return { context, page: await context.newPage() };
  }

  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto('/dang-nhap');
  const email = page.getByLabel('Email');
  const address = `${user}@demo.mihato.local`;
  // Thử lại khi (a) trang ở chế độ phát triển vẽ lại ngay sau lần tải đầu và làm trống ô vừa điền,
  // hoặc (b) API báo quá số lần đăng nhập mỗi phút (dùng chung với người khác trên cùng máy).
  await expect(async () => {
    await email.fill(address);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(PASSWORD);
    await expect(email).toHaveValue(address, { timeout: 500 });
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/dang-nhap'), { timeout: 8_000 });
  }).toPass({ timeout: 100_000, intervals: [1_000, 5_000, 15_000, 20_000] });
  if (!fresh) sessions.set(user, await context.storageState());
  return { context, page };
}

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  // Chờ dữ liệu và phông chữ ổn định để ảnh không dính khung giữ chỗ.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(400);
  // Ảnh cả trang chụp từ đầu trang, để thanh trên và thanh bên (dính) không nằm giữa ảnh.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

/** Mở thẻ việc của đúng lượt chạy kiểm thử ở "Việc của tôi". */
async function openMyStep(page: Page, stepTitle: string): Promise<void> {
  await page.goto('/viec-cua-toi');
  const card = page.getByRole('link', { name: stepTitle, exact: true }).filter({ hasText: runTitle });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByRole('heading', { level: 1, name: stepTitle })).toBeVisible();
  await expect(page.getByText(runTitle)).toBeVisible();
}

/** Gọi thẳng API bằng phiên đăng nhập của trang (cookie phiên, CSRF, khoá chống lặp) để dựng tình huống. */
async function apiSend(page: Page, method: 'POST' | 'PATCH', path: string, data: unknown = {}) {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'mihato_csrf')?.value ?? '';
  return page.request.fetch(path, { method, headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' }, data });
}
const apiPost = (page: Page, path: string, data: unknown = {}) => apiSend(page, 'POST', path, data);

/**
 * Ủy quyền tạm `from` → `to` (mọi việc, tài khoản IT tạo) để giao lại được. Việc trong quy trình chỉ giao lại cho người được bổ nhiệm
 * hoặc người được ủy quyền (docs/DECISIONS.md, 05/10/2026). Trả hàm gỡ ủy quyền: gỡ NGAY sau khi giao lại, kẻo việc tới lượt sau
 * bị chuyển thẳng cho người được ủy quyền.
 */
async function lend(browser: Browser, from: User, to: User): Promise<() => Promise<void>> {
  const admin = await login(browser, 'it', DESKTOP, true);
  try {
    const idOf = async (user: User): Promise<string> => {
      const res = await admin.page.request.get(`/v1/users?q=${user}@demo.mihato.local&limit=5`);
      expect(res.ok(), `tìm ${user}`).toBe(true);
      const found = ((await res.json()) as { items: { id: string; email: string | null }[] }).items.find((u) => u.email === `${user}@demo.mihato.local`);
      expect(found, `không thấy ${user}`).toBeTruthy();
      return found!.id;
    };
    const now = Date.now();
    const created = await apiPost(admin.page, '/v1/delegations', {
      fromUserId: await idOf(from),
      toUserId: await idOf(to),
      validFrom: new Date(now - 3_600_000).toISOString(),
      validTo: new Date(now + 24 * 3_600_000).toISOString(),
      scope: 'all',
      scopeRef: null,
    });
    expect(created.status(), `ủy quyền ${from} → ${to}`).toBe(201);
    const { id } = (await created.json()) as { id: string };
    return async () => {
      const again = await login(browser, 'it', DESKTOP, true);
      try {
        const csrf = (await again.page.context().cookies()).find((c) => c.name === 'mihato_csrf')?.value ?? '';
        const res = await again.page.request.delete(`/v1/delegations/${id}`, { headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() } });
        expect(res.ok(), 'gỡ ủy quyền').toBe(true);
      } finally {
        await again.context.close();
      }
    };
  } finally {
    await admin.context.close();
  }
}

/**
 * Lời đi thúc bị chặn khi tổ chức CÓ đặt giờ yên tĩnh (SPEC 4.6), nên bước 6 đỏ nếu chạy kịch bản vào buổi tối. Mặc định tổ chức
 * không có giờ yên tĩnh (docs/DECISIONS.md, 04/10/2026). Để kết quả không phụ thuộc cấu hình và giờ máy: trước khi chạy, tắt giờ
 * yên tĩnh (null); chạy xong trả lại đúng giá trị cũ, kể cả khi cũ là "không có".
 */
type QuietHours = { start: string; end: string };
let quietBefore: QuietHours | null | undefined;

async function setQuietHours(browser: Browser, quiet: QuietHours | null): Promise<QuietHours | null> {
  const admin = await login(browser, 'it', DESKTOP, true);
  try {
    const current = await admin.page.request.get('/v1/org/settings');
    expect(current.ok(), 'đọc cấu hình tổ chức').toBe(true);
    const before = ((await current.json()) as { quietHours: QuietHours | null }).quietHours;
    const patched = await apiSend(admin.page, 'PATCH', '/v1/org/settings', { quietHours: quiet });
    expect(patched.ok(), `đổi giờ yên tĩnh: ${patched.status()}`).toBe(true);
    return before;
  } finally {
    await admin.context.close();
  }
}

test.beforeAll(async ({ browser }) => {
  quietBefore = await setQuietHours(browser, null);
});

test.afterAll(async ({ browser }) => {
  if (quietBefore !== undefined) await setQuietHours(browser, quietBefore);
});

/** Một dòng trong "Danh sách việc" của chi tiết lượt chạy. */
function stepRow(page: Page, stepTitle: string) {
  return page.getByRole('region', { name: 'Danh sách việc' }).getByRole('listitem').filter({ hasText: stepTitle });
}

test('1. Văn phòng khởi chạy "Đón đoàn": bản xem trước đủ 6 việc, 6 người nhận, 6 hạn', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await login(browser, 'vanphong');

  await page.goto('/luot-chay');
  await expect(page.getByRole('heading', { level: 1, name: 'Lượt chạy' })).toBeVisible();
  // Các lần chạy kiểm thử để lại nhiều lượt mới hơn, đẩy lượt mẫu xuống trang sau: tìm theo tên thay vì mong thấy ngay ở trang đầu.
  await page.getByRole('searchbox', { name: 'Tìm theo tên lượt chạy' }).or(page.getByPlaceholder('Tìm theo tên lượt chạy')).first().fill(SAMPLE_LATE_RUN);
  await expect(page.getByRole('link', { name: SAMPLE_LATE_RUN })).toBeVisible();
  await expect(page.getByText('Chậm 2 ngày làm việc').or(page.getByText(/Chậm \d+ ngày làm việc|Đang chậm/)).first()).toBeVisible();
  await shot(page, '01-luot-chay-1280');

  await page.getByRole('link', { name: 'Khởi chạy mới' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Khởi chạy lượt chạy mới' })).toBeVisible();

  const template = page.getByRole('combobox', { name: /Quy trình/ });
  if (!(await template.textContent())?.includes(TEMPLATE)) {
    await template.click();
    await page.getByRole('option', { name: TEMPLATE, exact: true }).click();
  }
  await page.getByLabel(/Tên lượt chạy/).fill(runTitle);
  await page.getByLabel(/Tên đoàn/).fill('Đoàn kiểm thử tự động');

  // Ngày đến quá gần: mọi hạn tính lùi đều đã qua. Phải thấy cảnh báo và chưa bấm khởi chạy được.
  const visitDate = page.getByLabel(/Ngày đoàn đến/);
  await visitDate.fill(workingDaysFromToday(1));
  const preview = page.getByTestId('preview-table');
  await expect(preview.getByRole('row')).toHaveCount(7);
  await expect(page.getByText(/Có \d+ việc mà hạn đã qua ngay lúc khởi chạy/)).toBeVisible();
  await expect(preview.getByText('Hạn đã qua').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Khởi chạy', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await shot(page, '02-khoi-chay-han-da-qua-1280');

  // Ngày đến cách hôm nay 10 ngày làm việc: không còn hạn nào đã qua.
  await visitDate.fill(workingDaysFromToday(10));
  await expect(page.getByText(/hạn đã qua ngay lúc khởi chạy/)).toHaveCount(0);
  await expect(page.getByTestId('preview-summary')).toHaveText('6 việc, 6 người nhận');
  const rows = preview.locator('tbody tr');
  await expect(rows).toHaveCount(6);
  for (let i = 0; i < 6; i += 1) {
    const row = rows.nth(i);
    await expect(row.getByText('Cần giao người')).toHaveCount(0);
    await expect(row.locator('td').nth(2)).toContainText(/(anh|chị|ông|bà) \S+/);
    await expect(row.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
    await expect(row.getByText('Hạn đã qua')).toHaveCount(0);
  }

  // Người nhận do quy trình chỉ định: bản xem trước không còn chỗ đổi người lúc khởi chạy (docs/DECISIONS.md, 05/10/2026).
  await expect(page.getByRole('button', { name: /Đổi người nhận việc|Chọn người nhận việc/ })).toHaveCount(0);
  await expect(page.getByTestId('preview-summary')).toHaveText('6 việc, 6 người nhận');
  await shot(page, '03-khoi-chay-xem-truoc-1280');

  const submit = page.getByRole('button', { name: 'Khởi chạy', exact: true });
  await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
  await submit.click();
  await page.waitForURL(/\/luot-chay\/[0-9a-f-]{36}$/);
  runId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect(page.getByRole('heading', { level: 1, name: runTitle })).toBeVisible();
  await expect(page.getByText('0 trên 6 việc đã xong')).toBeVisible();
  await context.close();
});

test('2. Lan báo hoàn thành "Lập chương trình đón đoàn" ở Việc của tôi (điện thoại 390×844)', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await login(browser, 'lan', PHONE);

  await page.goto('/viec-cua-toi');
  await expect(page.getByRole('heading', { level: 1, name: 'Việc của tôi' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Cần làm/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Nhóm của tôi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lập chương trình đón đoàn', exact: true }).filter({ hasText: runTitle })).toBeVisible();
  // Không tràn ngang ở bề rộng điện thoại.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, '04-viec-cua-toi-390');

  await openMyStep(page, 'Lập chương trình đón đoàn');
  await shot(page, '05-viec-chi-tiet-390');
  await page.getByRole('button', { name: 'Báo hoàn thành' }).click();
  const dialog = page.getByRole('dialog', { name: 'Báo hoàn thành' });
  await dialog.getByLabel(/Ghi chú/).fill('Đã gửi chương trình cho các bên.');
  await shot(page, '06-bao-hoan-thanh-390', false);
  await dialog.getByRole('button', { name: 'Báo hoàn thành' }).click();
  await expect(page.getByText('Đã báo hoàn thành.')).toBeVisible();
  await expect(page.getByText(/Việc này đã xong lúc/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Báo hoàn thành' })).toHaveCount(0);

  // Trưởng đơn vị có tab "Nhóm của tôi".
  await page.goto('/viec-cua-toi?tab=team');
  await expect(page.getByRole('tab', { name: 'Nhóm của tôi' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, '07-nhom-cua-toi-390');
  // Việc của người trong đơn vị (anh Hùng, lượt mẫu) có nút đổi người nhận; chỉ mở hộp thoại, không đổi dữ liệu mẫu.
  await page.getByRole('button', { name: /Đổi người nhận việc/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Giao lại việc' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Không có nút làm thay ở việc của người khác.
  await expect(page.getByRole('button', { name: /Báo hoàn thành|Đồng ý/ })).toHaveCount(0);
  await context.close();
});

test('3. Phương nhập số tiền 20.000.000 và báo hoàn thành "Lập đề nghị tạm ứng"', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await login(browser, 'phuong');

  await openMyStep(page, 'Lập đề nghị tạm ứng');
  await page.getByRole('button', { name: 'Báo hoàn thành' }).click();
  const dialog = page.getByRole('dialog', { name: 'Báo hoàn thành' });

  // Ô bắt buộc còn trống thì chưa gửi được.
  await dialog.getByRole('button', { name: 'Báo hoàn thành' }).click();
  await expect(dialog.getByText('Xin điền ô này.')).toBeVisible();

  await dialog.getByLabel(/Số tiền đề nghị tạm ứng/).fill('20000000');
  await expect(dialog.getByText('Sẽ ghi là 20.000.000 đồng')).toBeVisible();
  await shot(page, '08-bao-hoan-thanh-so-tien-1280', false);
  await dialog.getByRole('button', { name: 'Báo hoàn thành' }).click();
  await expect(page.getByText('Đã báo hoàn thành.')).toBeVisible();
  await expect(page.getByText('Kết quả đã nhập')).toBeVisible();
  await expect(page.getByText('20.000.000 đồng')).toBeVisible();
  await context.close();
});

test('4. Huy duyệt: thiếu nâng quyền thì bị hỏi lại, nhập mật khẩu thì duyệt được', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await login(browser, 'huy');

  await openMyStep(page, 'Duyệt đề nghị tạm ứng');
  await expect(page.getByRole('heading', { name: 'Nội dung cần duyệt' })).toBeVisible();
  await expect(page.getByText('20.000.000 đồng').first()).toBeVisible();
  await shot(page, '09-duyet-1280');

  // Gọi thẳng API không kèm mã nâng quyền: máy chủ phải trả 403 step_up_required.
  const stepId = new URL(page.url()).pathname.split('/').pop() ?? '';
  const bare = await apiPost(page, `/v1/steps/${stepId}/approve`);
  expect(bare.status()).toBe(403);
  expect(((await bare.json()) as { code?: string }).code).toBe('step_up_required');

  // Trên giao diện: lần gửi đầu bị gỡ mã nâng quyền trên đường đi, máy chủ trả 403 và màn hình phải hỏi lại.
  let stripped = 0;
  await page.route('**/v1/steps/*/approve', async (route) => {
    if (stripped === 0) {
      stripped += 1;
      const headers = { ...route.request().headers() };
      delete headers['x-step-up-token'];
      await route.continue({ headers });
    } else {
      await route.continue();
    }
  });

  await page.getByRole('button', { name: 'Đồng ý', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Ý kiến/).fill('Đồng ý tạm ứng theo đề nghị.');
  await dialog.getByRole('button', { name: 'Đồng ý', exact: true }).click();

  await expect(dialog.getByRole('heading', { name: 'Xác nhận lại danh tính' })).toBeVisible();
  await shot(page, '10-nang-quyen-1280', false);

  // Để trống mật khẩu: báo ngay tại ô, không gọi máy chủ (không thử mật khẩu sai để khỏi khoá tài khoản mẫu).
  await dialog.getByRole('button', { name: 'Xác nhận và đồng ý' }).click();
  await expect(dialog.getByText('Xin nhập mật khẩu.')).toBeVisible();

  // Mật khẩu đúng nhưng lời duyệt tới máy chủ thiếu mã: bị hỏi lại.
  await dialog.getByLabel(/^Mật khẩu/).fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Xác nhận và đồng ý' }).click();
  await expect(dialog.getByText(/Lần xác nhận trước đã hết hiệu lực hoặc chưa được ghi nhận/)).toBeVisible();
  expect(stripped).toBe(1);

  // Nhập lại mật khẩu: duyệt được.
  await dialog.getByLabel(/^Mật khẩu/).fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Xác nhận và đồng ý' }).click();
  await expect(page.getByText('Đã đồng ý.')).toBeVisible();
  await expect(page.getByText(/Việc này đã xong lúc/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đồng ý', exact: true })).toHaveCount(0);
  await context.close();
});

test('5. Tuấn bấm Đã nhận; việc đổi trạng thái giữa chừng thì lỗi 409 được nói rõ và ghi chú vẫn còn', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await login(browser, 'tuan');

  await openMyStep(page, 'Kiểm tra tuyến tham quan');
  await page.getByRole('button', { name: 'Đã nhận' }).click();
  await expect(page.getByText('Đã ghi nhận: tôi đã nhận việc.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đã nhận' })).toHaveCount(0);
  await expect(page.getByText('Đang làm').first()).toBeVisible();

  await page.getByRole('button', { name: 'Báo hoàn thành' }).click();
  const dialog = page.getByRole('dialog', { name: 'Báo hoàn thành' });
  const note = 'Đã đi kiểm tra tuyến, biên bản gửi sau.';
  await dialog.getByLabel(/Ghi chú/).fill(note);

  // Trong lúc hộp thoại đang mở, việc được báo xong ở nơi khác (ở đây: gọi thẳng API bằng chính phiên này).
  const stepId = new URL(page.url()).pathname.split('/').pop() ?? '';
  const elsewhere = await apiPost(page, `/v1/steps/${stepId}/complete`);
  expect(elsewhere.ok()).toBe(true);

  await dialog.getByRole('button', { name: 'Báo hoàn thành' }).click();
  await expect(dialog.getByText(/Việc này vừa thay đổi .* Nội dung vừa nhập vẫn giữ nguyên/)).toBeVisible();
  await expect(dialog.getByLabel(/Ghi chú/)).toHaveValue(note);
  await shot(page, '10b-loi-409-giu-ghi-chu-1280', false);
  await dialog.getByRole('button', { name: 'Đóng' }).first().click();
  await expect(page.getByText(/Việc này đã xong lúc/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Báo hoàn thành' })).toHaveCount(0);
  await context.close();
});

test('6. Ngọc Anh báo vướng và xin thêm thời gian cho "Hồ sơ pháp lý đất và tài liệu giới thiệu"', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await login(browser, 'ngocanh', PHONE);

  await openMyStep(page, 'Hồ sơ pháp lý đất và tài liệu giới thiệu');

  // Văn phòng gửi một lời đi thúc cho việc này (qua API, nêu đích danh việc chưa quá hạn) để có lời nhắc đang mở.
  const stepId = new URL(page.url()).pathname.split('/').pop() ?? '';
  const office = await login(browser, 'vanphong');
  const message = 'Văn phòng Chủ tịch nhắc chị Ngọc Anh: xin cho biết tiến độ hồ sơ pháp lý.';
  const sent = await apiPost(office.page, '/v1/nudges', { items: [{ stepId, message }], allowNotOverdue: true });
  expect(sent.ok()).toBe(true);
  const sentResult = ((await sent.json()) as { results: { ok: boolean; error?: { code: string } }[] }).results[0];
  await office.context.close();
  expect(sentResult?.ok, `đi thúc qua API: ${sentResult?.error?.code ?? ''}`).toBe(true);

  // Lời nhắc hiện ở trang việc (tự làm mới qua SSE) kèm ba nút trả lời nhanh.
  const openNudge = page.getByRole('region', { name: 'Lời nhắc đang chờ trả lời' });
  await expect(openNudge).toBeVisible({ timeout: 15_000 });
  await expect(openNudge.getByText(message)).toBeVisible();
  for (const reply of ['Đã xong', 'Cần thêm thời gian', 'Đang vướng, cần hỗ trợ']) {
    await expect(openNudge.getByRole('button', { name: reply })).toBeVisible();
  }
  await shot(page, '10c-loi-nhac-tra-loi-nhanh-390');

  // Trả lời nhanh "Đang vướng, cần hỗ trợ": mở Báo vướng và gửi kèm nudgeId.
  await openNudge.getByRole('button', { name: 'Đang vướng, cần hỗ trợ' }).click();
  const block = page.getByRole('dialog', { name: 'Báo vướng' });
  await expect(block.getByText(/Lời nhắc sẽ được trả lời là/)).toBeVisible();
  await block.getByRole('button', { name: 'Gửi báo vướng' }).click();
  await expect(block.getByText('Xin chọn một lý do.')).toBeVisible();
  await block.getByRole('radio', { name: 'Chờ người khác' }).check();
  await block.getByLabel(/Ghi chú/).fill('Chờ phòng Kỹ thuật gửi bản đồ lô đất.');
  await shot(page, '10c-bao-vuong-390', false);
  const blockRequest = page.waitForRequest((r) => r.url().endsWith(`/v1/steps/${stepId}/block`) && r.method() === 'POST');
  await block.getByRole('button', { name: 'Gửi báo vướng' }).click();
  expect((await blockRequest).postDataJSON()).toMatchObject({ reasonCode: 'waiting_on_other', nudgeId: expect.any(String) });
  await expect(page.getByText(/Đã báo vướng\./)).toBeVisible();
  await expect(page.getByText(/Đang vướng: /)).toBeVisible();
  // Lời nhắc đã được trả lời: không còn khối "đang chờ trả lời", và lịch sử ghi câu trả lời.
  await expect(openNudge).toHaveCount(0);
  await expect(page.getByText('Đã trả lời: Đang vướng, cần hỗ trợ')).toBeVisible();

  await page.getByRole('button', { name: 'Xin thêm thời gian' }).click();
  const extension = page.getByRole('dialog', { name: 'Xin thêm thời gian' });
  await extension.getByRole('button', { name: 'Gửi yêu cầu' }).click();
  await expect(extension.getByText('Xin chọn ngày và giờ của hạn đề nghị.')).toBeVisible();
  await extension.getByLabel(/Hạn đề nghị/).fill(workingDaysFromToday(7));
  await extension.getByRole('button', { name: 'Chờ thông tin từ bên khác' }).click();
  await shot(page, '10d-xin-them-thoi-gian-390', false);
  await extension.getByRole('button', { name: 'Gửi yêu cầu' }).click();
  await expect(page.getByText('Đã gửi yêu cầu. Người giao sẽ duyệt.')).toBeVisible();
  await expect(page.getByText(/Đang chờ duyệt hạn mới/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, '10e-viec-dang-vuong-cho-duyet-390');
  await context.close();
});

test('7. Văn phòng xem chi tiết lượt chạy, duyệt gia hạn, giao lại, gia hạn, ghi chú, đi thúc, huỷ; xuất CSV có BOM', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const { context, page } = await login(browser, 'vanphong');

  // ── Chi tiết lượt chạy: tiến độ, sơ đồ, dòng thời gian khớp với ba việc vừa xong ──
  await page.goto(`/luot-chay/${runId}`);
  await expect(page.getByRole('heading', { level: 1, name: runTitle })).toBeVisible();
  await expect(page.getByText('4 trên 6 việc đã xong')).toBeVisible();
  await expect(page.getByText('Đúng tiến độ')).toBeVisible();

  const diagram = page.getByTestId('run-diagram');
  await expect(diagram.locator('.react-flow__node')).toHaveCount(8);
  for (const title of ['Lập chương trình đón đoàn', 'Lập đề nghị tạm ứng', 'Duyệt đề nghị tạm ứng', 'Kiểm tra tuyến tham quan']) {
    await expect(diagram.getByRole('button', { name: `Xem việc ${title}, Xong` })).toBeVisible();
  }
  await expect(diagram.getByRole('button', { name: 'Xem việc Hồ sơ pháp lý đất và tài liệu giới thiệu, Mới giao' })).toBeVisible();
  await expect(diagram.getByText('Chờ việc trước')).toBeVisible();

  const timeline = page.getByRole('region', { name: 'Dòng thời gian' });
  await expect(timeline.getByText(/Chị Lan báo hoàn thành việc Lập chương trình đón đoàn/)).toBeVisible();
  await expect(timeline.getByText(/Chị Phương báo hoàn thành việc Lập đề nghị tạm ứng/)).toBeVisible();
  await expect(timeline.getByText(/Ông Huy đồng ý ở bước Duyệt đề nghị tạm ứng/)).toBeVisible();
  await expect(timeline.getByText(/Anh Tuấn đã nhận việc Kiểm tra tuyến tham quan/)).toBeVisible();
  await expect(timeline.getByText(/Chị Ngọc Anh báo vướng ở việc Hồ sơ pháp lý đất và tài liệu giới thiệu \(Chờ người khác\)/)).toBeVisible();
  await expect(timeline.getByText(/Chị Ngọc Anh xin thêm thời gian cho việc Hồ sơ pháp lý đất và tài liệu giới thiệu đến/)).toBeVisible();
  await expect(timeline.getByText(/khởi chạy lượt chạy/)).toBeVisible();

  await expect(stepRow(page, 'Duyệt đề nghị tạm ứng').getByText('Số tiền cần duyệt: 20.000.000 đồng')).toBeVisible();
  await shot(page, '11-chi-tiet-luot-chay-1280');

  // Bảng trượt chi tiết việc: kết quả đã nhập và lịch sử.
  await page.getByRole('button', { name: 'Xem chi tiết việc Lập đề nghị tạm ứng' }).click();
  const sheet = page.getByRole('dialog', { name: 'Lập đề nghị tạm ứng' });
  await expect(sheet.getByText('Kết quả đã nhập')).toBeVisible();
  await expect(sheet.getByText('20.000.000 đồng')).toBeVisible();
  await expect(sheet.getByText('Lịch sử')).toBeVisible();
  await shot(page, '12-bang-truot-viec-1280', false);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // ── Việc đang vướng và có yêu cầu gia hạn chờ duyệt: quyết định ngay trên dòng ──
  const legal = stepRow(page, 'Hồ sơ pháp lý đất và tài liệu giới thiệu');
  await expect(legal.getByText(/Đang vướng: /)).toBeVisible();
  await expect(legal.getByText(/Xin gia hạn đến .*, đang chờ duyệt/)).toBeVisible();
  await legal.getByRole('button', { name: /Xem và quyết định yêu cầu gia hạn/ }).click();
  const decision = page.getByRole('dialog', { name: 'Yêu cầu gia hạn' });
  await expect(decision.getByText('Chờ thông tin từ bên khác')).toBeVisible();
  await shot(page, '12b-quyet-dinh-gia-han-1280', false);
  await decision.getByRole('button', { name: 'Duyệt gia hạn' }).click();
  await expect(page.getByText('Đã duyệt gia hạn.')).toBeVisible();
  await expect(legal.getByText(/Hạn gốc:/)).toBeVisible();
  await expect(legal.getByText(/đang chờ duyệt/)).toHaveCount(0);

  // ── Giao lại một việc: chỉ về người được bổ nhiệm hoặc người được ủy quyền (docs/DECISIONS.md, 05/10/2026) ──
  await legal.getByRole('button', { name: /Thao tác với việc Hồ sơ pháp lý/ }).click();
  await page.getByRole('menuitem', { name: 'Giao lại' }).click();
  const restricted = page.getByRole('dialog', { name: 'Giao lại việc' });
  await expect(restricted.getByText(/chỉ giao lại được cho người được bổ nhiệm hoặc người được ủy quyền/)).toBeVisible();
  // Chưa ai được ủy quyền thay chị Ngọc Anh: gõ tên chị Lan không ra ai.
  await restricted.getByRole('combobox').fill('Lan');
  await expect(page.getByRole('option', { name: /Nguyễn Thu Lan/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await restricted.getByRole('button', { name: 'Đóng' }).first().click();

  // Chị Ngọc Anh đi công tác nên ủy quyền cho chị Lan; từ lúc đó chị Lan là người nhận được.
  const unlend = await lend(browser, 'ngocanh', 'lan');
  await legal.getByRole('button', { name: /Thao tác với việc Hồ sơ pháp lý/ }).click();
  await page.getByRole('menuitem', { name: 'Giao lại' }).click();
  const reassign = page.getByRole('dialog', { name: 'Giao lại việc' });
  await reassign.getByRole('combobox').fill('Lan');
  await page.getByRole('option', { name: /Nguyễn Thu Lan/ }).click();
  await reassign.getByLabel(/Lý do giao lại/).fill('Chị Ngọc Anh đi công tác, chị Lan nhận thay.');
  await reassign.getByRole('button', { name: 'Giao lại' }).click();
  await expect(page.getByText('Đã giao lại việc cho chị Lan.')).toBeVisible();
  await unlend();
  await expect(legal).toContainText('chị Nguyễn Thu Lan');
  await expect(timeline.getByText(/giao lại việc Hồ sơ pháp lý đất và tài liệu giới thiệu cho chị Lan/)).toBeVisible();

  // ── Gia hạn một việc ──
  await legal.getByRole('button', { name: /Thao tác với việc Hồ sơ pháp lý/ }).click();
  await page.getByRole('menuitem', { name: 'Gia hạn' }).click();
  const extend = page.getByRole('dialog', { name: 'Gia hạn việc' });
  await extend.getByLabel(/Hạn mới/).fill(workingDaysFromToday(9));
  await extend.getByLabel(/Lý do gia hạn/).fill('Chị Lan mới nhận việc, cần thêm hai ngày.');
  await extend.getByRole('button', { name: 'Gia hạn' }).click();
  await expect(page.getByText(/Đã gia hạn việc đến/)).toBeVisible();
  await expect(legal.getByText(/Hạn gốc:/)).toBeVisible();
  await expect(timeline.getByText(/Văn phòng gia hạn việc Hồ sơ pháp lý đất và tài liệu giới thiệu đến/).first()).toBeVisible();

  // ── Ghi chú vào lượt chạy ──
  await page.getByRole('button', { name: 'Ghi chú' }).click();
  const noteDialog = page.getByRole('dialog', { name: 'Ghi chú vào lượt chạy' });
  await noteDialog.getByLabel(/Nội dung ghi chú/).fill('Đoàn xác nhận giữ nguyên ngày đến.');
  await noteDialog.getByRole('button', { name: 'Lưu ghi chú' }).click();
  await expect(page.getByText('Đã ghi chú vào lượt chạy.')).toBeVisible();
  await expect(timeline.getByText('Đoàn xác nhận giữ nguyên ngày đến.')).toBeVisible();

  // ── Tự làm mới bằng SSE: ghi chú tạo qua API hiện lên dòng thời gian mà không tải lại trang ──
  const viaApi = await apiPost(page, `/v1/runs/${runId}/notes`, { text: 'Ghi chú tạo qua API để kiểm tự làm mới.' });
  expect(viaApi.ok()).toBe(true);
  await expect(timeline.getByText('Ghi chú tạo qua API để kiểm tự làm mới.')).toBeVisible({ timeout: 15_000 });
  await shot(page, '13-sau-giao-lai-gia-han-1280');

  // ── Đi thúc một việc đang chậm của lượt mẫu ──
  await page.goto('/luot-chay');
  await page.getByLabel('Tìm theo tên lượt chạy').fill('Nhật Bản');
  await page.getByRole('link', { name: SAMPLE_LATE_RUN }).click();
  await expect(page.getByRole('heading', { level: 1, name: SAMPLE_LATE_RUN })).toBeVisible();
  await page.getByRole('button', { name: /Đi thúc( \d+)? việc chậm/ }).click();
  const nudge = page.getByRole('dialog', { name: 'Đi thúc' });
  await expect(nudge.getByRole('listitem').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, '14-di-thuc-1280', false);
  const send = nudge.getByRole('button', { name: /Gửi( \d+)? lời nhắc/ });
  if (await send.isEnabled()) {
    await send.click();
    await expect(page.getByRole('dialog', { name: 'Kết quả gửi' })).toBeVisible();
    const outcome = (await page.getByRole('dialog', { name: 'Kết quả gửi' }).getByRole('status').first().textContent()) ?? '';
    testInfo.annotations.push({ type: 'đi thúc', description: `Đã bấm gửi: ${outcome}` });
    console.log(`[đi thúc] Đã bấm gửi: ${outcome}`);
    await shot(page, '15-di-thuc-ket-qua-1280', false);
  } else {
    // Mọi lời nhắc đều bị chặn làm phiền: ghi lại lý do từng việc.
    const reasons = await nudge.getByText(/Hôm nay đã nhắc|giờ yên tĩnh|chưa quá hạn|chờ duyệt|không còn mở|chặn nhắc/).allTextContents();
    expect(reasons.length).toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'đi thúc', description: `Bị chặn làm phiền: ${reasons.join(' | ')}` });
    console.log(`[đi thúc] Bị chặn làm phiền: ${reasons.join(' | ')}`);
  }
  await page.keyboard.press('Escape');

  // ── Công việc: lọc theo lượt chạy, xuất CSV, kiểm BOM ──
  await page.goto('/cong-viec');
  await expect(page.getByRole('heading', { level: 1, name: 'Công việc' })).toBeVisible();
  await shot(page, '16-cong-viec-1280');
  await page.goto('/cong-viec?late=true');
  await expect(page.getByRole('switch', { name: 'Chỉ quá hạn' })).toBeChecked();
  await page.goto('/cong-viec?state=unassigned');
  await expect(page.getByRole('combobox', { name: 'Lọc theo trạng thái' })).toContainText('Cần giao người');
  await page.goto(`/cong-viec?runId=${runId}`);
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(6);

  // Chọn nhiều dòng: thanh thao tác hàng loạt hiện ra.
  await page.getByRole('checkbox', { name: 'Chọn dòng: Báo giá thuê nhà xưởng cho đoàn' }).click();
  await page.getByRole('checkbox', { name: 'Chọn dòng: Hồ sơ pháp lý đất và tài liệu giới thiệu' }).click();
  await expect(page.getByText('Đã chọn 2 việc')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Thao tác với các việc đã chọn' }).getByRole('button', { name: 'Giao lại' })).toBeVisible();
  await shot(page, '17-cong-viec-chon-nhieu-1280');
  await page.getByRole('button', { name: 'Bỏ chọn' }).click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Xuất CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^cong-viec-\d{4}-\d{2}-\d{2}\.csv$/);
  const file = await download.path();
  const bytes = await readFile(file);
  expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = bytes.subarray(3).toString('utf8').trimEnd().split('\r\n');
  expect(lines[0]).toBe('Lượt chạy,Việc,Người nhận,Đơn vị,Trạng thái,Hạn,Hạn gốc,Số ngày trễ,Ngày xong');
  expect(lines).toHaveLength(7);
  expect(lines.some((l) => l.startsWith(`${runTitle},Lập đề nghị tạm ứng,chị Đặng Mai Phương,Kế toán,Xong,`))).toBe(true);
  expect(lines.some((l) => l.includes('Hồ sơ pháp lý đất và tài liệu giới thiệu,chị Nguyễn Thu Lan'))).toBe(true);

  // ── Huỷ lượt chạy vừa tạo bằng cách gõ lại tên ──
  await page.goto(`/luot-chay/${runId}`);
  await page.getByRole('button', { name: 'Huỷ lượt chạy' }).click();
  const cancel = page.getByRole('dialog', { name: 'Huỷ lượt chạy' });
  await cancel.getByLabel(/Lý do huỷ/).fill('Lượt chạy kiểm thử tự động, huỷ sau khi kiểm xong.');
  // Tên gõ lại chưa trùng: nút huỷ còn khoá.
  await cancel.getByLabel(/Gõ lại tên lượt chạy/).fill('Tên sai');
  await expect(cancel.getByRole('button', { name: 'Huỷ lượt chạy' })).toHaveAttribute('aria-disabled', 'true');
  await cancel.getByLabel(/Gõ lại tên lượt chạy/).fill(runTitle);
  await expect(cancel.getByRole('button', { name: 'Huỷ lượt chạy' })).not.toHaveAttribute('aria-disabled', 'true');
  await shot(page, '18-huy-luot-chay-1280', false);
  await cancel.getByRole('button', { name: 'Huỷ lượt chạy' }).click();
  await expect(page.getByText('Đã huỷ lượt chạy.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Huỷ lượt chạy' })).toHaveCount(0);
  await expect(timeline.getByText(/huỷ lượt chạy/)).toBeVisible();
  await shot(page, '19-luot-chay-da-huy-1280');
  await context.close();
});

test('8. Lượt chạy thứ hai: gia hạn và giao lại hàng loạt, bỏ qua bước, Huy chưa đồng ý (bắt buộc lý do)', async ({ browser }) => {
  test.setTimeout(180_000);
  const title = `${runTitle} B`;
  const office = await login(browser, 'vanphong', DESKTOP, true);
  const { page } = office;

  // Dựng lượt chạy thứ hai bằng API (màn Khởi chạy mới đã kiểm ở bước 1).
  const templates = (await (await page.request.get('/v1/templates')).json()) as { items: { id: string; name: string }[] };
  const templateId = templates.items.find((item) => item.name === TEMPLATE)?.id ?? '';
  const created = await apiPost(page, '/v1/runs', { templateId, title, inputs: { delegation: 'Đoàn kiểm thử thứ hai', visitDate: workingDaysFromToday(12) } });
  expect(created.status()).toBe(201);
  const run = (await created.json()) as { id: string; steps: { id: string; title: string }[] };
  const stepIdOf = (stepTitle: string) => run.steps.find((step) => step.title === stepTitle)?.id ?? '';

  // Lan báo xong việc đầu (API) để hai việc kế tiếp tới lượt.
  const lan = await login(browser, 'lan');
  expect((await apiPost(lan.page, `/v1/steps/${stepIdOf('Lập chương trình đón đoàn')}/complete`)).ok()).toBe(true);
  await lan.context.close();

  // ── Công việc: chọn hai việc đang mở, gia hạn rồi giao lại hàng loạt (steps.batch) ──
  await page.goto(`/cong-viec?runId=${run.id}`);
  const table = page.getByRole('table');
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await page.getByRole('checkbox', { name: 'Chọn dòng: Kiểm tra tuyến tham quan' }).click();
  await page.getByRole('checkbox', { name: 'Chọn dòng: Hồ sơ pháp lý đất và tài liệu giới thiệu' }).click();
  const bulk = page.getByRole('region', { name: 'Thao tác với các việc đã chọn' });
  await bulk.getByRole('button', { name: 'Gia hạn' }).click();
  const extend = page.getByRole('dialog', { name: 'Gia hạn 2 việc' });
  await extend.getByLabel(/Hạn mới/).fill(workingDaysFromToday(10));
  await extend.getByLabel(/Lý do gia hạn/).fill('Dời cả hai việc theo lịch mới của đoàn.');
  await extend.getByRole('button', { name: 'Gia hạn' }).click();
  await expect(page.getByText(/Đã gia hạn 2 việc đến/)).toBeVisible();
  await expect(table.getByText(/Hạn gốc:/)).toHaveCount(2);

  // Hai việc của hai người khác nhau: chỉ giao chung cho một người được khi người đó được cả hai ủy quyền.
  const unlendTuan = await lend(browser, 'tuan', 'hung');
  const unlendNgocAnh = await lend(browser, 'ngocanh', 'hung');
  await page.reload();
  await page.getByRole('checkbox', { name: 'Chọn dòng: Kiểm tra tuyến tham quan' }).click();
  await page.getByRole('checkbox', { name: 'Chọn dòng: Hồ sơ pháp lý đất và tài liệu giới thiệu' }).click();
  await bulk.getByRole('button', { name: 'Giao lại' }).click();
  const reassign = page.getByRole('dialog', { name: 'Giao lại 2 việc' });
  // Người ngoài quy trình (chị Lan) không nằm trong danh sách; anh Hùng được cả hai ủy quyền nên chọn được.
  await reassign.getByRole('combobox').fill('Lan');
  await expect(page.getByRole('option', { name: /Nguyễn Thu Lan/ })).toHaveCount(0);
  await reassign.getByRole('combobox').fill('Hùng');
  await page.getByRole('option', { name: /Võ Hoàng Hùng/ }).click();
  await reassign.getByLabel(/Lý do giao lại/).fill('Anh Hùng phụ trách cả hai việc của đoàn này.');
  await shot(page, '23-giao-lai-hang-loat-1280', false);
  await reassign.getByRole('button', { name: 'Giao lại' }).click();
  await expect(page.getByText('Đã giao lại 2 việc cho anh Hùng.')).toBeVisible();
  await expect(table.getByText('anh Võ Hoàng Hùng')).toHaveCount(2);
  await unlendTuan();
  await unlendNgocAnh();

  // ── Chi tiết lượt chạy: bỏ qua một bước đang chờ ──
  await page.goto(`/luot-chay/${run.id}`);
  const quote = stepRow(page, 'Báo giá thuê nhà xưởng cho đoàn');
  await quote.getByRole('button', { name: /Thao tác với việc Báo giá/ }).click();
  await page.getByRole('menuitem', { name: 'Bỏ qua bước' }).click();
  const skip = page.getByRole('dialog', { name: 'Bỏ qua bước' });
  await skip.getByLabel(/Lý do bỏ qua/).fill('Đoàn này không cần báo giá thuê xưởng.');
  await skip.getByRole('button', { name: 'Bỏ qua bước' }).click();
  await expect(page.getByText('Đã bỏ qua bước.')).toBeVisible();
  await expect(quote.getByText('Không cần làm')).toBeVisible();
  await expect(page.getByTestId('run-diagram').getByRole('button', { name: 'Xem việc Báo giá thuê nhà xưởng cho đoàn, Không cần làm' })).toBeVisible();

  // Phương báo xong đề nghị tạm ứng (API) để việc duyệt tới lượt ông Huy.
  const phuong = await login(browser, 'phuong');
  expect((await apiPost(phuong.page, `/v1/steps/${stepIdOf('Lập đề nghị tạm ứng')}/complete`, { result: { amount: 5_000_000 } })).ok()).toBe(true);
  await phuong.context.close();

  // ── Huy: Chưa đồng ý, bắt buộc lý do ──
  const huy = await login(browser, 'huy');
  await huy.page.goto(`/viec-cua-toi/${stepIdOf('Duyệt đề nghị tạm ứng')}`);
  await expect(huy.page.getByText('5.000.000 đồng').first()).toBeVisible();
  await huy.page.getByRole('button', { name: 'Chưa đồng ý', exact: true }).click();
  const reject = huy.page.getByRole('dialog', { name: 'Chưa đồng ý' });
  await reject.getByRole('button', { name: 'Ghi là chưa đồng ý' }).click();
  await expect(reject.getByText('Xin ghi lý do để người giao việc biết cần làm gì tiếp.')).toBeVisible();
  await reject.getByLabel(/Lý do chưa đồng ý/).fill('Cần bổ sung dự toán chi tiết trước khi tạm ứng.');
  await shot(huy.page, '24-chua-dong-y-1280', false);
  await reject.getByRole('button', { name: 'Ghi là chưa đồng ý' }).click();
  await expect(huy.page.getByText('Đã ghi nhận: chưa đồng ý.')).toBeVisible();
  await expect(huy.page.getByText(/Việc này đã khép lại: Chưa đồng ý/)).toBeVisible();
  await expect(huy.page.getByRole('button', { name: 'Đồng ý', exact: true })).toHaveCount(0);
  await huy.context.close();

  // ── Văn phòng thấy quyết định ở dòng thời gian và sơ đồ; rồi dọn lượt chạy nếu còn chạy ──
  await page.goto(`/luot-chay/${run.id}`);
  const timeline = page.getByRole('region', { name: 'Dòng thời gian' });
  await expect(timeline.getByText(/Ông Huy chưa đồng ý ở bước Duyệt đề nghị tạm ứng/)).toBeVisible();
  await expect(timeline.getByText('Cần bổ sung dự toán chi tiết trước khi tạm ứng.')).toBeVisible();
  await expect(timeline.getByText(/Văn phòng bỏ qua bước Báo giá thuê nhà xưởng cho đoàn/)).toBeVisible();
  await expect(page.getByTestId('run-diagram').getByRole('button', { name: 'Xem việc Duyệt đề nghị tạm ứng, Chưa đồng ý' })).toBeVisible();
  await shot(page, '25-luot-chay-chua-dong-y-1280');
  const state = ((await (await page.request.get(`/v1/runs/${run.id}`)).json()) as { state: string; outcome: string | null });
  console.log(`[lượt chạy thứ hai] sau khi chưa đồng ý: state=${state.state}, outcome=${state.outcome ?? 'null'}`);
  if (state.state === 'running') {
    const cancelled = await apiPost(page, `/v1/runs/${run.id}/cancel`, { reason: 'Dọn lượt chạy kiểm thử tự động', confirmTitle: title });
    expect(cancelled.ok()).toBe(true);
  }
  await office.context.close();
});

test('9. Việc của tôi trên máy bàn và điện thoại: thẻ việc, hai tab, không tràn ngang', async ({ browser }) => {
  test.setTimeout(120_000);
  const sizes = [
    [DESKTOP, '1280'],
    [PHONE, '390'],
    [{ width: 360, height: 740 }, '360'],
  ] as const;
  for (const [viewport, suffix] of sizes) {
    const { context, page } = await login(browser, 'lan', viewport);
    await page.goto('/viec-cua-toi');
    await expect(page.getByRole('tab', { name: /Cần làm/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, `20-viec-cua-toi-${suffix}`);
    await page.getByRole('tab', { name: 'Đã xong' }).click();
    await expect(page.getByRole('link', { name: 'Lập chương trình đón đoàn', exact: true }).first()).toBeVisible();
    await shot(page, `21-viec-da-xong-${suffix}`);
    await page.getByRole('link', { name: 'Lập chương trình đón đoàn', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, `22-viec-da-xong-chi-tiet-${suffix}`);
    await context.close();
  }
});

test('10. Giao một việc ngoài quy trình: giao tuỳ ý, người nhận thấy "Việc giao riêng", giao lại cho ai cũng được', async ({ browser }) => {
  test.setTimeout(150_000);
  const taskTitle = `Gửi báo giá kiểm thử ${stamp}`;
  const office = await login(browser, 'vanphong', DESKTOP, true);
  const { page } = office;

  // ── Giao việc: thiếu ô thì báo từng ô; đủ thì việc được giao ngay ──
  await page.goto('/cong-viec');
  await page.getByRole('button', { name: 'Giao việc', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Giao việc ngoài quy trình' });
  await dialog.getByRole('button', { name: 'Giao việc', exact: true }).click();
  await expect(dialog.getByText('Xin đặt tên cho việc.')).toBeVisible();
  await expect(dialog.getByText('Xin chọn người nhận việc.')).toBeVisible();
  await expect(dialog.getByText('Xin chọn ngày hạn.')).toBeVisible();
  await dialog.getByLabel(/Tên việc/).fill(taskTitle);
  await dialog.getByRole('combobox').fill('Lan');
  await page.getByRole('option', { name: /Nguyễn Thu Lan/ }).click();
  await dialog.getByLabel(/Hạn xong/).fill(workingDaysFromToday(3));
  await dialog.getByLabel(/Dặn thêm/).fill('Kèm bảng giá quý bốn.');
  await shot(page, '26-giao-viec-ngoai-quy-trinh-1280', false);
  await dialog.getByRole('button', { name: 'Giao việc', exact: true }).click();
  await expect(page.getByText('Đã giao việc cho chị Lan.')).toBeVisible();

  // ── Công việc: việc hiện ra với nhãn "Việc giao riêng", đúng người nhận ──
  await page.getByLabel('Tìm theo tên việc').fill(taskTitle);
  const row = page.getByRole('table').locator('tbody tr').filter({ hasText: taskTitle });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Việc giao riêng');
  await expect(row).toContainText('chị Nguyễn Thu Lan');
  await shot(page, '27-cong-viec-viec-giao-rieng-1280', false);

  // ── Người nhận thấy việc ở Việc của tôi, không kèm tên quy trình ──
  const lan = await login(browser, 'lan');
  await lan.page.goto('/viec-cua-toi');
  const card = lan.page.getByRole('link', { name: taskTitle, exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Việc giao riêng');
  await lan.context.close();

  // ── Giao lại: việc ngoài quy trình giao cho ai cũng được, không bị giới hạn người ──
  await row.getByRole('button', { name: new RegExp(`Thao tác với việc ${taskTitle}`) }).click();
  await page.getByRole('menuitem', { name: 'Giao lại' }).click();
  const reassign = page.getByRole('dialog', { name: 'Giao lại việc' });
  await expect(reassign.getByText(/chỉ giao lại được cho người được bổ nhiệm/)).toHaveCount(0);
  await reassign.getByRole('combobox').fill('Hùng');
  await page.getByRole('option', { name: /Võ Hoàng Hùng/ }).click();
  await reassign.getByLabel(/Lý do giao lại/).fill('Anh Hùng phụ trách báo giá này.');
  await reassign.getByRole('button', { name: 'Giao lại' }).click();
  await expect(page.getByText('Đã giao lại việc cho anh Hùng.')).toBeVisible();
  await expect(row).toContainText('anh Võ Hoàng Hùng');

  // ── Lượt chạy: đây là việc giao riêng, không vẽ sơ đồ quy trình; dọn bằng cách huỷ ──
  const listed = (await (await page.request.get(`/v1/runs?adhoc=true&q=${encodeURIComponent(taskTitle)}`)).json()) as { items: { id: string; title: string; adhoc: boolean }[] };
  const adhoc = listed.items.find((r) => r.title === taskTitle);
  expect(adhoc?.adhoc).toBe(true);
  await page.goto(`/luot-chay/${adhoc!.id}`);
  await expect(page.getByRole('heading', { level: 1, name: taskTitle })).toBeVisible();
  await expect(page.getByText('Việc giao riêng, không thuộc quy trình')).toBeVisible();
  await expect(page.getByTestId('run-diagram')).toHaveCount(0);
  const cancelled = await apiPost(page, `/v1/runs/${adhoc!.id}/cancel`, { reason: 'Dọn việc kiểm thử tự động', confirmTitle: taskTitle });
  expect(cancelled.ok()).toBe(true);
  await office.context.close();
});
