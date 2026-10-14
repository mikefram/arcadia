/**
 * Kịch bản kiểm bình luận theo việc, chia sẻ lượt chạy kiểu Google Drive, văn bản mật và đặt lại TOTP
 * (docs/DECISIONS.md, 07/10/2026 điểm a và b), chạy trên API thật với dữ liệu mẫu của `pnpm db:seed` (SPEC 13.2, 15.4).
 *
 * Chuẩn bị: API ở cổng 3100 và web quản trị ở cổng 5273 đang chạy, đã `pnpm db:seed`.
 * Chạy (từ apps/web-admin):
 *   pnpm exec playwright test e2e/chia-se-binh-luan.spec.ts
 *   WEB_URL=http://127.0.0.1:5275 pnpm exec playwright test e2e/chia-se-binh-luan.spec.ts     (web ở cổng khác)
 * Biến môi trường: WEB_URL, DEMO_PASSWORD.
 *
 * Các bước chạy nối tiếp:
 *   1. Người thiết kế dựng MỘT quy trình tạm bằng API: ô `mucMat` loại chọn (thuong, mat), ô chọn người xử lý, một việc giao cho người đó.
 *   2. Lan khởi chạy hai lượt bằng API: một lượt thường, một lượt mật; Phương là người xử lý của cả hai.
 *   3. Bình luận (lượt thường): Phương gửi bằng Ctrl+Enter, thấy "(bạn)", số ký tự bị chặn ở 4000, xoá bình luận của mình có hỏi lại;
 *      người khởi chạy đọc và viết thêm nhưng không xoá được bình luận của người khác; thẻ việc hiện số bình luận.
 *   4. Văn bản mật: Văn phòng (xem mọi lượt, có quyền chia sẻ) và Tuấn (người ngoài) không thấy lượt mật ở danh sách, chi tiết và việc.
 *   5. Hộp thoại Chia sẻ của Lan (chủ sở hữu): dòng "Văn bản mật: chỉ những người dưới đây xem được", chủ sở hữu và người tham gia
 *      cố định không gỡ được, thêm Tuấn với mức Xem.
 *   6. Tuấn (mức Xem) thấy lượt và thảo luận nhưng KHÔNG có ô nhập.
 *   7. Lan đổi Tuấn sang mức Bình luận: Tuấn thấy ô nhập và gửi được.
 *   8. Phương (người tham gia, không có quyền quản lý) thấy danh sách ở chế độ chỉ đọc, không có ô thêm người.
 *   9. Lan gỡ Tuấn: Tuấn lại không thấy lượt mật nữa. Lan mời Văn phòng xem: Văn phòng thấy huy hiệu "Mật" ở danh sách và tiêu đề.
 *  10. Đặt lại TOTP: không có nút cho chính mình ở bảng người dùng; gọi thẳng API thì bị từ chối (thiếu mã nâng quyền, rồi 403 vì là chính mình).
 *
 * DỌN DẸP (afterAll, kể cả khi có bước đỏ): Lan mời Văn phòng xem mọi lượt của kịch bản (lượt mật chỉ Văn phòng mới huỷ được khi thấy
 * nó), Văn phòng huỷ mọi lượt còn đang chạy, lưu trữ mọi quy trình tạm, rồi kiểm lại bằng API. Bình luận và chia sẻ đi theo lượt chạy
 * (hệ thống không xoá lịch sử). Kịch bản không đổi quyền, không sửa dữ liệu mẫu, không đặt lại TOTP của ai (chỉ thử với chính tài khoản IT
 * và chỉ ở mức bị từ chối). Mỗi tài khoản chỉ đăng nhập một lần rồi dùng lại phiên, vì API giới hạn 10 lần đăng nhập mỗi phút.
 */
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { vi } from '@mihato/i18n';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5273';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'mihato-demo-2026';
const DESKTOP = { width: 1280, height: 900 };

type User = 'thietke' | 'vanphong' | 'it' | 'lan' | 'phuong' | 'tuan';

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEB_URL, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });

/** Chuỗi giao diện lấy từ @mihato/i18n để kịch bản không lệch khi đổi câu chữ. */
const tc = vi.admin.runs.comments;
const ts = vi.admin.runs.share;
const tconf = vi.admin.runs.confidential;
const tstep = vi.admin.runs.step;
const tlist = vi.admin.runs.list;
const trun = vi.admin.runs;
const torg = vi.admin.org.users;

// ───────────────────────── Tên riêng cho mỗi lần chạy ─────────────────────────

const stamp = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(5, 19).replace(/[-:]/g, '').replace('T', '-');
/** Tiền tố nhận diện mọi thứ do kịch bản tạo, để dọn kể cả dữ liệu còn sót của lần chạy trước bị ngắt. */
const TEMPLATE_PREFIX = 'Chia sẻ kiểm thử';
const RUN_PREFIX = 'Hồ sơ chia sẻ kiểm thử';
const templateName = `${TEMPLATE_PREFIX} ${stamp}`;
const normalTitle = `${RUN_PREFIX} thường ${stamp}`;
const secretTitle = `${RUN_PREFIX} mật ${stamp}`;
const STEP_TITLE = 'Xử lý hồ sơ chia sẻ';

