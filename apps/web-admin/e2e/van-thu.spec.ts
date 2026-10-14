/**
 * Kịch bản vàng rút gọn của module quy trình văn thư (docs/DECISIONS.md, 06/10/2026; docs/HUONG-DAN-QUY-TRINH.md), chạy trên API thật
 * với dữ liệu mẫu của `pnpm db:seed` (SPEC 13.2, 15.4).
 *
 * Chuẩn bị: API ở cổng 3100 và web quản trị ở cổng 5273 đang chạy, đã `pnpm db:seed`.
 * Chạy (từ apps/web-admin):
 *   pnpm exec playwright test e2e/van-thu.spec.ts
 *   WEB_URL=http://127.0.0.1:5275 pnpm exec playwright test e2e/van-thu.spec.ts     (web ở cổng khác)
 * Biến môi trường: WEB_URL, DEMO_PASSWORD, SHOTS_DIR (nơi lưu ảnh chụp, mặc định test-results/van-thu-shots).
 *
 * Các bước chạy nối tiếp:
 *   1. Thư viện mẫu: người thiết kế mở hộp chọn tạo quy trình, thấy đúng ba thẻ mẫu, đóng hộp mà chưa tạo gì.
 *   2. Sổ văn bản: Văn phòng thấy ba sổ VBDEN, VBDI, CHITHI cùng các văn bản mẫu; IT vào ở chế độ chỉ cấu hình; nhân viên không thấy mục.
 *   3. Dựng MỘT quy trình tạm bằng API (không có ô cấp số, không dùng ba sổ mặc định): mọi cán bộ khởi chạy được; biểu mẫu có
 *      ô chữ, ô chọn người đóng góp và ô tệp; bước đóng góp có ô nhiều dòng và ô tệp; bước tổng hợp xuất Word kiểu công văn.
 *   4. Lan khởi chạy bằng nút ở Việc của tôi: tải tệp lên (kèm hai tệp bị chặn), chọn hai người đóng góp, gửi.
 *   5. Hai người đóng góp gửi phần của mình (một người kèm tệp).
 *   6. Lan xuất tệp Word và PDF, tải về, kiểm docx hợp lệ chứa chữ đã gõ và PDF hợp lệ, rồi báo xong.
 *   7. Văn phòng xem chi tiết lượt chạy: hồ sơ đính kèm có tệp đã tải lên, tệp của người đóng góp và bản xuất Word.
 *   8. Không tràn ngang ở 1280: hộp chọn mẫu, /so-van-ban, biểu mẫu có ô tệp.
 *
 * DỌN DẸP (afterAll, kể cả khi có bước đỏ): huỷ mọi lượt chạy của kịch bản còn đang chạy, lưu trữ mọi quy trình tạm, rồi kiểm lại
 * bằng API. Lượt chạy đã hoàn tất thì không còn gì để huỷ (hệ thống không xoá lịch sử). Kịch bản không sửa sổ văn bản, không đổi
 * quyền, không sửa dữ liệu mẫu. Mỗi tài khoản chỉ đăng nhập một lần rồi dùng lại phiên, vì API giới hạn 10 lần đăng nhập mỗi phút.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { vi } from '@mihato/i18n';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5273';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'mihato-demo-2026';
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/van-thu-shots';
const DESKTOP = { width: 1280, height: 900 };

type User = 'thietke' | 'vanphong' | 'it' | 'lan' | 'phuong' | 'tuan';

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEB_URL, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });

/** Chuỗi giao diện lấy từ @mihato/i18n để kịch bản không lệch khi đổi câu chữ. */
const tp = vi.admin.designer.list.presets;
const tdoc = vi.admin.documents;
const tnav = vi.admin.shell.nav;
const trun = vi.admin.runs;

// ───────────────────────── Tên riêng cho mỗi lần chạy ─────────────────────────

const stamp = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(5, 19).replace(/[-:]/g, '').replace('T', '-');
/** Tiền tố nhận diện mọi thứ do kịch bản tạo, để dọn kể cả dữ liệu còn sót của lần chạy trước bị ngắt. */
const TEMPLATE_PREFIX = 'Văn thư kiểm thử';
const RUN_PREFIX = 'Hồ sơ văn thư kiểm thử';
const templateName = `${TEMPLATE_PREFIX} ${stamp}`;
const runTitle = `${RUN_PREFIX} ${stamp}`;
const subject = `Công văn kiểm thử ${stamp}`;
const recipient = `Sở Kế hoạch và Đầu tư ${stamp}`;

const CONTRIBUTE_STEP = 'Góp nội dung vào dự thảo';
const COMPILE_STEP = 'Tổng hợp dự thảo và xuất tệp trình duyệt';

/** Văn bản mỗi người gõ; phải xuất hiện lại trong tệp Word. */
const textPhuong = `Kế toán đề xuất bố trí kinh phí quý bốn, mã kiểm thử ${stamp}.`;
const textTuan = `Kỹ thuật xác nhận phương án hạ tầng đã sẵn sàng, mã kiểm thử ${stamp}.`;
const textLan = `Dự thảo đã tổng hợp ý kiến các đơn vị, mã kiểm thử ${stamp}.`;

let templateId = '';
let runId = '';

// ───────────────────────── Tệp thử ─────────────────────────

