/**
 * Kịch bản kiểm các màn Người dùng và tổ chức, Thông báo và nhật ký, Cài đặt tổ chức, Báo cáo trên API thật với dữ liệu mẫu
 * (SPEC 9.1, 9.2, 9.5, 9.6, 15.4). Mọi thao tác đi qua giao diện; API chỉ dùng để chuẩn bị, đối chiếu số liệu và dọn dẹp.
 *
 * Chuẩn bị: API ở cổng 3100 (pnpm db:seed rồi pnpm --filter @mihato/api dev) và web quản trị đang chạy.
 * Chạy (từ apps/web-admin):
 *   npx playwright test e2e/org.spec.ts                                   (web ở cổng 5273)
 *   WEB_URL=http://localhost:5276 npx playwright test e2e/org.spec.ts     (web ở cổng khác)
 * Khi vừa sửa mã, nên trỏ vào bản đã dựng (pnpm build rồi vite preview): máy chủ phát triển tải lại cả trang mỗi khi ai đó sửa
 * tệp chuỗi dùng chung, làm mất biểu mẫu đang điền giữa chừng.
 * Biến môi trường: WEB_URL (mặc định http://localhost:5273, cùng playwright.config.ts), DEMO_PASSWORD, SHOTS_DIR (nơi lưu ảnh chụp từng màn),
 * E2E_DATABASE_URL (CSDL phát triển, mặc định theo docker-compose.yml).
 *
 * Ba chỗ dùng CSDL trực tiếp qua `psql`, vì dữ liệu mẫu không có và giao diện không thể tạo ra:
 *   - bảng `effects`: chèn hai dòng `dead` (kind `webhook`, mã lỗi mang dấu của lần chạy) để thử nút "Thử lại" và lỗi 409;
 *   - bảng `ai_usage`: chèn ba dòng số liệu dùng Trợ lý AI (hai người, hai ngày) và một dòng của hôm nay (1 USD) cho cảnh báo ngân sách;
 *   - bảng `notifications`: chèn bốn thông báo thử cho người thử A ở các trạng thái chờ gửi, đã giao, đã mở, lỗi (dữ liệu mẫu chỉ có "Đã gửi").
 * Cả ba được xoá ngay sau khi dùng và lần nữa ở afterAll. Ngoài ra `psql` chỉ đọc (đối chiếu số liệu báo cáo với dữ liệu gốc).
 *
 * Dữ liệu thử: người dùng mới mang tiền tố "Kiểm thử tổ chức" và dấu thời gian của lần chạy; 12 người mẫu và 7 đơn vị mẫu không
 * bị đụng tới. API chưa có đường xoá người và đơn vị, nên cuối lần chạy mọi người thử bị vô hiệu hoá, ủy quyền và ngày nghỉ thử
 * bị xoá, cấu hình tổ chức được trả về như cũ; các đơn vị thử còn lại dưới đơn vị gốc "Kiểm thử tự động" (pnpm db:seed để xoá sạch).
 *
 * Giới hạn: API cho mỗi phiên 120 yêu cầu mỗi phút, đăng nhập 10 lần mỗi phút mỗi địa chỉ. Kịch bản đăng nhập mỗi vai một lần
 * và tự giãn các yêu cầu (xô thẻ ở lớp mạng) để không bao giờ chạm ngưỡng, kể cả khi chạy cùng các kịch bản khác.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';
import { AUDIT_ACTIONS, type AuditEntry, type DelegationView, type Holiday, type OrgSettings, type Report, type UnitView, type UserView } from '@mihato/domain';
import { vi } from '@mihato/i18n';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5273';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'mihato-demo-2026';
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/org-shots';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres_dev@127.0.0.1:5455/mihato_dev';
const DESKTOP = { width: 1280, height: 900 };
const WIDE = { width: 1440, height: 900 };

test.use({ baseURL: WEB_URL, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });

// ───────────────────────── Dữ liệu thử ─────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
/** Dấu riêng của mỗi lần chạy (tháng, ngày, giờ, phút, giây theo giờ Việt Nam). Đặt vào môi trường để mọi worker cùng dùng một dấu. */
const stamp = (process.env.ORG_STAMP ??= (() => {
  const d = new Date(Date.now() + 7 * 3_600_000);
  return `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
})());

const PREFIX = 'Kiểm thử tổ chức';
type TestUser = { fullName: string; givenName: string; honorific: string; email: string; label: string; short: string };
const person = (suffix: string, givenName: string, honorific: string): TestUser => {
  const fullName = `${PREFIX} ${stamp} ${suffix}`;
  return { fullName, givenName, honorific, email: `ktchuc${stamp}${suffix.toLowerCase()}@demo.mihato.local`, label: `${honorific} ${fullName}`, short: `${honorific} ${givenName}` };
};
/** A: nhập bằng biểu mẫu (nhân viên). B và C: nhập bằng CSV (nhân viên; Giám đốc). D: Quản trị hệ thống thứ hai, để kiểm điều kiện "cuối cùng". */
const userA = person('A', 'Thử', 'anh');
const userB = person('B', 'Nhập', 'chị');
const userC = person('C', 'Điều', 'ông');
const userD = person('D', 'Phụ', 'bà');

const PARENT_UNIT = 'Kiểm thử tự động';
const unitMain = `Tổ kiểm thử tổ chức ${stamp}`;
/** Hai đơn vị chỉ khác dấu: nhập CSV theo tên không phân biệt dấu thì không biết chọn đơn vị nào (`unit_ambiguous`). */
const unitTwin = `Tổ trùng tên ${stamp}`;
const unitTwinPlain = `To trung ten ${stamp}`;
const newPassword = `Mk-${stamp}`.slice(0, 12);
const HOLIDAY_YEAR = 2028;
const IT_EMAIL = 'it@demo.mihato.local';
/** Dòng tiêu đề của tệp nhập người dùng (SPEC 9.5): mã cột, không dịch. */
const CSV_HEADER = 'fullName,givenName,honorific,email,phone,unit,manager,roles,uiProfile';

// ───────────────────────── Hạ tầng: phiên, yêu cầu API, CSDL ─────────────────────────

/**
 * Xô thẻ cho yêu cầu API của một phiên. Máy chủ cho 120 yêu cầu mỗi phút mỗi phiên: ở đây nổ tối đa 20 yêu cầu liền, sau đó
 * 1,2 yêu cầu mỗi giây, nên mọi cửa sổ 60 giây có không quá 20 + 72 = 92 yêu cầu. Phần dư 28 dành cho luồng /v1/stream (mỗi
 * lần mở trang là một kết nối, không qua xô) và cho các yêu cầu sát mép cửa sổ. Người dùng thật không chạm ngưỡng này;
 * kịch bản bấm nhanh hơn người nhiều lần nên tự giãn thay vì nhận 429.
 */
class Throttle {
  private tokens = 20;
  private last = Date.now();
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(20, this.tokens + ((now - this.last) / 1000) * 1.2);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, ((1 - this.tokens) / 1.2) * 1000));
    }
  }
}

/** Mã trạng thái cổng proxy trả khi API đang khởi động lại hoặc chưa sẵn sàng. */
const UNAVAILABLE = [502, 503, 504];

type UserKey = 'it' | 'vanphong' | 'chutich' | 'lan';
type Session = { key: UserKey; context: BrowserContext; page: Page; throttle: Throttle; jsErrors: string[] };
type Viewport = { width: number; height: number };

async function newContext(browser: Browser, throttle: Throttle, viewport: Viewport = DESKTOP, storageState?: Awaited<ReturnType<BrowserContext['storageState']>>): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: WEB_URL, viewport, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', acceptDownloads: true, storageState, permissions: ['clipboard-read', 'clipboard-write'] });
  // Thao tác không tìm thấy hoặc không bấm được thì báo lỗi sau 15 giây, không treo tới hết thời gian của cả test.
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(30_000);
  // Mọi yêu cầu tới /v1 của trình duyệt đi qua xô thẻ (luồng /v1/stream chỉ là một kết nối dài nên để qua).
  await context.route(/\/v1\/(?!stream)/, async (route) => {
    await throttle.take();
    // API tự khởi động lại mỗi khi mã nguồn đổi (tsx watch): vài giây cổng proxy trả 502 và màn hình dừng ở "Chưa tải được dữ liệu"
    // cho tới khi có người bấm "Thử lại". Yêu cầu đọc được thử lại tới 15 giây rồi mới trả lỗi cho trình duyệt (kết quả cuối vẫn
    // là phản hồi thật, không giả lập gì); yêu cầu ghi đi thẳng vì đăng nhập đặt cookie và mỗi lần ghi cần đúng một lần gửi.
    if (route.request().method() !== 'GET') return route.continue();
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const response = await route.fetch();
        if (!UNAVAILABLE.includes(response.status())) return await route.fulfill({ response });
      } catch (error) {
        if (/closed|disposed|already handled/i.test(String(error))) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_250));
    }
    await route.continue().catch(() => undefined);
  });
  return context;
}

/** Điền biểu mẫu đăng nhập; bị giới hạn tần suất (10 lần mỗi phút) thì chờ rồi thử lại. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goto('/dang-nhap');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    try {
      await page.getByRole('navigation', { name: 'Điều hướng chính' }).first().waitFor({ timeout: 8_000 });
      return;
    } catch {
      await page.waitForTimeout(15_000);
    }
  }
  throw new Error(`Không đăng nhập được bằng ${email}`);
}

async function openSession(browser: Browser, key: UserKey): Promise<Session> {
  const throttle = new Throttle();
  const context = await newContext(browser, throttle);
  const page = await context.newPage();
  const jsErrors: string[] = [];
  page.on('pageerror', (error) => jsErrors.push(String(error)));
  await signIn(page, `${key}@demo.mihato.local`, PASSWORD);
  return { key, context, page, throttle, jsErrors };
}

/** Mỗi vai đăng nhập một lần cho cả lần chạy (gọi lại thì dùng phiên cũ). */
const sessions = new Map<UserKey, Promise<Session>>();
function sessionOf(browser: Browser, key: UserKey): Promise<Session> {
  let session = sessions.get(key);
  if (!session) {
    session = openSession(browser, key);
    sessions.set(key, session);
  }
  return session;
}

/** Mở cùng phiên đăng nhập ở một bề rộng khác (ảnh chụp 1280 và 1440). */
async function atViewport(browser: Browser, session: Session, viewport: Viewport, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await newContext(browser, session.throttle, viewport, await session.context.storageState());
  const page = await context.newPage();
  page.on('pageerror', (error) => session.jsErrors.push(String(error)));
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/**
 * Gọi API bằng phiên đã đăng nhập (kèm mã CSRF và khoá chống lặp như web), qua cùng xô thẻ với trình duyệt.
 * API tự khởi động lại mỗi khi mã nguồn đổi (tsx watch), trong vài giây cổng proxy trả 502 hoặc từ chối kết nối; bị giới hạn
 * tần suất thì chờ hết cửa sổ một phút. Cả hai trường hợp đều thử lại, các lỗi khác trả về nguyên trạng để test khẳng định.
 */
async function api<T = unknown>(session: Session, method: Method, path: string, data?: unknown): Promise<{ status: number; body: T }> {
  // Một khoá chống lặp cho mọi lần thử của cùng một lời gọi: thử lại sau khi máy chủ khởi động lại không tạo trùng.
  const idempotencyKey = crypto.randomUUID();
  for (let attempt = 0; attempt < 8; attempt++) {
    await session.throttle.take();
    const csrf = (await session.context.cookies()).find((c) => c.name === 'mihato_csrf')?.value ?? '';
    try {
      const res = await session.context.request.fetch(path, {
        method,
        data,
        headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Idempotency-Key': idempotencyKey },
      });
      if (res.status() === 429) {
        await session.page.waitForTimeout(20_000);
        continue;
      }
      if (UNAVAILABLE.includes(res.status())) {
        await session.page.waitForTimeout(1_500);
        continue;
      }
      return { status: res.status(), body: (await res.json().catch(() => null)) as T };
    } catch (error) {
      if (attempt === 7) throw error;
      await session.page.waitForTimeout(1_500);
    }
  }
  throw new Error(`${method} ${path}: máy chủ chưa sẵn sàng sau 8 lần thử`);
}

/** Chạy một câu SQL bằng psql và trả kết quả dạng chữ (cột ngăn bằng "|"). */
function psql(statement: string): string {
  return execFileSync('psql', [DATABASE_URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim();
}
const demoOrgId = (): string => psql("select id from organizations where code = 'demo'");

const vnDate = (offsetDays = 0): string => new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
const vnDateOf = (iso: string): string => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);

type Page_<T> = { items: T[]; nextCursor: string | null };
async function listAll<T>(session: Session, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const res: { status: number; body: Page_<T> } = await api<Page_<T>>(session, 'GET', `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.status, path).toBe(200);
    out.push(...res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor);
  return out;
}
const usersOf = (session: Session, q: string): Promise<UserView[]> => listAll<UserView>(session, `/v1/users?q=${encodeURIComponent(q)}`);

// ───────────────────────── Hàm dùng chung cho các bước trên giao diện ─────────────────────────

/**
 * API tự khởi động lại mỗi khi mã nguồn đổi: trong vài giây cổng proxy từ chối kết nối và màn hình hiện "Chưa tải được dữ liệu".
 * Người dùng thật bấm "Thử lại"; kịch bản cũng vậy.
 */
async function retryLoad(page: Page): Promise<void> {
  for (const alert of await page.getByRole('alert').filter({ hasText: 'Chưa tải được dữ liệu' }).all()) await alert.getByRole('button', { name: 'Thử lại' }).click();
}

/** Chờ bảng hiện ra và hết tải: bảng đang tải hiện các dòng giữ chỗ (cũng là <tr>), nên phải chờ hết `aria-busy` trước khi đếm dòng. */
async function settled(table: Locator): Promise<void> {
  await expect(async () => {
    await retryLoad(table.page());
    await expect(table).toBeVisible({ timeout: 3_000 });
    await expect(table).not.toHaveAttribute('aria-busy', 'true', { timeout: 3_000 });
  }).toPass({ timeout: 25_000 });
}

/** Thông báo nổi ở góc màn hình (danh sách có nhãn "Thông báo của hệ thống"). */
const toast = (page: Page, text: string | RegExp): Locator => page.getByRole('list', { name: 'Thông báo của hệ thống' }).getByText(text).first();

/** Chọn một giá trị trong hộp chọn (Radix Select) theo nhãn của ô. */
async function choose(scope: Page | Locator, label: string | RegExp, option: string | RegExp, exact = true): Promise<void> {
  await scope.getByLabel(label, { exact: typeof label === 'string' }).click();
  // Danh sách lựa chọn được vẽ ở cuối trang (portal), ngoài hộp thoại đang mở.
  const page = 'page' in scope ? scope.page() : scope;
  await page.getByRole('option', { name: option, exact }).click();
}

/** Gõ tên vào ô chọn người rồi chọn dòng khớp. */
async function pickPerson(field: Locator, text: string, option: string | RegExp): Promise<void> {
  await field.click();
  await field.fill(text);
  await field.page().getByRole('option', { name: option }).first().click();
}

/** Chụp ảnh sau khi dữ liệu và phông chữ đã ổn định (không còn khung giữ chỗ). */
async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  // Ảnh cả trang chụp từ đầu trang: thanh bên và thanh trên dính (sticky) sẽ lệch xuống giữa ảnh nếu trang đang cuộn.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

/**
 * Những chỗ chưa đạt về bố cục của trang đang mở (rỗng là đạt): trang không được tràn ngang, và chữ ở tiêu đề, nút, tiêu đề cột,
 * nhãn không được bị cắt (scrollWidth lớn hơn clientWidth). Chữ cắt bằng dấu "…" có chủ ý (email dài trong bảng) không tính.
 * Trả về danh sách để một lần chạy báo hết mọi màn, thay vì dừng ở màn đầu tiên.
 */
async function fitIssues(page: Page, where: string): Promise<string[]> {
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > window.innerWidth) out.push(`trang tràn ngang: ${root.scrollWidth} > ${window.innerWidth}`);
    for (const el of document.querySelectorAll<HTMLElement>('h1, h2, h3, legend, th, label, nav a, button:not([role="combobox"])')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.display === 'inline' || style.visibility === 'hidden' || el.classList.contains('sr-only')) continue;
      if (el.closest('.sr-only, [aria-hidden="true"]')) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`chữ bị cắt ở <${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 50)}" (${el.scrollWidth} > ${el.clientWidth})`);
    }
    return out;
  });
  return issues.map((issue) => `${where}: ${issue}`);
}

/**
 * Trợ năng cơ bản của trang đang mở (rỗng là đạt): mọi nút, liên kết, ô nhập, hộp chọn, ô tích, công tắc đang hiện đều có tên
 * đọc được (nhãn gắn với ô, aria-label hoặc chữ bên trong), mọi ảnh có alt. Chỉ tính phần tử đang hiện và không bị ẩn khỏi cây trợ năng.
 */
async function labelIssues(page: Page, where: string): Promise<string[]> {
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    const shown = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && (box.width > 0 || box.height > 0) && !el.closest('[aria-hidden="true"], [hidden]');
    };
    const nameOf = (el: Element): string => {
      const label = el.getAttribute('aria-label')?.trim();
      if (label) return label;
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const named = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (named) return named;
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) {
        const labelled = [...(el.labels ?? [])].map((l) => l.textContent ?? '').join(' ').trim();
        if (labelled) return labelled;
      }
      return (el.textContent ?? '').trim() || (el.getAttribute('title') ?? '').trim();
    };
    for (const el of document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="combobox"], [role="checkbox"], [role="switch"], [role="radio"]')) {
      if (!shown(el) || nameOf(el)) continue;
      out.push(`<${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}> không có tên: ${el.outerHTML.slice(0, 110)}`);
    }
    for (const img of document.querySelectorAll('img')) if (shown(img) && img.getAttribute('alt') === null) out.push(`<img> thiếu alt: ${img.src.slice(0, 40)}`);
    return out;
  });
  return issues.map((issue) => `${where}: ${issue}`);
}

/** Đọc một tệp tải về: 3 byte BOM đầu tiên, nội dung UTF-8 dạng NFC, không có ký tự thay thế (dấu tiếng Việt không vỡ). */
async function readCsv(download: { path(): Promise<string>; suggestedFilename(): string }): Promise<{ rows: string[][]; text: string; bytes: Buffer }> {
  const bytes = await readFile(await download.path());
  expect([...bytes.subarray(0, 3)], 'BOM EF BB BF').toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8').slice(1);
  expect(text.includes('\uFFFD'), 'không có ký tự thay thế U+FFFD').toBe(false);
  expect(text, 'chữ ở dạng NFC').toBe(text.normalize('NFC'));
  expect(text.endsWith('\r\n'), 'xuống dòng CRLF').toBe(true);
  return { rows: parseCsv(text), text, bytes };
}

/** Đọc CSV theo RFC 4180 (ô trong nháy kép chứa dấu phẩy và xuống dòng). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ───────────────────────── Người dùng: bước dùng chung ─────────────────────────

/** Đọc dải thẻ số (StatGroup): nhãn → con số đang hiện. */
async function tilesIn(group: Locator): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const card of await group.locator(':scope > div').all()) {
    const spans = card.locator(':scope > span');
    out[(await spans.nth(0).innerText()).trim()] = (await spans.nth(1).innerText()).trim();
  }
  return out;
}

/** Dòng của một người trong bảng người dùng, tìm theo email (họ tên còn xuất hiện ở dòng "Cấp trên" của người khác). */
const userRow = (page: Page, email: string): Locator => page.getByRole('row').filter({ hasText: email });