const PHUONG = { full: 'Đặng Mai Phương', query: 'Phương' };
const TUAN = { full: 'Bùi Quốc Tuấn', query: 'Tuấn' };
const textPhuong = `Đã nhận hồ sơ, sẽ trả lời trong ngày, mã kiểm thử ${stamp}.`;
const textPhuong2 = `Cần thêm bản scan có dấu, mã kiểm thử ${stamp}.`;
const textLan = `Nhờ ưu tiên xử lý trước thứ Sáu, mã kiểm thử ${stamp}.`;
const textTuan = `Tôi bổ sung số liệu quý ba, mã kiểm thử ${stamp}.`;

let templateId = '';
let normalRunId = '';
let secretRunId = '';
let normalStepId = '';
let secretStepId = '';
let tuanId = '';
let officeId = '';

// ───────────────────────── Phiên đăng nhập ─────────────────────────

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
/** Phiên đã đăng nhập của từng người: mỗi tài khoản chỉ đăng nhập một lần, vì API giới hạn số lần đăng nhập mỗi phút. */
const sessions = new Map<User, Session>();

async function login(browser: Browser, user: User, viewport = DESKTOP): Promise<{ context: BrowserContext; page: Page }> {
  const options = { baseURL: WEB_URL, viewport, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', acceptDownloads: true };
  const saved = sessions.get(user);
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
  sessions.set(user, await context.storageState());
  return { context, page };
}

// ───────────────────────── Gọi API (dựng dữ liệu thử, đối chiếu, dọn dẹp) ─────────────────────────

/** Gọi thẳng API bằng phiên đăng nhập của trang (cookie phiên, CSRF, khoá chống lặp). */
async function apiSend(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data: unknown = {}, headers: Record<string, string> = {}): Promise<APIResponse> {
  if (method === 'GET') return page.request.get(path);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'mihato_csrf')?.value ?? '';
  return page.request.fetch(path, {
    method,
    headers: { 'X-CSRF-Token': decodeURIComponent(csrf), 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json', ...headers },
    data,
  });
}

type Paged<T> = { items: T[]; nextCursor?: string | null };
type TemplateRow = { id: string; name: string; archivedAt: string | null };
type RunRow = { id: string; title: string; state: string; confidentiality?: string };
type PersonRow = { id: string; fullName: string };
type ShareRow = { person: PersonRow; role: string };
type SharesBody = { confidentiality: string; shares: ShareRow[]; fixed: { person: PersonRow; role: string }[]; canManage: boolean; canComment: boolean };
type RunBody = { id: string; confidentiality?: string; steps: { id: string; title: string }[] };
type ProblemBody = { code: string; errors?: { path: string; code: string }[] };

async function json<T>(res: APIResponse, what: string): Promise<T> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function myId(page: Page): Promise<string> {
  return (await json<{ id: string }>(await apiSend(page, 'GET', '/v1/me'), 'đọc hồ sơ của tôi')).id;
}

async function findPerson(page: Page, query: string, fullName: string): Promise<string> {
  const found = await json<Paged<PersonRow>>(await apiSend(page, 'GET', `/v1/people?q=${encodeURIComponent(query)}&limit=20`), `tìm người ${query}`);
  const row = found.items.find((p) => p.fullName === fullName);
  expect(row, `không tìm thấy ${fullName}`).toBeDefined();
  return row?.id ?? '';
}

async function listTemplates(page: Page): Promise<TemplateRow[]> {
  return (await json<{ items: TemplateRow[] }>(await apiSend(page, 'GET', '/v1/templates'), 'đọc danh sách quy trình')).items;
}

async function listRuns(page: Page, state?: string): Promise<RunRow[]> {
  const rows: RunRow[] = [];
  let cursor: string | null | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const query = new URLSearchParams({ q: RUN_PREFIX, limit: '100', ...(state ? { state } : {}), ...(cursor ? { cursor } : {}) });
    const body = await json<Paged<RunRow>>(await apiSend(page, 'GET', `/v1/runs?${query.toString()}`), 'đọc danh sách lượt chạy');
    rows.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return rows.filter((r) => r.title.startsWith(RUN_PREFIX));
}

async function readShares(page: Page, runId: string): Promise<SharesBody> {
  return json<SharesBody>(await apiSend(page, 'GET', `/v1/runs/${runId}/shares`), 'đọc danh sách chia sẻ');
}

// ───────────────────────── Dọn dẹp ─────────────────────────

test.afterAll(async ({ browser }) => {
  test.setTimeout(180_000);
  // 1. Lan (chủ sở hữu) mời Văn phòng xem mọi lượt của kịch bản, kể cả của lần chạy trước bị ngắt: lượt mật chỉ người có tên mới thấy,
  //    nên Văn phòng chỉ huỷ được sau khi được mời. Rồi Văn phòng huỷ mọi lượt còn đang chạy.
  const lan = await login(browser, 'lan');
  const office = await login(browser, 'vanphong');
  try {
    const officeUser = officeId || (await myId(office.page));
    for (const run of await listRuns(lan.page, 'running')) {
      const shared = await apiSend(lan.page, 'PUT', `/v1/runs/${run.id}/shares/${officeUser}`, { role: 'viewer' });
      // 422 already_has_access: đã được mời rồi, vẫn huỷ được.
      expect([200, 422], `mời Văn phòng xem lượt ${run.id}: ${shared.status()}`).toContain(shared.status());
      const cancelled = await apiSend(office.page, 'POST', `/v1/runs/${run.id}/cancel`, { reason: 'Dọn lượt chạy kiểm thử tự động', confirmTitle: run.title });
      expect(cancelled.ok(), `huỷ lượt chạy ${cancelled.status()} ${await cancelled.text()}`).toBe(true);
    }
    const stillRunning = await listRuns(lan.page, 'running');
    expect(stillRunning.map((r) => r.title), 'lượt chạy của kịch bản còn đang chạy').toEqual([]);
  } finally {
    await office.context.close();
    await lan.context.close();
  }

  // 2. Lưu trữ mọi quy trình tạm.
  const designer = await login(browser, 'thietke');
  try {
    const leftovers = (await listTemplates(designer.page)).filter((t) => t.name.startsWith(TEMPLATE_PREFIX) && t.archivedAt === null);
    for (const template of leftovers) {
      const archived = await apiSend(designer.page, 'POST', `/v1/templates/${template.id}/archive`, { archived: true });
      expect(archived.ok(), `lưu trữ quy trình ${archived.status()}`).toBe(true);
    }
    const after = (await listTemplates(designer.page)).filter((t) => t.name.startsWith(TEMPLATE_PREFIX) && t.archivedAt === null);
    expect(after.map((t) => t.name), 'quy trình tạm chưa được lưu trữ').toEqual([]);
    console.log(`[dọn dẹp] đã lưu trữ ${leftovers.length} quy trình tạm; lượt chạy còn đang chạy: 0`);
  } finally {
    await designer.context.close();
  }
});

// ───────────────────────── Thao tác dùng chung ─────────────────────────

/** Mở thẻ việc của đúng lượt chạy kiểm thử ở "Việc của tôi". */
async function openMyStep(page: Page, runTitle: string): Promise<void> {
  await page.goto('/viec-cua-toi');
  const card = page.getByRole('link', { name: STEP_TITLE, exact: true }).filter({ hasText: runTitle });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByRole('heading', { level: 1, name: STEP_TITLE })).toBeVisible();
}