/** PDF hợp lệ tối thiểu một trang (đúng dấu hiệu %PDF-, có bảng xref); chữ không dấu vì phông PDF chuẩn không có chữ Việt. */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 14 Tf 72 740 Td (${text.replace(/[()\\]/g, ' ')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const pdfStart = minimalPdf(`Tai lieu khoi chay ${stamp}`);
const pdfPhuong = minimalPdf(`Minh chung cua ke toan ${stamp}`);
const START_PDF = `tai-lieu-khoi-chay-${stamp}.pdf`;
const PHUONG_PDF = `minh-chung-ke-toan-${stamp}.pdf`;

// ───────────────────────── Đọc tệp docx (ZIP) ─────────────────────────

/**
 * Đọc một mục của tệp ZIP bằng thư mục trung tâm (docx là ZIP). Cùng cách làm với packages/backend/test/support/zip.ts,
 * chép lại để kịch bản trình duyệt không phụ thuộc vào thư mục test của gói khác.
 */
function readZipEntry(zip: Buffer, name: string): string | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (zip.subarray(p + 46, p + 46 + nameLen).toString('utf8') === name) {
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(dataStart, dataStart + compressed);
      return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Chữ thuần trong word/document.xml: nối các thẻ <w:t>, mỗi đoạn một dòng. */
function docxText(zip: Buffer): string {
  const xml = readZipEntry(zip, 'word/document.xml') ?? '';
  return xml
    .split('</w:p>')
    .map((para) => [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
    .map((t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
    .filter(Boolean)
    .join('\n');
}

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

// ───────────────────────── Ảnh chụp, kiểm tràn ngang ─────────────────────────

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  // Chờ dữ liệu và phông chữ ổn định để ảnh không dính khung giữ chỗ.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

/** Trang không có thanh cuộn ngang. `scope` (nếu có): phần tử cụ thể, ví dụ hộp thoại, cũng không được rộng hơn khung của nó. */
async function expectNoHorizontalScroll(page: Page, what: string, scope?: Locator): Promise<void> {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(widths.scroll, `${what}: trang rộng ${widths.scroll}px hơn khung ${widths.inner}px`).toBeLessThanOrEqual(widths.inner);
  if (scope) {
    const box = await scope.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(box.scroll, `${what}: nội dung rộng ${box.scroll}px hơn khung ${box.client}px`).toBeLessThanOrEqual(box.client + 1);
  }
}

// ───────────────────────── Gọi API (dựng dữ liệu thử, đối chiếu, dọn dẹp) ─────────────────────────

/** Gọi thẳng API bằng phiên đăng nhập của trang (cookie phiên, CSRF, khoá chống lặp). */
async function apiSend(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data: unknown = {}) {
  if (method === 'GET') return page.request.get(path);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'mihato_csrf')?.value ?? '';
  return page.request.fetch(path, {
    method,
    headers: { 'X-CSRF-Token': decodeURIComponent(csrf), 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' },
    data,
  });
}

type Paged<T> = { items: T[]; nextCursor?: string | null };
type TemplateRow = { id: string; name: string; archivedAt: string | null };
type RunRow = { id: string; title: string; state: string };

async function listTemplates(page: Page): Promise<TemplateRow[]> {
  const res = await apiSend(page, 'GET', '/v1/templates');
  expect(res.ok(), 'đọc danh sách quy trình').toBe(true);
  return ((await res.json()) as { items: TemplateRow[] }).items;
}

async function listRuns(page: Page, state?: string): Promise<RunRow[]> {
  const rows: RunRow[] = [];
  let cursor: string | null | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const query = new URLSearchParams({ q: RUN_PREFIX, limit: '100', ...(state ? { state } : {}), ...(cursor ? { cursor } : {}) });
    const res = await apiSend(page, 'GET', `/v1/runs?${query.toString()}`);
    expect(res.ok(), 'đọc danh sách lượt chạy').toBe(true);
    const body = (await res.json()) as Paged<RunRow>;
    rows.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return rows.filter((r) => r.title.startsWith(RUN_PREFIX));
}

// ───────────────────────── Dọn dẹp ─────────────────────────

test.afterAll(async ({ browser }) => {
  test.setTimeout(150_000);
  // 1. Huỷ mọi lượt chạy của kịch bản còn đang chạy (kể cả của lần chạy trước bị ngắt).
  const office = await login(browser, 'vanphong');
  try {
    for (const run of await listRuns(office.page, 'running')) {
      const cancelled = await apiSend(office.page, 'POST', `/v1/runs/${run.id}/cancel`, { reason: 'Dọn lượt chạy kiểm thử tự động', confirmTitle: run.title });
      expect(cancelled.ok(), `huỷ lượt chạy ${cancelled.status()}`).toBe(true);
    }
    const stillRunning = await listRuns(office.page, 'running');
    expect(stillRunning.map((r) => r.title), 'lượt chạy của kịch bản còn đang chạy').toEqual([]);
    const byState = new Map<string, number>();
    for (const run of await listRuns(office.page)) byState.set(run.state, (byState.get(run.state) ?? 0) + 1);
    console.log(`[dọn dẹp] mọi lượt chạy mang tên kịch bản theo trạng thái: ${JSON.stringify(Object.fromEntries(byState))}`);
  } finally {
    await office.context.close();
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
async function openMyStep(page: Page, stepTitle: string): Promise<void> {
  await page.goto('/viec-cua-toi');
  const card = page.getByRole('link', { name: stepTitle, exact: true }).filter({ hasText: runTitle });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByRole('heading', { level: 1, name: stepTitle })).toBeVisible();
  await expect(page.getByText(runTitle)).toBeVisible();
}

/** Chờ một tệp trong ô `file` tải lên xong (dòng tệp hiện chữ "Đã tải lên"). */
async function expectUploaded(scope: Page | Locator, fieldKey: string, fileName: string) {
  const item = scope.getByTestId(`file-${fieldKey}-item`).filter({ hasText: fileName });
  await expect(item).toBeVisible();
  await expect(item.getByText(trun.files.uploaded)).toBeVisible();
  return item;
}

/** Bấm một nút tải xuống và đọc tệp về. */
async function downloadVia(page: Page, button: Locator): Promise<{ name: string; data: Buffer }> {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), data: await readFile(path) };
}

// ───────────────────────── 1. Thư viện mẫu ─────────────────────────

test('1. Người thiết kế mở hộp chọn tạo quy trình: đúng ba thẻ mẫu có sẵn, đóng hộp thì chưa tạo gì', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await login(browser, 'thietke');
  const before = (await listTemplates(page)).length;

  await page.goto('/quy-trinh');
  await expect(page.getByRole('heading', { level: 1, name: tnav.templates })).toBeVisible();
  await page.getByTestId('create-template').click();

  // Hộp chọn: Quy trình trống hoặc Từ mẫu có sẵn.
  const chooser = page.getByRole('dialog', { name: vi.admin.designer.list.chooser.title });
  await expect(chooser).toBeVisible();
  await expect(page.getByTestId('create-chooser')).toBeVisible();
  await expect(page.getByTestId('create-blank')).toBeVisible();
  await expect(page.getByTestId('create-from-preset')).toBeVisible();
  await page.getByTestId('create-from-preset').click();

  // Thư viện mẫu: đúng ba thẻ, mỗi thẻ có tên, nhóm, số việc và nút chọn.
  const gallery = page.getByTestId('preset-gallery');
  await expect(gallery.getByRole('heading', { name: tp.title })).toBeVisible();
  const cards = gallery.getByRole('list', { name: tp.region }).getByRole('article');
  await expect(cards).toHaveCount(3);
  const expected = [
    { id: 'chi-thi', name: 'Chỉ thị của Chủ tịch' },
    { id: 'van-ban-den', name: 'Văn bản đến' },
    { id: 'van-ban-di', name: 'Văn bản đi' },
  ];
  for (const preset of expected) {
    const card = gallery.getByTestId(`preset-${preset.id}`);
    await expect(card.getByRole('heading', { level: 3, name: preset.name, exact: true })).toBeVisible();
    await expect(card.getByText(tp.summaryLabel)).toBeVisible();
    await expect(card.getByRole('button', { name: tp.pick })).toBeVisible();
  }
  await expectNoHorizontalScroll(page, 'thư viện mẫu', gallery);

  // Đóng hộp bằng phím Esc; không tạo gì.
  await page.keyboard.press('Escape');
  await expect(gallery).toHaveCount(0);
  await expect(page).toHaveURL(/\/quy-trinh$/);
  expect((await listTemplates(page)).length, 'mở và đóng thư viện mẫu không được tạo quy trình').toBe(before);
  await context.close();
});

// ───────────────────────── 2. Sổ văn bản ─────────────────────────

test('2. Sổ văn bản: Văn phòng thấy ba sổ và các văn bản mẫu; IT chỉ cấu hình; nhân viên không thấy mục', async ({ browser }) => {
  test.setTimeout(180_000);

  // Văn phòng: xem, không sửa.
  const office = await login(browser, 'vanphong');
  const page = office.page;
  await page.goto('/so-van-ban');
  await expect(page.getByRole('heading', { level: 1, name: tdoc.title })).toBeVisible();
  await expect(page.getByRole('navigation', { name: tnav.label }).getByRole('link', { name: tnav.documents })).toBeVisible();
  const tabs = page.getByTestId('register-select');
  for (const code of ['VBDEN', 'VBDI', 'CHITHI']) await expect(tabs.getByTestId(`register-${code}`)).toBeVisible();

  // Trích yếu dòng sổ là ô trích yếu (hoặc tiêu đề chỉ thị) của biểu mẫu mẫu ở packages/backend/src/seed/vrg.ts. Mỗi sổ phải có ít nhất một dòng mẫu và số dòng khớp số đếm trên thẻ.
  const seeded = [
    // Mỗi sổ nhận cả trích yếu của bản seed mới và tiêu đề lượt chạy của bản seed cũ: seed chạy lại không ghi đè dòng sổ đã có, nên CSDL nạp từ trước còn dữ liệu cũ.
    { code: 'VBDEN', subjects: ['V/v kiểm tra công tác phòng cháy chữa cháy tại các khu công nghiệp', 'V/v nhân sự cấp cao (mật)', 'Công văn 2345/UBND-KT về kiểm tra phòng cháy chữa cháy', 'Thông báo mật 88/TĐ-TCNS của Tập đoàn'] },
    { code: 'VBDI', subjects: ['Tờ trình xin chủ trương đầu tư hạ tầng giai đoạn 2', 'Báo cáo tình hình nhân sự quý III'] },
    { code: 'CHITHI', subjects: ['Đẩy nhanh thu hồi công nợ quý IV', 'Rà soát quỹ đất trống tại các khu công nghiệp', 'Chuẩn bị tổng kết hoạt động năm', 'Chỉ thị: Đẩy nhanh thu hồi công nợ quý IV', 'Chỉ thị: Rà soát quỹ đất trống tại các khu công nghiệp', 'Chỉ thị: Chuẩn bị tổng kết hoạt động năm'] },
  ];
  for (const { code, subjects } of seeded) {
    const tab = tabs.getByTestId(`register-${code}`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('register-info')).toContainText(`Mã sổ: ${code}`);
    await expect(page.getByTestId('register-info')).toContainText('Mẫu số:');
    // Bảng có văn bản mẫu đã seed: số, trích yếu, người tạo, tình trạng.
    const table = page.getByRole('table', { name: /Bảng các văn bản trong/ });
    await expect(table.getByRole('columnheader', { name: tdoc.colNumber, exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: tdoc.colSubject, exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: tdoc.colState, exact: true })).toBeVisible();
    const rows = table.locator('tbody tr');
    const anySeeded = subjects.map((text) => table.getByText(text, { exact: true })).reduce((all, one) => all.or(one));
    await expect(anySeeded.first(), `sổ ${code} phải có một trong các văn bản mẫu: ${subjects.join(' | ')}`).toBeVisible();
    const badge = Number((await tab.locator('span').last().textContent()) ?? '0');
    expect(badge, `thẻ sổ ${code} phải có số đếm`).toBeGreaterThan(0);
    await expect(rows, `số dòng sổ ${code} phải khớp số đếm trên thẻ`).toHaveCount(badge);
    await shot(page, `02-so-van-ban-${code}-1280`);
  }
  await office.context.close();

  // IT: vào được trang, chỉ cấu hình (không xem nội dung văn bản).
  const it = await login(browser, 'it');
  await it.page.goto('/so-van-ban');
  await expect(it.page.getByRole('heading', { level: 1, name: tdoc.title })).toBeVisible();
  await expect(it.page.getByTestId('register-config-only')).toBeVisible();
  await expect(it.page.getByTestId('register-config-only')).toContainText(tdoc.configOnly);
  await expect(it.page.getByTestId('register-add')).toBeVisible();
  await expect(it.page.getByRole('table', { name: /Bảng các văn bản trong/ })).toHaveCount(0);
  await shot(it.page, '02-so-van-ban-it-chi-cau-hinh-1280');
  await it.context.close();

  // Nhân viên (Lan): không có mục trên thanh bên; vào thẳng đường dẫn thì bị đưa về Việc của tôi.
  const lan = await login(browser, 'lan');
  await lan.page.goto('/viec-cua-toi');
  await expect(lan.page.getByRole('heading', { level: 1, name: trun.myTasks.title })).toBeVisible();
  await expect(lan.page.getByRole('navigation', { name: tnav.label }).getByRole('link', { name: tnav.myTasks })).toBeVisible();
  await expect(lan.page.getByRole('navigation', { name: tnav.label }).getByRole('link', { name: tnav.documents })).toHaveCount(0);
  await lan.page.goto('/so-van-ban');
  await expect(lan.page).toHaveURL(/\/viec-cua-toi/);
  await expect(lan.page.getByRole('heading', { level: 1, name: trun.myTasks.title })).toBeVisible();
  await lan.context.close();
});

// ───────────────────────── 3. Dựng quy trình tạm ─────────────────────────

test('3. Dựng quy trình tạm bằng API: mọi cán bộ khởi chạy, ô chọn người và ô tệp, bước đóng góp, xuất Word kiểu công văn', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await login(browser, 'thietke');

  const definition = {
    schemaVersion: 1,
    name: templateName,
    inputs: [
      { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
      { key: 'noiNhan', label: 'Nơi nhận', type: 'text', required: true },
      { key: 'dongGop', label: 'Người đóng góp', type: 'users', required: true, hint: 'Chọn những người sẽ góp nội dung vào dự thảo.' },
      { key: 'tep', label: 'Tài liệu kèm theo', type: 'file', multiple: true },
    ],
    starters: [{ kind: 'everyone' }],
    layout: {
      start: { x: 0, y: 120 },
      gop: { x: 240, y: 120 },
      tonghop: { x: 520, y: 120 },
      end: { x: 800, y: 120 },
    },
    nodes: [
      { id: 'start', type: 'start', label: 'Người soạn khởi tạo' },
      {
        id: 'gop',
        type: 'approval',
        action: 'contribute',
        mode: 'all',
        label: 'Góp nội dung',
        title: CONTRIBUTE_STEP,
        approvers: [{ kind: 'form_field', field: 'dongGop' }],
        due: { anchor: 'activation', offset: { value: 3, unit: 'working_day' } },
        form: [
          { key: 'noiDung', label: 'Nội dung góp ý', type: 'longtext', required: true },
          { key: 'tepGop', label: 'Tệp minh chứng', type: 'file', multiple: true },
        ],
      },
      {
        id: 'tonghop',
        type: 'task',
        label: 'Tổng hợp dự thảo',
        title: COMPILE_STEP,
        description: 'Gộp nội dung các đơn vị đã góp rồi bấm “Xuất tệp Word” để có một tệp cuối.',
        assignee: { kind: 'initiator' },
        due: { anchor: 'activation', offset: { value: 5, unit: 'working_day' } },
        form: [{ key: 'duThao', label: 'Nội dung dự thảo sau tổng hợp', type: 'longtext', required: true }],
        compile: {
          layout: 'official',
          title: '{trichYeu}',
          required: true,
          includeAttachments: true,
          sections: [
            { heading: 'Nội dung dự thảo', ref: 'steps.tonghop.duThao' },
            { heading: 'Ý kiến góp của các đơn vị', ref: 'responses.gop.noiDung' },
          ],
        },
      },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'gop' },
      { id: 'e2', from: 'gop', to: 'tonghop', outcome: 'approved' },
      { id: 'e3', from: 'tonghop', to: 'end' },
    ],
  };

  const created = await apiSend(page, 'POST', '/v1/templates', { name: templateName, description: 'Quy trình tạm của kịch bản kiểm thử văn thư, sẽ được lưu trữ ngay sau khi chạy.', category: 'general', definition });
  expect(created.status(), `tạo quy trình tạm: ${await created.text()}`).toBe(201);
  templateId = ((await created.json()) as { id: string }).id;

  const checked = await apiSend(page, 'POST', `/v1/templates/${templateId}/validate`);
  expect(checked.ok(), 'kiểm tra nháp').toBe(true);
  expect(((await checked.json()) as { errors: unknown[] }).errors, 'nháp không được còn lỗi').toEqual([]);

  const published = await apiSend(page, 'POST', `/v1/templates/${templateId}/publish`);
  expect(published.status(), `xuất bản: ${await published.text()}`).toBe(200);
  expect(((await published.json()) as { version: number }).version).toBe(1);

  // Người thiết kế thấy quy trình trên giao diện, đã xuất bản.
  await page.goto('/quy-trinh');
  await expect(page.getByRole('link', { name: templateName }).first()).toBeVisible();
  await context.close();
});

// ───────────────────────── 4. Lan khởi chạy ─────────────────────────

test('4. Lan khởi chạy quy trình tạm từ Việc của tôi: tải tệp lên, chọn hai người đóng góp, gửi', async ({ browser }) => {
  test.setTimeout(150_000);
  // Nhân viên khởi chạy được theo `starters` dù không có quyền xem trước (template.simulate): màn Khởi chạy không bắt buộc xem trước,
  // và sau khi khởi chạy đưa về Việc của tôi (nhân viên không có quyền xem chi tiết mọi lượt chạy).
  expect(templateId, 'cần quy trình tạm của bước 3').not.toBe('');
  const { context, page } = await login(browser, 'lan');

  await page.goto('/viec-cua-toi');
  await expect(page.getByRole('heading', { level: 1, name: trun.myTasks.title })).toBeVisible();
  const start = page.getByRole('link', { name: trun.myTasks.startProcess });
  await expect(start).toBeVisible();
  await start.click();
  await expect(page.getByRole('heading', { level: 1, name: trun.create.title })).toBeVisible();

  // Chọn đúng quy trình tạm trong danh sách quy trình khởi chạy được.
  await page.getByRole('combobox', { name: trun.create.template }).click();
  await page.getByRole('option', { name: templateName, exact: true }).click();
  await page.getByLabel(new RegExp(trun.create.runTitle)).fill(runTitle);
  await page.getByLabel(/^Trích yếu/).fill(subject);
  await page.getByLabel(/^Nơi nhận/).fill(recipient);

  // Ô tệp: một tệp chạy được và một tệp đổi đuôi giả bị chặn; tệp PDF thật tải lên được.
  const fileInput = page.getByTestId('file-tep-input');
  await fileInput.setInputFiles({ name: 'tro-giup.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ-gia') });
  const exe = page.getByTestId('file-tep-item').filter({ hasText: 'tro-giup.exe' });
  await expect(exe.getByRole('alert')).toContainText('Loại tệp này chưa được nhận');
  await fileInput.setInputFiles({ name: 'gia-mao.pdf', mimeType: 'application/pdf', buffer: Buffer.from('day khong phai la tep pdf that') });
  const fake = page.getByTestId('file-tep-item').filter({ hasText: 'gia-mao.pdf' });
  await expect(fake.getByRole('alert')).toContainText('Nội dung tệp không khớp');
  await page.getByRole('button', { name: 'Gỡ tệp tro-giup.exe' }).click();
  await page.getByRole('button', { name: 'Gỡ tệp gia-mao.pdf' }).click();
  await expect(page.getByTestId('file-tep-item')).toHaveCount(0);

  await fileInput.setInputFiles({ name: START_PDF, mimeType: 'application/pdf', buffer: pdfStart });
  const uploaded = await expectUploaded(page, 'tep', START_PDF);
  await expect(uploaded).toContainText(/KB|byte/);

  // Ô chọn nhiều người: thêm Phương và Tuấn.
  const people = page.getByTestId('field-dongGop');
  const combo = people.getByRole('combobox');
  for (const [query, full] of [
    ['Phương', /Đặng Mai Phương/],
    ['Tuấn', /Bùi Quốc Tuấn/],
  ] as const) {
    await combo.click();
    await combo.fill(query);
    await page.getByRole('option', { name: full }).click();
    await expect(people.getByRole('list').getByText(full)).toBeVisible();
  }
  await expect(people.getByRole('list').getByRole('listitem')).toHaveCount(2);

  await expectNoHorizontalScroll(page, 'biểu mẫu khởi chạy có ô tệp');

  // Không có quyền xem trước: khung xem trước nói rõ điều đó, không có bảng, nhưng nút Khởi chạy vẫn dùng được.
  await expect(page.getByTestId('preview-not-allowed')).toContainText(trun.create.previewNotAllowed);
  await expect(page.getByTestId('preview-table')).toHaveCount(0);
  await expect(page.getByText(trun.create.previewFailed)).toHaveCount(0);
  await shot(page, '04-khoi-chay-co-o-tep-1280');

  const submit = page.getByRole('button', { name: trun.create.submit, exact: true });
  await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
  const created = page.waitForResponse((r) => r.url().endsWith('/v1/runs') && r.request().method() === 'POST');
  await submit.click();
  const res = await created;
  expect(res.status(), `khởi chạy: ${await res.text()}`).toBe(201);
  runId = ((await res.json()) as { id: string }).id;
  await expect(page.getByText(`Đã khởi chạy lượt “${runTitle}”.`)).toBeVisible();
  // Lan không có quyền xem mọi lượt chạy, nên về Việc của tôi và không bị báo thiếu quyền.
  await page.waitForURL(/\/viec-cua-toi/);
  await expect(page.getByRole('heading', { level: 1, name: trun.myTasks.title })).toBeVisible();
  await expect(page.getByText(vi.admin.shell.auth.noPermission)).toHaveCount(0);
  expect(runId, 'phải có lượt chạy để các bước sau kiểm').not.toBe('');
  await context.close();
});

// ───────────────────────── 5. Hai người đóng góp ─────────────────────────

test('5. Phương và Tuấn gửi phần của mình ở bước góp nội dung (Phương kèm tệp)', async ({ browser }) => {
  test.setTimeout(180_000);

  for (const { user, text, file } of [
    { user: 'phuong' as const, text: textPhuong, file: { name: PHUONG_PDF, buffer: pdfPhuong } },
    { user: 'tuan' as const, text: textTuan, file: null },
  ]) {
    const { context, page } = await login(browser, user);
    await openMyStep(page, CONTRIBUTE_STEP);
    await expect(page.getByText(trun.myTasks.contribute.stepBadge, { exact: true })).toBeVisible();
    if (user === 'tuan') {
      // Phương đã gửi rồi: Tuấn chỉ cùng góp nội dung nên không đọc được phần của Phương, ở màn hình lẫn trong dữ liệu máy chủ trả về.
      await expect(page.getByText(textPhuong)).toHaveCount(0);
      await expect(page.getByText(PHUONG_PDF)).toHaveCount(0);
      const detail = await apiSend(page, 'GET', `/v1/runs/${runId}`);
      expect(detail.status()).toBe(200);
      const raw = await detail.text();
      expect(raw).not.toContain(textPhuong);
      expect(raw).not.toContain(PHUONG_PDF);
      expect(raw).toContain('contentHidden');
      const files = await apiSend(page, 'GET', `/v1/runs/${runId}/files`);
      expect(await files.text()).not.toContain(PHUONG_PDF);
    }
    // Bước đóng góp chỉ có nút Gửi, không có Chưa đồng ý hay Báo hoàn thành.
    await expect(page.getByRole('button', { name: 'Chưa đồng ý' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Báo hoàn thành' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Gửi', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: trun.myTasks.contribute.title });
    // Ô nội dung bắt buộc: để trống thì chưa gửi được.
    await dialog.getByRole('button', { name: 'Gửi', exact: true }).click();
    await expect(dialog.getByText('Xin điền ô này.')).toBeVisible();
    await dialog.getByLabel(/Nội dung góp ý/).fill(text);
    if (file) {
      await dialog.getByTestId('file-tepGop-input').setInputFiles({ name: file.name, mimeType: 'application/pdf', buffer: file.buffer });
      await expectUploaded(dialog, 'tepGop', file.name);
    }
    await dialog.getByRole('button', { name: 'Gửi', exact: true }).click();
    await expect(page.getByText(trun.myTasks.contribute.done)).toBeVisible();
    await expect(page.getByText(trun.myTasks.contribute.alreadySent, { exact: false })).toBeVisible();
    // Gửi rồi thì không còn nút Gửi.
    await expect(page.getByRole('button', { name: 'Gửi', exact: true })).toHaveCount(0);
    await context.close();
  }
});

// ───────────────────────── 6. Lan xuất Word và báo xong ─────────────────────────

test('6. Lan xuất tệp Word và PDF kiểu công văn, tải về kiểm docx hợp lệ chứa chữ đã gõ và PDF hợp lệ, rồi báo xong', async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await login(browser, 'lan');

  await openMyStep(page, COMPILE_STEP);
  // Phần của từng người đã gửi hiện sẵn cho người tổng hợp đọc.
  const prior = page.getByTestId('prior-contributions');
  await expect(prior).toContainText(textPhuong);
  await expect(prior).toContainText(textTuan);

  await page.getByRole('button', { name: 'Báo hoàn thành' }).click();
  const dialog = page.getByRole('dialog', { name: 'Báo hoàn thành' });
  // Việc yêu cầu xuất Word (compile.required): chưa xuất thì chưa báo xong được, và nói rõ vì sao.
  await expect(dialog.getByTestId('compile-panel')).toBeVisible();
  await expect(dialog.getByTestId('complete-lock-note')).toContainText(trun.myTasks.complete.compileRequiredNote);
  const submit = dialog.getByRole('button', { name: 'Báo hoàn thành' });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.click({ force: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByText(trun.myTasks.complete.done)).toHaveCount(0);

  await dialog.getByLabel(/Nội dung dự thảo sau tổng hợp/).fill(textLan);
  await shot(page, '06-bao-hoan-thanh-xuat-word-1280', false);
  await dialog.getByTestId('compile-button').click();
  const files = dialog.getByTestId('compile-files');
  const rows = files.getByTestId('file-row');
  // Mỗi lần xuất ra hai tệp cùng nội dung: Word (nhãn "Mới nhất") rồi bản PDF của nó.
  await expect(rows).toHaveCount(2);
  const row = rows.filter({ hasText: `${subject}.docx` });
  const pdfRow = rows.filter({ hasText: `${subject}.pdf` });
  await expect(row).toHaveCount(1);
  await expect(pdfRow).toHaveCount(1);
  await expect(row).toContainText(trun.myTasks.complete.compileLatest);
  await expect(pdfRow).toContainText(trun.files.pdfCopy);
  await expect(dialog.getByTestId('compile-button')).toContainText(trun.myTasks.complete.compileAgain);
  await expect(dialog.getByTestId('complete-lock-note')).toHaveCount(0);

  // Tải về: docx là ZIP (bắt đầu bằng "PK"), có word/document.xml, chứa mọi đoạn chữ đã gõ ở ba nơi.
  const { name, data } = await downloadVia(page, row.getByRole('button', { name: /^Tải xuống tệp/ }));
  expect(name).toBe(`${subject}.docx`);
  expect(data.subarray(0, 2).toString('latin1'), 'docx phải bắt đầu bằng PK').toBe('PK');
  expect(data.length).toBeGreaterThan(2_000);
  expect(readZipEntry(data, '[Content_Types].xml'), 'thiếu [Content_Types].xml').toContain('wordprocessingml');
  const text = docxText(data);
  for (const expected of [
    'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',
    'Độc lập - Tự do - Hạnh phúc',
    subject,
    recipient,
    textLan,
    textPhuong,
    textTuan,
    'Đặng Mai Phương',
    'Bùi Quốc Tuấn',
    START_PDF,
    PHUONG_PDF,
  ]) {
    expect(text, `tệp Word thiếu: ${expected}`).toContain(expected);
  }

  // Bản PDF: PDF thật (%PDF-), có đủ chỗ cho chữ, đúng tên.
  const pdf = await downloadVia(page, pdfRow.getByRole('button', { name: /^Tải xuống tệp/ }));
  expect(pdf.name).toBe(`${subject}.pdf`);
  expect(pdf.data.subarray(0, 5).toString('latin1'), 'PDF phải bắt đầu bằng %PDF-').toBe('%PDF-');
  expect(pdf.data.length).toBeGreaterThan(5_000);
  expect(pdf.data.subarray(-1024).toString('latin1')).toContain('%%EOF');

  // Xuất lại giữ cả hai lần xuất: bốn tệp.
  await dialog.getByTestId('compile-button').click();
  await expect(files.getByTestId('file-row')).toHaveCount(4);

  await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
  await submit.click();
  await expect(page.getByText(trun.myTasks.complete.done)).toBeVisible();
  await expect(page.getByText(/Việc này đã xong lúc/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Báo hoàn thành' })).toHaveCount(0);
  await context.close();
});

// ───────────────────────── 7. Chi tiết lượt chạy ─────────────────────────

test('7. Văn phòng xem chi tiết lượt chạy: hồ sơ đính kèm có tệp tải lên, tệp của người đóng góp và hai lần xuất (Word và PDF)', async ({ browser }) => {
  test.setTimeout(120_000);
  expect(runId, 'cần lượt chạy của bước 4').not.toBe('');
  const { context, page } = await login(browser, 'vanphong');

  await page.goto(`/luot-chay/${runId}`);
  await expect(page.getByRole('heading', { level: 1, name: runTitle })).toBeVisible();
  await expect(page.getByText('2 trên 2 việc đã xong')).toBeVisible();

  const attachments = page.getByTestId('run-attachments');
  await expect(attachments.getByRole('heading', { name: trun.detail.attachments.title })).toBeVisible();
  // Hai lần xuất (mỗi lần một Word và một PDF; lần mới nhất là bản trình duyệt), tệp khởi chạy của Lan, tệp của Phương: 6 tệp.
  await expect(attachments).toContainText(trun.detail.attachments.count.replace('{n}', '6'));
  const group = (title: string) => attachments.locator('section').filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });
  const presented = group(trun.detail.attachments.presented);
  await expect(presented).toContainText(`${subject}.docx`);
  await expect(presented).toContainText(`${subject}.pdf`);
  await expect(group(trun.detail.attachments.earlierCompiled)).toContainText(`${subject}.docx`);
  await expect(group(trun.detail.attachments.earlierCompiled)).toContainText(`${subject}.pdf`);
  const initial = group(trun.detail.attachments.initial);
  await expect(initial).toContainText(START_PDF);
  await expect(initial).toContainText('Ô: Tài liệu kèm theo');
  const byStep = group(trun.detail.attachments.byStep);
  await expect(byStep).toContainText(`Việc: ${CONTRIBUTE_STEP}`);
  await expect(byStep).toContainText(PHUONG_PDF);

  // Thông tin khởi chạy hiện tên tệp và người đóng góp.
  const info = page.getByTestId('run-start-info');
  await expect(info).toContainText(subject);
  await expect(info).toContainText(recipient);
  await expect(info).toContainText(START_PDF);
  await expect(info).toContainText('Đặng Mai Phương');
  await expect(info).toContainText('Bùi Quốc Tuấn');
  await shot(page, '07-chi-tiet-luot-chay-ho-so-1280');

  // Tải lại đúng tệp PDF đã tải lên từ hồ sơ: nội dung không đổi một byte.
  const pdf = await downloadVia(page, attachments.getByRole('button', { name: `Tải xuống tệp ${START_PDF}` }));
  expect(pdf.name).toBe(START_PDF);
  expect(pdf.data.equals(pdfStart), 'tệp PDF tải về phải đúng từng byte với tệp đã tải lên').toBe(true);
  // Và tệp Word mới nhất mở được bằng phiên của Văn phòng.
  const word = await downloadVia(page, presented.getByRole('button', { name: `Tải xuống tệp ${subject}.docx` }));
  expect(word.data.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(docxText(word.data)).toContain(textLan);
  // Bản PDF của lần xuất mới nhất cũng mở được bằng phiên của Văn phòng.
  const pdfNow = await downloadVia(page, presented.getByRole('button', { name: `Tải xuống tệp ${subject}.pdf` }));
  expect(pdfNow.data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await context.close();
});

// ───────────────────────── 8. Không tràn ngang ở 1280 ─────────────────────────

test('8. Không tràn ngang ở 1280: hộp chọn mẫu, Sổ văn bản, biểu mẫu có ô tệp', async ({ browser }) => {
  test.setTimeout(150_000);

  // Hộp chọn tạo quy trình và thư viện mẫu.
  const designer = await login(browser, 'thietke', DESKTOP);
  await designer.page.goto('/quy-trinh');
  await designer.page.getByTestId('create-template').click();
  const chooser = designer.page.getByRole('dialog', { name: vi.admin.designer.list.chooser.title });
  await expect(chooser).toBeVisible();
  await expectNoHorizontalScroll(designer.page, 'hộp chọn tạo quy trình', chooser);
  await shot(designer.page, '08-hop-chon-tao-quy-trinh-1280', false);
  await designer.page.getByTestId('create-from-preset').click();
  const gallery = designer.page.getByTestId('preset-gallery');
  await expect(gallery.getByRole('article')).toHaveCount(3);
  await expectNoHorizontalScroll(designer.page, 'thư viện mẫu', gallery);
  await shot(designer.page, '08-thu-vien-mau-1280', false);
  await designer.page.keyboard.press('Escape');
  await designer.context.close();

  // Sổ văn bản: cả ba sổ.
  const office = await login(browser, 'vanphong', DESKTOP);
  await office.page.goto('/so-van-ban');
  await expect(office.page.getByRole('heading', { level: 1, name: tdoc.title })).toBeVisible();
  for (const code of ['VBDEN', 'VBDI', 'CHITHI']) {
    await office.page.getByTestId(`register-${code}`).click();
    await expect(office.page.getByRole('table', { name: /Bảng các văn bản trong/ }).locator('tbody tr').first()).toBeVisible();
    await expectNoHorizontalScroll(office.page, `Sổ văn bản ${code}`);
  }
  await shot(office.page, '08-so-van-ban-1280');
  await office.context.close();

  // Biểu mẫu khởi chạy có ô tệp, với tên tệp rất dài và đủ người đóng góp (trường hợp dễ tràn nhất). Không khởi chạy.
  const lan = await login(browser, 'lan', DESKTOP);
  await lan.page.goto(`/luot-chay/moi?templateId=${templateId}`);
  await expect(lan.page.getByTestId('file-tep-input')).toBeAttached();
  const longName = `${'bao-cao-tong-hop-rat-dai-'.repeat(6)}${stamp}.pdf`;
  await lan.page.getByTestId('file-tep-input').setInputFiles({ name: longName, mimeType: 'application/pdf', buffer: pdfStart });
  await expectUploaded(lan.page, 'tep', longName);
  const combo = lan.page.getByTestId('field-dongGop').getByRole('combobox');
  await combo.click();
  await combo.fill('Phương');
  await lan.page.getByRole('option', { name: /Đặng Mai Phương/ }).click();
  await expectNoHorizontalScroll(lan.page, 'biểu mẫu có ô tệp');
  await shot(lan.page, '08-bieu-mau-o-tep-1280');
  // Gỡ tệp vừa tải để không để lại tệp chờ gắn.
  await lan.page.getByRole('button', { name: `Gỡ tệp ${longName}` }).click();
  await expect(lan.page.getByTestId('file-tep-item')).toHaveCount(0);
  await lan.context.close();
});