/** Mở tab Người dùng và lọc theo `query`; chờ bảng đã lọc xong (không còn dòng của dữ liệu mẫu) rồi mới thao tác. */
async function gotoUsers(page: Page, query: string = stamp): Promise<void> {
  await page.goto('/to-chuc/nguoi-dung');
  const box = page.getByLabel('Tìm người dùng theo tên');
  // Tải lại trang giữa chừng (máy chủ phát triển) làm mất chữ đã gõ: gõ lại cho tới khi bảng lọc xong.
  await expect(async () => {
    await retryLoad(page);
    if ((await box.inputValue()) !== query) await box.fill(query);
    // Bảng đã lọc xong khi mọi dòng, trừ dòng tiêu đề, đều chứa chữ cần tìm. Danh sách chưa lọc (hoặc khung giữ chỗ lúc đang tải)
    // cũng có dòng thử, nên chỉ đếm dòng thử là chưa đủ: bấm vào trình đơn của dòng đó rồi bảng lọc xong sẽ đóng trình đơn.
    await expect(page.getByRole('row').filter({ hasNotText: query })).toHaveCount(1, { timeout: 2_000 });
    await expect(page.getByRole('row').filter({ hasText: query }).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 25_000 });
}

/** Tìm người thử trong bảng người dùng rồi mở trình đơn thao tác của dòng đó. */
async function openUserMenu(page: Page, label: string, item: string): Promise<void> {
  await page.getByRole('button', { name: `Thao tác với ${label}` }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Số lần một yêu cầu khớp bộ lọc xuất hiện kể từ lúc gọi (để khẳng định "không gửi gì lên máy chủ"). */
function countRequests(page: Page, match: (method: string, url: string) => boolean): () => number {
  let n = 0;
  page.on('request', (request) => {
    if (match(request.method(), request.url())) n++;
  });
  return () => n;
}

// ───────────────────────── Quản trị hệ thống ─────────────────────────

test.describe('Quản trị hệ thống', () => {
  test.describe.configure({ mode: 'serial' });

  test('thêm đơn vị: đơn vị gốc cho dữ liệu thử, đơn vị con và hai đơn vị trùng tên khác dấu', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await page.goto('/to-chuc/don-vi');
    const table = page.getByRole('table', { name: 'Cây đơn vị của tổ chức' });
    await settled(table);
    await expect(table.getByRole('row').filter({ hasText: 'Ban Chủ tịch' })).toBeVisible();

    // Đơn vị gốc của dữ liệu thử chỉ tạo ở lần chạy đầu tiên.
    if ((await table.getByRole('row').filter({ hasText: PARENT_UNIT }).count()) === 0) {
      await page.getByRole('button', { name: 'Thêm đơn vị', exact: true }).click();
      const create = page.getByRole('dialog', { name: 'Thêm đơn vị' });
      await expect(create.getByLabel('Đơn vị cha')).toContainText('Không có (đơn vị cấp cao nhất)');
      await create.getByLabel('Tên đơn vị').fill(PARENT_UNIT);
      await create.getByRole('button', { name: 'Thêm đơn vị' }).click();
      await expect(toast(page, `Đã thêm đơn vị ${PARENT_UNIT}.`)).toBeVisible();
    }

    let first = true;
    for (const name of [unitMain, unitTwin, unitTwinPlain]) {
      await page.getByRole('button', { name: `Thêm đơn vị con của ${PARENT_UNIT}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Thêm đơn vị' });
      // Mở từ nút "thêm đơn vị con" thì đơn vị cha được chọn sẵn.
      await expect(dialog.getByLabel('Đơn vị cha')).toContainText(PARENT_UNIT);
      if (first) {
        await dialog.getByRole('button', { name: 'Thêm đơn vị' }).click();
        await expect(dialog.getByText('Xin nhập tên đơn vị, tối đa 120 ký tự.')).toBeVisible();
        first = false;
      }
      await dialog.getByLabel('Tên đơn vị').fill(name);
      await dialog.getByRole('button', { name: 'Thêm đơn vị' }).click();
      await expect(toast(page, `Đã thêm đơn vị ${name}.`)).toBeVisible();
      await expect(dialog).toBeHidden();
    }

    const row = table.getByRole('row').filter({ hasText: unitMain });
    await expect(row).toContainText(`thuộc ${PARENT_UNIT}`);
    await expect(row).toContainText('Chưa có trưởng đơn vị');
  });

  test('thêm người dùng mới bằng bảng trượt; ô chọn có nhãn, lỗi gắn với ô', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await page.goto('/to-chuc');
    // /to-chuc tự chuyển tới tab đầu tiên có quyền; Quản trị hệ thống không có quyền ngày nghỉ nên không thấy tab đó.
    await expect(page).toHaveURL(/\/to-chuc\/nguoi-dung$/);
    const tabs = page.getByRole('navigation', { name: 'Các mục của Người dùng và tổ chức' });
    await expect(tabs.getByRole('link')).toHaveText(['Người dùng', 'Đơn vị', 'Ủy quyền', 'Phân quyền']);
    await expect(page.getByRole('row').filter({ hasText: 'chutich@demo' })).toContainText('Chủ tịch');

    await page.getByRole('button', { name: 'Thêm người dùng' }).click();
    const sheet = page.getByRole('dialog', { name: 'Thêm người dùng' });
    // Gửi khi còn trống: báo lỗi tại ô (aria-invalid, aria-describedby trỏ tới câu lỗi), không gọi máy chủ.
    const created = countRequests(page, (method, url) => method === 'POST' && /\/v1\/users$/.test(url));
    await sheet.getByRole('button', { name: 'Thêm người dùng' }).click();
    const fullName = sheet.getByLabel('Họ và tên');
    await expect(sheet.getByText('Xin nhập họ và tên, tối đa 120 ký tự.')).toBeVisible();
    await expect(fullName).toHaveAttribute('aria-invalid', 'true');
    const describedBy = (await fullName.getAttribute('aria-describedby')) ?? '';
    await expect(page.locator(`[id="${describedBy.split(' ')[0]}"]`)).toContainText('Xin nhập họ và tên');
    expect(created()).toBe(0);

    // Ô chọn gắn đúng nhãn: getByLabel ra đúng một hộp chọn (combobox), không rơi vào ô khác.
    for (const label of ['Xưng hô', 'Đơn vị', 'Hồ sơ giao diện', 'Vai trò thứ 1', 'Phạm vi của vai trò thứ 1']) {
      const control = sheet.getByLabel(label, { exact: true });
      await expect(control, label).toHaveCount(1);
      await expect(control, label).toHaveRole('combobox');
    }
    await expect(sheet.getByLabel('Người quản lý')).toHaveRole('combobox');

    await fullName.fill(userA.fullName);
    await fullName.blur();
    // Tên gọi được điền sẵn bằng tiếng cuối của họ tên, sửa lại được.
    await expect(sheet.getByLabel('Tên gọi')).toHaveValue('A');
    await sheet.getByLabel('Tên gọi').fill(userA.givenName);
    await choose(sheet, 'Xưng hô', userA.honorific);
    await expect(sheet.getByText('Cách gọi trong lời nhắc và thông báo:')).toContainText(userA.short);
    await choose(sheet, 'Đơn vị', unitMain);
    await pickPerson(sheet.getByLabel('Người quản lý'), 'huy', /Phạm Quang Huy/);
    await choose(sheet, 'Phạm vi của vai trò thứ 1', unitMain);
    await sheet.getByLabel('Email').fill(userA.email);
    await sheet.getByLabel('Điện thoại').fill('0900 000 001');
    await choose(sheet, 'Hồ sơ giao diện', 'Chữ lớn, nút lớn (senior)');
    await sheet.getByLabel('Thứ tự hiển thị').fill('90');
    await shot(page, 'nguoi-dung-them-1280', false);
    await sheet.getByRole('button', { name: 'Thêm người dùng' }).click();
    await expect(toast(page, `Đã thêm ${userA.label}.`)).toBeVisible();

    await gotoUsers(page);
    const row = userRow(page, userA.email);
    await expect(row).toContainText('Chờ kích hoạt');
    await expect(row).toContainText(unitMain);
    await expect(row).toContainText('Cấp trên: Phạm Quang Huy');
    await expect(row).toContainText(`Nhân viên (${unitMain})`);
    await expect(row).toContainText('Chưa đặt mật khẩu');

    // Email trùng: lỗi gắn đúng ô email, bằng câu tiếng Việt.
    await page.getByRole('button', { name: 'Thêm người dùng' }).click();
    const again = page.getByRole('dialog', { name: 'Thêm người dùng' });
    await again.getByLabel('Họ và tên').fill(`${PREFIX} ${stamp} trùng email`);
    await again.getByLabel('Tên gọi').fill('Trùng');
    await again.getByLabel('Email').fill(userA.email);
    await again.getByRole('button', { name: 'Thêm người dùng' }).click();
    await expect(again.getByText('Email này đã thuộc về một người dùng khác.')).toBeVisible();
    await expect(again.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
    await again.getByRole('button', { name: 'Đóng' }).first().click();
    await expect(again).toBeHidden();
  });

  test('tạo mã kích hoạt cho nhân viên: mã QR, đường dẫn mihato://, hạn 72 giờ, chỉ hiện một lần, chép và in', async ({ browser, playwright }) => {
    const { page } = await sessionOf(browser, 'it');
    // Trình duyệt không đầu không mở hộp thoại in: thay window.print (kể cả trong khung in) bằng bộ đếm để kiểm tờ in.
    await page.addInitScript(() => {
      window.print = () => {
        const top = window.top as unknown as { printCalls?: number };
        top.printCalls = (top.printCalls ?? 0) + 1;
      };
    });
    await gotoUsers(page);
    await openUserMenu(page, userA.label, 'Tạo mã kích hoạt thiết bị');
    const dialog = page.getByRole('dialog', { name: 'Mã kích hoạt thiết bị' });
    await expect(dialog.getByText('Mã chỉ hiện một lần')).toBeVisible();
    await expect(dialog.getByText('Đóng hộp thoại này là không xem lại được.')).toBeVisible();
    // Nhân viên không có lựa chọn app: tạo ngay, app nhân viên.
    await expect(dialog.getByRole('radio')).toHaveCount(0);
    await expect(dialog.getByText('Ứng dụng: MIHATO Việc của tôi')).toBeVisible();
    const qr = dialog.getByRole('img', { name: `Mã QR kích hoạt thiết bị của ${userA.label}` });
    await expect(qr).toBeVisible();
    expect(await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 100)).toBe(true);
    await expect(dialog.getByText(/Hết hạn lúc \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(sau 72 giờ\)\. Dùng được một lần\./)).toBeVisible();
    const url = await dialog.getByLabel('Đường dẫn kích hoạt').inputValue();
    expect(url).toMatch(/^mihato:\/\/activate\?token=/);
    // Hạn thật là 72 giờ kể từ lúc tạo: câu chữ không được lệch với dữ liệu.
    const shown = (await dialog.getByText(/Hết hạn lúc/).innerText()).match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
    const expires = Date.parse(`${shown![3]}-${shown![2]}-${shown![1]}T${shown![4]}:${shown![5]}:00+07:00`);
    expect(Math.abs(expires - (Date.now() + 72 * 3_600_000))).toBeLessThan(10 * 60_000);
    await shot(page, 'ma-kich-hoat-1280', false);

    await dialog.getByRole('button', { name: 'Sao chép đường dẫn' }).click();
    await expect(toast(page, 'Đã sao chép đường dẫn.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

    // Nút in dựng một tờ riêng (khung ẩn) có tên người, mã QR, tên ứng dụng và cách dùng.
    await dialog.getByRole('button', { name: 'In mã' }).click();
    const sheet = page.frameLocator('iframe[data-print-frame]');
    await expect(sheet.getByText(userA.label)).toBeAttached();
    await expect(sheet.locator('img')).toBeAttached();
    await expect(sheet.locator('li')).toHaveCount(3);
    await expect(sheet.locator('li').first()).toHaveText('Cài và mở ứng dụng MIHATO Việc của tôi trên điện thoại.');
    await expect.poll(() => page.evaluate(() => (window as unknown as { printCalls?: number }).printCalls ?? 0)).toBe(1);

    // Dùng chính mã vừa tạo để kích hoạt một thiết bị qua API công khai (thay cho app điện thoại), lấy dữ liệu cho bước thu hồi.
    const token = new URL(url.replace('mihato://', 'https://x/')).searchParams.get('token');
    expect(token).toBeTruthy();
    const anonymous = await playwright.request.newContext({ baseURL: WEB_URL });
    const activated = await anonymous.post('/v1/devices/activate', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { activationToken: token, deviceName: 'Máy kiểm thử', platform: 'android' },
    });
    expect(activated.status(), await activated.text()).toBeLessThan(300);
    // Mã chỉ dùng được một lần.
    const reused = await anonymous.post('/v1/devices/activate', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { activationToken: token, deviceName: 'Máy khác', platform: 'ios' },
    });
    expect(reused.status()).toBe(401);
    await anonymous.dispose();
    await dialog.getByRole('button', { name: 'Đóng' }).first().click();
    await expect(dialog).toBeHidden();
  });

  test('xem thiết bị và thu hồi có xác nhận', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await gotoUsers(page);
    const row = userRow(page, userA.email);
    // Kích hoạt thiết bị chuyển người dùng từ Chờ kích hoạt sang Đang hoạt động (SPEC 9.5 điều 3).
    await expect(row).toContainText('Đang hoạt động');
    await openUserMenu(page, userA.label, 'Thiết bị');
    const sheet = page.getByRole('dialog', { name: `Thiết bị của ${userA.label}` });
    await expect(sheet.getByText('Máy kiểm thử')).toBeVisible();
    await expect(sheet.getByText('Đang dùng')).toBeVisible();
    await expect(sheet.getByText('Android')).toBeVisible();
    await shot(page, 'thiet-bi-1280', false);
    await sheet.getByRole('button', { name: 'Thu hồi Máy kiểm thử' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Thu hồi thiết bị này?' });
    await expect(confirm).toContainText('sẽ bị đăng xuất ngay');
    await confirm.getByRole('button', { name: 'Thu hồi thiết bị' }).click();
    await expect(toast(page, 'Đã thu hồi thiết bị.')).toBeVisible();
    await expect(sheet.getByText('Đã thu hồi', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Thu hồi Máy kiểm thử' })).toHaveCount(0);
  });

  test('đường dẫn đặt mật khẩu: đặt mật khẩu từ 12 ký tự, đăng nhập bằng người mới, đường dẫn không dùng lại được', async ({ browser }) => {
    test.setTimeout(240_000);
    const { page } = await sessionOf(browser, 'it');
    await gotoUsers(page);
    await openUserMenu(page, userA.label, 'Tạo đường dẫn đặt mật khẩu web');
    const dialog = page.getByRole('dialog', { name: 'Đường dẫn đặt mật khẩu web' });
    await expect(dialog.getByText('Đường dẫn chỉ hiện một lần')).toBeVisible();
    await expect(dialog.getByText(/Hết hạn lúc \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\. Dùng được một lần\./)).toBeVisible();
    const link = await dialog.getByLabel('Đường dẫn đặt mật khẩu').inputValue();
    const token = new URL(link).searchParams.get('token');
    expect(token).toBeTruthy();
    await shot(page, 'duong-dan-mat-khau-1280', false);
    await dialog.getByRole('button', { name: 'Đóng' }).first().click();

    // Người mới mở đường dẫn ở một trình duyệt khác (chưa đăng nhập).
    const context = await newContext(browser, new Throttle());
    const guest = await context.newPage();
    await guest.goto(`/dat-mat-khau?token=${encodeURIComponent(token ?? '')}`);
    const set = async (password: string, again: string) => {
      await guest.getByLabel('Mật khẩu mới').fill(password);
      await guest.getByLabel('Nhập lại mật khẩu').fill(again);
      await guest.getByRole('button', { name: 'Đặt mật khẩu' }).click();
    };
    // 11 ký tự chưa đủ, hai lần nhập lệch nhau cũng không được; không gửi gì lên máy chủ.
    const posted = countRequests(guest, (method, url) => method === 'POST' && url.endsWith('/v1/auth/password/set'));
    await set(newPassword.slice(0, 11), newPassword.slice(0, 11));
    await expect(guest.getByText('Mật khẩu cần ít nhất 12 ký tự.')).toBeVisible();
    await set(newPassword, `${newPassword}x`);
    await expect(guest.getByText('Hai lần nhập chưa giống nhau.')).toBeVisible();
    expect(posted()).toBe(0);
    await set(newPassword, newPassword);
    await expect(guest.getByRole('heading', { name: 'Đã đặt mật khẩu' })).toBeVisible();
    await signIn(guest, userA.email, newPassword);
    // Nhân viên chỉ có màn "Việc của tôi"; không thấy nhóm Quản trị, vào thẳng /to-chuc thì bị chuyển về.
    await expect(guest).toHaveURL(/\/viec-cua-toi/);
    await expect(guest.getByRole('link', { name: 'Người dùng và tổ chức' })).toHaveCount(0);
    await guest.goto('/to-chuc');
    await expect(guest).toHaveURL(/\/viec-cua-toi/);
    await expect(toast(guest, 'Tài khoản này chưa có quyền xem mục đó.')).toBeVisible();

    // Đường dẫn chỉ dùng một lần: mở lại thì không đặt được, và nói bằng câu tiếng Việt.
    await context.close();
    const fresh = await newContext(browser, new Throttle());
    const reuse = await fresh.newPage();
    await reuse.goto(`/dat-mat-khau?token=${encodeURIComponent(token ?? '')}`);
    await reuse.getByLabel('Mật khẩu mới').fill(`${newPassword}-moi`);
    await reuse.getByLabel('Nhập lại mật khẩu').fill(`${newPassword}-moi`);
    await reuse.getByRole('button', { name: 'Đặt mật khẩu' }).click();
    await expect(reuse.getByText(/Chưa đặt được mật khẩu\. Đường dẫn có thể đã được dùng hoặc đã hết hạn\./)).toBeVisible();
    await fresh.close();

    await gotoUsers(page);
    await expect(userRow(page, userA.email)).toContainText('Đã đặt mật khẩu');
  });

  test('sửa hồ sơ: chỉ gửi trường đã đổi, thêm vai trò có phạm vi', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await gotoUsers(page);
    await openUserMenu(page, userA.label, 'Sửa hồ sơ');
    const sheet = page.getByRole('dialog', { name: 'Sửa hồ sơ' });
    await expect(sheet.getByLabel('Họ và tên')).toHaveValue(userA.fullName);
    await expect(sheet.getByLabel('Người quản lý')).toHaveValue('Phạm Quang Huy');
    await sheet.getByLabel('Điện thoại').fill('0900 000 002');
    await sheet.getByRole('button', { name: 'Thêm vai trò' }).click();
    await choose(sheet, 'Vai trò thứ 2', 'Người vẽ quy trình');

    const update = page.waitForRequest((r) => r.method() === 'PATCH' && /\/v1\/users\//.test(r.url()));
    const roles = page.waitForRequest((r) => r.method() === 'PUT' && /\/v1\/users\/.+\/roles$/.test(r.url()));
    await sheet.getByRole('button', { name: 'Lưu hồ sơ' }).click();
    expect((await update).postDataJSON()).toEqual({ phone: '0900 000 002' });
    expect(((await roles).postDataJSON() as { roles: unknown[] }).roles).toHaveLength(2);
    await expect(toast(page, `Đã lưu hồ sơ của ${userA.label}.`)).toBeVisible();
    await expect(userRow(page, userA.email)).toContainText('Người vẽ quy trình');
  });

  // Mỗi mã lỗi của máy chủ (packages/backend/src/services/org.ts, importUsers) và câu tiếng Việt phải hiện ở giao diện.
  const CSV_ERRORS = {
    header_missing: 'Tệp trống hoặc thiếu dòng tiêu đề.',
    header_missing_fullName: 'Dòng tiêu đề thiếu cột fullName (họ và tên).',
    columns_mismatch: 'Dòng có nhiều ô hơn số cột ở dòng tiêu đề.',
    fullName_required: 'Thiếu họ và tên.',
    fullName_invalid: 'Họ và tên quá dài (tối đa 120 ký tự).',
    givenName_invalid: 'Tên gọi quá dài (tối đa 40 ký tự).',
    honorific_invalid: 'Xưng hô không thuộc danh sách: anh, chị, ông, bà, cô, chú, bác.',
    email_invalid: 'Email chưa đúng dạng.',
    email_duplicate: 'Email đã có trong hệ thống hoặc bị lặp trong tệp.',
    phone_invalid: 'Số điện thoại quá dài (tối đa 20 ký tự).',
    unit_not_found: 'Không tìm thấy đơn vị có tên này.',
    unit_ambiguous: 'Có nhiều đơn vị cùng tên này. Xin thêm người này bằng nút Thêm người dùng.',
    role_invalid: 'Có vai trò hệ thống không nhận ra.',
    uiProfile_invalid: 'Hồ sơ giao diện chỉ nhận senior hoặc standard.',
    manager_not_found: 'Không tìm thấy người quản lý có email này, kể cả trong tệp.',
    manager_self: 'Người quản lý không thể là chính người này.',
  } as const;

  test('nhập CSV: chạy thử báo từng mã lỗi bằng tiếng Việt, tệp còn lỗi thì không ghi dòng nào, rồi nhập thật', async ({ browser }) => {
    test.setTimeout(240_000);
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    await page.goto('/to-chuc/nguoi-dung');
    await page.getByRole('button', { name: 'Nhập CSV' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nhập người dùng từ tệp CSV' });
    const importButton = dialog.getByRole('button', { name: /^Nhập (\d+ )?người dùng$/ });
    const content = dialog.getByLabel('Nội dung CSV');
    const errors = dialog.getByRole('table', { name: 'Các dòng còn lỗi' });

    // Tệp mẫu tải về là CSV UTF-8 có BOM, dòng đầu là tên cột.
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Tải mẫu CSV' }).click()]);
    const template = await readCsv(download);
    expect(template.rows[0]).toEqual(CSV_HEADER.split(','));
    expect(download.suggestedFilename()).toBe('mau-nhap-nguoi-dung.csv');
    expect(template.rows.length).toBe(3);

    // Danh sách các cột có giải thích (mở ra bằng chuột hoặc bàn phím).
    await dialog.getByText('Các cột của tệp').click();
    await expect(dialog.getByText('Email của người quản lý, đã có trong hệ thống hoặc nằm trong chính tệp.')).toBeVisible();

    await content.fill([CSV_HEADER, `${userB.fullName},${userB.givenName},chị,${userB.email},,${unitMain},${userA.email},Nhân viên,standard`].join('\n'));
    await expect(importButton).toBeDisabled();
    await expect(dialog.getByText('Chạy thử và sửa hết lỗi trước khi nhập.')).toBeVisible();

    // Một lần chạy thử, mỗi dòng một lỗi (một số dòng hai lỗi): đủ mọi mã mà tệp có dòng dữ liệu có thể gặp.
    const dup = `trung${stamp}@demo.mihato.local`;
    const self = `tuquanly${stamp}@demo.mihato.local`;
    const bad: { csv: string; codes: (keyof typeof CSV_ERRORS)[] }[] = [
      { csv: ',Lỗi,,,,,,,', codes: ['fullName_required'] },
      { csv: `Dòng xưng hô ${stamp},,xyz,,,,,,`, codes: ['honorific_invalid'] },
      { csv: `Dòng email trùng ${stamp},,,lan@demo.mihato.local,,,,,`, codes: ['email_duplicate'] },
      { csv: `Dòng đơn vị lạ ${stamp},,,,,Đơn vị không có ${stamp},,,`, codes: ['unit_not_found'] },
      { csv: `Dòng đơn vị trùng ${stamp},,,,,${unitTwin},,,`, codes: ['unit_ambiguous'] },
      { csv: `Dòng vai trò ${stamp},,,,,,,Giám đốc kho,`, codes: ['role_invalid'] },
      { csv: `Dòng hồ sơ ${stamp},,,,,,,,lớn`, codes: ['uiProfile_invalid'] },
      { csv: `Dòng cấp trên ${stamp},,,,,,khong-co-${stamp}@demo.mihato.local,,`, codes: ['manager_not_found'] },
      { csv: `Dòng tự quản ${stamp},,,${self},,,${self},,`, codes: ['manager_self'] },
      { csv: `Dòng thừa ô ${stamp},,,,,,,,,thừa`, codes: ['columns_mismatch'] },
      { csv: `Dòng email sai ${stamp},,,email-sai,,,,,`, codes: ['email_invalid'] },
      { csv: `Dòng điện thoại ${stamp},,,,01234567890123456789012345,,,,`, codes: ['phone_invalid'] },
      { csv: `${'H'.repeat(121)},,,,,,,,`, codes: ['fullName_invalid', 'givenName_invalid'] },
      { csv: `Dòng tên gọi ${stamp},${'T'.repeat(41)},,,,,,,`, codes: ['givenName_invalid'] },
      { csv: `Dòng lặp một ${stamp},,,${dup},,,,,`, codes: [] },
      { csv: `Dòng lặp hai ${stamp},,,${dup},,,,,`, codes: ['email_duplicate'] },
      { csv: `Dòng nhiều lỗi ${stamp},,xyz,,,Đơn vị không có,,Giám đốc kho,lớn`, codes: ['honorific_invalid', 'unit_not_found', 'role_invalid', 'uiProfile_invalid'] },
    ];
    await content.fill([CSV_HEADER, ...bad.map((b) => b.csv)].join('\n'));
    await expect(dialog.getByText('Nội dung đã đổi sau lần chạy thử.')).toBeHidden();
    await dialog.getByRole('button', { name: 'Chạy thử' }).click();
    const failing = bad.filter((b) => b.codes.length > 0).length;
    await expect(dialog.getByText(`Có ${failing} trên ${bad.length} dòng còn lỗi.`)).toBeVisible();
    await expect(errors.getByRole('row')).toHaveCount(failing + 1);
    for (const [index, entry] of bad.entries()) {
      const line = index + 2;
      const row = errors.getByRole('row').filter({ hasText: new RegExp(`^\\s*Dòng ${line}(?!\\d)`) });
      if (entry.codes.length === 0) {
        await expect(row, `dòng ${line} hợp lệ nên không có trong bảng lỗi`).toHaveCount(0);
        continue;
      }
      await expect(row, `dòng ${line}`).toHaveCount(1);
      for (const code of entry.codes) await expect(row, `dòng ${line}: ${code}`).toContainText(CSV_ERRORS[code]);
      await expect(row.getByRole('listitem'), `dòng ${line}: đúng ${entry.codes.length} lỗi`).toHaveCount(entry.codes.length);
    }
    // Không chỗ nào hiện mã thô (quy ước của máy chủ) hay câu dự phòng.
    const resultText = await dialog.getByRole('region', { name: 'Kết quả chạy thử' }).innerText();
    expect(resultText).not.toMatch(/[a-zA-Z]+_[a-zA-Z_]+/);
    expect(resultText).not.toContain('(mã');
    await expect(importButton).toBeDisabled();
    await shot(page, 'nhap-csv-loi-1280', false);

    // Tệp còn dòng lỗi thì máy chủ không ghi dòng nào, kể cả dòng hợp lệ nằm cạnh dòng lỗi (SPEC 9.5, 10.3).
    const goodAlone = `Kiểm thử tổ chức ${stamp} không ghi,Ghi,anh,khongghi${stamp}@demo.mihato.local,,,,Nhân viên,standard`;
    const refused = await api<{ created: number; total: number; rows: { ok: boolean }[] }>(it, 'POST', '/v1/users/import?dryRun=false', { csv: [CSV_HEADER, goodAlone, bad[0]!.csv].join('\n') });
    expect(refused.status).toBe(200);
    expect(refused.body.created).toBe(0);
    expect(refused.body.rows.map((r) => r.ok)).toEqual([true, false]);
    expect(await usersOf(it, `khongghi${stamp}`)).toHaveLength(0);

    // Dòng tiêu đề: tệp chỉ có dòng trống, và tệp thiếu cột fullName.
    await content.fill('\n\n');
    await dialog.getByRole('button', { name: 'Chạy thử' }).click();
    await expect(dialog.getByText('Tệp chưa đọc được. Hệ thống chưa ghi dòng nào.')).toBeVisible();
    await expect(errors).toContainText(CSV_ERRORS.header_missing);
    await content.fill('email,phone\nabc@demo.mihato.local,0900000000');
    await dialog.getByRole('button', { name: 'Chạy thử' }).click();
    await expect(errors).toContainText(CSV_ERRORS.header_missing_fullName);

    // Mã máy chủ trả mà giao diện chưa biết: vẫn có câu dự phòng bằng tiếng Việt, kèm mã để báo lại.
    await page.route('**/v1/users/import?*', (route) => route.fulfill({ json: { dryRun: true, total: 1, created: 0, rows: [{ line: 2, ok: false, errors: ['ma_la_chua_co'] }] } }));
    await content.fill(`${CSV_HEADER}\nAi đó,,,,,,,,`);
    await dialog.getByRole('button', { name: 'Chạy thử' }).click();
    await expect(errors).toContainText('Dòng chưa hợp lệ (mã ma_la_chua_co).');
    await page.unroute('**/v1/users/import?*');

    // Tệp không phải UTF-8 thì báo bằng câu tiếng Việt; không đọc nửa chừng.
    const chooser = dialog.getByLabel('Tệp CSV để nhập');
    await chooser.setInputFiles({ name: 'hong.csv', mimeType: 'text/csv', buffer: Buffer.from([0x66, 0x75, 0x6c, 0x6c, 0xff, 0xfe, 0x00, 0x41]) });
    await expect(dialog.getByText('Chưa đọc được tệp này. Xin lưu tệp ở dạng CSV UTF-8 rồi chọn lại.')).toBeVisible();

    // Nhập thật bằng tệp (có BOM, như Excel lưu): hai dòng, dòng sau lấy dòng trước làm cấp trên (cả hai nằm trong chính tệp).
    const good = [
      CSV_HEADER,
      `${userB.fullName},${userB.givenName},chị,${userB.email},,${unitMain},${userA.email},Nhân viên,standard`,
      `${userC.fullName},${userC.givenName},ông,${userC.email},,${unitMain},${userB.email},Giám đốc|Nhân viên,senior`,
    ].join('\r\n');
    await chooser.setInputFiles({ name: 'nguoi-dung.csv', mimeType: 'text/csv', buffer: Buffer.from(`\uFEFF${good}`, 'utf8') });
    await expect(dialog.getByText('Đã đọc tệp nguoi-dung.csv.')).toBeVisible();
    await expect(content).toHaveValue(good.replace(/\r\n/g, '\n'));
    await dialog.getByRole('button', { name: 'Chạy thử' }).click();
    await expect(dialog.getByText('Cả 2 dòng đều hợp lệ. Có thể nhập.')).toBeVisible();
    // Sửa nội dung: kết quả cũ không còn dùng được, phải chạy thử lại.
    await content.fill(`${good}\n`);
    await expect(dialog.getByText('Nội dung đã đổi sau lần chạy thử.')).toBeVisible();
    await expect(importButton).toBeDisabled();
    await dialog.getByRole('button', { name: 'Chạy thử' }).click();
    await expect(dialog.getByText('Cả 2 dòng đều hợp lệ. Có thể nhập.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Nhập 2 người dùng' }).click();
    await expect(toast(page, 'Đã nhập 2 người dùng.')).toBeVisible();
    await expect(dialog).toBeHidden();

    await gotoUsers(page);
    await expect(userRow(page, userB.email)).toContainText('Chờ kích hoạt');
    await expect(userRow(page, userB.email)).toContainText(`Cấp trên: ${userA.fullName}`);
    await expect(userRow(page, userC.email)).toContainText(`Cấp trên: ${userB.fullName}`);
    await expect(userRow(page, userC.email)).toContainText('Giám đốc');
  });

  test('mã kích hoạt cho Giám đốc: chọn ứng dụng Điều hành (mihato-exec://) hoặc ứng dụng nhân viên (mihato://)', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await gotoUsers(page);
    const open = async () => {
      await openUserMenu(page, userC.label, 'Tạo mã kích hoạt thiết bị');
      return page.getByRole('dialog', { name: 'Mã kích hoạt thiết bị' });
    };

    // Chọn trước rồi mới tạo mã: chưa bấm "Tạo mã" thì chưa có mã nào còn hiệu lực.
    let dialog = await open();
    const group = dialog.getByRole('group', { name: 'Ứng dụng cần kích hoạt' });
    await expect(group).toBeVisible();
    await expect(dialog.getByRole('img')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'In mã' })).toHaveCount(0);
    // Mặc định theo vai trò: app Điều hành.
    await expect(group.getByRole('radio', { name: /MIHATO Điều hành/ })).toBeChecked();
    await expect(group.getByRole('radio', { name: /MIHATO Việc của tôi/ })).not.toBeChecked();
    await shot(page, 'ma-kich-hoat-chon-ung-dung-1280', false);
    await dialog.getByRole('button', { name: 'Tạo mã' }).click();
    await expect(dialog.getByText('Ứng dụng: MIHATO Điều hành')).toBeVisible();
    expect(await dialog.getByLabel('Đường dẫn kích hoạt').inputValue()).toMatch(/^mihato-exec:\/\/activate\?token=/);
    await expect(dialog.getByRole('img', { name: `Mã QR kích hoạt thiết bị của ${userC.label}` })).toBeVisible();
    await dialog.getByRole('button', { name: 'Đóng' }).first().click();
    await expect(dialog).toBeHidden();

    // Giám đốc dùng app nhân viên (SPEC 8.6 điều 4): chọn app kia, đường dẫn đổi lược đồ và tờ in nói đúng tên app.
    dialog = await open();
    await dialog.getByRole('radio', { name: /MIHATO Việc của tôi/ }).check();
    await dialog.getByRole('button', { name: 'Tạo mã' }).click();
    await expect(dialog.getByText('Ứng dụng: MIHATO Việc của tôi')).toBeVisible();
    expect(await dialog.getByLabel('Đường dẫn kích hoạt').inputValue()).toMatch(/^mihato:\/\/activate\?token=/);
    await dialog.getByRole('button', { name: 'Đóng' }).first().click();
    await expect(dialog).toBeHidden();

    // Người không phải Giám đốc, Phó giám đốc (Quản trị hệ thống, nhân viên) không có lựa chọn: đã kiểm ở bước tạo mã của nhân viên.
  });

  test('Quản trị hệ thống cuối cùng: không vô hiệu hoá, không bỏ vai trò, nói bằng câu tiếng Việt', async ({ browser }) => {
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    // Dọn Quản trị hệ thống thử còn sót của lần chạy dở trước, để điều kiện "cuối cùng" đúng.
    for (const admin of (await listAll<UserView>(it, '/v1/users')).filter((u) => u.status !== 'disabled' && u.roles.some((r) => r.role === 'it_admin') && u.fullName.startsWith(PREFIX))) {
      expect((await api(it, 'POST', `/v1/users/${admin.id}/disable`)).status).toBe(200);
    }
    const admins = (await listAll<UserView>(it, '/v1/users')).filter((u) => u.status !== 'disabled' && u.roles.some((r) => r.role === 'it_admin'));
    expect(
      admins.map((u) => u.email),
      'điều kiện đầu: chỉ có it@ là Quản trị hệ thống đang dùng được',
    ).toEqual([IT_EMAIL]);
    const adminName = admins[0]!.fullName;

    await gotoUsers(page, IT_EMAIL);
    // 1. Vô hiệu hoá: hộp thoại nêu hệ quả; bấm xác nhận thì báo lỗi ngay trong hộp thoại, không đóng.
    await openUserMenu(page, adminName, 'Vô hiệu hoá');
    const confirm = page.getByRole('alertdialog', { name: `Vô hiệu hoá ${adminName}?` });
    await confirm.getByRole('button', { name: 'Vô hiệu hoá' }).click();
    const refusal = 'Đây là Quản trị hệ thống cuối cùng của tổ chức nên chưa vô hiệu hoá được. Hãy trao vai trò này cho một người khác trước.';
    await expect(confirm.getByRole('alert')).toHaveText(refusal);
    await expect(confirm).not.toContainText('last_it_admin');
    await expect(confirm).not.toContainText('state_conflict');
    await shot(page, 'quan-tri-cuoi-cung-1280', false);
    await confirm.getByRole('button', { name: 'Đóng' }).click();
    await expect(confirm).toBeHidden();
    await expect(userRow(page, IT_EMAIL)).toContainText('Đang hoạt động');

    // 2. Bỏ vai trò: thêm Nhân viên rồi bỏ Quản trị hệ thống; máy chủ từ chối, câu báo lỗi nằm ngay dưới mục vai trò.
    await openUserMenu(page, adminName, 'Sửa hồ sơ');
    const sheet = page.getByRole('dialog', { name: 'Sửa hồ sơ' });
    await sheet.getByRole('button', { name: 'Thêm vai trò' }).click();
    await choose(sheet, 'Vai trò thứ 2', 'Nhân viên');
    await sheet.getByRole('button', { name: 'Bỏ vai trò thứ 1' }).click();
    await expect(sheet.getByLabel('Vai trò thứ 1', { exact: true })).toContainText('Nhân viên');
    await sheet.getByRole('button', { name: 'Lưu hồ sơ' }).click();
    const roleRefusal = 'Đây là Quản trị hệ thống cuối cùng của tổ chức nên không bỏ vai trò này được. Hãy trao vai trò cho một người khác trước.';
    await expect(sheet.getByText(roleRefusal)).toBeVisible();
    await expect(sheet).not.toContainText('last_it_admin');
    await sheet.getByRole('button', { name: 'Đóng' }).first().click();
    await expect(sheet).toBeHidden();

    const after = await api<UserView>(it, 'GET', `/v1/users/${admins[0]!.id}`);
    expect(after.body.status).toBe('active');
    expect(after.body.roles.map((r) => r.role)).toEqual(['it_admin']);
  });

  test('đối chứng: khi còn Quản trị hệ thống khác thì vô hiệu hoá và bỏ vai trò Quản trị hệ thống được', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await page.goto('/to-chuc/nguoi-dung');
    await page.getByRole('button', { name: 'Thêm người dùng' }).click();
    const sheet = page.getByRole('dialog', { name: 'Thêm người dùng' });
    await sheet.getByLabel('Họ và tên').fill(userD.fullName);
    await sheet.getByLabel('Tên gọi').fill(userD.givenName);
    await choose(sheet, 'Xưng hô', userD.honorific);
    await choose(sheet, 'Vai trò thứ 1', 'Quản trị hệ thống');
    await sheet.getByLabel('Email').fill(userD.email);
    await sheet.getByRole('button', { name: 'Thêm người dùng' }).click();
    await expect(toast(page, `Đã thêm ${userD.label}.`)).toBeVisible();

    await gotoUsers(page, userD.email);
    await expect(userRow(page, userD.email)).toContainText('Quản trị hệ thống');
    await openUserMenu(page, userD.label, 'Vô hiệu hoá');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Vô hiệu hoá' }).click();
    await expect(toast(page, `Đã vô hiệu hoá ${userD.label}.`)).toBeVisible();
    await expect(userRow(page, userD.email)).toContainText('Đã vô hiệu hoá');
    await openUserMenu(page, userD.label, 'Bật lại');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Bật lại' }).click();
    await expect(toast(page, `Đã bật lại ${userD.label}.`)).toBeVisible();

    await openUserMenu(page, userD.label, 'Sửa hồ sơ');
    const edit = page.getByRole('dialog', { name: 'Sửa hồ sơ' });
    await edit.getByRole('button', { name: 'Thêm vai trò' }).click();
    await choose(edit, 'Vai trò thứ 2', 'Nhân viên');
    await edit.getByRole('button', { name: 'Bỏ vai trò thứ 1' }).click();
    await edit.getByRole('button', { name: 'Lưu hồ sơ' }).click();
    await expect(toast(page, `Đã lưu hồ sơ của ${userD.label}.`)).toBeVisible();
    await expect(userRow(page, userD.email)).not.toContainText('Quản trị hệ thống');
  });

  test('lọc và sắp xếp bảng người dùng theo tiếng Việt', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await page.goto('/to-chuc/nguoi-dung');
    const table = page.getByRole('table', { name: 'Bảng người dùng của tổ chức' });
    await settled(table);
    await page.getByLabel('Lọc theo đơn vị').click();
    await page.getByRole('option', { name: 'Kế toán', exact: true }).click();
    await expect(table.getByRole('row').filter({ hasText: 'Đặng Mai Phương' })).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: 'chutich@demo' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Bỏ lọc' }).click();

    await page.getByLabel('Lọc theo trạng thái').click();
    await page.getByRole('option', { name: 'Chờ kích hoạt' }).click();
    await expect(table.getByRole('row').filter({ hasText: userB.email })).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: 'chutich@demo' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Bỏ lọc' }).click();

    // Tìm không phân biệt dấu: gõ "tai khoan quan tri" ra tài khoản quản trị.
    await page.getByLabel('Tìm người dùng theo tên').fill('tai khoan quan tri');
    await expect(table.getByRole('row').filter({ hasText: IT_EMAIL })).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: 'chutich@demo' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Bỏ lọc' }).click();

    // Sắp theo cột đơn vị: đúng thứ tự chữ cái tiếng Việt ("Kế toán" trước "Kinh doanh", khác thứ tự mã ký tự).
    await expect(table.getByRole('row').filter({ hasText: 'chutich@demo' })).toBeVisible();
    await table.getByRole('button', { name: 'Đơn vị, cấp trên' }).click();
    await expect(table.locator('th[aria-sort="ascending"]')).toHaveCount(1);
    const shown = (await table.locator('tbody tr td:nth-child(2) p:first-child').allInnerTexts()).map((u) => u.trim());
    expect(shown.length).toBeGreaterThanOrEqual(12);
    // Người chưa xếp đơn vị (ô trống) đứng cuối bảng, các đơn vị còn lại theo thứ tự chữ cái tiếng Việt.
    const blank = 'Chưa xếp đơn vị';
    const units = shown.filter((u) => u !== blank);
    expect(units).toEqual([...units].sort(new Intl.Collator('vi').compare));
    expect(shown.slice(units.length).every((u) => u === blank), 'ô trống xuống cuối').toBe(true);
    expect(units.indexOf('Kế toán')).toBeLessThan(units.indexOf('Kinh doanh'));
    expect(units.indexOf('Kinh doanh')).toBeLessThan(units.indexOf('Kỹ thuật'));
  });

  test('sửa đơn vị: không chọn được chính nó làm cha, đặt trưởng; máy chủ chặn vòng cha con khi dữ liệu đã cũ', async ({ browser }) => {
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    await page.goto('/to-chuc/don-vi');
    const table = page.getByRole('table', { name: 'Cây đơn vị của tổ chức' });
    await settled(table);
    const row = table.getByRole('row').filter({ hasText: unitMain });
    // Ba người thử đã được xếp vào đơn vị này (một qua biểu mẫu, hai qua CSV).
    await expect(row.getByRole('cell').nth(2)).toHaveText('3');

    await page.getByRole('button', { name: `Sửa đơn vị ${unitMain}` }).click();
    const edit = page.getByRole('dialog', { name: 'Sửa đơn vị' });
    // Không cho chọn chính đơn vị đó làm cha của nó.
    await edit.getByLabel('Đơn vị cha').click();
    await expect(page.getByRole('option', { name: PARENT_UNIT, exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: unitMain })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await pickPerson(edit.getByLabel('Trưởng đơn vị'), stamp, new RegExp(userA.fullName));
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && /\/v1\/units\//.test(r.url()));
    await edit.getByRole('button', { name: 'Lưu đơn vị' }).click();
    // Chỉ gửi trường đã đổi.
    expect(Object.keys((await patch).postDataJSON() as object)).toEqual(['headUserId']);
    await expect(toast(page, `Đã lưu đơn vị ${unitMain}.`)).toBeVisible();
    await expect(row).toContainText(userA.fullName);
    await shot(page, 'don-vi-1280');

    // Dữ liệu cũ: mở hộp thoại sửa đơn vị X khi X và Y còn ngang hàng; trong lúc đó Y bị đặt xuống dưới X (ở nơi khác).
    // Giao diện còn tưởng Y chọn được làm cha của X; máy chủ phải chặn và giao diện nói rõ bằng tiếng Việt.
    const units = (await api<{ items: UnitView[] }>(it, 'GET', '/v1/units')).body.items;
    const x = units.find((u) => u.name === unitTwin)!;
    const y = units.find((u) => u.name === unitTwinPlain)!;
    await page.getByRole('button', { name: `Sửa đơn vị ${unitTwin}` }).click();
    const stale = page.getByRole('dialog', { name: 'Sửa đơn vị' });
    expect((await api(it, 'PATCH', `/v1/units/${y.id}`, { parentId: x.id })).status).toBe(200);
    await choose(stale, 'Đơn vị cha', unitTwinPlain);
    await stale.getByRole('button', { name: 'Lưu đơn vị' }).click();
    await expect(stale.getByRole('alert')).toHaveText('Đơn vị cha vừa chọn đang nằm dưới chính đơn vị này. Xin chọn đơn vị khác.');
    await stale.getByRole('button', { name: 'Đóng' }).first().click();
    await expect(stale).toBeHidden();
    // Máy chủ không đổi gì; trả Y về đơn vị gốc của dữ liệu thử.
    const afterCycle = (await api<{ items: UnitView[] }>(it, 'GET', '/v1/units')).body.items;
    expect(afterCycle.find((u) => u.id === x.id)!.parentId).toBe(units.find((u) => u.name === PARENT_UNIT)!.id);
    expect((await api(it, 'PATCH', `/v1/units/${y.id}`, { parentId: units.find((u) => u.name === PARENT_UNIT)!.id })).status).toBe(200);
  });

  test('thêm rồi xoá ủy quyền; phạm vi, hiệu lực và kiểm tra ngày', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await page.goto('/to-chuc/uy-quyen');
    await page.getByRole('button', { name: 'Thêm ủy quyền' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Thêm ủy quyền' });
    await dialog.getByRole('button', { name: 'Thêm ủy quyền' }).click();
    await expect(dialog.getByText('Xin chọn người ủy quyền.')).toBeVisible();
    await expect(dialog.getByText('Xin chọn người nhận ủy quyền.')).toBeVisible();

    // Quản trị hệ thống không xem được danh sách quy trình nên phạm vi "Một quy trình" bị khoá, kèm lời giải thích.
    await dialog.getByLabel('Phạm vi').click();
    await expect(page.getByRole('option', { name: 'Một quy trình' })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog.getByText('Tài khoản này không xem được danh sách quy trình')).toBeVisible();

    await pickPerson(dialog.getByLabel('Người ủy quyền'), stamp, new RegExp(userA.fullName));
    await pickPerson(dialog.getByLabel('Người nhận ủy quyền'), stamp, new RegExp(userB.fullName));
    const today = vnDate();
    const nextWeek = vnDate(7);
    await dialog.getByLabel('Từ ngày').fill(today);
    await dialog.getByLabel('Đến hết ngày').fill(vnDate(-3));
    await dialog.getByRole('button', { name: 'Thêm ủy quyền' }).click();
    await expect(dialog.getByText('Ngày kết thúc phải từ ngày bắt đầu trở đi.')).toBeVisible();
    await dialog.getByLabel('Đến hết ngày').fill(nextWeek);
    await choose(dialog, 'Phạm vi', 'Một vai trò');
    await choose(dialog, /^Vai trò/, 'Nhân viên');
    await shot(page, 'uy-quyen-them-1280', false);
    await dialog.getByRole('button', { name: 'Thêm ủy quyền' }).click();
    await expect(toast(page, `Đã thêm ủy quyền từ ${userA.short} cho ${userB.short}.`)).toBeVisible();

    const table = page.getByRole('table', { name: 'Bảng ủy quyền' });
    const row = table.getByRole('row').filter({ hasText: userA.fullName });
    await expect(row).toContainText(userB.fullName);
    await expect(row).toContainText('Vai trò: Nhân viên');
    await expect(row).toContainText('Đang hiệu lực');

    // Ủy quyền bắt đầu từ tuần sau: "Chưa tới ngày", phạm vi mọi việc.
    await page.getByRole('button', { name: 'Thêm ủy quyền' }).first().click();
    const later = page.getByRole('dialog', { name: 'Thêm ủy quyền' });
    await pickPerson(later.getByLabel('Người ủy quyền'), stamp, new RegExp(userB.fullName));
    await pickPerson(later.getByLabel('Người nhận ủy quyền'), stamp, new RegExp(userA.fullName));
    await later.getByLabel('Từ ngày').fill(vnDate(14));
    await later.getByLabel('Đến hết ngày').fill(vnDate(20));
    await later.getByRole('button', { name: 'Thêm ủy quyền' }).click();
    await expect(toast(page, `Đã thêm ủy quyền từ ${userB.short} cho ${userA.short}.`)).toBeVisible();
    const upcoming = table.getByRole('row').filter({ hasText: userB.fullName }).filter({ hasText: 'Chưa tới ngày' });
    await expect(upcoming).toContainText('Tất cả công việc');
    await shot(page, 'uy-quyen-1280');

    for (const [who, other] of [
      [userA, userB],
      [userB, userA],
    ] as const) {
      await table.getByRole('button', { name: `Xoá ủy quyền của ${who.short}` }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Xoá ủy quyền này?' });
      await expect(confirm).toContainText(`việc mới của ${who.short} không còn được giao cho ${other.short}`);
      await confirm.getByRole('button', { name: 'Xoá ủy quyền' }).click();
      await expect(toast(page, 'Đã xoá ủy quyền.')).toBeVisible();
      // Dòng của ủy quyền vừa xoá (người ủy quyền ở ô đầu) biến mất; dòng còn lại vẫn nhắc tên cả hai người.
      await expect(table.getByRole('row').filter({ hasText: new RegExp(`^\\s*${who.label}`) })).toHaveCount(0);
    }
    await expect(table.getByRole('row').filter({ hasText: stamp })).toHaveCount(0);
  });

  test('vô hiệu hoá nêu rõ hệ quả và có hiệu lực thật; bật lại thì đăng nhập lại được', async ({ browser, playwright }) => {
    test.setTimeout(240_000);
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    // Chuẩn bị một thiết bị đang dùng để thấy nó bị thu hồi.
    const [a] = await usersOf(it, userA.email);
    const activation = await api<{ url: string }>(it, 'POST', `/v1/users/${a!.id}/activation`);
    expect(activation.status).toBe(200);
    const anonymous = await playwright.request.newContext({ baseURL: WEB_URL });
    const enrolled = await anonymous.post('/v1/devices/activate', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { activationToken: new URL(activation.body.url.replace('mihato://', 'https://x/')).searchParams.get('token'), deviceName: 'Máy thứ hai', platform: 'ios' },
    });
    expect(enrolled.status()).toBeLessThan(300);
    const device = (await enrolled.json()) as { accessToken: string };
    await anonymous.dispose();

    await gotoUsers(page);
    await expect(userRow(page, userA.email).getByRole('cell').nth(4)).toHaveText('1');
    await openUserMenu(page, userA.label, 'Vô hiệu hoá');
    const confirm = page.getByRole('alertdialog', { name: `Vô hiệu hoá ${userA.label}?` });
    await expect(confirm).toContainText('Mọi thiết bị của người này bị thu hồi, phiên đăng nhập web bị đóng.');
    await expect(confirm).toContainText('chuyển sang "Cần giao người"');
    await expect(confirm).toContainText('Mã kích hoạt còn hạn bị huỷ.');
    await expect(confirm).toContainText('Lịch sử công việc được giữ nguyên.');
    await shot(page, 'vo-hieu-hoa-1280', false);
    await confirm.getByRole('button', { name: 'Vô hiệu hoá' }).click();
    await expect(toast(page, `Đã vô hiệu hoá ${userA.label}.`)).toBeVisible();
    const row = userRow(page, userA.email);
    await expect(row).toContainText('Đã vô hiệu hoá');
    await expect(row.getByRole('cell').nth(4)).toHaveText('0');

    // Hệ quả có thật: thiết bị bị thu hồi, mã truy cập của thiết bị không còn dùng được, đăng nhập web bị từ chối.
    await openUserMenu(page, userA.label, 'Thiết bị');
    const sheet = page.getByRole('dialog', { name: `Thiết bị của ${userA.label}` });
    await expect(sheet.getByText('Máy thứ hai')).toBeVisible();
    await expect(sheet.getByText('Đang dùng')).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /^Thu hồi/ })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Đóng' }).first().click();
    const stale = await playwright.request.newContext({ baseURL: WEB_URL, extraHTTPHeaders: { Authorization: `Bearer ${device.accessToken}` } });
    expect((await stale.get('/v1/me')).status()).toBe(401);
    await stale.dispose();
    const guestContext = await newContext(browser, new Throttle());
    const guest = await guestContext.newPage();
    await guest.goto('/dang-nhap');
    await guest.getByLabel('Email').fill(userA.email);
    await guest.getByLabel('Mật khẩu', { exact: true }).fill(newPassword);
    await guest.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(guest.getByText(/Chưa đăng nhập được\. Xin kiểm tra lại email và mật khẩu\./)).toBeVisible();
    await expect(guest).toHaveURL(/\/dang-nhap/);

    // Người đã vô hiệu hoá không còn mục tạo mã kích hoạt; có mục "Bật lại".
    await page.getByRole('button', { name: `Thao tác với ${userA.label}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Tạo mã kích hoạt thiết bị' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Tạo đường dẫn đặt mật khẩu web' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Bật lại' }).click();
    const again = page.getByRole('alertdialog', { name: `Bật lại ${userA.label}?` });
    await expect(again).toContainText('Thiết bị đã thu hồi không tự bật lại');
    await again.getByRole('button', { name: 'Bật lại' }).click();
    await expect(toast(page, `Đã bật lại ${userA.label}.`)).toBeVisible();
    await expect(userRow(page, userA.email)).toContainText('Đang hoạt động');
    await expect(userRow(page, userA.email).getByRole('cell').nth(4)).toHaveText('0');

    // Bật lại: đăng nhập web lại được bằng mật khẩu cũ.
    await signIn(guest, userA.email, newPassword);
    await expect(guest).toHaveURL(/\/viec-cua-toi/);
    await guestContext.close();

    // Dọn dẹp: để lại hai người thử ở trạng thái đã vô hiệu hoá.
    for (const user of [userA, userB]) {
      await openUserMenu(page, user.label, 'Vô hiệu hoá');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Vô hiệu hoá' }).click();
      await expect(userRow(page, user.email)).toContainText('Đã vô hiệu hoá');
    }
    await shot(page, 'nguoi-dung-thu-1280');
  });

  test('nhật ký hoạt động ghi lại các thao tác vừa làm bằng tên tiếng Việt; lọc theo hành động, người làm, ngày', async ({ browser }) => {
    test.setTimeout(240_000);
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    await page.goto('/nhat-ky');
    await expect(page).toHaveURL(/\/nhat-ky\/hoat-dong$/);
    const table = page.getByRole('table', { name: 'Nhật ký hoạt động, mới nhất ở trên' });
    await settled(table);
    for (const action of [
      'Thêm người dùng',
      'Tạo mã kích hoạt thiết bị',
      'Kích hoạt thiết bị',
      'Thu hồi thiết bị',
      'Tạo đường dẫn đặt mật khẩu',
      'Đặt mật khẩu',
      'Sửa hồ sơ người dùng',
      'Đổi vai trò',
      'Thêm đơn vị',
      'Sửa đơn vị',
      'Thêm ủy quyền',
      'Xoá ủy quyền',
      'Vô hiệu hoá người dùng',
      'Bật lại người dùng',
      'Đăng nhập',
    ]) {
      await expect(table.getByRole('row').filter({ hasText: action }).first(), action).toBeVisible();
    }
    // Đối tượng là người dùng thì tên được tra lại từ danh sách (nhật ký chỉ lưu id); dòng mới nhất lưu địa chỉ IP.
    const disabledRow = table.getByRole('row').filter({ hasText: 'Vô hiệu hoá người dùng' }).first();
    await expect(disabledRow).toContainText('Người dùng');
    await expect(disabledRow).toContainText(/\d+\.\d+\.\d+\.\d+|::1/);
    // Mọi hành động trên trang đều có tên tiếng Việt: không dòng nào rơi vào câu dự phòng "Hành động khác (mã)".
    await expect(table.getByRole('row').filter({ hasText: 'Hành động khác' })).toHaveCount(0);
    await shot(page, 'nhat-ky-hoat-dong-1280');

    // Lọc theo hành động: chỉ còn hành động đó.
    await choose(page, 'Lọc theo hành động', 'Thêm đơn vị');
    await expect(table.locator('tbody tr').first()).toContainText('Thêm đơn vị');
    await expect(async () => {
      const actions = (await table.locator('tbody tr td:nth-child(3)').allInnerTexts()).map((a) => a.trim());
      expect(actions.length).toBeGreaterThan(0);
      expect(new Set(actions)).toEqual(new Set(['Thêm đơn vị']));
    }).toPass();
    // Lọc theo người làm: tài khoản Văn phòng chưa làm gì ở đây.
    await pickPerson(page.getByLabel('Lọc theo người làm'), 'van phong', /Tài khoản văn phòng/);
    await expect(page.getByText('Không có dòng nhật ký khớp điều kiện lọc')).toBeVisible();
    await page.getByRole('button', { name: 'Bỏ lọc' }).first().click();
    await expect(table.getByRole('row').filter({ hasText: 'Đăng nhập' }).first()).toBeVisible();

    // Lọc theo ngày: hôm nay có dòng; một ngày ở tương lai thì không; ngày bắt đầu sau ngày kết thúc thì báo lỗi.
    await page.getByLabel('Từ ngày').fill(vnDate());
    await page.getByLabel('Đến ngày').fill(vnDate());
    await expect(table.getByRole('row').filter({ hasText: 'Thêm đơn vị' }).first()).toBeVisible();
    await page.getByLabel('Từ ngày').fill(vnDate(30));
    await page.getByLabel('Đến ngày').fill(vnDate(31));
    await expect(page.getByText('Không có dòng nhật ký khớp điều kiện lọc')).toBeVisible();
    await page.getByLabel('Đến ngày').fill(vnDate(-5));
    await expect(page.getByRole('alert').filter({ hasText: 'Ngày bắt đầu phải trước hoặc trùng ngày kết thúc.' })).toBeVisible();
    await page.getByRole('button', { name: 'Bỏ lọc' }).first().click();

    // Nhật ký dài: có "Tải thêm" thì bấm là thêm dòng.
    await settled(table);
    const first = await api<Page_<AuditEntry>>(it, 'GET', '/v1/admin/audit-log?limit=100');
    if (first.body.nextCursor) {
      const before = await table.locator('tbody tr').count();
      await page.getByRole('button', { name: 'Tải thêm' }).click();
      await expect(async () => expect(await table.locator('tbody tr').count()).toBeGreaterThan(before)).toPass();
    }

    // Đủ chuỗi cho mọi hành động mà hệ thống ghi: miền giá trị của hợp đồng và các mã đang có trong nhật ký đều có tên tiếng Việt.
    const labelled = Object.keys(vi.admin.org.logs.audit.actions);
    const used = psql('select distinct action from audit_log').split('\n').filter(Boolean);
    expect(AUDIT_ACTIONS.filter((a) => !labelled.includes(a)), 'mã trong hợp đồng chưa có tên tiếng Việt').toEqual([]);
    expect(used.filter((a) => !labelled.includes(a)), 'mã đang có trong nhật ký chưa có tên tiếng Việt').toEqual([]);
  });
});

// ───────────────────────── Cài đặt tổ chức ─────────────────────────

test.describe('Cài đặt tổ chức', () => {
  test.describe.configure({ mode: 'serial' });

  const settingsOf = async (session: Session): Promise<OrgSettings> => (await api<OrgSettings>(session, 'GET', '/v1/org/settings')).body;
  /** Chỉ các khoá mà test này đụng tới: người khác (hoặc agent khác) đổi một khoá không liên quan giữa chừng thì test không đỏ oan. */
  const only = (settings: OrgSettings, keys: readonly (keyof OrgSettings)[]): Partial<OrgSettings> => Object.fromEntries(keys.map((key) => [key, settings[key]]));
  /**
   * Dù test hỏng giữa chừng, các khoá đã đụng tới vẫn được trả về giá trị lúc đầu bằng API (giao diện có thể từ chối một giá trị gốc
   * lạ, ví dụ giờ yên tĩnh bắt đầu trùng giờ kết thúc). Cấu hình tổ chức dùng chung cho cả nhóm làm việc: không được bỏ lại sai.
   */
  const restoreKeys = async (session: Session, before: OrgSettings, keys: readonly (keyof OrgSettings)[]): Promise<void> => {
    const now = await settingsOf(session);
    const patch: Record<string, unknown> = {};
    for (const key of keys) if (JSON.stringify(now[key]) !== JSON.stringify(before[key])) patch[key] = before[key];
    if (Object.keys(patch).length > 0) expect((await api(session, 'PATCH', '/v1/org/settings', patch)).status).toBe(200);
  };
  const section = (page: Page, id: string): Locator => page.locator(`#${id}`);
  const saveButton = (page: Page, group: string): Locator => page.getByRole('button', { name: `Lưu thay đổi: ${group}` });
  /**
   * Lần PATCH cấu hình kế tiếp, trả về yêu cầu (để khẳng định thân gửi đi) SAU KHI máy chủ đã trả lời. Chờ phản hồi chứ không chỉ
   * chờ yêu cầu rời đi: đọc lại cấu hình ngay lúc đó mới chắc thấy giá trị mới, và chữ vừa gõ không bị biểu mẫu đặt lại giữa chừng.
   */
  const nextPatch = (page: Page): Promise<Request> =>
    page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/v1/org/settings')).then((response) => response.request());

  test('mỗi nhóm lưu riêng và báo "Đã lưu"; PATCH chỉ gửi khoá đã đổi (cả khoá lồng một mình); sau đó trả lại giá trị cũ', async ({ browser }) => {
    test.setTimeout(240_000);
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    const before = await settingsOf(it);
    const touched = ['officePhone', 'quietHours'] as const;
    // Mặc định tổ chức KHÔNG có giờ yên tĩnh (docs/DECISIONS.md, 04/10/2026), mà phần dưới thử sửa từng đầu của một khoảng giờ. Nếu
    // đang không có thì đặt sẵn bằng API một khoảng cách bây giờ 12 giờ (không làm thông báo của ai bị dời); ở cuối trả về đúng `before`.
    const awayHour = (new Date(Date.now() + 19 * 3_600_000).getUTCHours() + 24) % 24;
    const quietBase = before.quietHours ?? { start: `${pad(awayHour)}:00`, end: `${pad(awayHour)}:30` };
    try {
      if (!before.quietHours) expect((await api(it, 'PATCH', '/v1/org/settings', { quietHours: quietBase })).status).toBe(200);
      await page.goto('/cai-dat');
      const nav = page.getByRole('navigation', { name: 'Các nhóm cài đặt' });
      await expect(nav.getByRole('link')).toHaveCount(9);

      // ── Văn phòng: một khoá ở gốc.
      const phone = page.getByLabel('Số điện thoại Văn phòng');
      await expect(phone).toHaveValue(before.officePhone ?? '');
      const officeSave = saveButton(page, 'Văn phòng');
      await expect(officeSave).toBeDisabled();
      const patches = countRequests(page, (method, url) => method === 'PATCH' && url.endsWith('/v1/org/settings'));
      await phone.fill('abc');
      await officeSave.click();
      await expect(page.getByText('Số điện thoại gồm chữ số, dấu cách, dấu chấm hoặc dấu +')).toBeVisible();
      await expect(phone).toHaveAttribute('aria-invalid', 'true');
      expect(patches()).toBe(0);

      await phone.fill('028 3822 1234');
      await expect(nav.getByRole('link', { name: /Văn phòng/ })).toContainText('có thay đổi chưa lưu');

      // ── Hai nhóm cùng có thay đổi chưa lưu: lưu nhóm này không đụng nhóm kia (mỗi nhóm lưu riêng, SPEC 9.2).
      const quiet = section(page, 'gio-yen-tinh');
      const start = quiet.getByLabel('Bắt đầu', { exact: true });
      const end = quiet.getByLabel('Kết thúc', { exact: true });
      await expect(start).toHaveValue(quietBase.start);
      await expect(end).toHaveValue(quietBase.end);
      // Đổi giờ bắt đầu sang một giờ gần nhất mà lúc này vẫn đúng/sai như cũ về chuyện "đang trong giờ yên tĩnh" (cùng cách tính với
      // máy chủ: bắt đầu trùng kết thúc là không có giờ yên tĩnh). Nhờ vậy vài giây thử nghiệm không làm thông báo của người khác bị dời tới sáng.
      const vnNow = new Date(Date.now() + 7 * 3_600_000);
      const nowMinute = vnNow.getUTCHours() * 60 + vnNow.getUTCMinutes();
      const minuteOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
      const timeOf = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
      const quietNow = (from: number, to: number) => (from === to ? false : from > to ? nowMinute >= from || nowMinute < to : nowMinute >= from && nowMinute < to);
      const [startMinute, endMinute] = [minuteOf(quietBase.start), minuteOf(quietBase.end)];
      let newStart = '';
      for (let step = 1; step < 1440 && newStart === ''; step++) {
        for (const sign of [1, -1]) {
          const candidate = (startMinute + sign * step + 1440) % 1440;
          if (candidate !== endMinute && quietNow(candidate, endMinute) === quietNow(startMinute, endMinute)) {
            newStart = timeOf(candidate);
            break;
          }
        }
      }
      expect(newStart, 'có giờ bắt đầu thử mà trạng thái giờ yên tĩnh lúc này không đổi').not.toBe('');
      await start.fill(newStart);
      await expect(quiet.getByText(/^Không đẩy thông báo từ/)).toContainText(newStart);
      const quietPatch = nextPatch(page);
      await saveButton(page, 'Giờ yên tĩnh').click();
      // Nhóm con thiếu khoá: chỉ `start`, không kèm `end`.
      expect((await quietPatch).postDataJSON()).toEqual({ quietHours: { start: newStart } });
      await expect(toast(page, 'Đã lưu Giờ yên tĩnh.')).toBeVisible();
      await expect(quiet.getByText(/Đã lưu lúc \d{2}:\d{2}/)).toBeVisible();
      await expect(saveButton(page, 'Giờ yên tĩnh')).toBeDisabled();
      // Nhóm Văn phòng vẫn còn thay đổi chưa lưu, chữ đã gõ vẫn còn, và máy chủ chưa nhận số điện thoại.
      await expect(section(page, 'van-phong').getByText('Có thay đổi chưa lưu')).toBeVisible();
      await expect(phone).toHaveValue('028 3822 1234');
      await expect(nav.getByRole('link', { name: /Văn phòng/ })).toContainText('có thay đổi chưa lưu');
      await expect(nav.getByRole('link', { name: /Giờ yên tĩnh/ })).not.toContainText('có thay đổi chưa lưu');
      expect((await settingsOf(it)).officePhone).toBe(before.officePhone);
      expect((await settingsOf(it)).quietHours).toEqual({ start: newStart, end: quietBase.end });

      const officePatch = nextPatch(page);
      await officeSave.click();
      expect((await officePatch).postDataJSON()).toEqual({ officePhone: '028 3822 1234' });
      await expect(toast(page, 'Đã lưu Văn phòng.')).toBeVisible();
      await expect(section(page, 'van-phong').getByText(/Đã lưu lúc \d{2}:\d{2}/)).toBeVisible();
      await page.reload();
      await expect(page.getByLabel('Số điện thoại Văn phòng')).toHaveValue('028 3822 1234');
      await expect(section(page, 'gio-yen-tinh').getByLabel('Bắt đầu', { exact: true })).toHaveValue(newStart);

      // Giờ bắt đầu trùng giờ kết thúc thì không lưu.
      const sameTime = countRequests(page, (method, url) => method === 'PATCH' && url.endsWith('/v1/org/settings'));
      await section(page, 'gio-yen-tinh').getByLabel('Kết thúc', { exact: true }).fill(newStart);
      await saveButton(page, 'Giờ yên tĩnh').click();
      await expect(page.getByText('Giờ bắt đầu và giờ kết thúc phải khác nhau.')).toBeVisible();
      expect(sameTime()).toBe(0);
      await section(page, 'gio-yen-tinh').getByRole('button', { name: 'Bỏ thay đổi' }).click();
      await expect(section(page, 'gio-yen-tinh').getByLabel('Kết thúc', { exact: true })).toHaveValue(quietBase.end);

      // ── Trả lại giá trị cũ (mỗi nhóm một lần lưu, chỉ gửi khoá đã đổi). Giao diện không nhận giờ bắt đầu trùng giờ kết thúc:
      // giá trị gốc kiểu đó (do ai đó đặt qua API) được trả lại ở khối finally, không đi qua biểu mẫu.
      if (quietBase.start !== quietBase.end) {
        const restoreQuiet = nextPatch(page);
        await section(page, 'gio-yen-tinh').getByLabel('Bắt đầu', { exact: true }).fill(quietBase.start);
        await saveButton(page, 'Giờ yên tĩnh').click();
        expect((await restoreQuiet).postDataJSON()).toEqual({ quietHours: { start: quietBase.start } });
        await expect(section(page, 'gio-yen-tinh').getByText(/Đã lưu lúc/)).toBeVisible();
      }
      await page.getByLabel('Số điện thoại Văn phòng').fill(before.officePhone ?? '');
      const restoreOffice = nextPatch(page);
      await saveButton(page, 'Văn phòng').click();
      expect((await restoreOffice).postDataJSON()).toEqual({ officePhone: before.officePhone });
      await expect(section(page, 'van-phong').getByText(/Đã lưu lúc/)).toBeVisible();
      await restoreKeys(it, before, touched);
      expect(only(await settingsOf(it), touched)).toEqual(only(before, touched));
    } finally {
      await restoreKeys(it, before, touched);
    }
  });

  test('giờ yên tĩnh: mặc định không dùng; công tắc bật rồi tắt, PATCH gửi đủ hai đầu rồi gửi null', async ({ browser }) => {
    test.setTimeout(180_000);
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    const before = await settingsOf(it);
    const touched = ['quietHours'] as const;
    try {
      // Bắt đầu từ trạng thái mặc định: không có giờ yên tĩnh.
      expect((await api(it, 'PATCH', '/v1/org/settings', { quietHours: null })).status).toBe(200);
      await page.goto('/cai-dat');
      const quiet = section(page, 'gio-yen-tinh');
      const enable = quiet.getByRole('checkbox', { name: 'Dùng giờ yên tĩnh cho cả tổ chức' });
      const start = quiet.getByLabel('Bắt đầu', { exact: true });
      const end = quiet.getByLabel('Kết thúc', { exact: true });
      await expect(enable).not.toBeChecked();
      await expect(start).toHaveCount(0);
      await expect(quiet.getByText(/^Đang không dùng giờ yên tĩnh/)).toBeVisible();
      await expect(saveButton(page, 'Giờ yên tĩnh')).toBeDisabled();

      // Bật: hiện hai ô với giờ gợi ý 21:00 đến 07:00; bật rồi tắt lại ngay (chưa lưu) thì không còn thay đổi.
      await enable.click();
      await expect(start).toHaveValue('21:00');
      await expect(end).toHaveValue('07:00');
      await expect(saveButton(page, 'Giờ yên tĩnh')).toBeEnabled();
      await enable.click();
      await expect(start).toHaveCount(0);
      await expect(saveButton(page, 'Giờ yên tĩnh')).toBeDisabled();

      // Bật lại, đặt khoảng cách bây giờ 12 giờ (thử vài giây không làm thông báo của ai bị dời), lưu: chuyển từ "không có" sang "có" gửi đủ hai đầu.
      const awayHour = (new Date(Date.now() + 19 * 3_600_000).getUTCHours() + 24) % 24;
      const [from, to] = [`${pad(awayHour)}:00`, `${pad(awayHour)}:30`];
      await enable.click();
      await start.fill(from);
      await end.fill(to);
      const on = nextPatch(page);
      await saveButton(page, 'Giờ yên tĩnh').click();
      expect((await on).postDataJSON()).toEqual({ quietHours: { start: from, end: to } });
      await expect(toast(page, 'Đã lưu Giờ yên tĩnh.')).toBeVisible();
      expect((await settingsOf(it)).quietHours).toEqual({ start: from, end: to });
      await page.reload();
      await expect(section(page, 'gio-yen-tinh').getByRole('checkbox', { name: 'Dùng giờ yên tĩnh cho cả tổ chức' })).toBeChecked();
      await expect(section(page, 'gio-yen-tinh').getByLabel('Bắt đầu', { exact: true })).toHaveValue(from);

      // Tắt: PATCH gửi quietHours là null, các ô giờ ẩn đi, máy chủ ghi null.
      await section(page, 'gio-yen-tinh').getByRole('checkbox', { name: 'Dùng giờ yên tĩnh cho cả tổ chức' }).click();
      const off = nextPatch(page);
      await saveButton(page, 'Giờ yên tĩnh').click();
      expect((await off).postDataJSON()).toEqual({ quietHours: null });
      await expect(toast(page, 'Đã lưu Giờ yên tĩnh.')).toBeVisible();
      await expect(section(page, 'gio-yen-tinh').getByLabel('Bắt đầu', { exact: true })).toHaveCount(0);
      expect((await settingsOf(it)).quietHours).toBeNull();
    } finally {
      await restoreKeys(it, before, touched);
    }
  });

  test('lời nhắc: xem trước đúng câu người nhận sẽ thấy, báo biến lạ, chỉ gửi mẫu đã đổi', async ({ browser }) => {
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    const before = await settingsOf(it);
    const touched = ['nudgeTemplates'] as const;
    try {
      await page.goto('/cai-dat');
      const nudge = section(page, 'loi-nhac');
      const down = nudge.getByRole('textbox', { name: 'Gửi cấp dưới' });
      await expect(down).toHaveValue(before.nudgeTemplates.down);
      // Mẫu mặc định xem trước với người nhận mẫu (chị Lan, việc mẫu, quá hạn 2 ngày).
      await expect(page.getByTestId('nudge-preview-down')).toHaveText(
        before.nudgeTemplates.down === 'Văn phòng Chủ tịch nhắc {honorific} {tên}: việc ‘{việc}’ đã quá hạn {n} ngày. {Honorific} cho biết khi nào hoàn thành.'
          ? 'Văn phòng Chủ tịch nhắc chị Lan: việc ‘Lập chương trình đón đoàn’ đã quá hạn 2 ngày. Chị cho biết khi nào hoàn thành.'
          : /.+/,
      );

      const template = 'Nhờ {honorific} {tên} xem việc ‘{việc}’, đã trễ {n} ngày.';
      await down.fill(template);
      await expect(page.getByTestId('nudge-preview-down')).toHaveText('Nhờ chị Lan xem việc ‘Lập chương trình đón đoàn’, đã trễ 2 ngày.');
      // Xem trước với người khác: xưng hô và tên gọi theo hồ sơ người đó (ông Sơn).
      await pickPerson(nudge.getByLabel('Xem trước với người nhận'), 'thanh son', /Lê Thanh Sơn/);
      await expect(page.getByTestId('nudge-preview-down')).toHaveText('Nhờ ông Sơn xem việc ‘Lập chương trình đón đoàn’, đã trễ 2 ngày.');
      await expect(nudge.getByText(/^Người nhận mẫu: ông Lê Thanh Sơn\./)).toBeVisible();
      // Dòng "do Trợ lý AI soạn" luôn hiện dưới lời nhắc.
      await expect(nudge.getByRole('figure', { name: 'Xem trước: Gửi cấp dưới' })).toContainText(before.nudgeTemplates.aiDisclosure);

      // Biến lạ: báo lỗi tại ô, không gửi gì.
      const patches = countRequests(page, (method, url) => method === 'PATCH' && url.endsWith('/v1/org/settings'));
      await down.fill('Nhắc {ten}');
      await saveButton(page, 'Lời nhắc và xưng hô').click();
      await expect(nudge.getByText('Mẫu có biến lạ: {ten}.')).toBeVisible();
      await expect(down).toHaveAttribute('aria-invalid', 'true');
      // Để trống: bắt buộc nhập. Dòng cho biết "do Trợ lý AI soạn" không được xoá trắng.
      await down.fill('');
      await saveButton(page, 'Lời nhắc và xưng hô').click();
      await expect(nudge.getByText('Mẫu câu không được để trống.')).toBeVisible();
      await nudge.getByLabel('Dòng nhỏ khi Trợ lý AI soạn').fill('');
      await saveButton(page, 'Lời nhắc và xưng hô').click();
      await expect(nudge.getByText('Dòng này bắt buộc có, để người nhận biết lời nhắc do Trợ lý AI soạn.')).toBeVisible();
      expect(patches()).toBe(0);
      await nudge.getByRole('button', { name: 'Bỏ thay đổi' }).click();
      await expect(down).toHaveValue(before.nudgeTemplates.down);

      // Lưu một mẫu: chỉ khoá `down` của nhóm `nudgeTemplates` được gửi, các mẫu khác giữ nguyên.
      await down.fill(template);
      const patch = nextPatch(page);
      await saveButton(page, 'Lời nhắc và xưng hô').click();
      expect((await patch).postDataJSON()).toEqual({ nudgeTemplates: { down: template } });
      await expect(toast(page, 'Đã lưu Lời nhắc và xưng hô.')).toBeVisible();
      const saved = await settingsOf(it);
      expect(saved.nudgeTemplates).toEqual({ ...before.nudgeTemplates, down: template });

      // Trả lại mẫu cũ.
      await down.fill(before.nudgeTemplates.down);
      const restore = nextPatch(page);
      await saveButton(page, 'Lời nhắc và xưng hô').click();
      expect((await restore).postDataJSON()).toEqual({ nudgeTemplates: { down: before.nudgeTemplates.down } });
      await expect(nudge.getByText(/Đã lưu lúc/)).toBeVisible();
      await restoreKeys(it, before, touched);
      expect(only(await settingsOf(it), touched)).toEqual(only(before, touched));
    } finally {
      await restoreKeys(it, before, touched);
    }
  });

  test('Trợ lý AI: giải thích hệ quả khi tắt, ngân sách chỉ cảnh báo, công tắc lưu riêng khoá rồi trả lại', async ({ browser }) => {
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    const before = await settingsOf(it);
    const touched = ['ai'] as const;
    try {
      await page.goto('/cai-dat');
      const assistant = section(page, 'tro-ly');
      const power = assistant.getByRole('switch', { name: 'Bật Trợ lý AI cho tổ chức' });
      await expect(power).toBeChecked({ checked: before.ai.enabled });

      // Hệ quả luôn được nói rõ; tắt thì khung đổi sang tông cảnh báo (chưa lưu gì).
      const effects = assistant.getByRole('status').filter({ hasText: 'Khi tắt Trợ lý AI' });
      for (const line of ['Ứng dụng của Chủ tịch ẩn mục Trợ lý.', 'Báo cáo đầu ngày vẫn có, dựng bằng mẫu văn bản và đọc bằng giọng của máy.', 'Mọi thao tác chạm vẫn dùng được: xem việc, duyệt, đi thúc, giao lại, gia hạn.']) {
        await expect(effects).toContainText(line);
      }
      await expect(assistant.getByText('Vượt ngân sách chỉ cảnh báo, không tự cắt Trợ lý AI: Quản trị hệ thống quyết định.')).toBeVisible();
      // Nhãn của ba hộp chọn và hai ô số.
      for (const label of ['Nhận giọng nói (STT)', 'Mô hình ngôn ngữ (LLM)', 'Đọc thành tiếng (TTS)']) {
        await expect(assistant.getByLabel(label, { exact: true }), label).toHaveRole('combobox');
      }
      await expect(assistant.getByLabel('Hạn mức lượt gọi mỗi người mỗi ngày')).toHaveValue(String(before.ai.dailyCallLimit));
      await expect(assistant.getByLabel('Ngân sách tháng (USD)')).toHaveValue(before.ai.monthlyBudgetUsd === null ? '' : String(before.ai.monthlyBudgetUsd));

      // Tắt mô hình ngôn ngữ cũng có hệ quả như tắt Trợ lý AI: giao diện nhắc điều đó, chưa lưu.
      await choose(assistant, 'Mô hình ngôn ngữ (LLM)', 'Tắt: ẩn Trợ lý');
      await expect(assistant.getByText('Tắt mô hình ngôn ngữ có cùng hệ quả như tắt Trợ lý AI.')).toBeVisible();
      await choose(assistant, 'Mô hình ngôn ngữ (LLM)', 'Anthropic Claude');
      await expect(assistant.getByText('Tắt mô hình ngôn ngữ có cùng hệ quả như tắt Trợ lý AI.')).toBeHidden();
      await expect(saveButton(page, 'Trợ lý AI')).toBeDisabled();

      // Ngân sách tháng: lưu riêng khoá `monthlyBudgetUsd`; số âm bị chặn.
      const budget = assistant.getByLabel('Ngân sách tháng (USD)');
      await budget.fill('-5');
      await saveButton(page, 'Trợ lý AI').click();
      await expect(assistant.getByText('Ngân sách là số từ 0 trở lên, hoặc để trống.')).toBeVisible();
      await budget.fill('12.5');
      const budgetPatch = nextPatch(page);
      await saveButton(page, 'Trợ lý AI').click();
      expect((await budgetPatch).postDataJSON()).toEqual({ ai: { monthlyBudgetUsd: 12.5 } });
      await expect(toast(page, 'Đã lưu Trợ lý AI.')).toBeVisible();
      expect((await settingsOf(it)).ai).toEqual({ ...before.ai, monthlyBudgetUsd: 12.5 });

      // Công tắc: tắt rồi lưu thì chỉ khoá `enabled` đi lên; trả lại ngay.
      try {
        await power.click();
        await expect(power).not.toBeChecked();
        await expect(assistant.getByText('Đang tắt')).toBeVisible();
        await expect(effects).toHaveClass(/bg-warn-bg/);
        const offPatch = nextPatch(page);
        await saveButton(page, 'Trợ lý AI').click();
        expect((await offPatch).postDataJSON()).toEqual({ ai: { enabled: false } });
        await expect(toast(page, 'Đã lưu Trợ lý AI.')).toBeVisible();
        const off = await settingsOf(it);
        expect(off.ai.enabled).toBe(false);
        expect(off.ai.llm).toBe(before.ai.llm);
        const me = await api<{ ai: { enabled: boolean } }>(it, 'GET', '/v1/me');
        expect(me.body.ai.enabled, 'công tắc tắt thì /v1/me cũng báo tắt (app đọc ở đây)').toBe(false);
      } finally {
        // Trả lại bằng API nếu giao diện hỏng giữa chừng, để không bỏ lại cấu hình sai cho người khác.
        const current = await settingsOf(it);
        if (current.ai.enabled !== before.ai.enabled) {
          await power.click();
          const onPatch = nextPatch(page);
          await saveButton(page, 'Trợ lý AI').click();
          expect((await onPatch).postDataJSON()).toEqual({ ai: { enabled: before.ai.enabled } });
          await expect(assistant.getByText(/Đã lưu lúc/)).toBeVisible();
        }
      }

      // Số liệu dùng Trợ lý AI nói đúng ngân sách đã đặt, và nhắc lại rằng vượt ngân sách chỉ cảnh báo.
      await page.goto('/nhat-ky/tro-ly');
      await expect(page.getByText(/^Tính theo đơn giá token/)).toContainText('Ngân sách tháng là 12,50 USD; từ đầu tháng đã dùng');
      await expect(page.getByText(/^Tính theo đơn giá token/)).toContainText('Vượt ngân sách chỉ cảnh báo, không tự cắt Trợ lý AI.');

      // Trả lại ngân sách cũ.
      await page.goto('/cai-dat');
      await section(page, 'tro-ly').getByLabel('Ngân sách tháng (USD)').fill(before.ai.monthlyBudgetUsd === null ? '' : String(before.ai.monthlyBudgetUsd));
      const restore = nextPatch(page);
      await saveButton(page, 'Trợ lý AI').click();
      expect((await restore).postDataJSON()).toEqual({ ai: { monthlyBudgetUsd: before.ai.monthlyBudgetUsd } });
      await expect(section(page, 'tro-ly').getByText(/Đã lưu lúc/)).toBeVisible();
      await restoreKeys(it, before, touched);
      expect(only(await settingsOf(it), touched)).toEqual(only(before, touched));
    } finally {
      await restoreKeys(it, before, touched);
    }
  });

  test('lịch làm việc, bộ nhắc, phiên bản, thời hạn lưu, đầu mối dữ liệu: kiểm tra ô nhập, lưu thử rồi trả lại', async ({ browser }) => {
    test.setTimeout(240_000);
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    const before = await settingsOf(it);
    const touched = ['workdays', 'workStart', 'workEnd', 'reminderPreset', 'minAppVersion', 'dataContact', 'retention'] as const;
    try {
      await page.goto('/cai-dat');
      const patches = countRequests(page, (method, url) => method === 'PATCH' && url.endsWith('/v1/org/settings'));

      // Lịch làm việc: giờ kết thúc phải sau giờ bắt đầu; phải còn ít nhất một ngày làm việc.
      const calendar = section(page, 'lich-lam-viec');
      await expect(calendar.getByLabel('Giờ bắt đầu')).toHaveValue(before.workStart);
      await calendar.getByLabel('Giờ kết thúc').fill('07:00');
      await saveButton(page, 'Lịch làm việc').click();
      await expect(calendar.getByText('Giờ kết thúc phải sau giờ bắt đầu.')).toBeVisible();
      await calendar.getByRole('button', { name: 'Bỏ thay đổi' }).click();
      const weekdays = calendar.getByRole('group', { name: 'Ngày làm việc trong tuần' });
      await expect(weekdays.getByRole('checkbox')).toHaveCount(7);
      for (const box of await weekdays.getByRole('checkbox').all()) if (await box.isChecked()) await box.click();
      await saveButton(page, 'Lịch làm việc').click();
      await expect(calendar.getByText('Chọn ít nhất một ngày làm việc.')).toBeVisible();
      await calendar.getByRole('button', { name: 'Bỏ thay đổi' }).click();
      expect(patches()).toBe(0);
      // Lưu thử giờ kết thúc, rồi trả lại ngay (đổi giờ làm việc đổi hạn mặc định của việc mới).
      // Chỉ lệch một phút và trả lại ngay: giờ kết thúc quyết định hạn mặc định của việc mới.
      const [endHour, endMinute] = [Number(before.workEnd.slice(0, 2)), Number(before.workEnd.slice(3, 5))];
      const newEnd = endMinute === 59 ? `${pad(endHour)}:58` : `${pad(endHour)}:${pad(endMinute + 1)}`;
      try {
        await calendar.getByLabel('Giờ kết thúc').fill(newEnd);
        const patch = nextPatch(page);
        await saveButton(page, 'Lịch làm việc').click();
        expect((await patch).postDataJSON()).toEqual({ workEnd: newEnd });
        await expect(toast(page, 'Đã lưu Lịch làm việc.')).toBeVisible();
      } finally {
        const current = await settingsOf(it);
        if (current.workEnd !== before.workEnd) {
          await calendar.getByLabel('Giờ kết thúc').fill(before.workEnd);
          const restore = nextPatch(page);
          await saveButton(page, 'Lịch làm việc').click();
          expect((await restore).postDataJSON()).toEqual({ workEnd: before.workEnd });
          await expect(calendar.getByText(/Đã lưu lúc/)).toBeVisible();
        }
      }

      // Bộ nhắc: ba lựa chọn, mỗi lựa chọn giải thích các mốc; đổi sang "Chặt" rồi trả lại.
      const reminders = section(page, 'bo-nhac');
      const presets = reminders.getByRole('group').getByRole('radio');
      await expect(presets).toHaveCount(3);
      await expect(reminders.getByRole('radio', { checked: true })).toBeVisible();
      await expect(reminders).toContainText('Quá hạn 3 ngày: báo Văn phòng và đưa vào mục "Cần Chủ tịch biết". Không tự nhắn thẳng cho Chủ tịch.');
      const other = before.reminderPreset === 'strict' ? 'Chuẩn' : 'Chặt';
      const otherKey = before.reminderPreset === 'strict' ? 'standard' : 'strict';
      try {
        await reminders.getByRole('radio', { name: new RegExp(`^${other}`) }).check();
        const patch = nextPatch(page);
        await saveButton(page, 'Bộ nhắc mặc định').click();
        expect((await patch).postDataJSON()).toEqual({ reminderPreset: otherKey });
        await expect(toast(page, 'Đã lưu Bộ nhắc mặc định.')).toBeVisible();
      } finally {
        const current = await settingsOf(it);
        if (current.reminderPreset !== before.reminderPreset) {
          await reminders.getByRole('radio', { name: new RegExp(`^${before.reminderPreset === 'strict' ? 'Chặt' : before.reminderPreset === 'none' ? 'Không nhắc' : 'Chuẩn'}`) }).check();
          const restore = nextPatch(page);
          await saveButton(page, 'Bộ nhắc mặc định').click();
          expect((await restore).postDataJSON()).toEqual({ reminderPreset: before.reminderPreset });
          await expect(reminders.getByText(/Đã lưu lúc/)).toBeVisible();
        }
      }

      // Phiên bản tối thiểu: chỉ nhận các số ngăn bằng dấu chấm; đặt 0.0.1 rồi để trống lại (không khoá app nào).
      const version = section(page, 'phien-ban').getByLabel('Phiên bản tối thiểu');
      await version.fill('abc');
      await saveButton(page, 'Phiên bản ứng dụng tối thiểu').click();
      await expect(section(page, 'phien-ban').getByText('Phiên bản gồm các số ngăn bằng dấu chấm, ví dụ 1.2.0.')).toBeVisible();
      await version.fill('0.0.1');
      const versionPatch = nextPatch(page);
      await saveButton(page, 'Phiên bản ứng dụng tối thiểu').click();
      expect((await versionPatch).postDataJSON()).toEqual({ minAppVersion: '0.0.1' });
      await expect(toast(page, 'Đã lưu Phiên bản ứng dụng tối thiểu.')).toBeVisible();
      await version.fill(before.minAppVersion ?? '');
      const versionRestore = nextPatch(page);
      await saveButton(page, 'Phiên bản ứng dụng tối thiểu').click();
      expect((await versionRestore).postDataJSON()).toEqual({ minAppVersion: before.minAppVersion });
      await expect(section(page, 'phien-ban').getByText(/Đã lưu lúc/)).toBeVisible();

      // Thời hạn lưu: chỉ kiểm tra ô nhập (đổi thật có thể làm hệ thống xoá dữ liệu đang có).
      const retention = section(page, 'luu-du-lieu');
      await retention.getByLabel('Thông báo', { exact: true }).fill('0');
      await saveButton(page, 'Thời hạn lưu dữ liệu').click();
      await expect(retention.getByText('Xin nhập số nguyên từ 1 trở lên.')).toBeVisible();
      await retention.getByRole('button', { name: 'Bỏ thay đổi' }).click();
      await expect(retention.getByLabel('Thông báo', { exact: true })).toHaveValue(String(before.retention.notificationDays));

      // Đầu mối dữ liệu: quá 300 ký tự thì không lưu; lưu một dòng rồi xoá trắng thì gửi null.
      const contact = section(page, 'dau-moi-du-lieu').getByLabel('Đầu mối liên hệ');
      await contact.fill('x'.repeat(301));
      await saveButton(page, 'Đầu mối bảo vệ dữ liệu').click();
      await expect(section(page, 'dau-moi-du-lieu').getByText('Nội dung dài tối đa 300 ký tự.')).toBeVisible();
      await contact.fill(`Kiểm thử ${stamp}`);
      const contactPatch = nextPatch(page);
      await saveButton(page, 'Đầu mối bảo vệ dữ liệu').click();
      expect((await contactPatch).postDataJSON()).toEqual({ dataContact: `Kiểm thử ${stamp}` });
      // Chờ máy chủ trả lời: lúc đó biểu mẫu được đặt lại theo giá trị đã lưu, chữ gõ trước đó sẽ bị thay.
      await expect(toast(page, 'Đã lưu Đầu mối bảo vệ dữ liệu.')).toBeVisible();
      await contact.fill(before.dataContact ?? '');
      const contactRestore = nextPatch(page);
      await saveButton(page, 'Đầu mối bảo vệ dữ liệu').click();
      expect((await contactRestore).postDataJSON()).toEqual({ dataContact: before.dataContact });
      await expect(section(page, 'dau-moi-du-lieu').getByText(/Đã lưu lúc/)).toBeVisible();
      await restoreKeys(it, before, touched);
      expect(only(await settingsOf(it), touched)).toEqual(only(before, touched));
    } finally {
      await restoreKeys(it, before, touched);
    }
  });
});

// ───────────────────────── Thông báo và nhật ký ─────────────────────────

test.describe('Thông báo và nhật ký', () => {
  test.describe.configure({ mode: 'serial' });

  type Notification = { id: string; user: { id: string; fullName: string }; title: string; state: string; sentAt: string | null; deliveredAt: string | null; openedAt: string | null; createdAt: string };

  test('thông báo: trạng thái gửi và đọc khớp dữ liệu, lọc theo trạng thái và người nhận', async ({ browser }) => {
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    const api50 = await api<Page_<Notification>>(it, 'GET', '/v1/admin/notifications?limit=50');
    expect(api50.status).toBe(200);
    const items = api50.body.items;
    expect(items.length).toBeGreaterThan(0);
    // Các mốc giờ phải nhất quán với trạng thái: đã gửi thì có giờ gửi, đã giao thì có giờ giao, đã mở thì có giờ mở.
    for (const n of items) {
      if (n.state === 'queued') expect(n.sentAt, 'chờ gửi thì chưa có giờ gửi').toBeNull();
      if (n.state === 'sent') expect(n.sentAt, 'đã gửi thì có giờ gửi').not.toBeNull();
      if (n.state === 'delivered') expect(n.deliveredAt, 'đã giao thì có giờ giao').not.toBeNull();
      if (n.state === 'opened') expect(n.openedAt, 'đã mở thì có giờ mở').not.toBeNull();
      if (n.openedAt) expect(n.deliveredAt ?? n.sentAt, 'mở được thì phải đã gửi').not.toBeNull();
    }

    await page.goto('/nhat-ky');
    const tabs = page.getByRole('navigation', { name: 'Các mục của Thông báo và nhật ký' });
    await expect(tabs.getByRole('link')).toHaveText(['Nhật ký hoạt động', 'Thông báo', 'Tác vụ lỗi', 'Dùng Trợ lý AI']);
    await tabs.getByRole('link', { name: 'Thông báo' }).click();
    const table = page.getByRole('table', { name: 'Trạng thái gửi và đọc của thông báo, mới nhất ở trên' });
    await settled(table);
    // Tiêu đề cột đủ các mốc.
    await expect(table.getByRole('columnheader')).toHaveText(['Người nhận', 'Thông báo', 'Trạng thái', 'Tạo lúc', 'Gửi', 'Giao', 'Mở']);
    const rows = table.locator('tbody tr');
    const label: Record<string, string> = { queued: 'Chờ gửi', sent: 'Đã gửi', delivered: 'Đã giao', opened: 'Đã mở', failed: 'Lỗi' };
    // Dòng đầu của bảng là thông báo mới nhất của API (cùng thứ tự), kèm đúng chữ trạng thái và dấu "Chưa" ở mốc chưa tới.
    await expect(async () => {
      const text = await rows.first().innerText();
      expect(text).toContain(items[0]!.user.fullName);
      expect(text).toContain(label[items[0]!.state]!);
    }).toPass();
    const firstCells = rows.first().getByRole('cell');
    await expect(firstCells.nth(5)).toHaveText(items[0]!.deliveredAt ? /\d{2}:\d{2}/ : 'Chưa');
    await expect(firstCells.nth(6)).toHaveText(items[0]!.openedAt ? /\d{2}:\d{2}/ : 'Chưa');
    await shot(page, 'nhat-ky-thong-bao-1280');

    // Lọc theo từng trạng thái: hoặc mọi dòng đúng trạng thái đó, hoặc báo rỗng bằng câu tiếng Việt.
    for (const state of ['Chờ gửi', 'Đã gửi', 'Đã giao', 'Đã mở', 'Lỗi']) {
      await choose(page, 'Lọc theo trạng thái', state);
      await expect(async () => {
        await settled(table);
        const empty = await page.getByText('Không có thông báo khớp điều kiện lọc').count();
        if (empty > 0) return;
        const chips = await rows.locator('td:nth-child(3)').allInnerTexts();
        expect(chips.length).toBeGreaterThan(0);
        expect(new Set(chips.map((c) => c.trim()))).toEqual(new Set([state]));
      }).toPass();
    }
    await page.getByRole('button', { name: 'Bỏ lọc' }).first().click();

    // Lọc theo người nhận: chỉ còn thông báo của người đó.
    const who = items[0]!.user.fullName;
    await pickPerson(page.getByLabel('Lọc theo người nhận'), who, new RegExp(who));
    await expect(async () => {
      await settled(table);
      const names = await rows.locator('td:nth-child(1)').allInnerTexts();
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toContain(who);
    }).toPass();
    await page.getByRole('button', { name: 'Bỏ lọc' }).first().click();

    // Có nhiều hơn 50 thông báo thì "Tải thêm" thêm dòng.
    if (api50.body.nextCursor) {
      await settled(table);
      const count = await rows.count();
      await page.getByRole('button', { name: 'Tải thêm' }).click();
      await expect(async () => expect(await rows.count()).toBeGreaterThan(count)).toPass();
    }

    // Dữ liệu mẫu chỉ có thông báo ở trạng thái "Đã gửi" (nhà cung cấp đẩy là bản giả). Bốn trạng thái còn lại: chèn thông báo thử cho
    // người thử A bằng psql, rồi xem cột trạng thái và ba cột mốc giờ (Gửi, Giao, Mở) vẽ đúng; xoá ngay sau đó.
    const [a] = await usersOf(it, userA.email);
    const org = demoOrgId();
    const day = vnDate();
    const at = (hhmm: string) => `${day}T${hhmm}:00+07:00`;
    const seeded = [
      { state: 'queued', label: 'Chờ gửi', sent: null, delivered: null, opened: null },
      { state: 'delivered', label: 'Đã giao', sent: '08:01', delivered: '08:02', opened: null },
      { state: 'opened', label: 'Đã mở', sent: '08:01', delivered: '08:02', opened: '09:30' },
      { state: 'failed', label: 'Lỗi', sent: null, delivered: null, opened: null },
    ];
    const sql = (value: string | null) => (value ? `'${at(value)}'` : 'null');
    const title = (state: string) => `Kiểm thử ${stamp} trạng thái ${state}`;
    try {
      for (const n of seeded) {
        psql(
          `insert into notifications (id, org_id, user_id, kind, title, body, state, created_at, sent_at, delivered_at, opened_at) values (gen_random_uuid(), '${org}', '${a!.id}', 'reminder', '${title(n.state)}', 'x', '${n.state}', '${at('08:00')}', ${sql(n.sent)}, ${sql(n.delivered)}, ${sql(n.opened)})`,
        );
      }
      await page.reload();
      await settled(table);
      for (const n of seeded) {
        // Lọc theo trạng thái: dữ liệu thật chỉ có "Đã gửi" nên mỗi trạng thái này chỉ còn dòng vừa chèn.
        await choose(page, 'Lọc theo trạng thái', n.label);
        await settled(table);
        const row = rows.filter({ hasText: title(n.state) });
        await expect(row, n.state).toHaveCount(1);
        await expect(row.getByRole('cell').nth(0), n.state).toContainText(userA.fullName);
        await expect(row.getByRole('cell').nth(1), n.state).toContainText('Nhắc hạn');
        await expect(row.getByRole('cell').nth(2), n.state).toHaveText(n.label);
        // Ba cột mốc: có giờ thì hiện giờ (cùng ngày với lúc tạo nên chỉ hiện giờ và phút), chưa tới thì ghi "Chưa".
        await expect(row.getByRole('cell').nth(4), `${n.state}: Gửi`).toHaveText(n.sent ?? 'Chưa');
        await expect(row.getByRole('cell').nth(5), `${n.state}: Giao`).toHaveText(n.delivered ?? 'Chưa');
        await expect(row.getByRole('cell').nth(6), `${n.state}: Mở`).toHaveText(n.opened ?? 'Chưa');
        await expect(rows.filter({ hasNotText: n.label }), `lọc ${n.label}`).toHaveCount(0);
      }
      await shot(page, 'nhat-ky-thong-bao-du-trang-thai-1280');
    } finally {
      psql(`delete from notifications where title like 'Kiểm thử ${stamp} trạng thái %'`);
    }
  });

  test('tác vụ lỗi: dòng "dead" thật chèn bằng psql; nút Thử lại đưa về hàng chờ; trạng thái đã đổi thì báo 409 bằng tiếng Việt', async ({ browser }) => {
    test.setTimeout(180_000);
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    const org = demoOrgId();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const errorOf = (i: number) => `kiem_thu_${stamp}_${i}`;
    try {
      for (const [i, id] of ids.entries()) {
        psql(
          `insert into effects (id, org_id, kind, payload, dedupe_key, state, attempts, last_error) values ('${id}', '${org}', 'webhook', '{}'::jsonb, 'kiem-thu-to-chuc-${stamp}-${i}', 'dead', 8, '${errorOf(i)}')`,
        );
      }
      await page.goto('/nhat-ky/tac-vu-loi');
      const table = page.getByRole('table', { name: 'Các tác vụ nền đang ở trạng thái lỗi' });
      await settled(table);
      const rowOf = (i: number) => table.getByRole('row').filter({ hasText: errorOf(i) });
      await expect(rowOf(0)).toContainText('Gọi dịch vụ ngoài');
      await expect(rowOf(0)).toContainText('webhook');
      await expect(rowOf(0)).toContainText('8');
      await expect(rowOf(0)).toContainText('Không thuộc lượt chạy nào');
      await shot(page, 'nhat-ky-tac-vu-loi-1280');

      // Thử lại dòng thứ nhất: về hàng chờ (worker có chạy thì sang "done"), dòng biến khỏi danh sách lỗi, nhật ký ghi lại.
      await rowOf(0).getByRole('button', { name: /^Thử lại tác vụ Gọi dịch vụ ngoài tạo lúc/ }).click();
      await expect(toast(page, 'Đã đưa tác vụ về hàng chờ. Hệ thống sẽ thử lại trong ít phút.')).toBeVisible();
      await expect(rowOf(0)).toHaveCount(0);
      expect(['pending', 'processing', 'done']).toContain(psql(`select state from effects where id = '${ids[0]}'`));
      expect(psql(`select attempts from effects where id = '${ids[0]}'`)).toBe('0');
      const audit = await api<Page_<AuditEntry>>(it, 'GET', '/v1/admin/audit-log?action=effect_retried&limit=5');
      expect(audit.body.items.some((e) => e.targetId === ids[0] && e.targetType === 'effect')).toBe(true);

      // Dòng thứ hai bị người khác (hoặc worker) đổi trạng thái trước khi bấm: máy chủ trả 409, giao diện làm mới và nói rõ.
      psql(`update effects set state = 'done' where id = '${ids[1]}'`);
      await rowOf(1).getByRole('button', { name: /^Thử lại tác vụ/ }).click();
      await expect(toast(page, 'Tác vụ này không còn ở trạng thái lỗi. Danh sách đã được làm mới.')).toBeVisible();
      await expect(rowOf(1)).toHaveCount(0);
    } finally {
      psql(`delete from effects where dedupe_key like 'kiem-thu-to-chuc-${stamp}-%'`);
    }
    await expect(page.getByRole('table', { name: 'Các tác vụ nền đang ở trạng thái lỗi' }).getByText(`kiem_thu_${stamp}`)).toHaveCount(0);
  });

  test('số liệu Trợ lý AI: chỉ số liệu (không nội dung hội thoại); tổng, chi phí, lọc kỳ và xuất CSV khớp dữ liệu', async ({ browser }) => {
    test.setTimeout(180_000);
    const it = await sessionOf(browser, 'it');
    const { page } = it;
    const org = demoOrgId();
    const [chairman, director, hung] = ['chutich', 'giamdoc', 'hung'].map((name) => psql(`select id from users where email = '${name}@demo.mihato.local'`));
    // Hai ngày gần đây chưa có số liệu thật của hai người này (dùng trợ lý thật để lại dòng ở những ngày gần), kẻo trùng khoá chính khi chèn.
    const taken = new Set(psql(`select day from ai_usage where org_id = '${org}' and user_id in ('${chairman}', '${director}')`).split('\n').filter(Boolean));
    const free = Array.from({ length: 40 }, (_v, i) => vnDate(-(i + 2))).filter((d) => !taken.has(d));
    const [d2, d3] = [free[0]!, free[1]!];
    const mine = [
      { user: chairman, day: d2, calls: 12, input: 52_000, output: 3_400, stt: 120, tts: 5_000, errors: 1 },
      { user: director, day: d2, calls: 7, input: 20_000, output: 1_500, stt: 0, tts: 0, errors: 0 },
      { user: chairman, day: d3, calls: 5, input: 9_000, output: 800, stt: 30, tts: 1_000, errors: 0 },
    ];
    const clean = () => {
      psql(
        `delete from ai_usage where org_id = '${org}' and llm_input_tokens in (${mine.map((r) => r.input).join(',')}) and ((user_id = '${chairman}' and day in ('${d2}','${d3}')) or (user_id = '${director}' and day = '${d2}'))`,
      );
      psql(`delete from ai_usage where org_id = '${org}' and user_id = '${hung}' and day = '${vnDate()}' and llm_input_tokens = 400000`);
    };
    type Usage = { rows: { user: { id: string; fullName: string }; day: string; llmCalls: number; llmInputTokens: number; llmOutputTokens: number; sttSeconds: number; ttsChars: number; errors: number }[]; totals: { llmCalls: number; llmInputTokens: number; llmOutputTokens: number; sttSeconds: number; ttsChars: number; errors: number; estimatedUsd: number } };
    try {
      clean();
      for (const r of mine) {
        psql(
          `insert into ai_usage (org_id, user_id, day, llm_calls, llm_input_tokens, llm_output_tokens, stt_seconds, tts_chars, errors) values ('${org}', '${r.user}', '${r.day}', ${r.calls}, ${r.input}, ${r.output}, ${r.stt}, ${r.tts}, ${r.errors})`,
        );
      }
      const usage = (await api<Usage>(it, 'GET', '/v1/admin/ai-usage')).body;
      // Ba dòng vừa chèn có mặt, đúng số; tổng bằng tổng các dòng; chi phí theo đơn giá 2 và 10 USD mỗi triệu token (SPEC 6.3).
      for (const r of mine) {
        const found = usage.rows.find((x) => x.user.id === r.user && x.day === r.day)!;
        expect(found, `dòng ${r.day}`).toMatchObject({ llmCalls: r.calls, llmInputTokens: r.input, llmOutputTokens: r.output, sttSeconds: r.stt, ttsChars: r.tts, errors: r.errors });
      }
      const sumRows = (key: 'llmCalls' | 'llmInputTokens' | 'llmOutputTokens' | 'sttSeconds' | 'ttsChars' | 'errors') => usage.rows.reduce((s, r) => s + r[key], 0);
      for (const key of ['llmCalls', 'llmInputTokens', 'llmOutputTokens', 'sttSeconds', 'ttsChars', 'errors'] as const) expect(usage.totals[key], `tổng ${key}`).toBe(sumRows(key));
      expect(usage.totals.estimatedUsd).toBeCloseTo((usage.totals.llmInputTokens * 2 + usage.totals.llmOutputTokens * 10) / 1_000_000, 3);
      // Chỉ số liệu: mỗi dòng chỉ có người, ngày và các con số; không có khoá nào mang nội dung hội thoại.
      for (const row of usage.rows) expect(Object.keys(row).sort()).toEqual(['day', 'errors', 'llmCalls', 'llmInputTokens', 'llmOutputTokens', 'sttSeconds', 'ttsChars', 'user']);
      expect(JSON.stringify(usage)).not.toMatch(/transcript|content|message|utterance/i);

      await page.goto('/nhat-ky/tro-ly');
      await expect(page.getByText('Chỉ số liệu, không có nội dung hội thoại')).toBeVisible();
      const int = (n: number) => n.toLocaleString('vi-VN');
      const usd = (n: number) => n.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      // Thẻ số trên màn hình đúng với phản hồi mới nhất của API (số có thể nhích khi có người đang dùng Trợ lý: so lại cho tới khi khớp).
      await expect(async () => {
        const fresh = (await api<Usage>(it, 'GET', '/v1/admin/ai-usage')).body.totals;
        expect(await tilesIn(page.getByRole('group', { name: 'Tổng trong kỳ' }))).toMatchObject({
          'Lượt gọi': int(fresh.llmCalls),
          'Token vào': int(fresh.llmInputTokens),
          'Token ra': int(fresh.llmOutputTokens),
          'Giây nhận giọng nói': int(fresh.sttSeconds),
          'Ký tự đọc thành tiếng': int(fresh.ttsChars),
          Lỗi: int(fresh.errors),
          'Chi phí ước tính': `${usd(fresh.estimatedUsd)} USD`,
        });
      }).toPass({ timeout: 15_000 });
      const table = page.getByRole('table', { name: 'Số liệu dùng Trợ lý AI theo người và ngày' });
      await settled(table);
      const dayText = (d: string) => d.split('-').reverse().join('/');
      for (const r of mine) {
        const who = r.user === chairman ? 'Trần Đức Minh' : 'Lê Thanh Sơn';
        const row = table.getByRole('row').filter({ hasText: who }).filter({ hasText: dayText(r.day) });
        await expect(row).toContainText(int(r.input));
        await expect(row).toContainText(int(r.calls));
      }
      await shot(page, 'nhat-ky-tro-ly-1280');

      // Lọc một ngày: chỉ còn các dòng của ngày đó (hai người). Hai nhãn ngày nằm trong nhóm "Chọn kỳ xem số liệu".
      await page.getByLabel('Từ ngày').fill(d2);
      await page.getByLabel('Đến ngày').fill(d2);
      await expect(async () => {
        const days = (await table.locator('tbody tr td:nth-child(2)').allInnerTexts()).map((t) => t.trim());
        expect(days.length).toBeGreaterThanOrEqual(2);
        expect(new Set(days)).toEqual(new Set([dayText(d2)]));
      }).toPass();
      // Xuất CSV: đúng số dòng đang hiện, tiêu đề tiếng Việt, số liệu khớp.
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Xuất CSV' }).click()]);
      const csv = await readCsv(download);
      expect(csv.rows[0]).toEqual(['Người dùng', 'Ngày', 'Lượt gọi', 'Token vào', 'Token ra', 'Giây nhận giọng nói', 'Ký tự đọc thành tiếng', 'Lỗi']);
      expect(csv.rows.length - 1).toBe(await table.locator('tbody tr').count());
      expect(csv.rows.some((r) => r[0]!.endsWith('Trần Đức Minh') && r[1] === dayText(d2) && r[2] === '12' && r[3] === '52000')).toBe(true);
      // Ngày bắt đầu sau ngày kết thúc: báo lỗi, không gọi máy chủ.
      await page.getByLabel('Đến ngày').fill(vnDate(-9));
      await expect(page.getByRole('alert').filter({ hasText: 'Ngày bắt đầu phải trước hoặc trùng ngày kết thúc.' })).toBeVisible();

      // Ngân sách tháng (SPEC 12.6): cảnh báo ở 80% và 100% chi phí từ đầu tháng, và nói rõ hệ thống không tự cắt Trợ lý AI.
      // Thêm một dòng của hôm nay để chi phí tháng này chắc chắn lớn hơn 0 (1 USD: 400.000 token vào, 20.000 token ra).
      psql(`insert into ai_usage (org_id, user_id, day, llm_calls, llm_input_tokens, llm_output_tokens) values ('${org}', '${hung}', '${vnDate()}', 3, 400000, 20000)`);
      const budgetBefore = (await api<OrgSettings>(it, 'GET', '/v1/org/settings')).body.ai.monthlyBudgetUsd;
      const setBudget = async (usdValue: number | null) => expect((await api(it, 'PATCH', '/v1/org/settings', { ai: { monthlyBudgetUsd: usdValue } })).status).toBe(200);
      try {
        const monthSoFar = (await api<Usage>(it, 'GET', `/v1/admin/ai-usage?from=${vnDate().slice(0, 8)}01&to=${vnDate()}`)).body.totals.estimatedUsd;
        expect(monthSoFar).toBeGreaterThanOrEqual(1);
        const note = 'Trợ lý AI vẫn chạy bình thường vì hệ thống chỉ cảnh báo, không tự cắt.';
        const alertBox = (title: string) => page.getByRole('status').filter({ hasText: title });
        await setBudget(Math.round((monthSoFar / 0.9) * 10_000) / 10_000);
        await page.goto('/nhat-ky/tro-ly');
        await expect(alertBox('Chi phí sắp chạm ngân sách tháng')).toContainText(note);
        await expect(page.getByText('Chi phí đã vượt ngân sách tháng')).toHaveCount(0);
        await setBudget(Math.round((monthSoFar / 2) * 10_000) / 10_000);
        await page.goto('/nhat-ky/tro-ly');
        await expect(alertBox('Chi phí đã vượt ngân sách tháng')).toContainText(note);
        await expect(alertBox('Chi phí đã vượt ngân sách tháng')).toContainText(/bằng \d+% ngân sách/);
        await shot(page, 'nhat-ky-tro-ly-vuot-ngan-sach-1280');
        await setBudget(Math.round(monthSoFar * 10 * 10_000) / 10_000);
        await page.goto('/nhat-ky/tro-ly');
        await expect(page.getByText(/^Tính theo đơn giá token/)).toContainText(/Ngân sách tháng là [\d.,]+ USD; từ đầu tháng đã dùng \d+%\./);
        await expect(page.getByText('Chi phí sắp chạm ngân sách tháng')).toHaveCount(0);
        await expect(page.getByText('Chi phí đã vượt ngân sách tháng')).toHaveCount(0);
      } finally {
        await setBudget(budgetBefore);
      }
    } finally {
      clean();
    }
  });

  test('bàn phím: mở và đóng lớp nổi, focus trở về đúng nút; hộp chọn dùng được bằng phím', async ({ browser }) => {
    const { page } = await sessionOf(browser, 'it');
    await page.goto('/to-chuc/nguoi-dung');
    const add = page.getByRole('button', { name: 'Thêm người dùng' });
    await add.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Thêm người dùng' });
    await expect(sheet).toBeVisible();
    // Focus nằm trong bảng trượt; Esc đóng lại và trả focus về nút đã mở.
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(add).toBeFocused();

    // Trình đơn của một dòng: mở bằng Enter, đi bằng mũi tên, chọn bằng Enter; đóng hộp thoại thì focus về nút "…".
    const menuButton = page.getByRole('button', { name: 'Thao tác với ông Trần Đức Minh' });
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Sửa hồ sơ' })).toBeFocused();
    await page.keyboard.press('Enter');
    const edit = page.getByRole('dialog', { name: 'Sửa hồ sơ' });
    await expect(edit.getByLabel('Họ và tên')).toHaveValue('Trần Đức Minh');
    await page.keyboard.press('Escape');
    await expect(edit).toBeHidden();
    await expect(menuButton).toBeFocused();

    // Dải tab là liên kết thật: tab đang mở mang aria-current.
    const tabs = page.getByRole('navigation', { name: 'Các mục của Người dùng và tổ chức' });
    await expect(tabs.getByRole('link', { name: 'Người dùng' })).toHaveAttribute('aria-current', 'page');

    // Biểu mẫu "Thêm đơn vị" chỉ dùng bàn phím: Tab tới từng ô, hộp chọn mở bằng Enter, mũi tên chọn, Enter xác nhận.
    await page.goto('/to-chuc/don-vi');
    const addUnit = page.getByRole('button', { name: 'Thêm đơn vị', exact: true });
    await addUnit.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Thêm đơn vị' });
    await expect(dialog).toBeVisible();
    const name = dialog.getByLabel('Tên đơn vị');
    // Hộp chọn bị khoá cho tới khi danh sách đơn vị tải xong; chờ nó mở khoá thì Tab mới dừng ở đó.
    await expect(dialog.getByLabel('Đơn vị cha')).toBeEnabled();
    await name.focus();
    await page.keyboard.press('Tab');
    // Khi hộp chọn mở, mọi thứ ngoài danh sách bị ẩn khỏi cây trợ năng: định vị ô theo id để vẫn thấy được nó.
    const parent = page.locator(`[id="${await dialog.getByLabel('Đơn vị cha').getAttribute('id')}"]`);
    await expect(parent).toBeFocused();
    await page.keyboard.press('Enter');
    const options = page.getByRole('option');
    await expect(options.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(parent).not.toContainText('Không có (đơn vị cấp cao nhất)');
    await expect(parent).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(addUnit).toBeFocused();
  });
});

// ───────────────────────── Văn phòng ─────────────────────────

test.describe('Văn phòng', () => {
  test.describe.configure({ mode: 'serial' });

  /** Một lượt chạy thử `simulate` của mẫu "Đón đoàn nhà đầu tư thăm KCN": hạn của từng việc tính lùi từ ngày đoàn đến. */
  async function simulatedDues(office: Session, visitDate: string): Promise<Map<string, string>> {
    const list = await api<{ items: { id: string; name: string }[] }>(office, 'GET', '/v1/templates');
    const template = list.body.items.find((t) => t.name === 'Đón đoàn nhà đầu tư thăm KCN');
    expect(template, 'dữ liệu mẫu có mẫu "Đón đoàn nhà đầu tư thăm KCN"').toBeTruthy();
    const res = await api<{ rows: { nodeId: string; dueAt: string | null }[] }>(office, 'POST', `/v1/templates/${template!.id}/simulate`, { inputs: { delegation: 'Đoàn kiểm thử', visitDate } });
    expect(res.status).toBe(200);
    return new Map(res.body.rows.map((r) => [r.nodeId, vnDateOf(r.dueAt!)]));
  }
  /** Nguồn kiểm độc lập: lùi `n` ngày làm việc từ `target`, bỏ qua ngày nghỉ và cuối tuần, tính ngày làm bù là ngày làm việc (SPEC 4.5). */
  function workingDaysBefore(target: string, n: number, workdays: readonly number[], holidays: readonly Holiday[]): string {
    const kind = new Map(holidays.map((h) => [h.day, h.kind]));
    const isWorking = (day: string): boolean => {
      const k = kind.get(day);
      if (k === 'makeup_workday') return true;
      if (k) return false;
      const iso = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      return workdays.includes(iso);
    };
    let day = target;
    let left = n;
    while (left > 0) {
      day = new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      if (isWorking(day)) left--;
    }
    return day;
  }
  const OFFSETS: Record<string, number> = { s1: 7, s2: 5, s3: 6, s4: 7, s5: 4, s6: 6 };

  test('ngày nghỉ: thêm từ gợi ý rồi xoá, thêm hết, thêm sửa xoá bằng tay; ngày nghỉ làm dời hạn việc', async ({ browser }) => {
    test.setTimeout(240_000);
    const office = await sessionOf(browser, 'vanphong');
    const { page } = office;
    // Dọn năm thử còn sót của lần chạy dở trước (qua API, để không chen vào bước xem giao diện).
    const clearYear = async () => {
      const left = await api<{ items: Holiday[] }>(office, 'GET', `/v1/holidays?year=${HOLIDAY_YEAR}`);
      for (const h of left.body.items) expect((await api(office, 'DELETE', `/v1/holidays/${h.day}`)).status).toBe(200);
    };
    await clearYear();

    /** Tab Ngày nghỉ luôn mở ở năm hiện tại: bấm "Xem năm" tới năm thử. */
    const openTestYear = async () => {
      await page.goto('/to-chuc');
      await expect(page).toHaveURL(/\/to-chuc\/ngay-nghi$/);
      const thisYear = Number(vnDate().slice(0, 4));
      for (let year = thisYear + 1; year <= HOLIDAY_YEAR; year++) await page.getByRole('button', { name: `Xem năm ${year}` }).click();
      await expect(page.getByRole('heading', { name: `Ngày nghỉ năm ${HOLIDAY_YEAR}` })).toBeVisible();
    };
    await page.goto('/to-chuc');
    // Văn phòng chỉ có quyền ngày nghỉ: vào thẳng tab đó và không thấy các tab quản trị.
    await expect(page).toHaveURL(/\/to-chuc\/ngay-nghi$/);
    await expect(page.getByRole('navigation', { name: 'Các mục của Người dùng và tổ chức' }).getByRole('link')).toHaveText(['Ngày nghỉ']);
    await expect(page.getByText('Đây chỉ là gợi ý')).toBeVisible();
    await expect(page.getByText('Văn phòng nhập ngày nghỉ theo thông báo chính thức hằng năm, kể cả ngày nghỉ bù và ngày làm bù.')).toBeVisible();
    await expect(page.getByText(/^Tuần làm việc: Thứ Hai đến Thứ Sáu\./)).toBeVisible();

    await openTestYear();
    const table = page.getByRole('table', { name: `Bảng ngày nghỉ năm ${HOLIDAY_YEAR}` });
    await settled(table);
    await expect(page.getByText(`Năm ${HOLIDAY_YEAR} chưa có ngày nghỉ nào`)).toBeVisible();
    const newYear = `Thứ Bảy, ngày 1 tháng 1 năm ${HOLIDAY_YEAR}`;

    const suggestions = page.getByRole('region', { name: 'Gợi ý ngày lễ cố định' });
    // Gợi ý có nhãn ngày âm cho các ngày lễ tính theo âm lịch (SPEC 4.5): Giỗ Tổ là mùng 10 tháng 3 âm lịch.
    await expect(suggestions.getByRole('listitem').filter({ hasText: 'Giỗ Tổ Hùng Vương' })).toContainText('mùng 10 tháng 3 âm lịch');
    await expect(suggestions.getByRole('listitem').filter({ hasText: 'mùng 1 Tết' })).toContainText('mùng 1 tháng Giêng âm lịch');
    await shot(page, 'ngay-nghi-goi-y-1280');

    await suggestions.getByRole('button', { name: 'Thêm Tết Dương lịch vào ngày nghỉ' }).click();
    await expect(toast(page, 'Đã thêm Tết Dương lịch.')).toBeVisible();
    const row = table.getByRole('row').filter({ hasText: newYear });
    await expect(row).toContainText('Tết Dương lịch');
    await expect(row).toContainText('Nghỉ lễ');
    await expect(suggestions.getByRole('listitem').filter({ hasText: 'Tết Dương lịch' })).toContainText('Đã thêm');

    await page.getByRole('button', { name: `Xoá ngày ${newYear}` }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Xoá ngày nghỉ này?' });
    await expect(confirm).toContainText('sẽ được tính như ngày thường khi tính hạn công việc');
    await confirm.getByRole('button', { name: 'Xoá ngày nghỉ' }).click();
    await expect(toast(page, `Đã xoá ngày ${newYear}.`)).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(suggestions.getByRole('button', { name: 'Thêm Tết Dương lịch vào ngày nghỉ' })).toBeVisible();

    // "Thêm tất cả": mọi ngày gợi ý vào bảng; sau đó dọn bằng API và xem bảng trống lại.
    await suggestions.getByRole('button', { name: /^Thêm tất cả \(\d+\)$/ }).click();
    await expect(toast(page, /^Đã thêm \d+ ngày nghỉ\.$/)).toBeVisible({ timeout: 30_000 });
    await expect(suggestions.getByText(`Mọi ngày gợi ý của năm ${HOLIDAY_YEAR} đã có trong danh sách.`)).toBeVisible();
    const added = await suggestions.getByRole('listitem').count();
    expect(added).toBeGreaterThanOrEqual(10);
    await expect(table.locator('tbody tr')).toHaveCount(added);
    await shot(page, 'ngay-nghi-day-du-1280');
    await clearYear();
    // Tải lại trang thì bảng về năm hiện tại: bấm tới năm thử lần nữa (dữ liệu lấy mới từ máy chủ).
    await openTestYear();
    await expect(page.getByText(`Năm ${HOLIDAY_YEAR} chưa có ngày nghỉ nào`)).toBeVisible();

    // Hạn việc tính lùi từ ngày đoàn đến (thứ Tư 20/09/2028). Chưa có ngày nghỉ: chỉ bỏ cuối tuần.
    const visit = `${HOLIDAY_YEAR}-09-20`;
    const settings = (await api<OrgSettings>(office, 'GET', '/v1/org/settings')).body;
    const expectDues = (holidays: Holiday[]) => Object.fromEntries(Object.entries(OFFSETS).map(([node, n]) => [node, workingDaysBefore(visit, n, settings.workdays, holidays)]));
    const plain = await simulatedDues(office, visit);
    expect(Object.fromEntries(plain)).toEqual(expectDues([]));

    // Nhập tay một ngày nghỉ riêng của công ty vào thứ Ba 12/09/2028: các việc hạn lùi từ 6 ngày làm việc trở lên phải dời sớm hơn.
    await page.getByRole('button', { name: 'Thêm ngày nghỉ' }).click();
    const dialog = page.getByRole('dialog', { name: 'Thêm ngày nghỉ' });
    await dialog.getByRole('button', { name: 'Thêm ngày nghỉ' }).click();
    await expect(dialog.getByText('Xin chọn ngày.')).toBeVisible();
    await expect(dialog.getByText('Xin nhập tên ngày nghỉ.')).toBeVisible();
    await dialog.locator('input[type="date"]').fill(`${HOLIDAY_YEAR}-09-12`);
    await expect(dialog.getByText(`Thứ Ba, ngày 12 tháng 9 năm ${HOLIDAY_YEAR}`)).toBeVisible();
    await dialog.getByLabel('Tên ngày nghỉ').fill('Công ty nghỉ giữa tuần (kiểm thử)');
    await choose(dialog, 'Loại', 'Nghỉ riêng của công ty');
    await dialog.getByRole('button', { name: 'Thêm ngày nghỉ' }).click();
    const manual = table.getByRole('row').filter({ hasText: 'Công ty nghỉ giữa tuần (kiểm thử)' });
    await expect(manual).toContainText(`Thứ Ba, ngày 12 tháng 9 năm ${HOLIDAY_YEAR}`);
    await expect(manual).toContainText('Nghỉ riêng của công ty');
    await shot(page, 'ngay-nghi-1280');
    const withHoliday = await simulatedDues(office, visit);
    const holidays1: Holiday[] = [{ day: `${HOLIDAY_YEAR}-09-12`, name: 'x', kind: 'company' }];
    expect(Object.fromEntries(withHoliday)).toEqual(expectDues(holidays1));
    expect(withHoliday.get('s3'), 'việc lùi 6 ngày làm việc dời sớm hơn một ngày làm việc').toBe(`${HOLIDAY_YEAR}-09-11`);
    expect(withHoliday.get('s1'), 'việc lùi 7 ngày làm việc dời sớm hơn một ngày làm việc').toBe(`${HOLIDAY_YEAR}-09-08`);
    expect(withHoliday.get('s5'), 'việc lùi 4 ngày làm việc không bị ảnh hưởng').toBe(plain.get('s5'));
    expect(withHoliday.get('s3')).not.toBe(plain.get('s3'));

    // Sửa loại thành "Ngày làm bù": ngày đó lại là ngày làm việc, hạn trở về như chưa có ngày nghỉ.
    await manual.getByRole('button', { name: /^Sửa ngày/ }).click();
    const edit = page.getByRole('dialog', { name: 'Sửa ngày nghỉ' });
    await expect(edit.getByText('Muốn đổi sang ngày khác, xin xoá ngày này rồi thêm ngày mới.')).toBeVisible();
    await choose(edit, 'Loại', 'Ngày làm bù');
    await edit.getByRole('button', { name: 'Lưu ngày nghỉ' }).click();
    await expect(manual).toContainText('Ngày làm bù');
    expect(Object.fromEntries(await simulatedDues(office, visit))).toEqual(Object.fromEntries(plain));

    // Ngày làm bù vào thứ Bảy 16/09/2028 (nằm giữa 15/09 và 18/09, trong khoảng đếm lùi từ 20/09): đếm lùi tính cả ngày đó,
    // nên hạn của mọi việc dời muộn hơn một ngày làm việc.
    const saturday = `${HOLIDAY_YEAR}-09-16`;
    await page.getByRole('button', { name: 'Thêm ngày nghỉ' }).click();
    const makeup = page.getByRole('dialog', { name: 'Thêm ngày nghỉ' });
    await makeup.locator('input[type="date"]').fill(saturday);
    await makeup.getByLabel('Tên ngày nghỉ').fill('Đi làm bù thứ Bảy (kiểm thử)');
    await choose(makeup, 'Loại', 'Ngày làm bù');
    await expect(makeup.getByText('Ngày cuối tuần đi làm bù: được tính là ngày làm việc.')).toBeVisible();
    await makeup.getByRole('button', { name: 'Thêm ngày nghỉ' }).click();
    await expect(table.getByRole('row').filter({ hasText: 'Đi làm bù thứ Bảy (kiểm thử)' })).toContainText(`Thứ Bảy, ngày 16 tháng 9 năm ${HOLIDAY_YEAR}`);
    const later = await simulatedDues(office, visit);
    const holidays2: Holiday[] = [
      { day: `${HOLIDAY_YEAR}-09-12`, name: 'x', kind: 'makeup_workday' },
      { day: saturday, name: 'x', kind: 'makeup_workday' },
    ];
    expect(Object.fromEntries(later)).toEqual(expectDues(holidays2));
    for (const node of Object.keys(OFFSETS)) expect(later.get(node)! > plain.get(node)!, `thêm ngày làm việc thì hạn ${node} dời muộn hơn`).toBe(true);

    // Xoá hết bằng giao diện: hạn quay về như lúc đầu.
    for (const name of ['Công ty nghỉ giữa tuần (kiểm thử)', 'Đi làm bù thứ Bảy (kiểm thử)']) {
      const target = table.getByRole('row').filter({ hasText: name });
      await target.getByRole('button', { name: /^Xoá ngày/ }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Xoá ngày nghỉ' }).click();
      await expect(target).toHaveCount(0);
    }
    await expect(page.getByText(`Năm ${HOLIDAY_YEAR} chưa có ngày nghỉ nào`)).toBeVisible();
    expect(Object.fromEntries(await simulatedDues(office, visit))).toEqual(Object.fromEntries(plain));
    await clearYear();
  });

  type ReportBody = Report;
  const reportPath = (q: { from: string; to: string; unitId?: string; userId?: string; templateId?: string }) => `/v1/reports/summary?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][])}`;
  const percent = (rate: number | null) => (rate === null ? '–' : `${Math.round(rate * 100)}%`);
  const decimal = (n: number | null) => (n === null ? '–' : n.toLocaleString('vi-VN', { maximumFractionDigits: 2 }));
  const cellsOf = (table: Locator) =>
    table.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())));
  const tilesOf = (page: Page) => tilesIn(page.getByRole('group', { name: 'Các chỉ số của kỳ' }));

  test('báo cáo: số liệu khớp reports.summary và dữ liệu gốc; đổi kỳ, đơn vị, người, quy trình; xuất CSV có BOM', async ({ browser }) => {
    test.setTimeout(240_000);
    const office = await sessionOf(browser, 'vanphong');
    const { page } = office;
    const today = vnDate();
    const defaults = { from: vnDate(-29), to: today };
    await page.goto('/bao-cao');
    const stats = page.getByRole('group', { name: 'Các chỉ số của kỳ' });
    for (const label of ['Tỷ lệ đúng hạn', 'Đúng hạn sau gia hạn', 'Việc quá hạn hiện tại', 'Xử lý trung bình', 'Số việc xong']) await expect(stats).toContainText(label);
    const byUser = page.getByRole('table', { name: 'Khối lượng và tỷ lệ đúng hạn theo người' });
    const byUnit = page.getByRole('table', { name: 'Khối lượng và tỷ lệ đúng hạn theo đơn vị' });
    const nudges = page.getByRole('table', { name: 'Số lần đi thúc và tỷ lệ phản hồi theo người nhận' });
    await settled(byUser);
    await expect(page.getByText(/^Từ \d{2}\/\d{2}\/\d{4} đến \d{2}\/\d{2}\/\d{4}$/)).toBeVisible();
    await expect(page.locator('time').filter({ hasText: /^Số liệu lúc \d{2}:\d{2}$/ })).toBeVisible();

    // Định nghĩa của chỉ số hiện khi focus nút ⓘ.
    await page.getByRole('button', { name: 'Cách tính: Tỷ lệ đúng hạn' }).focus();
    await expect(page.getByRole('tooltip')).toContainText('Số việc xong không muộn hơn hạn gốc, chia cho số việc xong trong kỳ.');
    await page.keyboard.press('Escape');

    /** Thẻ số và các bảng trên màn hình phải đúng với phản hồi của API cho cùng bộ lọc. */
    const expectScreenMatches = async (query: Parameters<typeof reportPath>[0], where: string) => {
      await expect(async () => {
        const report = (await api<ReportBody>(office, 'GET', reportPath(query))).body;
        const tiles = await tilesOf(page);
        expect(tiles['Tỷ lệ đúng hạn'], `${where}: tỷ lệ đúng hạn`).toBe(percent(report.onTimeRate));
        expect(tiles['Đúng hạn sau gia hạn'], `${where}: đúng hạn sau gia hạn`).toBe(percent(report.onTimeRateAfterExtension));
        expect(tiles['Việc quá hạn hiện tại'], `${where}: quá hạn`).toBe(String(report.overdueNow));
        expect(tiles['Xử lý trung bình'], `${where}: xử lý trung bình`).toBe(decimal(report.avgHandlingWorkingDays));
        expect(tiles['Số việc xong'], `${where}: số việc xong`).toBe(String(report.completedCount));
        const users = await cellsOf(byUser);
        if (report.byUser.length === 0) expect(users.length, `${where}: bảng người rỗng`).toBe(1);
        else {
          expect(users.length, `${where}: số dòng theo người`).toBe(report.byUser.length);
          for (const [i, u] of report.byUser.entries()) {
            expect(users[i]![0], `${where}: tên`).toContain(u.user.fullName);
            expect(users[i]!.slice(1), `${where}: ${u.user.fullName}`).toEqual([u.unitName ?? '–', String(u.open), String(u.overdue), String(u.completed), u.onTimeRate === null ? 'Chưa có' : percent(u.onTimeRate)]);
          }
        }
        const units = await cellsOf(byUnit);
        if (report.byUnit.length > 0) {
          expect(units.length, `${where}: số dòng theo đơn vị`).toBe(report.byUnit.length);
          for (const [i, u] of report.byUnit.entries()) expect(units[i]!.slice(1), `${where}: ${u.unitName}`).toEqual([String(u.open), String(u.overdue), String(u.completed), u.onTimeRate === null ? 'Chưa có' : percent(u.onTimeRate)]);
        }
        // Tổng các dòng nhất quán: bảng theo đơn vị gộp từ bảng theo người; việc quá hạn của từng người không vượt tổng.
        const sum = (rows: { completed: number; overdue: number; open: number }[], key: 'completed' | 'overdue' | 'open') => rows.reduce((s, r) => s + r[key], 0);
        expect(sum(report.byUnit, 'completed'), `${where}: Σ xong theo đơn vị = theo người`).toBe(sum(report.byUser, 'completed'));
        expect(sum(report.byUser, 'overdue'), `${where}: Σ quá hạn theo người ≤ tổng`).toBeLessThanOrEqual(report.overdueNow);
        expect(sum(report.byUser, 'completed'), `${where}: Σ xong theo người ≤ tổng`).toBeLessThanOrEqual(report.completedCount);
        for (const u of report.byUser) {
          expect(u.onTimeRate === null || (u.onTimeRate >= 0 && u.onTimeRate <= 1)).toBe(true);
          expect(u.open).toBeGreaterThanOrEqual(0);
          expect(u.overdue).toBeLessThanOrEqual(u.open);
        }
        expect(await nudges.count()).toBe(1);
      }).toPass({ timeout: 20_000 });
    };
    await expectScreenMatches(defaults, 'mặc định 30 ngày qua');

    // Đối chiếu độc lập với dữ liệu gốc trong CSDL (không đi qua mã báo cáo): số việc xong trong kỳ và số việc quá hạn lúc này.
    await expect(async () => {
      const report = (await api<ReportBody>(office, 'GET', reportPath(defaults))).body;
      const done = Number(psql(`select count(*) from step_runs where kind in ('task','approval') and state = 'done' and completed_at >= '${defaults.from}T00:00:00+07' and completed_at < '${vnDate(1)}T00:00:00+07'`));
      const overdue = Number(psql("select count(*) from v_step_status where is_overdue and state in ('unassigned','ready','in_progress')"));
      expect(report.completedCount, 'Số việc xong khớp bảng step_runs').toBe(done);
      expect(report.overdueNow, 'Số việc quá hạn khớp view v_step_status').toBe(overdue);
      // Cùng nguồn với Tổng quan (SPEC 9.6): số quá hạn của hai màn bằng nhau.
      const overview = await api<{ overdue: number }>(office, 'GET', '/v1/overview');
      expect(report.overdueNow, 'cùng nguồn với Tổng quan').toBe(overview.body.overdue);
    }).toPass({ timeout: 20_000 });

    // Đổi kỳ: khoảng ngày hiện ở đầu trang đúng với kỳ (tuần bắt đầu từ Thứ Hai); đổi sang kỳ mới thì gọi reports.summary với khoảng đó.
    const vn = (d: string) => d.split('-').reverse().join('/');
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    const periods: [string, { from: string; to: string }][] = [
      ['Tuần này', { from: vnDate(-weekday), to: today }],
      ['Tháng này', { from: `${today.slice(0, 8)}01`, to: today }],
      ['30 ngày qua', defaults],
    ];
    for (const [label, range] of periods) {
      // Máy chủ nhớ kết quả 30 giây: kỳ vừa xem không gọi lại. Chỉ khẳng định lời gọi khi có.
      const asked = page.waitForRequest((r) => r.url().includes('/v1/reports/summary') && r.url().includes(`from=${range.from}`) && r.url().includes(`to=${range.to}`), { timeout: 4_000 }).catch(() => null);
      await choose(page, 'Kỳ báo cáo', label);
      await asked;
      await expect(page.getByText(`Từ ${vn(range.from)} đến ${vn(range.to)}`), label).toBeVisible();
      await expectScreenMatches(range, label);
    }
    await choose(page, 'Kỳ báo cáo', 'Tuỳ chọn');
    const [from, to] = [vnDate(-45), vnDate(-10)];
    await page.getByLabel('Từ ngày').fill(from);
    await page.getByLabel('Đến ngày').fill(vnDate(-60));
    await expect(page.getByText('Ngày bắt đầu phải trước hoặc trùng ngày kết thúc.')).toBeVisible();
    const custom = page.waitForRequest((r) => r.url().includes(`from=${from}`) && r.url().includes(`to=${to}`));
    await page.getByLabel('Đến ngày').fill(to);
    await custom;
    await expect(page.getByText(`Từ ${vn(from)} đến ${vn(to)}`)).toBeVisible();
    await expectScreenMatches({ from, to }, 'kỳ tuỳ chọn');
    await choose(page, 'Kỳ báo cáo', '30 ngày qua');
    await expectScreenMatches(defaults, 'về 30 ngày qua');

    // Lọc theo đơn vị: lấy đơn vị của người đầu bảng, bảng theo người chỉ còn người của đơn vị đó.
    const full = (await api<ReportBody>(office, 'GET', reportPath(defaults))).body;
    const someone = full.byUser.find((u) => u.unitName !== null)!;
    const unitName = someone.unitName!;
    const unitId = (await api<{ items: UnitView[] }>(office, 'GET', '/v1/units')).body.items.find((u) => u.name === unitName)!.id;
    await choose(page, 'Lọc theo đơn vị', unitName);
    await expectScreenMatches({ ...defaults, unitId }, `đơn vị ${unitName}`);
    const unitCells = await cellsOf(byUser);
    expect(new Set(unitCells.map((c) => c[1]))).toEqual(new Set([unitName]));
    // Lọc theo người.
    await pickPerson(page.getByLabel('Lọc theo người'), someone.user.fullName, new RegExp(someone.user.fullName));
    await expectScreenMatches({ ...defaults, unitId, userId: someone.user.id }, `người ${someone.user.fullName}`);
    await expect(byUser.locator('tbody tr')).toHaveCount(1);
    // Lọc theo quy trình.
    const templates = (await api<{ items: { id: string; name: string }[] }>(office, 'GET', '/v1/templates')).body.items;
    const template = templates.find((t) => t.name === 'Đón đoàn nhà đầu tư thăm KCN')!;
    await choose(page, 'Lọc theo quy trình', template.name);
    await expectScreenMatches({ ...defaults, unitId, userId: someone.user.id, templateId: template.id }, 'thêm quy trình');
    await page.getByRole('button', { name: 'Bỏ lọc' }).click();
    await expectScreenMatches(defaults, 'bỏ lọc');

    // Nút thắt: tổng số dòng các bảng con bằng số bước; mỗi quy trình có bước "Xử lý lâu nhất" ở đầu (bước nào có thời gian xử lý lớn nhất).
    await expect(async () => {
      const report = (await api<ReportBody>(office, 'GET', reportPath(defaults))).body;
      let stepRows = 0;
      for (const name of new Set(report.byTemplateStep.map((r) => r.templateName))) {
        const steps = report.byTemplateStep.filter((r) => r.templateName === name);
        const table = page.getByRole('table', { name: `Các bước của quy trình ${name}, bước xử lý lâu nhất ở trên` });
        const rows = await cellsOf(table);
        expect(rows.length, `quy trình ${name}`).toBe(steps.length);
        stepRows += rows.length;
        const slowest = Math.max(...steps.map((r) => r.avgWorkingDays ?? 0));
        if (slowest > 0) expect(rows[0]![0], `bước đầu của ${name} là bước chậm nhất`).toContain('Xử lý lâu nhất');
        // Cột "Xử lý trung bình" ghi số ngày làm việc, ví dụ "1,5 ngày".
        expect(rows[0]![2]).toContain(`${(steps[0]!.avgWorkingDays ?? 0).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} ngày`);
      }
      expect(stepRows).toBe(report.byTemplateStep.length);
    }).toPass({ timeout: 20_000 });

    // Xuất CSV: BOM EF BB BF, dấu tiếng Việt nguyên vẹn, nội dung đúng với dữ liệu đang hiện.
    const csvOf = async (name: string) => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Xuất CSV bảng ${name}` }).click()]);
      return { download, ...(await readCsv(download)) };
    };
    await expect(async () => {
      const report = (await api<ReportBody>(office, 'GET', reportPath(defaults))).body;
      const users = await csvOf('Theo người');
      expect(users.download.suggestedFilename()).toBe(`bao-cao-theo-nguoi_${defaults.from}_${defaults.to}.csv`);
      expect(users.rows[0]).toEqual(['Người', 'Đơn vị', 'Đang giữ', 'Quá hạn', 'Đã xong', 'Tỷ lệ đúng hạn (%)']);
      expect(users.rows.length - 1).toBe(report.byUser.length);
      for (const [i, u] of report.byUser.entries()) {
        const r = users.rows[i + 1]!;
        expect(r[0]).toContain(u.user.fullName);
        expect(r.slice(1)).toEqual([u.unitName ?? '', String(u.open), String(u.overdue), String(u.completed), u.onTimeRate === null ? '' : String(Math.round(u.onTimeRate * 100))]);
      }
      // Dấu tiếng Việt đúng: tên người có dấu nằm nguyên trong tệp (không vỡ, không tách dấu).
      const accented = report.byUser.find((u) => /[ạ-ỹà-ỹ]/i.test(u.user.fullName));
      expect(accented, 'có người có dấu để kiểm').toBeTruthy();
      expect(users.text).toContain(accented!.user.fullName);

      const units = await csvOf('Theo đơn vị');
      expect(units.download.suggestedFilename()).toBe(`bao-cao-theo-don-vi_${defaults.from}_${defaults.to}.csv`);
      expect(units.rows[0]).toEqual(['Đơn vị', 'Đang giữ', 'Quá hạn', 'Đã xong', 'Tỷ lệ đúng hạn (%)']);
      expect(units.rows.length - 1).toBe(report.byUnit.length);
      for (const [i, u] of report.byUnit.entries()) expect(units.rows[i + 1]!.slice(0, 4)).toEqual([u.unitName || 'Chưa xếp đơn vị', String(u.open), String(u.overdue), String(u.completed)]);

      const bottleneck = await csvOf('Nút thắt');
      expect(bottleneck.download.suggestedFilename()).toBe(`bao-cao-nut-that_${defaults.from}_${defaults.to}.csv`);
      expect(bottleneck.rows[0]).toEqual(['Quy trình', 'Bước', 'Số việc xong', 'Xử lý trung bình (ngày làm việc)', 'Tỷ lệ quá hạn (%)']);
      expect(bottleneck.rows.length - 1).toBe(report.byTemplateStep.length);
      if (await page.getByRole('button', { name: 'Xuất CSV bảng Đi thúc' }).isEnabled()) {
        const sent = await csvOf('Đi thúc');
        expect(sent.rows[0]).toEqual(['Người nhận', 'Số lần được nhắc', 'Phản hồi trong 1 ngày làm việc', 'Tỷ lệ phản hồi (%)']);
        expect(sent.rows.length - 1).toBe(report.nudges.length);
      } else {
        expect(report.nudges).toHaveLength(0);
      }
    }).toPass({ timeout: 40_000 });
    await shot(page, 'bao-cao-1280');

    // Người chưa xếp đơn vị nào gom thành một dòng; máy chủ để trống tên, giao diện ghi "Chưa xếp đơn vị" (cả bảng lẫn CSV).
    // Dữ liệu mẫu không có người như vậy: thêm một dòng vào phản hồi ngay tại trình duyệt, chỉ để xem cách giao diện vẽ.
    await page.route('**/v1/reports/summary?*', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as ReportBody;
      body.byUnit.push({ unitId: null, unitName: '', open: 2, overdue: 1, completed: 0, onTimeRate: null });
      await route.fulfill({ status: response.status(), headers: { 'content-type': 'application/json' }, json: body });
    });
    await choose(page, 'Kỳ báo cáo', 'Tuỳ chọn');
    await page.getByLabel('Từ ngày').fill(vnDate(-100));
    await page.getByLabel('Đến ngày').fill(vnDate(-90));
    const noUnit = byUnit.getByRole('row').filter({ hasText: 'Chưa xếp đơn vị' });
    await expect(noUnit).toHaveCount(1);
    await expect(noUnit.getByRole('cell')).toHaveText(['Chưa xếp đơn vị', '2', '1', '0', 'Chưa có']);
    const [pending] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Xuất CSV bảng Theo đơn vị' }).click()]);
    expect((await readCsv(pending)).rows.some((r) => r[0] === 'Chưa xếp đơn vị' && r[1] === '2')).toBe(true);
    await page.unroute('**/v1/reports/summary?*');
  });

  test('báo cáo của Chủ tịch cùng số liệu với Văn phòng; cả hai chỉ-đọc', async ({ browser }) => {
    const office = await sessionOf(browser, 'vanphong');
    const chairman = await sessionOf(browser, 'chutich');
    const range = { from: vnDate(-29), to: vnDate() };
    await expect(async () => {
      const a = (await api<ReportBody>(office, 'GET', reportPath(range))).body;
      const b = (await api<ReportBody>(chairman, 'GET', reportPath(range))).body;
      // Cùng tầm nhìn điều phối nên cùng số (trừ thời điểm lấy số).
      expect({ ...b, asOf: '' }).toEqual({ ...a, asOf: '' });
    }).toPass({ timeout: 20_000 });
    await chairman.page.goto('/bao-cao');
    await expect(chairman.page.getByRole('heading', { level: 1, name: 'Báo cáo' })).toBeVisible();
    const tiles = await (async () => {
      await expect(chairman.page.getByRole('group', { name: 'Các chỉ số của kỳ' })).toContainText('Số việc xong');
      return tilesOf(chairman.page);
    })();
    expect(Object.keys(tiles)).toHaveLength(5);
  });
});

// ───────────────────────── Quyền ─────────────────────────

test.describe('Quyền', () => {
  const NAV: Record<UserKey, string[]> = {
    // Quản trị hệ thống vào Sổ văn bản để cấu hình sổ (quyền org.settings), không xem nội dung văn bản.
    it: ['Việc của tôi', 'Sổ văn bản', 'Người dùng và tổ chức', 'Thông báo và nhật ký', 'Cài đặt tổ chức'],
    vanphong: ['Tổng quan', 'Việc của tôi', 'Lượt chạy', 'Công việc', 'Quy trình', 'Sổ văn bản', 'Báo cáo', 'Người dùng và tổ chức', 'Thông báo và nhật ký'],
    // Chủ tịch toàn quyền (docs/DECISIONS.md, 04/10/2026): thấy mọi mục.
    chutich: ['Tổng quan', 'Việc của tôi', 'Lượt chạy', 'Công việc', 'Quy trình', 'Sổ văn bản', 'Báo cáo', 'Người dùng và tổ chức', 'Thông báo và nhật ký', 'Cài đặt tổ chức'],
    lan: ['Việc của tôi'],
  };
  /** Mục không được vào: mở thẳng đường dẫn thì bị chuyển về "Việc của tôi" kèm thông báo. */
  const FORBIDDEN: Record<UserKey, string[]> = {
    it: ['/bao-cao', '/to-chuc/ngay-nghi', '/luot-chay', '/cong-viec', '/quy-trinh'],
    vanphong: ['/to-chuc/nguoi-dung', '/to-chuc/don-vi', '/to-chuc/uy-quyen', '/nhat-ky/hoat-dong', '/nhat-ky/tac-vu-loi', '/nhat-ky/tro-ly', '/cai-dat'],
    chutich: [],
    lan: ['/to-chuc', '/nhat-ky', '/cai-dat', '/bao-cao', '/luot-chay', '/quy-trinh'],
  };

  for (const key of ['it', 'vanphong', 'chutich', 'lan'] as const) {
    test(`${key}: thanh bên chỉ có mục được dùng; mở thẳng mục không có quyền thì bị chuyển về và được báo`, async ({ browser }) => {
      const { page } = await sessionOf(browser, key);
      await page.goto('/viec-cua-toi');
      const nav = page.getByRole('navigation', { name: 'Điều hướng chính' });
      await expect(nav.getByRole('link')).toHaveText(NAV[key]);
      for (const path of FORBIDDEN[key]) {
        await page.goto(path);
        await expect(page, path).toHaveURL(/\/viec-cua-toi/);
        await expect(toast(page, 'Tài khoản này chưa có quyền xem mục đó.'), path).toBeVisible();
      }
      if (key === 'it' || key === 'lan') {
        // Trang đầu (Tổng quan) chỉ dành cho người điều phối; người khác được chuyển thẳng tới "Việc của tôi", không kèm thông báo.
        await page.goto('/');
        await expect(page).toHaveURL(/\/viec-cua-toi/);
      }
      if (key === 'chutich') {
        // Chủ tịch mở được cả các mục quản trị, không bị chuyển về, kể cả mục chỉ it_admin và Văn phòng từng có.
        for (const path of ['/to-chuc/nguoi-dung', '/to-chuc/ngay-nghi', '/to-chuc/phan-quyen', '/nhat-ky/hoat-dong', '/nhat-ky/thong-bao', '/cai-dat', '/quy-trinh']) {
          await page.goto(path);
          await expect(page, path).toHaveURL(new RegExp(`${path}$`));
          await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
        }
      }
      if (key === 'vanphong') {
        // Văn phòng: chỉ có tab "Ngày nghỉ" ở Người dùng và tổ chức, chỉ tab "Thông báo" ở Thông báo và nhật ký.
        await page.goto('/to-chuc');
        await expect(page.getByRole('navigation', { name: 'Các mục của Người dùng và tổ chức' }).getByRole('link')).toHaveText(['Ngày nghỉ']);
        await page.goto('/nhat-ky');
        await expect(page).toHaveURL(/\/nhat-ky\/thong-bao$/);
        await expect(page.getByRole('navigation', { name: 'Các mục của Thông báo và nhật ký' }).getByRole('link')).toHaveText(['Thông báo']);
        await expect(page.getByRole('table', { name: 'Trạng thái gửi và đọc của thông báo, mới nhất ở trên' })).toBeVisible();
        await shot(page, 'nhat-ky-van-phong-1280');
      }
    });
  }

  test('máy chủ từ chối thật (không chỉ ẩn nút trên giao diện): mỗi vai chỉ gọi được route của mình', async ({ browser }) => {
    test.setTimeout(180_000);
    const [it, office, chairman, lan] = await Promise.all([sessionOf(browser, 'it'), sessionOf(browser, 'vanphong'), sessionOf(browser, 'chutich'), sessionOf(browser, 'lan')]);
    const range = `from=${vnDate(-29)}&to=${vnDate()}`;
    const settings = (await api<OrgSettings>(it, 'GET', '/v1/org/settings')).body;
    const user = { fullName: `${PREFIX} ${stamp} quyền`, givenName: 'Quyền', roles: [{ role: 'employee', unitId: null }] };
    const matrix: [Session, Method, string, unknown, number][] = [
      [lan, 'GET', '/v1/users', undefined, 403],
      [lan, 'GET', '/v1/admin/audit-log', undefined, 403],
      [lan, 'GET', '/v1/admin/notifications', undefined, 403],
      [lan, 'GET', '/v1/org/settings', undefined, 403],
      [lan, 'GET', `/v1/reports/summary?${range}`, undefined, 403],
      [lan, 'PUT', `/v1/holidays/${HOLIDAY_YEAR}-03-03`, { name: 'x', kind: 'public' }, 403],
      [lan, 'GET', `/v1/holidays?year=${HOLIDAY_YEAR}`, undefined, 200],
      // Chủ tịch toàn quyền (docs/DECISIONS.md, 04/10/2026): làm được mọi việc, trừ "Trình" (kênh của Văn phòng).
      [chairman, 'GET', '/v1/users', undefined, 200],
      [chairman, 'GET', '/v1/admin/notifications', undefined, 200],
      [chairman, 'GET', '/v1/admin/audit-log', undefined, 200],
      [chairman, 'GET', '/v1/admin/effects', undefined, 200],
      [chairman, 'GET', '/v1/admin/ai-usage', undefined, 200],
      [chairman, 'GET', '/v1/org/settings', undefined, 200],
      [chairman, 'PATCH', '/v1/org/settings', { officePhone: settings.officePhone }, 200],
      [chairman, 'GET', `/v1/reports/summary?${range}`, undefined, 200],
      [chairman, 'GET', `/v1/holidays/suggestions?year=${HOLIDAY_YEAR}`, undefined, 200],
      [chairman, 'POST', '/v1/proposals', {}, 403],
      [office, 'GET', '/v1/users', undefined, 403],
      [office, 'POST', '/v1/users', user, 403],
      [office, 'GET', '/v1/admin/audit-log', undefined, 403],
      [office, 'GET', '/v1/admin/effects', undefined, 403],
      [office, 'POST', `/v1/admin/effects/${crypto.randomUUID()}/retry`, undefined, 403],
      [office, 'GET', '/v1/admin/ai-usage', undefined, 403],
      [office, 'PATCH', '/v1/org/settings', { officePhone: settings.officePhone }, 403],
      [office, 'POST', '/v1/units', { name: `${PREFIX} ${stamp} quyền` }, 403],
      [office, 'GET', '/v1/org/settings', undefined, 200],
      [office, 'GET', '/v1/admin/notifications', undefined, 200],
      [office, 'GET', `/v1/holidays/suggestions?year=${HOLIDAY_YEAR}`, undefined, 200],
      [office, 'GET', `/v1/reports/summary?${range}`, undefined, 200],
      [it, 'GET', `/v1/reports/summary?${range}`, undefined, 403],
      [it, 'GET', `/v1/holidays/suggestions?year=${HOLIDAY_YEAR}`, undefined, 403],
      [it, 'PUT', `/v1/holidays/${HOLIDAY_YEAR}-03-03`, { name: 'x', kind: 'public' }, 403],
      [it, 'GET', '/v1/admin/ai-usage', undefined, 200],
      [it, 'GET', '/v1/admin/effects', undefined, 200],
      [it, 'GET', '/v1/admin/notifications', undefined, 200],
    ];
    for (const [session, method, path, body, expected] of matrix) {
      const res = await api<{ code?: string }>(session, method, path, body);
      expect(res.status, `${session.key} ${method} ${path}`).toBe(expected);
      if (expected === 403) expect(res.body.code, `${session.key} ${method} ${path}`).toBe('forbidden');
    }
    // Không có người lạ nào lọt qua: vẫn chưa có người "quyền" nào được tạo.
    expect(await usersOf(it, `${stamp} quyền`)).toHaveLength(0);
  });
});

// ───────────────────────── Ảnh các màn ở 1280 và 1440 ─────────────────────────

test.describe('Ảnh các màn', () => {
  const SCREENS: Record<'it' | 'vanphong' | 'chutich', [string, string][]> = {
    it: [
      ['/to-chuc/nguoi-dung', 'nguoi-dung'],
      ['/to-chuc/don-vi', 'don-vi'],
      ['/to-chuc/uy-quyen', 'uy-quyen-trong'],
      ['/nhat-ky/hoat-dong', 'nhat-ky-hoat-dong'],
      ['/nhat-ky/thong-bao', 'nhat-ky-thong-bao'],
      ['/nhat-ky/tac-vu-loi', 'nhat-ky-tac-vu-loi-trong'],
      ['/nhat-ky/tro-ly', 'nhat-ky-tro-ly'],
      ['/cai-dat', 'cai-dat'],
    ],
    vanphong: [
      ['/bao-cao', 'bao-cao'],
      ['/to-chuc/ngay-nghi', 'ngay-nghi-nam-nay'],
      ['/nhat-ky', 'nhat-ky-van-phong'],
    ],
    chutich: [
      ['/bao-cao', 'bao-cao-chu-tich'],
      ['/to-chuc/nguoi-dung', 'nguoi-dung-chu-tich'],
      ['/cai-dat', 'cai-dat-chu-tich'],
    ],
  };

  for (const key of ['it', 'vanphong', 'chutich'] as const) {
    test(`${key}: từng màn ở 1280 và 1440: không tràn ngang, chữ không bị cắt, mọi ô và nút có tên`, async ({ browser }) => {
      test.setTimeout(300_000);
      const session = await sessionOf(browser, key);
      const problems: string[] = [];
      for (const viewport of [DESKTOP, WIDE]) {
        await atViewport(browser, session, viewport, async (page) => {
          for (const [path, name] of SCREENS[key]) {
            await page.goto(path);
            await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
            await shot(page, `${name}-${viewport.width}`);
            problems.push(...(await fitIssues(page, `${path} ở ${viewport.width}`)), ...(await labelIssues(page, `${path} ở ${viewport.width}`)));
          }
        });
      }
      expect(problems).toEqual([]);
    });
  }

  test('hộp thoại và bảng trượt ở 1280 và 1440: không tràn, chữ không bị cắt, mọi ô và nút có tên', async ({ browser }) => {
    test.setTimeout(300_000);
    const session = await sessionOf(browser, 'it');
    const problems: string[] = [];
    for (const viewport of [DESKTOP, WIDE]) {
      await atViewport(browser, session, viewport, async (page) => {
        const w = viewport.width;
        await page.goto('/to-chuc/nguoi-dung');
        await page.getByRole('button', { name: 'Thêm người dùng' }).click();
        await expect(page.getByRole('dialog', { name: 'Thêm người dùng' })).toBeVisible();
        await shot(page, `hop-thoai-them-nguoi-dung-${w}`, false);
        problems.push(...(await fitIssues(page, `thêm người dùng ở ${w}`)), ...(await labelIssues(page, `thêm người dùng ở ${w}`)));
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Nhập CSV' }).click();
        const csv = page.getByRole('dialog', { name: 'Nhập người dùng từ tệp CSV' });
        await csv.getByLabel('Nội dung CSV').fill(`${CSV_HEADER}\n,Lỗi,xyz,email-sai,,Không có,,Giám đốc kho,lớn`);
        await csv.getByRole('button', { name: 'Chạy thử' }).click();
        await expect(csv.getByRole('table', { name: 'Các dòng còn lỗi' })).toBeVisible();
        await shot(page, `hop-thoai-nhap-csv-${w}`, false);
        problems.push(...(await fitIssues(page, `nhập CSV ở ${w}`)), ...(await labelIssues(page, `nhập CSV ở ${w}`)));
        await page.keyboard.press('Escape');
        await page.goto('/to-chuc/don-vi');
        await page.getByRole('button', { name: 'Thêm đơn vị', exact: true }).click();
        await shot(page, `hop-thoai-them-don-vi-${w}`, false);
        problems.push(...(await fitIssues(page, `thêm đơn vị ở ${w}`)), ...(await labelIssues(page, `thêm đơn vị ở ${w}`)));
        await page.keyboard.press('Escape');
        await page.goto('/to-chuc/uy-quyen');
        await page.getByRole('button', { name: 'Thêm ủy quyền' }).first().click();
        await shot(page, `hop-thoai-them-uy-quyen-${w}`, false);
        problems.push(...(await fitIssues(page, `thêm ủy quyền ở ${w}`)), ...(await labelIssues(page, `thêm ủy quyền ở ${w}`)));
      });
    }
    expect(problems).toEqual([]);
  });
});

// ───────────────────────── Dọn dẹp và kiểm lỗi JavaScript ─────────────────────────

test.afterAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  try {
    const it = await sessionOf(browser, 'it');
    // Người thử: vô hiệu hoá những ai còn dùng được (không bao giờ đụng tới người mẫu).
    for (const user of await usersOf(it, stamp)) {
      if (user.status !== 'disabled' && user.fullName.startsWith(PREFIX) && user.email !== IT_EMAIL) await api(it, 'POST', `/v1/users/${user.id}/disable`);
    }
    for (const user of await usersOf(it, `${stamp} quyền`)) if (user.status !== 'disabled') await api(it, 'POST', `/v1/users/${user.id}/disable`);
    // Ủy quyền thử.
    const delegations = (await api<{ items: DelegationView[] }>(it, 'GET', '/v1/delegations')).body.items;
    for (const d of delegations) if (d.fromUser.fullName.startsWith(PREFIX) || d.toUser.fullName.startsWith(PREFIX)) await api(it, 'DELETE', `/v1/delegations/${d.id}`);
    // Dòng CSDL chèn trực tiếp.
    psql(`delete from effects where dedupe_key like 'kiem-thu-to-chuc-${stamp}-%'`);
    psql(`delete from notifications where title like 'Kiểm thử ${stamp} trạng thái %'`);
    const users = psql("select id from users where email in ('chutich@demo.mihato.local','giamdoc@demo.mihato.local')").split('\n').filter(Boolean);
    psql(`delete from ai_usage where user_id in (${users.map((u) => `'${u}'`).join(',')}) and day in ('${vnDate(-2)}','${vnDate(-3)}') and llm_input_tokens in (52000, 20000, 9000)`);
    psql("delete from ai_usage where user_id = (select id from users where email = 'hung@demo.mihato.local') and llm_input_tokens = 400000");
    // Cấu hình tổ chức: mỗi test tự trả lại các khoá nó đổi (khối finally ở nhóm "Cài đặt tổ chức"). Không trả lại cả bản chụp đầu
    // lần chạy ở đây: người khác dùng chung cấu hình này có thể đang đổi giá trị khác để thử, trả lại sẽ phá việc của họ.
    // Ngày nghỉ thử.
    const office = await sessionOf(browser, 'vanphong');
    const held = await api<{ items: Holiday[] }>(office, 'GET', `/v1/holidays?year=${HOLIDAY_YEAR}`);
    for (const h of held.body.items) await api(office, 'DELETE', `/v1/holidays/${h.day}`);
  } catch (error) {
    problems.push(`dọn dẹp lỗi: ${String(error)}`);
  }
  for (const session of await Promise.all([...sessions.values()])) {
    if (session.jsErrors.length > 0) problems.push(`${session.key}: lỗi JavaScript chưa bắt: ${session.jsErrors.slice(0, 3).join(' | ')}`);
    await session.context.close();
  }
  expect(problems, 'dọn dẹp và lỗi JavaScript').toEqual([]);
});