/** Mục Thảo luận của trang việc đang mở. */
function thread(page: Page): Locator {
  return page.getByTestId('step-comments');
}

/** Chờ mục Thảo luận tải xong (hết khung giữ chỗ). */
async function threadReady(page: Page): Promise<Locator> {
  const box = thread(page);
  await expect(box).toBeVisible();
  await expect(box.getByRole('heading', { name: tc.title })).toBeVisible();
  await expect(box.getByText(tc.loading)).toHaveCount(0);
  return box;
}

function shareDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: ts.title });
}

function shareRow(dialog: Locator, fullName: string): Locator {
  return dialog.getByTestId('share-row').filter({ hasText: fullName });
}

/** Mở hộp thoại Chia sẻ ở trang việc và chờ danh sách tải xong. */
async function openShare(page: Page): Promise<Locator> {
  await page.getByTestId('share-run').click();
  const dialog = shareDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('share-list')).toBeVisible();
  return dialog;
}

// ───────────────────────── 1. Dựng quy trình tạm ─────────────────────────

test('1. Dựng quy trình tạm bằng API: ô mucMat loại chọn, ô chọn người xử lý, một việc giao cho người đó', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await login(browser, 'thietke');

  const definition = {
    schemaVersion: 1,
    name: templateName,
    inputs: [
      { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
      {
        key: 'mucMat',
        label: 'Mức mật',
        type: 'select',
        required: true,
        options: [
          { value: 'thuong', label: 'Thường' },
          { value: 'mat', label: 'Mật' },
        ],
      },
      { key: 'nguoiXuLy', label: 'Người xử lý', type: 'user', required: true },
    ],
    starters: [{ kind: 'everyone' }],
    layout: { start: { x: 0, y: 120 }, xuly: { x: 260, y: 120 }, end: { x: 520, y: 120 } },
    nodes: [
      { id: 'start', type: 'start', label: 'Khởi tạo' },
      {
        id: 'xuly',
        type: 'task',
        label: 'Xử lý hồ sơ',
        title: STEP_TITLE,
        description: 'Việc của kịch bản kiểm thử chia sẻ và bình luận.',
        assignee: { kind: 'form_field', field: 'nguoiXuLy' },
        due: { anchor: 'activation', offset: { value: 3, unit: 'working_day' } },
      },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'xuly' },
      { id: 'e2', from: 'xuly', to: 'end' },
    ],
  };

  const created = await apiSend(page, 'POST', '/v1/templates', { name: templateName, description: 'Quy trình tạm của kịch bản kiểm thử chia sẻ, sẽ được lưu trữ ngay sau khi chạy.', category: 'general', definition });
  expect(created.status(), `tạo quy trình tạm: ${await created.text()}`).toBe(201);
  templateId = ((await created.json()) as { id: string }).id;

  const checked = await json<{ errors: unknown[] }>(await apiSend(page, 'POST', `/v1/templates/${templateId}/validate`), 'kiểm tra nháp');
  expect(checked.errors, 'nháp không được còn lỗi').toEqual([]);
  const published = await apiSend(page, 'POST', `/v1/templates/${templateId}/publish`);
  expect(published.status(), `xuất bản: ${await published.text()}`).toBe(200);
  await context.close();
});

// ───────────────────────── 2. Lan khởi chạy hai lượt ─────────────────────────

test('2. Lan khởi chạy hai lượt bằng API: một lượt thường, một lượt mật, cùng giao cho Phương', async ({ browser }) => {
  test.setTimeout(120_000);
  expect(templateId, 'cần quy trình tạm của bước 1').not.toBe('');
  const { context, page } = await login(browser, 'lan');
  const phuongId = await findPerson(page, PHUONG.query, PHUONG.full);

  const start = async (title: string, mucMat: 'thuong' | 'mat'): Promise<RunBody> => {
    const res = await apiSend(page, 'POST', '/v1/runs', { templateId, title, inputs: { trichYeu: `Trích yếu ${title}`, mucMat, nguoiXuLy: phuongId } });
    expect(res.status(), `khởi chạy ${title}: ${await res.text()}`).toBe(201);
    return (await res.json()) as RunBody;
  };
  const normal = await start(normalTitle, 'thuong');
  const secret = await start(secretTitle, 'mat');
  normalRunId = normal.id;
  secretRunId = secret.id;

  // Mức mật tính một lần lúc khởi chạy từ ô mucMat.
  const normalDetail = await json<RunBody>(await apiSend(page, 'GET', `/v1/runs/${normalRunId}`), 'đọc lượt thường');
  const secretDetail = await json<RunBody>(await apiSend(page, 'GET', `/v1/runs/${secretRunId}`), 'đọc lượt mật');
  expect(normalDetail.confidentiality).toBe('normal');
  expect(secretDetail.confidentiality).toBe('restricted');
  normalStepId = normalDetail.steps.find((s) => s.title === STEP_TITLE)?.id ?? '';
  secretStepId = secretDetail.steps.find((s) => s.title === STEP_TITLE)?.id ?? '';
  expect(normalStepId).not.toBe('');
  expect(secretStepId).not.toBe('');

  tuanId = await findPerson(page, TUAN.query, TUAN.full);
  const office = await login(browser, 'vanphong');
  officeId = await myId(office.page);
  await office.context.close();
  await context.close();
});

// ───────────────────────── 3. Bình luận ─────────────────────────

test('3. Bình luận: Phương gửi bằng Ctrl+Enter, thấy "(bạn)", bị chặn ở 4000 ký tự, xoá có hỏi lại; Lan đọc, viết thêm, không xoá được của người khác', async ({ browser }) => {
  test.setTimeout(180_000);
  expect(normalStepId, 'cần lượt chạy của bước 2').not.toBe('');

  // --- Phương ---
  const phuong = await login(browser, 'phuong');
  const p = phuong.page;
  await openMyStep(p, normalTitle);
  const box = await threadReady(p);
  await expect(box.getByText(tc.emptyCanWrite)).toBeVisible();

  const input = box.getByLabel(tc.inputLabel);
  const send = box.getByTestId('comment-send');
  // Ô trống thì nút gửi bị khoá; chỉ có khoảng trắng cũng vậy.
  await expect(send).toBeDisabled();
  await input.fill('   ');
  await expect(send).toBeDisabled();

  // Dán quá dài: bị cắt đúng 4000 ký tự, bộ đếm báo 4000 / 4000.
  await input.fill('a'.repeat(4100));
  await expect(input).toHaveValue('a'.repeat(4000));
  await expect(box.getByText('4000 / 4000 ký tự')).toBeVisible();
  await expect(box.getByText('Bình luận dài tối đa 4000 ký tự.')).toBeVisible();
  await expect(send).toBeEnabled();

  // Gửi bằng Ctrl+Enter.
  await input.fill(textPhuong);
  await expect(send).toBeEnabled();
  await input.press('Control+Enter');
  const mine = box.getByTestId('comment-item').filter({ hasText: textPhuong });
  await expect(mine).toBeVisible();
  await expect(mine).toContainText(`(${tc.you})`);
  await expect(mine.locator('time')).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  await expect(input).toHaveValue('');
  await expect(box.getByText(fmtCount(1))).toBeVisible();

  // Gửi thêm một bình luận bằng nút; cũ nhất ở trên.
  await input.fill(textPhuong2);
  await send.click();
  const items = box.getByTestId('comment-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(textPhuong);
  await expect(items.nth(1)).toContainText(textPhuong2);

  // Xoá bình luận của mình: hỏi lại, bỏ qua thì còn, xác nhận thì mất.
  const second = items.filter({ hasText: textPhuong2 });
  await second.getByRole('button', { name: /^Xoá bình luận của bạn lúc / }).click();
  const confirm = p.getByRole('alertdialog', { name: tc.deleteTitle });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: vi.admin.shell.ui.close }).click();
  await expect(items).toHaveCount(2);
  await second.getByRole('button', { name: /^Xoá bình luận của bạn lúc / }).click();
  await p.getByRole('alertdialog', { name: tc.deleteTitle }).getByRole('button', { name: tc.deleteConfirm }).click();
  await expect(p.getByText(tc.deleted)).toBeVisible();
  await expect(items).toHaveCount(1);
  await expect(box.getByText(textPhuong2)).toHaveCount(0);

  // Thẻ việc ở "Việc của tôi" hiện số bình luận.
  await p.goto('/viec-cua-toi');
  const card = p.getByRole('link', { name: STEP_TITLE, exact: true }).filter({ hasText: normalTitle });
  await expect(card.getByTestId('comment-count')).toHaveText(fmtCount(1));
  await phuong.context.close();

  // --- Lan (người khởi chạy) ---
  const lan = await login(browser, 'lan');
  const l = lan.page;
  await l.goto(`/viec-cua-toi/${normalStepId}`);
  await expect(l.getByRole('heading', { level: 1, name: STEP_TITLE })).toBeVisible();
  const lanBox = await threadReady(l);
  const theirs = lanBox.getByTestId('comment-item').filter({ hasText: textPhuong });
  await expect(theirs).toBeVisible();
  await expect(theirs).not.toContainText(`(${tc.you})`);
  // Không xoá được bình luận của người khác: không có nút xoá.
  await expect(theirs.getByRole('button', { name: /Xoá bình luận/ })).toHaveCount(0);
  // Người khởi chạy viết được.
  await lanBox.getByLabel(tc.inputLabel).fill(textLan);
  await lanBox.getByTestId('comment-send').click();
  const lanOwn = lanBox.getByTestId('comment-item').filter({ hasText: textLan });
  await expect(lanOwn).toBeVisible();
  await expect(lanOwn).toContainText(`(${tc.you})`);
  await expect(lanBox.getByTestId('comment-item')).toHaveCount(2);

  // Bình luận không đổi trạng thái việc: việc vẫn của Phương, chưa xong.
  const after = await json<{ steps: { id: string; state: string }[] }>(await apiSend(l, 'GET', `/v1/runs/${normalRunId}`), 'đọc lượt thường sau bình luận');
  expect(after.steps.find((s) => s.id === normalStepId)?.state).not.toBe('done');
  await lan.context.close();
});

/** "N bình luận" như giao diện hiển thị. */
function fmtCount(n: number): string {
  return tc.count.replace('{n}', String(n));
}

// ───────────────────────── 4. Văn bản mật: người ngoài không thấy ─────────────────────────

test('4. Văn bản mật: Văn phòng (xem mọi lượt) và Tuấn (người ngoài) không thấy lượt mật ở danh sách, chi tiết và việc; lượt thường vẫn thấy', async ({ browser }) => {
  test.setTimeout(150_000);
  expect(secretRunId, 'cần lượt mật của bước 2').not.toBe('');

  // --- Văn phòng: có run.view_all nhưng không phải chủ sở hữu hay người tham gia ---
  const office = await login(browser, 'vanphong');
  const o = office.page;
  const titles = (await listRuns(o)).map((r) => r.title);
  expect(titles, 'Văn phòng thấy lượt thường').toContain(normalTitle);
  expect(titles, 'Văn phòng không thấy lượt mật').not.toContain(secretTitle);
  const directRun = await apiSend(o, 'GET', `/v1/runs/${secretRunId}`);
  expect(directRun.status(), 'lượt mật là 404 với người ngoài').toBe(404);
  expect((await apiSend(o, 'GET', `/v1/steps/${secretStepId}`)).status()).toBe(404);
  expect((await apiSend(o, 'GET', `/v1/steps/${secretStepId}/comments`)).status()).toBe(404);
  expect((await apiSend(o, 'GET', `/v1/runs/${secretRunId}/shares`)).status()).toBe(404);

  // Giao diện: danh sách tìm theo tên không có lượt mật; mở thẳng chi tiết thì báo không tìm thấy.
  await o.goto('/luot-chay');
  await expect(o.getByRole('heading', { level: 1, name: tlist.title })).toBeVisible();
  await o.getByRole('searchbox', { name: tlist.search }).fill(RUN_PREFIX);
  await expect(o.getByRole('link', { name: normalTitle })).toBeVisible();
  await expect(o.getByRole('link', { name: secretTitle })).toHaveCount(0);
  // Lượt thường không có huy hiệu "Mật".
  // (Kiểm đúng dòng của lượt thường: lần chạy dở trước có thể để lại lượt mật đã chia sẻ cho Văn phòng, cùng tiền tố tên.)
  await expect(o.locator('tr', { hasText: normalTitle }).getByTestId('confidential-badge')).toHaveCount(0);
  await o.goto(`/luot-chay/${secretRunId}`);
  await expect(o.getByRole('heading', { name: trun.detail.notFoundTitle })).toBeVisible();
  await office.context.close();

  // --- Tuấn: người ngoài, nhân viên ---
  const tuan = await login(browser, 'tuan');
  const t = tuan.page;
  expect((await apiSend(t, 'GET', `/v1/runs/${secretRunId}`)).status()).toBe(404);
  await t.goto(`/viec-cua-toi/${secretStepId}`);
  await expect(t.getByText(tstep.notFoundTitle, { exact: true })).toBeVisible();
  // Lượt thường thì Tuấn cũng không dính tới (không phải người tham gia): cũng không đọc được việc.
  expect((await apiSend(t, 'GET', `/v1/steps/${normalStepId}/comments`)).status()).toBe(404);
  await tuan.context.close();
});

// ───────────────────────── 5. Hộp thoại Chia sẻ của chủ sở hữu ─────────────────────────

test('5. Lan mở Chia sẻ ở lượt mật: câu "Văn bản mật", chủ sở hữu và người tham gia cố định, thêm Tuấn với mức Xem', async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await login(browser, 'lan');
  await page.goto(`/viec-cua-toi/${secretStepId}`);
  await expect(page.getByRole('heading', { level: 1, name: STEP_TITLE })).toBeVisible();
  const dialog = await openShare(page);

  // Lượt mật nói rõ ai xem được và rằng quyền xem mọi lượt chạy không đủ.
  const note = dialog.getByTestId('share-restricted');
  await expect(note).toBeVisible();
  await expect(note).toContainText(ts.restrictedTitle);
  await expect(note).toContainText(/xem mọi lượt chạy không đủ/);

  // Chủ sở hữu và người tham gia: có nhãn, cố định (không có ô chọn mức, không có nút gỡ).
  const lanRow = dialog.getByTestId('share-row').filter({ has: page.getByText(`(${ts.you})`) });
  await expect(lanRow).toContainText(ts.roles.owner);
  const phuongRow = shareRow(dialog, PHUONG.full);
  await expect(phuongRow).toContainText(ts.roles.participant);
  for (const row of [lanRow, phuongRow]) {
    await expect(row.getByRole('combobox')).toHaveCount(0);
    await expect(row.getByRole('button')).toHaveCount(0);
  }
  await expect(dialog.getByText(ts.fixedNote)).toBeVisible();
  // Chủ sở hữu đứng trước người tham gia.
  await expect(dialog.getByTestId('share-row').first()).toContainText(ts.roles.owner);

  // Thêm Tuấn: gõ tên, chọn trong danh sách, mức mặc định là Xem.
  const add = dialog.getByRole('combobox', { name: ts.addLabel, exact: true });
  await add.click();
  await add.fill(TUAN.query);
  await page.getByRole('option', { name: new RegExp(TUAN.full) }).click();
  const tuanRow = shareRow(dialog, TUAN.full);
  await expect(tuanRow).toBeVisible();
  await expect(tuanRow.getByRole('combobox')).toContainText(ts.roles.viewer);
  await expect(dialog.getByText(/^Đã thêm .* với mức Xem\.$/)).toBeVisible();
  const shares = await readShares(page, secretRunId);
  expect(shares.shares.map((s) => [s.person.id, s.role])).toEqual([[tuanId, 'viewer']]);
  expect(shares.confidentiality).toBe('restricted');
  expect(shares.canManage).toBe(true);

  // Người đã có quyền không còn được gợi ý: gõ lại tên Tuấn thì không có dòng nào để chọn.
  await add.click();
  await add.fill(TUAN.query);
  await expect(page.getByRole('option', { name: new RegExp(TUAN.full) })).toHaveCount(0);
  await add.fill('');
  await context.close();
});

// ───────────────────────── 6. Người mức Xem không có ô nhập ─────────────────────────

test('6. Tuấn (mức Xem) thấy lượt mật và thảo luận nhưng không có ô nhập, chỉ có lý do ngắn', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await login(browser, 'tuan');

  // Chỉ có bình luận đã có thì mới có gì để đọc: Phương viết một bình luận ở lượt mật.
  const phuong = await login(browser, 'phuong');
  await openMyStep(phuong.page, secretTitle);
  const pBox = await threadReady(phuong.page);
  await pBox.getByLabel(tc.inputLabel).fill(textPhuong);
  await pBox.getByTestId('comment-send').click();
  await expect(pBox.getByTestId('comment-item').filter({ hasText: textPhuong })).toBeVisible();
  await phuong.context.close();

  expect((await apiSend(page, 'GET', `/v1/runs/${secretRunId}`)).status(), 'Tuấn thấy lượt mật sau khi được chia sẻ').toBe(200);
  const api = await json<{ items: { body: string }[]; canComment: boolean }>(await apiSend(page, 'GET', `/v1/steps/${secretStepId}/comments`), 'đọc bình luận');
  expect(api.canComment).toBe(false);
  const refused = await apiSend(page, 'POST', `/v1/steps/${secretStepId}/comments`, { body: 'Thử viết khi chỉ có mức Xem' });
  expect(refused.status(), 'mức Xem không viết được').toBe(403);

  await page.goto(`/viec-cua-toi/${secretStepId}`);
  await expect(page.getByRole('heading', { level: 1, name: STEP_TITLE })).toBeVisible();
  const box = await threadReady(page);
  await expect(box.getByTestId('comment-item').filter({ hasText: textPhuong })).toBeVisible();
  await expect(box.getByTestId('comment-input')).toHaveCount(0);
  await expect(box.getByTestId('comment-send')).toHaveCount(0);
  await expect(box.getByText(tc.cannotWrite)).toBeVisible();
  // Tuấn không có việc ở lượt này nên không có thanh nút thao tác.
  await expect(page.getByRole('button', { name: 'Báo hoàn thành' })).toHaveCount(0);
  await context.close();
});

// ───────────────────────── 7. Đổi mức sang Bình luận ─────────────────────────

test('7. Lan đổi Tuấn sang mức Bình luận: Tuấn thấy ô nhập và gửi được', async ({ browser }) => {
  test.setTimeout(150_000);
  const lan = await login(browser, 'lan');
  await lan.page.goto(`/viec-cua-toi/${secretStepId}`);
  const dialog = await openShare(lan.page);
  const row = shareRow(dialog, TUAN.full);
  await row.getByRole('combobox', { name: /^Mức truy cập của / }).click();
  await lan.page.getByRole('option', { name: ts.roles.commenter, exact: true }).click();
  await expect(dialog.getByText(/^Đã đổi mức của .* thành Bình luận\.$/)).toBeVisible();
  await expect(row.getByRole('combobox')).toContainText(ts.roles.commenter);
  expect((await readShares(lan.page, secretRunId)).shares.map((s) => s.role)).toEqual(['commenter']);
  await lan.context.close();

  const tuan = await login(browser, 'tuan');
  const t = tuan.page;
  await t.goto(`/viec-cua-toi/${secretStepId}`);
  const box = await threadReady(t);
  await expect(box.getByTestId('comment-input')).toBeVisible();
  await expect(box.getByText(tc.cannotWrite)).toHaveCount(0);
  await box.getByLabel(tc.inputLabel).fill(textTuan);
  await box.getByTestId('comment-send').click();
  const own = box.getByTestId('comment-item').filter({ hasText: textTuan });
  await expect(own).toBeVisible();
  await expect(own).toContainText(`(${tc.you})`);
  // Mức Bình luận chỉ viết được, không thêm người: Tuấn không có quyền quản lý chia sẻ.
  const share = await readShares(t, secretRunId);
  expect(share.canManage).toBe(false);
  expect(share.canComment).toBe(true);
  const denied = await apiSend(t, 'PUT', `/v1/runs/${secretRunId}/shares/${officeId}`, { role: 'viewer' });
  expect(denied.status(), 'người được chia sẻ không quản lý được chia sẻ').toBe(403);
  await tuan.context.close();
});

// ───────────────────────── 8. Người tham gia xem ở chế độ chỉ đọc ─────────────────────────

test('8. Phương (người tham gia, không có quyền quản lý) xem danh sách ở chế độ chỉ đọc', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await login(browser, 'phuong');
  await openMyStep(page, secretTitle);
  const dialog = await openShare(page);
  await expect(dialog.getByTestId('share-restricted')).toBeVisible();
  await expect(dialog.getByText(ts.readOnlyNote)).toBeVisible();
  // Vẫn thấy đủ danh sách, nhưng không có ô thêm người, ô đổi mức hay nút gỡ.
  await expect(shareRow(dialog, TUAN.full)).toBeVisible();
  await expect(shareRow(dialog, TUAN.full)).toContainText(ts.roles.commenter);
  await expect(dialog.getByTestId('share-add')).toHaveCount(0);
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Gỡ / })).toHaveCount(0);
  // Máy chủ cũng từ chối: người tham gia không quản lý được chia sẻ.
  const denied = await apiSend(page, 'DELETE', `/v1/runs/${secretRunId}/shares/${tuanId}`);
  expect(denied.status()).toBe(403);
  await context.close();
});

// ───────────────────────── 9. Gỡ người, mời Văn phòng, huy hiệu Mật ─────────────────────────

test('9. Lan gỡ Tuấn (Tuấn mất quyền xem), rồi mời Văn phòng: Văn phòng thấy huy hiệu "Mật" ở danh sách và tiêu đề chi tiết', async ({ browser }) => {
  test.setTimeout(180_000);
  const lan = await login(browser, 'lan');
  await lan.page.goto(`/viec-cua-toi/${secretStepId}`);
  const dialog = await openShare(lan.page);
  const row = shareRow(dialog, TUAN.full);
  await row.getByRole('button', { name: /^Gỡ .* khỏi danh sách chia sẻ$/ }).click();
  await expect(row).toHaveCount(0);
  await expect(dialog.getByText(/^Đã gỡ .* khỏi danh sách chia sẻ\.$/)).toBeVisible();
  const shares = await readShares(lan.page, secretRunId);
  expect(shares.shares).toEqual([]);

  // Gỡ người không có trong danh sách (Phương là người tham gia): máy chủ từ chối bằng mã con, và giao diện chưa từng đưa nút ra.
  const keep = await apiSend(lan.page, 'DELETE', `/v1/runs/${secretRunId}/shares/${(shares.fixed.find((f) => f.role === 'participant')?.person.id) ?? ''}`);
  expect(keep.status()).toBe(422);
  expect(((await keep.json()) as ProblemBody).errors?.[0]?.code).toBe('cannot_remove_participant');
  // Thêm người đã có quyền (chính Phương): 422 already_has_access.
  const dup = await apiSend(lan.page, 'PUT', `/v1/runs/${secretRunId}/shares/${shares.fixed.find((f) => f.role === 'participant')?.person.id ?? ''}`, { role: 'viewer' });
  expect(dup.status()).toBe(422);
  expect(((await dup.json()) as ProblemBody).errors?.[0]?.code).toBe('already_has_access');

  // Tuấn mất quyền xem ngay.
  const tuan = await login(browser, 'tuan');
  expect((await apiSend(tuan.page, 'GET', `/v1/runs/${secretRunId}`)).status()).toBe(404);
  await tuan.page.goto(`/viec-cua-toi/${secretStepId}`);
  await expect(tuan.page.getByText(tstep.notFoundTitle, { exact: true })).toBeVisible();
  await tuan.context.close();

  // Mời Văn phòng xem bằng hộp thoại (tìm theo tên tài khoản).
  const add = dialog.getByRole('combobox', { name: ts.addLabel, exact: true });
  await add.click();
  await add.fill('văn phòng');
  await lan.page.getByRole('option', { name: /Tài khoản văn phòng/ }).click();
  await expect(shareRow(dialog, 'Tài khoản văn phòng')).toBeVisible();
  await lan.context.close();

  // Văn phòng thấy lượt mật, có huy hiệu ở danh sách và ở tiêu đề chi tiết; hộp thoại có điều khiển quản lý (có quyền run.share).
  const office = await login(browser, 'vanphong');
  const o = office.page;
  await o.goto('/luot-chay');
  await o.getByRole('searchbox', { name: tlist.search }).fill(RUN_PREFIX);
  const secretLink = o.getByRole('link', { name: secretTitle });
  await expect(secretLink).toBeVisible();
  const secretCell = o.getByRole('cell').filter({ has: secretLink });
  await expect(secretCell.getByTestId('confidential-badge')).toHaveText(tconf.badge);
  const normalCell = o.getByRole('cell').filter({ has: o.getByRole('link', { name: normalTitle }) });
  await expect(normalCell.getByTestId('confidential-badge')).toHaveCount(0);

  await secretLink.click();
  await expect(o.getByRole('heading', { level: 1, name: new RegExp(secretTitle) })).toBeVisible();
  await expect(o.getByRole('heading', { level: 1 }).getByTestId('confidential-badge')).toHaveText(tconf.badge);
  await o.getByTestId('share-run').click();
  const dlg = shareDialog(o);
  await expect(dlg.getByTestId('share-restricted')).toBeVisible();
  await expect(dlg.getByTestId('share-add')).toBeVisible();
  await expect(shareRow(dlg, 'Tài khoản văn phòng')).toBeVisible();
  await office.context.close();
});

// ───────────────────────── 10. Đặt lại TOTP ─────────────────────────

test('10. Đặt lại TOTP: không có nút cho chính mình; gọi thẳng API thì thiếu mã nâng quyền, rồi bị 403 vì là chính mình', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await login(browser, 'it');
  const itId = await myId(page);

  // Bảng người dùng: ở dòng của chính mình không có mục "Đặt lại TOTP".
  await page.goto('/to-chuc');
  await page.getByRole('searchbox', { name: torg.searchLabel }).fill('Tài khoản quản trị hệ thống');
  await page.getByRole('button', { name: 'Thao tác với Tài khoản quản trị hệ thống' }).click();
  await expect(page.getByRole('menuitem', { name: torg.menu.edit })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: torg.menu.totpReset })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Không kèm mã nâng quyền: 403 step_up_required (không đổi gì, kể cả với người khác).
  const lanId = await findPerson(page, 'Lan', 'Nguyễn Thu Lan');
  const noToken = await apiSend(page, 'POST', `/v1/users/${lanId}/totp/reset`);
  expect(noToken.status()).toBe(403);
  expect(((await noToken.json()) as ProblemBody).code).toBe('step_up_required');

  // Có mã nâng quyền nhưng đặt cho chính mình: 403 forbidden.
  const stepUp = await json<{ stepUpToken: string }>(await apiSend(page, 'POST', '/v1/auth/step-up', { password: PASSWORD }), 'xác nhận lại danh tính');
  const self = await apiSend(page, 'POST', `/v1/users/${itId}/totp/reset`, {}, { 'X-Step-Up-Token': stepUp.stepUpToken });
  expect(self.status(), `tự đặt lại TOTP: ${await self.text()}`).toBe(403);
  expect(((await self.json()) as ProblemBody).code).toBe('forbidden');

  // Phiên của chính tài khoản IT vẫn còn: lần đặt lại bị từ chối không làm gì.
  expect((await apiSend(page, 'GET', '/v1/me')).status()).toBe(200);
  await context.close();
});
