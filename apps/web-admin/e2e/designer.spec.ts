/**
 * Màn Quy trình và trình thiết kế quy trình (SPEC 9.3, 9.8), chạy trên API thật với dữ liệu mẫu (SPEC 15.4).
 *
 * Chuẩn bị: API ở cổng 3100 (pnpm db:seed rồi pnpm --filter @mihato/api dev) và web quản trị đang chạy.
 * Chạy (từ apps/web-admin):
 *   WEB_URL=http://localhost:5273 npx playwright test e2e/designer.spec.ts
 * Biến môi trường: WEB_URL (mặc định theo playwright.config.ts), DEMO_PASSWORD, SHOTS_DIR (nơi lưu ảnh chụp, mỗi cảnh chụp ở 1280 và 1440).
 *
 * Mọi bước kiểm đều chạm giao diện thật. API chỉ dùng để dựng dữ liệu thử (nháp cố ý sai, bản nhân bản), đọc lại điều
 * giao diện đã lưu để đối chiếu, và dọn dẹp. Đăng nhập một lần cho mỗi vai bằng biểu mẫu thật (giới hạn 10 lần đăng nhập
 * mỗi phút cho mỗi địa chỉ IP); các thẻ sau dùng lại phiên. API giới hạn 120 yêu cầu mỗi phút mỗi phiên nên kịch bản tự chờ
 * khi sắp chạm giới hạn.
 *
 * Mọi mẫu do kịch bản tạo đều mang tên bắt đầu bằng "Kiểm thử thiết kế" và được lưu trữ ở cuối (afterAll, kể cả khi có test đỏ).
 * Mẫu "Đón đoàn nhà đầu tư thăm KCN" của dữ liệu mẫu chỉ được đọc (và nhân bản ra một mẫu riêng của kịch bản), không bị sửa.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'mihato-demo-2026';
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/designer-shots';
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;
const DESKTOP = SIZES[0];
const WIDE = SIZES[1];
const PREFIX = 'Kiểm thử thiết kế';
const SEED_NAME = 'Đón đoàn nhà đầu tư thăm KCN';

test.describe.configure({ mode: 'serial' });

const stamp = new Date().toISOString().slice(5, 19).replace(/[-:T]/g, '');
const named = (what: string): string => `${PREFIX} - ${what} ${stamp}`;
const TEMPLATE_NAME = named('Đón đoàn vẽ lại');
const created: string[] = [];
let mainTemplateId = '';

type User = 'thietke' | 'vanphong';
type Viewport = { width: number; height: number };

// ───────────────────────── Phiên đăng nhập và giới hạn tần suất ─────────────────────────

/** Thời điểm các yêu cầu /v1 của kịch bản trong 60 giây gần nhất (API giới hạn 120 yêu cầu mỗi phút mỗi phiên). */
const sent: number[] = [];
let peak = 0;

function track(page: Page): void {
  page.on('request', (r) => {
    if (!r.url().includes('/v1/') || r.url().includes('/v1/stream')) return;
    const now = Date.now();
    sent.push(now);
    while (sent.length > 0 && now - (sent[0] ?? now) > 60_000) sent.shift();
    peak = Math.max(peak, sent.length);
  });
}

/** Trước khi mở thẻ mới: chờ cho tới khi còn dư địa dưới giới hạn tần suất. */
async function waitForRoom(max = 70): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (sent.length > 0 && now - (sent[0] ?? now) > 60_000) sent.shift();
    if (sent.length < max) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
const sessions = new Map<User, Session>();

/** Đăng nhập bằng biểu mẫu thật. Gõ lại cho tới khi vào được, vì máy chủ dev có thể nạp lại trang ngay sau lần tải đầu. */
async function signIn(page: Page, user: User): Promise<void> {
  await page.goto('/dang-nhap');
  await expect(async () => {
    await page.getByLabel('Email').fill(`${user}@demo.mihato.local`);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(PASSWORD);
    await expect(page.getByLabel('Email')).toHaveValue(`${user}@demo.mihato.local`, { timeout: 1_000 });
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/dang-nhap'), { waitUntil: 'commit', timeout: 8_000 });
  }).toPass({ timeout: 45_000 });
}

/** Mở một thẻ đã đăng nhập. Lần đầu của mỗi vai đăng nhập bằng biểu mẫu; các lần sau dùng lại phiên đã lưu. */
async function login(browser: Browser, user: User, viewport: Viewport = DESKTOP): Promise<{ context: BrowserContext; page: Page }> {
  await waitForRoom();
  const saved = sessions.get(user);
  const context = await browser.newContext({ viewport, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', deviceScaleFactor: 2, ...(saved ? { storageState: saved } : {}) });
  context.on('page', track);
  const page = await context.newPage();
  if (saved) {
    await page.goto('/quy-trinh');
    if (!new URL(page.url()).pathname.startsWith('/dang-nhap')) return { context, page };
  }
  await signIn(page, user);
  sessions.set(user, await context.storageState());
  return { context, page };
}

// ───────────────────────── Ảnh chụp ─────────────────────────

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  // Đóng các thông báo nổi để chúng không che bảng thuộc tính trong ảnh.
  for (const close of await page.getByRole('button', { name: 'Đóng thông báo này' }).all()) await close.click({ timeout: 1_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Chụp một cảnh ở cả hai cỡ màn hình (1280 và 1440). `fit`: đưa cả sơ đồ vào khung vẽ trước khi chụp (không dùng khi đang có hộp thoại). */
async function shotBoth(page: Page, name: string, fit = true): Promise<void> {
  const before = page.viewportSize() ?? DESKTOP;
  for (const size of SIZES) {
    await page.setViewportSize(size);
    if (fit) await page.getByTestId('fit-view').click();
    await shot(page, `${name}-${size.width}`);
  }
  await page.setViewportSize(before);
}

// ───────────────────────── API (dựng dữ liệu thử, đối chiếu, dọn dẹp) ─────────────────────────

type ApiResult<T> = { status: number; json: T };

/** Một lần gọi API bằng phiên của trang (cookie + CSRF). Lỗi mạng trả status 0. */
async function apiOnce<T>(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
  return page.evaluate(
    async (req) => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('mihato_csrf='))
        ?.slice('mihato_csrf='.length);
      try {
        const res = await fetch(req.path, {
          method: req.method,
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(req.method !== 'GET' && csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}),
            ...(req.method !== 'GET' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
            ...req.headers,
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        });
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          // thân rỗng
        }
        return { status: res.status, json };
      } catch {
        return { status: 0, json: null };
      }
    },
    { method, path, body, headers },
  ) as Promise<ApiResult<T>>;
}

/**
 * Gọi API (dựng dữ liệu thử, đối chiếu, dọn dẹp). API tự khởi động lại mỗi khi mã nguồn đổi nên có lúc trả 502 hoặc không nối được,
 * và có lúc chạm giới hạn tần suất: những lỗi tạm đó được thử lại; yêu cầu chưa tới được API nên thử lại không tạo trùng.
 */
async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await apiOnce<T>(page, method, path, body, headers);
    const transient = res.status === 0 || res.status === 429 || (res.status >= 502 && res.status <= 504);
    if (!transient || attempt >= 6) return res;
    await page.waitForTimeout(res.status === 429 ? 8_000 : 2_000);
  }
}

type Rule = { kind: string; userId?: string };
type DefNode = {
  id: string;
  type: string;
  label: string;
  title?: string;
  assignee?: Rule;
  approvers?: Rule[];
  mode?: string;
  due?: { anchor: string; offset: { value: number; unit: string }; atTime?: string };
  form?: { key: string; label: string; type: string; required?: boolean }[];
  branches?: { id: string; label?: string; when: unknown }[];
  join?: string;
};
type DefEdge = { id: string; from: string; to: string; outcome?: string; branch?: string };
type Def = { schemaVersion: 1; name: string; inputs: { key: string; label: string; type: string; required?: boolean }[]; targetField?: string; layout?: Record<string, { x: number; y: number }>; nodes: DefNode[]; edges: DefEdge[] };
type Detail = { id: string; name: string; latestPublishedVersion: number | null; hasDraft: boolean; archivedAt: string | null; draft: { version: number; rev: number; definition: Def } | null; versions: { version: number; status: string }[] };
type Summary = { id: string; name: string; archivedAt: string | null };

/** Tạo một mẫu bằng API với bản nháp cho trước (dữ liệu thử, dùng cho các nháp cố ý sai). */
async function createTemplate(page: Page, name: string, definition?: Omit<Def, 'schemaVersion' | 'name'>): Promise<Detail> {
  const res = await api<Detail>(page, 'POST', '/v1/templates', { name, description: null, ...(definition ? { definition: { schemaVersion: 1, name, ...definition } } : {}) });
  expect(res.status, `tạo mẫu ${name}`).toBe(201);
  created.push(res.json.id);
  return res.json;
}

/** Nhân bản một mẫu có sẵn thành mẫu riêng của kịch bản (không đụng tới mẫu gốc). */
async function cloneTemplate(page: Page, name: string, fromId: string): Promise<Detail> {
  const res = await api<Detail>(page, 'POST', '/v1/templates', { name, description: null, cloneFromTemplateId: fromId });
  expect(res.status, `nhân bản mẫu ${name}`).toBe(201);
  created.push(res.json.id);
  return res.json;
}

const detailOf = async (page: Page, id: string): Promise<Detail> => (await api<Detail>(page, 'GET', `/v1/templates/${id}`)).json;

// ───────────────────────── Thao tác trên giao diện ─────────────────────────

async function openDesigner(page: Page, templateId: string): Promise<void> {
  await page.goto(`/quy-trinh/${templateId}`);
  await page.getByTestId('designer').waitFor();
  await page.locator('.react-flow__node').first().waitFor();
}

const node = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);
const selectedNodeId = async (page: Page): Promise<string> => (await page.locator('.react-flow__node.selected').getAttribute('data-id')) ?? '';
const status = (page: Page): Locator => page.getByTestId('save-status');

/** Chọn một dòng của hộp chọn (Radix Select): bấm ô, rồi bấm lựa chọn. */
async function choose(trigger: Locator, option: string): Promise<void> {
  await trigger.click();
  await trigger.page().getByRole('option', { name: option, exact: true }).click();
}

async function pickPerson(picker: Locator, query: string, fullName: RegExp): Promise<void> {
  await picker.click();
  await picker.fill(query);
  await picker.page().getByRole('option', { name: fullName }).click();
}

/** Kéo từ một cổng ra tới một cổng vào bằng chuột thật. */
async function dragConnect(page: Page, source: Locator, target: Locator): Promise<void> {
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error('không thấy cổng nối');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 30, a.y + a.height / 2 + 10, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function waitSaved(page: Page): Promise<void> {
  await expect(status(page)).toHaveAttribute('data-dirty', 'false', { timeout: 15_000 });
  await expect(status(page)).toContainText('Đã lưu lúc');
}

/** Đưa cả sơ đồ vào khung vẽ để các nút và dấu cộng luôn bấm được. */
async function fitAll(page: Page): Promise<void> {
  await page.getByTestId('fit-view').click();
  await page.waitForTimeout(350);
}

/** Bỏ chọn bước đang mở để bảng bên phải hiện thuộc tính của cả quy trình. */
async function deselect(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Bỏ chọn, về thuộc tính quy trình' });
  if ((await close.count()) > 0) await close.click();
  else await page.locator('.react-flow__pane').click({ position: { x: 40, y: 400 } });
  await expect(page.getByTestId('process-name')).toBeVisible();
}

/** Bấm vào góc trên trái của thẻ để chọn nút (không chạm vào ô nhập hay dấu cộng) và đưa focus bàn phím về khung vẽ. */
async function selectNode(page: Page, id: string): Promise<void> {
  await fitAll(page);
  await node(page, id).locator('[data-kind]').click({ position: { x: 8, y: 8 } });
}

/** Gom lỗi trên bảng điều khiển của trình duyệt (bỏ dòng "Failed to load resource" do mã trạng thái 4xx cố ý). */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
  return errors;
}

/** Ngày hôm nay (giờ Việt Nam) cộng `offset` ngày, dạng yyyy-mm-dd. */
const vnDay = (offset: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(Date.now() + offset * 86_400_000));

// ───────────────────────── Trợ năng ─────────────────────────

type AxNode = { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number };
const NAMED_ROLES = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'searchbox', 'menuitem', 'tab']);

/** Điều khiển đang hiện mà không có tên cho trình đọc màn hình. Đọc từ cây trợ năng thật của Chromium. */
async function unnamedControls(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    const tree = (await cdp.send('Accessibility.getFullAXTree')) as unknown as { nodes: AxNode[] };
    const bad: string[] = [];
    for (const n of tree.nodes) {
      const role = n.role?.value ?? '';
      if (n.ignored || !NAMED_ROLES.has(role) || (n.name?.value ?? '').trim() !== '') continue;
      let where = role;
      if (n.backendDOMNodeId !== undefined) {
        const described = (await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId }).catch(() => null)) as { node?: { nodeName?: string; attributes?: string[] } } | null;
        if (described?.node) where = `${role} <${described.node.nodeName?.toLowerCase()} ${(described.node.attributes ?? []).join(' ').slice(0, 120)}>`;
      }
      bad.push(where);
    }
    return bad;
  } finally {
    await cdp.detach();
  }
}

type Stop = { id: string; name: string; ring: boolean; inert: boolean; visible: boolean };

/** Phần tử đang có focus: có viền focus rõ không, có nằm trong vùng bị khoá (inert) không, có nhìn thấy không. */
async function activeStop(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement || el instanceof SVGElement) || el === document.body) return null;
    // Bước: viền vẽ quanh thẻ bên trong. Đường nối: nét vẽ dày lên và đổi sang màu chính (không dùng viền của phần tử SVG).
    const target = el.matches('.react-flow__node') ? (el.querySelector('[data-kind]') ?? el) : el;
    const cs = getComputedStyle(target);
    const path = el.matches('.react-flow__edge') ? el.querySelector('.react-flow__edge-path') : null;
    const outline = path ? parseFloat(getComputedStyle(path).strokeWidth) >= 3 : cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    const shadow = !path && cs.boxShadow !== 'none' && cs.boxShadow !== '';
    const rect = el.getBoundingClientRect();
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return {
      id: el.getAttribute('data-testid') ?? el.getAttribute('data-id') ?? el.tagName.toLowerCase(),
      name: el.getAttribute('aria-label') ?? (text || el.getAttribute('title') || ''),
      ring: outline || shadow,
      inert: !!el.closest('[inert]'),
      // Đường nối thẳng nằm ngang có khung bao cao 0 nhưng vẫn nhìn thấy: chỉ cần một chiều lớn hơn 0.
      visible: (rect.width > 0 || rect.height > 0) && rect.bottom >= 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    };
  });
}

type Low = { text: string; ratio: number; need: number; fg: string; bg: string };

/** Chữ trong `selector` có độ tương phản dưới mức AA (4,5:1; chữ lớn 3:1). Bỏ qua điều khiển đã khoá (không tương tác) và chữ chỉ dành cho trình đọc màn hình. */
async function lowContrast(page: Page, selector: string): Promise<Low[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [{ text: `không thấy ${sel}`, ratio: 0, need: 0, fg: '', bg: '' }];
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    // Đổi mọi kiểu màu CSS (hex, rgb, oklch…) về sRGB bằng cách vẽ một điểm ảnh.
    const rgba = (css: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
    };
    const over = (top: number[], bottom: number[]): number[] => {
      const a = top[3] ?? 1;
      return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (bottom[i] ?? 0) * (1 - a)).concat([1]);
    };
    const lum = (c: number[]): number => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0);
    };
    const backgroundOf = (el: Element): number[] => {
      const layers: number[][] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgba(getComputedStyle(n).backgroundColor);
        if ((c[3] ?? 0) > 0) {
          layers.push(c);
          if ((c[3] ?? 0) >= 1) break;
        }
      }
      let base = [255, 255, 255, 1];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const seen: Low[] = [];
    const all: Element[] = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim() !== '') || ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value !== '');
      if (!hasText) continue;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || rect.width <= 1 || rect.height <= 1) continue;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
      if (el.closest('[disabled], [aria-disabled="true"], [aria-hidden="true"], [inert]')) continue;
      let faded = false;
      for (let n: Element | null = el; n; n = n.parentElement) if (parseFloat(getComputedStyle(n).opacity) < 1) faded = true;
      if (faded) continue;
      const bg = backgroundOf(el);
      const fgRaw = rgba(cs.color);
      const fg = over(fgRaw, bg);
      const l1 = lum(fg);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const px = parseFloat(cs.fontSize);
      const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) seen.push({ text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50), ratio: Math.round(ratio * 100) / 100, need, fg: `${fg.slice(0, 3).map(Math.round)}`, bg: `${bg.slice(0, 3).map(Math.round)}` });
    }
    return seen.slice(0, 20);
  }, selector);
}

// ───────────────────────── Đếm thao tác ─────────────────────────

/**
 * Đếm thao tác như người dùng thật phải làm khi vẽ lại "Đón đoàn": mỗi lần bấm, mỗi ô gõ (kèm số ký tự), mỗi phím riêng, mỗi lần kéo.
 * Thời gian ước lượng theo mô hình bàn phím–chuột (Card, Moran, Newell): nghĩ 1,35 giây trước mỗi thao tác, rê chuột 1,1 giây,
 * bấm 0,2 giây, đưa tay về bàn phím 0,4 giây, mỗi ký tự 0,28 giây (người gõ trung bình).
 */
class Meter {
  clicks = 0;
  fields = 0;
  chars = 0;
  keys = 0;
  drags = 0;
  get operations(): number {
    return this.clicks + this.fields + this.keys + this.drags;
  }
  plus(other: Meter): Meter {
    const sum = new Meter();
    sum.clicks = this.clicks + other.clicks;
    sum.fields = this.fields + other.fields;
    sum.chars = this.chars + other.chars;
    sum.keys = this.keys + other.keys;
    sum.drags = this.drags + other.drags;
    return sum;
  }
  get seconds(): number {
    const think = 1.35;
    const point = 1.1;
    const press = 0.2;
    const home = 0.4;
    const key = 0.28;
    return this.clicks * (think + point + press) + this.fields * (think + point + press + home) + this.chars * key + this.keys * (think + key) + this.drags * (think + point + press + point + press);
  }
}

test.afterAll(async ({ browser }) => {
  const { context, page } = await login(browser, 'thietke');
  // Lưu trữ mọi mẫu đã ghi nhận, và quét thêm mọi mẫu mang tên "Kiểm thử thiết kế…" còn sót (kể cả của lần chạy trước bị ngắt).
  const listed = await api<{ items: Summary[] }>(page, 'GET', '/v1/templates');
  const leftovers = listed.json.items.filter((x) => x.name.startsWith(PREFIX) && x.archivedAt === null).map((x) => x.id);
  for (const id of new Set([...created, ...leftovers])) await api(page, 'POST', `/v1/templates/${id}/archive`, { archived: true });
  const after = await api<{ items: Summary[] }>(page, 'GET', '/v1/templates');
  expect(
    after.json.items.filter((x) => x.name.startsWith(PREFIX) && x.archivedAt === null).map((x) => x.name),
    'mẫu của kịch bản chưa được lưu trữ',
  ).toEqual([]);
  console.log(`[tần suất] đỉnh ${peak} yêu cầu /v1 trong 60 giây (giới hạn 120 mỗi phiên); đã lưu trữ ${new Set(created).size} mẫu thử`);
  await context.close();
});

// ───────────────────────── SPEC 9.8 điều 1: vẽ lại "Đón đoàn" ─────────────────────────

test('người vẽ quy trình vẽ lại "Đón đoàn" đủ sáu việc, chạy thử và xuất bản', async ({ browser }) => {
  const { context, page } = await login(browser, 'thietke');
  const consoleErrors = watchConsole(page);

  // `meter`: đường ngắn nhất. `optional`: việc không bắt buộc, ở đây là đặt "tên ngắn trên sơ đồ" cho khớp mẫu (bỏ trống thì sơ đồ dùng tên việc).
  const meter = new Meter();
  const optional = new Meter();
  const ui = {
    click: async (target: Locator): Promise<void> => {
      meter.clicks += 1;
      await target.click();
    },
    type: async (target: Locator, text: string, skippable = false): Promise<void> => {
      const counter = skippable ? optional : meter;
      counter.fields += 1;
      counter.chars += text.length;
      await target.fill(text);
    },
    press: async (target: Locator, key: string): Promise<void> => {
      meter.keys += 1;
      await target.press(key);
    },
    choose: async (trigger: Locator, option: string): Promise<void> => {
      meter.clicks += 2;
      await choose(trigger, option);
    },
    person: async (picker: Locator, query: string, fullName: RegExp): Promise<void> => {
      meter.fields += 1;
      meter.chars += query.length;
      meter.clicks += 1;
      await pickPerson(picker, query, fullName);
    },
    drag: async (source: Locator, target: Locator): Promise<void> => {
      meter.drags += 1;
      await dragConnect(page, source, target);
    },
  };
  const started = Date.now();

  await test.step('tạo quy trình mới', async () => {
    await page.goto('/quy-trinh');
    await ui.click(page.getByTestId('create-template'));
    // Hộp chọn: "Quy trình trống" hoặc "Từ mẫu có sẵn".
    await ui.click(page.getByTestId('create-blank'));
    await ui.type(page.getByTestId('create-dialog').getByLabel('Tên quy trình'), TEMPLATE_NAME);
    await ui.click(page.getByTestId('create-submit'));
    await page.getByTestId('designer').waitFor();
    mainTemplateId = page.url().split('/quy-trinh/')[1]?.split('?')[0] ?? '';
    expect(mainTemplateId).not.toBe('');
    created.push(mainTemplateId);
    // Quy trình mới có sẵn Bắt đầu, Hoàn tất và dòng gợi ý.
    await expect(node(page, 'start')).toBeVisible();
    await expect(node(page, 'end')).toBeVisible();
    await expect(page.getByTestId('blank-hint')).toBeVisible();
    await expect(page.getByTestId('save-draft')).toBeDisabled();
    expect(await unnamedControls(page), 'điều khiển không có tên (quy trình trống)').toEqual([]);
    await shotBoth(page, 'blank');
  });

  await test.step('biểu mẫu khởi chạy: hai ô (Tên đoàn, Ngày đoàn đến) và mốc đích', async () => {
    const label = page.getByTestId('inputs-new-label');
    await ui.type(label, 'Tên đoàn');
    await ui.press(label, 'Enter');
    await ui.type(label, 'Ngày đoàn đến');
    await ui.choose(page.getByTestId('inputs').getByRole('combobox', { name: 'Loại ô', exact: true }), 'Ngày');
    await ui.click(page.getByTestId('inputs-add'));
    await expect(page.getByTestId('inputs-row')).toHaveCount(2);
    // Ô ngày đầu tiên được chọn sẵn làm mốc đích (và thành ô bắt buộc); người vẽ không phải làm thêm gì.
    await expect(page.getByTestId('inputs').getByText('Mốc đích')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Mốc đích' })).toHaveText('Ngày đoàn đến');
  });

  /** Thêm một bước nối sau `fromId` bằng dấu cộng, trả mã của bước mới. */
  const addAfter = async (fromId: string, kind: 'task' | 'approval'): Promise<string> => {
    await ui.click(page.getByTestId(`add-next-${fromId}`));
    await ui.click(page.getByTestId(`quick-${kind}`));
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    const id = await selectedNodeId(page);
    expect(id).not.toBe(fromId);
    return id;
  };

  const fillTask = async (title: string, label: string, person: [string, RegExp], days: number): Promise<void> => {
    // Thả bước mới thì bảng thuộc tính mở sẵn, con trỏ nằm ở ô tên việc.
    await expect(page.getByTestId('node-title')).toBeFocused();
    await ui.type(page.getByTestId('node-title'), title);
    await ui.type(page.getByTestId('node-label'), label, true);
    await ui.person(page.getByRole('combobox', { name: 'Người nhận: Người' }), person[0], person[1]);
    // Mặc định hợp lý: quy trình có mốc đích thì hạn là 7 ngày làm việc trước mốc đích.
    await expect(page.getByLabel('Hạn: Số')).toHaveValue('7');
    if (days !== 7) await ui.type(page.getByLabel('Hạn: Số'), String(days));
  };

  const ids: Record<string, string> = {};

  await test.step('sáu bước: năm việc và một bước duyệt', async () => {
    ids.s1 = await addAfter('start', 'task');
    await fillTask('Lập chương trình đón đoàn', 'Chương trình đón đoàn', ['Thu Lan', /Nguyễn Thu Lan/], 7);
    await expect(node(page, ids.s1)).toContainText('7 ngày làm việc trước mốc đích');
    await expect(node(page, ids.s1)).toContainText('chị Nguyễn Thu Lan');

    ids.s4 = await addAfter('start', 'task');
    await fillTask('Lập đề nghị tạm ứng', 'Tạm ứng', ['Phương', /Đặng Mai Phương/], 7);
    await ui.click(page.getByRole('button', { name: /^Biểu mẫu kết quả/ }));
    await ui.type(page.getByTestId('result-form-new-label'), 'Số tiền đề nghị tạm ứng');
    await ui.choose(page.getByTestId('result-form').getByRole('combobox', { name: 'Loại ô', exact: true }), 'Số tiền (đồng)');
    await ui.click(page.getByTestId('result-form-add'));
    await expect(page.getByTestId('result-form-row')).toHaveCount(1);

    ids.s2 = await addAfter(ids.s1, 'task');
    await fillTask('Hồ sơ pháp lý đất và tài liệu giới thiệu', 'Hồ sơ pháp lý', ['Ngọc Anh', /Hoàng Ngọc Anh/], 5);

    ids.s3 = await addAfter(ids.s1, 'task');
    await fillTask('Kiểm tra tuyến tham quan', 'Tuyến tham quan', ['Tuấn', /Bùi Quốc Tuấn/], 6);

    ids.s6 = await addAfter(ids.s4, 'approval');
    await expect(page.getByTestId('node-title')).toBeFocused();
    await ui.type(page.getByTestId('node-title'), 'Duyệt đề nghị tạm ứng');
    await ui.type(page.getByTestId('node-label'), 'Duyệt tạm ứng', true);
    await ui.person(page.getByRole('combobox', { name: 'Người duyệt 1: Người' }), 'Huy', /Phạm Quang Huy/);
    await ui.type(page.getByLabel('Hạn duyệt: Số'), '6');

    ids.s5 = await addAfter(ids.s2, 'task');
    await fillTask('Báo giá thuê nhà xưởng cho đoàn', 'Báo giá', ['Hùng', /Võ Hoàng Hùng/], 4);
  });

  await test.step('nối ba nhánh tới Hoàn tất (dấu cộng, và một lần kéo bằng chuột)', async () => {
    await ui.click(page.getByTestId(`add-next-${ids.s5}`));
    await ui.click(page.getByTestId('quick-connect-end'));
    await ui.click(page.getByTestId(`add-next-${ids.s6}-approved`));
    await ui.click(page.getByTestId('quick-connect-end'));
    // Sắp xếp lại cho gọn rồi kéo từ cổng ra của "Tuyến tham quan" sang cổng vào của "Hoàn tất".
    await ui.click(page.getByTestId('auto-layout'));
    await ui.click(page.getByTestId('fit-view'));
    await page.waitForTimeout(600);
    await ui.drag(node(page, ids.s3).locator('.react-flow__handle.source'), node(page, 'end').locator('.react-flow__handle.target'));
    await expect(page.locator('.react-flow__edge')).toHaveCount(9);
    await expect(page.locator('[data-edge-label]')).toHaveText('Đồng ý');
  });

  await test.step('kiểm tra: không còn lỗi', async () => {
    await expect(page.getByTestId('issues-bar')).toHaveAttribute('data-errors', '0');
    await ui.click(page.getByTestId('validate'));
    await expect(page.getByText('Đã kiểm tra: không có lỗi')).toBeVisible();
    await expect(page.getByTestId('publish')).toHaveAttribute('data-blocked', 'false');
    await waitSaved(page);
    await ui.click(page.getByTestId('auto-layout'));
    await page.waitForTimeout(500);
    // Bỏ chọn để bảng bên phải hiện thuộc tính quy trình (biểu mẫu khởi chạy và mốc đích), rồi chụp cả sơ đồ.
    await deselect(page);
    await shotBoth(page, 'don-doan');
  });

  await test.step('bản nháp đã lưu khớp db/seed/templates/don-doan.json', async () => {
    await waitSaved(page);
    const detail = await detailOf(page, mainTemplateId);
    const def = detail.draft?.definition;
    expect(def).toBeTruthy();
    if (!def) return;
    const people = (await api<{ items: { id: string; fullName: string }[] }>(page, 'GET', '/v1/people?q=&limit=100')).json.items;
    const who = (rule?: Rule) => people.find((p) => p.id === rule?.userId)?.fullName ?? null;
    const byTitle = (title: string) => def.nodes.find((n) => n.title === title);

    expect(def.inputs.map((f) => [f.label, f.type, f.required])).toEqual([
      ['Tên đoàn', 'text', true],
      ['Ngày đoàn đến', 'date', true],
    ]);
    expect(def.targetField).toBe(def.inputs[1]?.key);
    expect(def.nodes).toHaveLength(8);
    expect(def.nodes.filter((n) => n.type === 'start')).toHaveLength(1);
    expect(def.nodes.filter((n) => n.type === 'end')).toHaveLength(1);
    expect(def.nodes.filter((n) => n.type === 'task')).toHaveLength(5);
    expect(def.nodes.filter((n) => n.type === 'approval')).toHaveLength(1);

    const expected: [string, string, string, number][] = [
      ['Lập chương trình đón đoàn', 'Chương trình đón đoàn', 'Nguyễn Thu Lan', -7],
      ['Lập đề nghị tạm ứng', 'Tạm ứng', 'Đặng Mai Phương', -7],
      ['Hồ sơ pháp lý đất và tài liệu giới thiệu', 'Hồ sơ pháp lý', 'Hoàng Ngọc Anh', -5],
      ['Kiểm tra tuyến tham quan', 'Tuyến tham quan', 'Bùi Quốc Tuấn', -6],
      ['Báo giá thuê nhà xưởng cho đoàn', 'Báo giá', 'Võ Hoàng Hùng', -4],
    ];
    for (const [title, label, person, days] of expected) {
      const n = byTitle(title);
      expect(n, title).toBeTruthy();
      expect(n?.type).toBe('task');
      expect(n?.label).toBe(label);
      expect(n?.assignee?.kind).toBe('user');
      expect(who(n?.assignee)).toBe(person);
      expect(n?.due).toEqual({ anchor: 'run_target', offset: { value: days, unit: 'working_day' } });
    }
    const approval = byTitle('Duyệt đề nghị tạm ứng');
    expect(approval?.type).toBe('approval');
    expect(approval?.label).toBe('Duyệt tạm ứng');
    expect(approval?.mode).toBe('any');
    expect(approval?.approvers?.map(who)).toEqual(['Phạm Quang Huy']);
    expect(approval?.due).toEqual({ anchor: 'run_target', offset: { value: -6, unit: 'working_day' } });
    expect(byTitle('Lập đề nghị tạm ứng')?.form?.map((f) => [f.label, f.type, f.required])).toEqual([['Số tiền đề nghị tạm ứng', 'money', true]]);

    const name = (id: string) => def.nodes.find((n) => n.id === id)?.label ?? id;
    const edges = def.edges.map((e) => `${name(e.from)} → ${name(e.to)}${e.outcome ? ` [${e.outcome}]` : ''}`).sort();
    expect(edges).toEqual(
      [
        'Bắt đầu → Chương trình đón đoàn',
        'Bắt đầu → Tạm ứng',
        'Chương trình đón đoàn → Hồ sơ pháp lý',
        'Chương trình đón đoàn → Tuyến tham quan',
        'Tạm ứng → Duyệt tạm ứng',
        'Hồ sơ pháp lý → Báo giá',
        'Tuyến tham quan → Hoàn tất',
        'Báo giá → Hoàn tất',
        'Duyệt tạm ứng → Hoàn tất [approved]',
      ].sort(),
    );
    // Toạ độ mọi nút nằm ở definition.layout.
    expect(Object.keys(def.layout ?? {}).sort()).toEqual(def.nodes.map((n) => n.id).sort());
  });

  await test.step('chạy thử với ngày 17/12/2026: sáu hạn đúng như SPEC 4.5 (mốc đích chọn xa hôm nay để không hạn nào đã qua; đổi sang ngày xa hơn khi tới gần 08/12/2026)', async () => {
    await ui.click(page.getByTestId('simulate'));
    const dialog = page.getByTestId('simulate-dialog');
    await ui.type(dialog.locator('[data-input-type="text"]'), 'Samsung');
    await ui.type(dialog.locator('[data-input-type="date"]'), '2026-12-17');
    await ui.click(page.getByTestId('simulate-run'));
    const result = page.getByTestId('simulate-result');
    await expect(result).toBeVisible();
    await expect(result.locator('tbody tr')).toHaveCount(6);
    const due: Record<string, string> = {
      'Lập chương trình đón đoàn': 'Thứ Ba 08/12/2026, 17:00',
      'Lập đề nghị tạm ứng': 'Thứ Ba 08/12/2026, 17:00',
      'Kiểm tra tuyến tham quan': 'Thứ Tư 09/12/2026, 17:00',
      'Duyệt đề nghị tạm ứng': 'Thứ Tư 09/12/2026, 17:00',
      'Hồ sơ pháp lý đất và tài liệu giới thiệu': 'Thứ Năm 10/12/2026, 17:00',
      'Báo giá thuê nhà xưởng cho đoàn': 'Thứ Sáu 11/12/2026, 17:00',
    };
    for (const [title, text] of Object.entries(due)) {
      const row = result.locator('tbody tr', { hasText: title });
      await expect(row).toHaveCount(1);
      await expect(row.locator('time')).toHaveText(text);
    }
    await expect(result).toContainText('Mốc đích: Thứ Năm 17/12/2026');
    await expect(result.locator('tbody tr', { hasText: 'Lập chương trình đón đoàn' })).toContainText('chị Nguyễn Thu Lan');
    await expect(result.getByText('Hạn đã qua', { exact: true })).toHaveCount(0);
    await shotBoth(page, 'simulate', false);

    // Mốc đích sát hôm nay: mọi hạn tính lùi đều rơi vào quá khứ. Phải cảnh báo và giữ nguyên hạn, không tự dời sang tương lai.
    await dialog.locator('[data-input-type="date"]').fill(vnDay(2));
    await page.getByTestId('simulate-run').click();
    await expect(result.getByText('Có 6 việc hạn đã qua ngay lúc khởi chạy')).toBeVisible();
    await expect(result.getByText('Hệ thống không tự dời hạn')).toBeVisible();
    await expect(result.locator('tbody tr').getByText('Hạn đã qua', { exact: true })).toHaveCount(6);
    const dueAt = await result.locator('tbody time').evaluateAll((els) => els.map((e) => e.getAttribute('datetime') ?? ''));
    expect(dueAt).toHaveLength(6);
    for (const iso of dueAt) expect(Date.parse(iso), `hạn ${iso} phải còn ở quá khứ`).toBeLessThan(Date.now());
    await shotBoth(page, 'simulate-past', false);
    await dialog.getByRole('button', { name: 'Đóng' }).last().click();
  });

  await test.step('xuất bản phiên bản 1', async () => {
    await ui.click(page.getByTestId('publish'));
    await expect(page.getByRole('alertdialog')).toContainText('Xuất bản phiên bản 1?');
    await expect(page.getByRole('alertdialog')).toContainText('Các lượt chạy đang chạy giữ nguyên phiên bản cũ');
    await ui.click(page.getByRole('button', { name: 'Xuất bản phiên bản 1' }));
    await expect(page.getByTestId('published-dialog')).toContainText('Đã xuất bản phiên bản 1');
    await shotBoth(page, 'published', false);
    await page.getByTestId('published-dialog').getByRole('button', { name: 'Đóng' }).first().click();
    await expect(status(page)).toContainText('Phiên bản 1 đã xuất bản');
  });

  const seconds = Math.round((Date.now() - started) / 1000);
  // Khởi chạy lượt đầu tiên: một lần bấm "Khởi chạy" rồi điền hai ô (tên đoàn, ngày đoàn đến) ở màn khởi chạy.
  const toStart = new Meter();
  toStart.clicks = 1;
  toStart.fields = 2;
  toStart.chars = 'Samsung'.length + '17/12/2026'.length;
  const shortest = meter.plus(toStart);
  const full = shortest.plus(optional);
  const minutes = (s: number): string => (s / 60).toFixed(1);
  const summary =
    `đường ngắn nhất (vẽ, chạy thử, xuất bản, khởi chạy): ${shortest.operations} thao tác (${shortest.clicks} lần bấm, ${shortest.fields} ô gõ gồm ${shortest.chars} ký tự, ${shortest.keys} phím riêng, ${shortest.drags} lần kéo), ` +
    `ước tính ${minutes(shortest.seconds)} phút cho người thành thạo, ${minutes(shortest.seconds * 2)} phút cho người dùng lần đầu (gấp đôi); ` +
    `thêm đặt tên ngắn như mẫu: ${full.operations} thao tác, ${minutes(full.seconds)} và ${minutes(full.seconds * 2)} phút; Playwright làm trong ${seconds} giây`;
  test.info().annotations.push({ type: 'thao tác', description: summary });
  console.log(`[Đón đoàn] ${summary}`);
  await mkdir(SHOTS, { recursive: true });
  await writeFile(
    `${SHOTS}/don-doan-thao-tac.json`,
    JSON.stringify({ duongNganNhat: { ...shortest, thaoTac: shortest.operations, giayNguoiThanhThao: Math.round(shortest.seconds), giayNguoiLanDau: Math.round(shortest.seconds * 2) }, kemTenNgan: { thaoTac: full.operations, giayNguoiThanhThao: Math.round(full.seconds), giayNguoiLanDau: Math.round(full.seconds * 2) }, playwrightGiay: seconds }, null, 2),
  );
  expect(shortest.seconds * 2, 'đường ngắn nhất, tính gấp đôi cho người dùng lần đầu, phải dưới 10 phút (SPEC 9.8 điều 1)').toBeLessThan(600);

  await test.step('tải lại trang: thấy bản đã xuất bản', async () => {
    await page.reload();
    await page.getByTestId('designer').waitFor();
    await expect(page.locator('.react-flow__node')).toHaveCount(8);
    await expect(page.locator('.react-flow__edge')).toHaveCount(9);
    await expect(status(page)).toContainText('Phiên bản 1 đã xuất bản');
    const detail = await detailOf(page, mainTemplateId);
    expect(detail.latestPublishedVersion).toBe(1);
    expect(detail.draft).toBeNull();
    await page.locator('.react-flow__node [data-kind="approval"]').click();
    await shotBoth(page, 'published-reload');

    // Xem phiên bản 1 ở chế độ chỉ đọc.
    await page.goto(`/quy-trinh/${mainTemplateId}?phienBan=1`);
    await expect(page.getByTestId('designer')).toHaveAttribute('data-mode', 'view');
    await expect(page.getByTestId('readonly-note')).toContainText('Đang xem phiên bản 1 đã xuất bản');
    await expect(page.getByTestId('process-name')).toBeDisabled();
    await expect(page.getByTestId('palette-task')).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(8);
    expect(await unnamedControls(page), 'điều khiển không có tên (chỉ đọc)').toEqual([]);
    await shotBoth(page, 'readonly');
  });

  expect(consoleErrors, 'lỗi trên bảng điều khiển của trình duyệt').toEqual([]);
  await context.close();
});

// ───────────────────────── SPEC 9.8 điều 2: bảy điều của validate() hiện trên giao diện ─────────────────────────

const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const START: DefNode = { id: 'start', type: 'start', label: 'Bắt đầu' };
const END: DefNode = { id: 'end', type: 'end', label: 'Hoàn tất' };
const task = (id: string, label: string, extra: Partial<DefNode> = {}): DefNode => ({ id, type: 'task', label, title: label, assignee: { kind: 'initiator' }, due: DUE, ...extra });
const edge = (id: string, from: string, to: string, extra: Partial<DefEdge> = {}): DefEdge => ({ id, from, to, ...extra });

type BadDraft = {
  rule: string;
  definition: Omit<Def, 'schemaVersion' | 'name'>;
  /** câu (một phần) phải hiện trong danh sách kiểm tra */
  messages: string[];
  /** nút phải có viền báo, và mức báo */
  nodes: Record<string, 'error' | 'warning'>;
  blocked: boolean;
};

const BAD_DRAFTS: BadDraft[] = [
  {
    rule: 'điều 1: hai ô Bắt đầu',
    definition: { inputs: [], nodes: [START, { id: 'start2', type: 'start', label: 'Bắt đầu 2' }, task('t1', 'Việc A'), END], edges: [edge('e1', 'start', 't1'), edge('e2', 'start2', 't1'), edge('e3', 't1', 'end')] },
    messages: ['Chỉ được có một ô'],
    nodes: { start2: 'error' },
    blocked: true,
  },
  {
    rule: 'điều 1: thiếu ô Hoàn tất',
    definition: { inputs: [], nodes: [START, task('t1', 'Việc A')], edges: [edge('e1', 'start', 't1')] },
    messages: ['Cần có ít nhất một ô'],
    nodes: {},
    blocked: true,
  },
  {
    rule: 'điều 2: nút mồ côi',
    definition: { inputs: [], nodes: [START, task('t1', 'Việc A'), task('t2', 'Việc mồ côi'), END], edges: [edge('e1', 'start', 't1'), edge('e2', 't1', 'end')] },
    messages: ['Bước “Việc mồ côi” chưa được nối từ ô “Bắt đầu”', 'Từ bước “Việc mồ côi” chưa có đường nào đi tới'],
    nodes: { t2: 'error' },
    blocked: true,
  },
  {
    rule: 'điều 3: vòng lặp không qua đường Chưa đồng ý',
    definition: {
      inputs: [],
      nodes: [START, task('t1', 'Việc A'), task('t2', 'Việc B'), END],
      edges: [edge('e1', 'start', 't1'), edge('e2', 't1', 't2'), edge('e3', 't2', 't1'), edge('e4', 't2', 'end')],
    },
    messages: ['nối thành vòng'],
    nodes: { t1: 'error' },
    blocked: true,
  },
  {
    rule: 'điều 4: rẽ nhánh thiếu Còn lại, duyệt thiếu Đồng ý',
    definition: {
      inputs: [{ key: 'so_tien', label: 'Số tiền', type: 'money', required: true }],
      nodes: [
        START,
        { id: 'c1', type: 'condition', label: 'Xét số tiền', branches: [{ id: 'b1', label: 'Lớn', when: { op: 'gte', left: { ref: 'inputs.so_tien' }, right: { value: 50_000_000 } } }] },
        { id: 'a1', type: 'approval', label: 'Duyệt chi', title: 'Duyệt chi', approvers: [{ kind: 'initiator' }], mode: 'any', due: DUE },
        END,
      ],
      edges: [edge('e1', 'start', 'c1'), edge('e2', 'c1', 'a1', { branch: 'b1' }), edge('e3', 'a1', 'end', { outcome: 'rejected' })],
    },
    messages: ['chưa có đường “Trường hợp còn lại”', 'chưa có đường đi tiếp khi “Đồng ý”'],
    nodes: { c1: 'error', a1: 'error' },
    blocked: true,
  },
  {
    rule: 'điều 5: thiếu người nhận và thiếu hạn',
    definition: { inputs: [], nodes: [START, { id: 't1', type: 'task', label: 'Việc thiếu', title: 'Việc thiếu' }, END], edges: [edge('e1', 'start', 't1'), edge('e2', 't1', 'end')] },
    messages: ['Việc “Việc thiếu” chưa chọn người nhận', 'Việc “Việc thiếu” chưa đặt hạn'],
    nodes: { t1: 'error' },
    blocked: true,
  },
  {
    rule: 'điều 6: "chỉ cần một nhánh" nhưng chỉ có một đường nối tới',
    definition: { inputs: [], nodes: [START, task('t1', 'Việc A', { join: 'any' }), END], edges: [edge('e1', 'start', 't1'), edge('e2', 't1', 'end')] },
    messages: ['phải có ít nhất hai đường nối tới'],
    nodes: { t1: 'error' },
    blocked: true,
  },
  {
    rule: 'điều 7 (chỉ cảnh báo): hạn sớm hơn việc đứng trước',
    definition: {
      inputs: [],
      nodes: [START, task('t1', 'Việc trước', { due: { anchor: 'run_start', offset: { value: 5, unit: 'working_day' } } }), task('t2', 'Việc sau', { due: { anchor: 'run_start', offset: { value: 1, unit: 'working_day' } } }), END],
      edges: [edge('e1', 'start', 't1'), edge('e2', 't1', 't2'), edge('e3', 't2', 'end')],
    },
    messages: ['Hạn của việc “Việc sau” sớm hơn hạn của việc đứng trước'],
    nodes: { t2: 'warning' },
    blocked: false,
  },
];

test('kiểm tra trực tiếp: bảy điều của validate() hiện đúng trên nút và trong danh sách', async ({ browser }) => {
  const { context, page } = await login(browser, 'thietke');
  const INK = 'rgb(31, 27, 22)';
  const WARN = 'rgb(102, 66, 0)';
  for (const [i, bad] of BAD_DRAFTS.entries()) {
    await test.step(bad.rule, async () => {
      await waitForRoom(85);
      const tpl = await createTemplate(page, named(`Nháp sai ${i + 1}`), bad.definition);
      await openDesigner(page, tpl.id);
      const bar = page.getByTestId('issues-bar');
      if (bad.blocked) await expect(bar).not.toHaveAttribute('data-errors', '0');
      else {
        await expect(bar).toHaveAttribute('data-errors', '0');
        await expect(bar).not.toHaveAttribute('data-warnings', '0');
      }
      await page.getByTestId('issues-toggle').click();
      const list = page.getByTestId('issues-list');
      for (const message of bad.messages) await expect(list).toContainText(message);
      for (const [id, level] of Object.entries(bad.nodes)) {
        if (id.startsWith('start')) {
          await expect(node(page, id)).toContainText('Chỉ được có một ô');
          continue;
        }
        const card = node(page, id).locator(`[data-issue="${level}"]`);
        await expect(card).toBeVisible();
        // Lỗi: viền đậm màu mực + hình + chữ. Cảnh báo: viền màu cảnh báo (cam đồng) + hình + chữ. Không chỉ dựa vào màu.
        const look = await card.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { color: cs.borderTopColor, width: parseFloat(cs.borderTopWidth), ring: cs.boxShadow !== 'none', icon: !!el.querySelector('svg.lucide-circle-alert, svg.lucide-triangle-alert'), text: (el.textContent ?? '').replace(/\s+/g, ' ') };
        });
        expect(look.color, `viền của ${id}`).toBe(level === 'error' ? INK : WARN);
        expect(look.width, 'bề dày viền').toBeGreaterThanOrEqual(1);
        expect(look.ring, 'viền kép (đậm hơn viền thường)').toBe(true);
        expect(look.icon, `${id} có hình báo ${level}`).toBe(true);
        expect(look.text, `${id} có chữ báo ${level}`).toContain(level === 'error' ? 'Lỗi: ' : 'Cần lưu ý: ');
      }
      // Không cho xuất bản khi còn lỗi (kèm lý do); cảnh báo thì vẫn xuất bản được.
      const publish = page.getByTestId('publish');
      await expect(publish).toHaveAttribute('data-blocked', bad.blocked ? 'true' : 'false');
      if (bad.blocked) {
        await expect(publish).toHaveAttribute('aria-disabled', 'true');
        await publish.hover();
        await expect(page.getByRole('tooltip').first()).toContainText('lỗi cần sửa trước khi xuất bản');
        // Nút mang aria-disabled (vẫn nhận focus và bấm được để nghe lý do), nên phải bấm ép.
        await publish.click({ force: true });
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await expect(page.getByText(/Còn \d+ lỗi cần sửa trước khi xuất bản/).first()).toBeVisible();
      } else {
        await expect(publish).not.toHaveAttribute('aria-disabled', 'true');
      }
      // Bấm một dòng lỗi thì chọn đúng nút và mở thuộc tính của nó.
      const firstNode = Object.keys(bad.nodes).find((id) => !id.startsWith('start'));
      if (firstNode) {
        await page.locator(`[data-testid="issue-item"][data-node-id="${firstNode}"]`).first().click();
        await expect(node(page, firstNode)).toHaveClass(/selected/);
        await expect(page.getByTestId('properties-panel').getByRole('alert').or(page.getByTestId('properties-panel').getByRole('status')).first()).toBeVisible();
      }
      if (i === 2) await shotBoth(page, 'errors-orphan');
      if (i === 4) await shotBoth(page, 'errors-branch');
      if (i === 7) await shotBoth(page, 'warning');
    });
  }

  await test.step('máy chủ trả 422 lúc xuất bản (phản hồi giả lập): lỗi hiện theo nút, không báo đã xuất bản', async () => {
    // Giao diện không cho bấm xuất bản khi tự thấy lỗi, nên 422 chỉ xảy ra khi máy chủ kiểm ra điều trình duyệt chưa thấy.
    // Ở đây chặn đúng lời gọi publish và trả 422 giả lập để thử nhánh xử lý đó; các lời gọi khác vẫn tới API thật.
    const tpl = await createTemplate(page, named('Nháp bị máy chủ từ chối'), BAD_DRAFTS[7]?.definition);
    await openDesigner(page, tpl.id);
    await page.route(`**/v1/templates/${tpl.id}/publish`, (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'https://mihato.local/problems/template_invalid', title: 'template_invalid', status: 422, code: 'template_invalid', errors: [{ path: 't2', code: 'assignee_missing' }] }),
      }),
    );
    await page.getByTestId('publish').click();
    await page.getByRole('button', { name: 'Xuất bản phiên bản 1' }).click();
    await expect(page.getByText('Chưa xuất bản được vì còn lỗi')).toBeVisible();
    await expect(page.getByTestId('published-dialog')).toHaveCount(0);
    await expect(node(page, 't2').locator('[data-issue="error"]')).toContainText('Chưa chọn người nhận.');
    await expect(page.getByTestId('issues-list')).toContainText('Chưa chọn người nhận.');
    await page.unroute(`**/v1/templates/${tpl.id}/publish`);
  });

  await test.step('máy chủ từ chối xuất bản nháp còn lỗi: 422 template_invalid', async () => {
    const tpl = await createTemplate(page, named('Nháp sai máy chủ'), BAD_DRAFTS[5]?.definition);
    const res = await api<{ code: string; errors?: { path: string; code: string }[] }>(page, 'POST', `/v1/templates/${tpl.id}/publish`);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('template_invalid');
    expect(res.json.errors?.map((e) => `${e.path}:${e.code}`)).toEqual(expect.arrayContaining(['t1:assignee_missing', 't1:due_missing']));
  });
  await context.close();
});

// ───────────────────────── Kiểm tra trực tiếp khi đang vẽ: lỗi hiện rồi mất theo từng thao tác ─────────────────────────

test('kiểm tra trực tiếp khi đang vẽ: lỗi hiện ra rồi mất đi theo từng thao tác của người vẽ', async ({ browser }) => {
  const { context, page } = await login(browser, 'thietke');
  const consoleErrors = watchConsole(page);
  const tpl = await createTemplate(page, named('Kiểm tra khi đang vẽ'));
  await openDesigner(page, tpl.id);
  const bar = page.getByTestId('issues-bar');
  const alert = page.getByTestId('properties-panel').getByRole('alert');
  const publish = page.getByTestId('publish');
  const panel = page.getByTestId('properties-panel');
  const hasErrors = (yes: boolean) => (yes ? expect(bar).not.toHaveAttribute('data-errors', '0') : expect(bar).toHaveAttribute('data-errors', '0'));

  let a = '';
  await test.step('việc mới chưa có người nhận: báo lỗi ngay, chưa cho xuất bản', async () => {
    await page.getByTestId('add-next-start').click();
    await page.getByTestId('quick-task').click();
    a = await selectedNodeId(page);
    await page.getByTestId('node-title').fill('Việc A');
    await expect(alert).toContainText('chưa chọn người nhận');
    await expect(node(page, a).locator('[data-issue="error"]')).toBeVisible();
    await hasErrors(true);
    await expect(publish).toHaveAttribute('data-blocked', 'true');
  });

  await test.step('chọn người nhận rồi nối tới Hoàn tất: hết lỗi, xuất bản được', async () => {
    await pickPerson(page.getByRole('combobox', { name: 'Người nhận: Người' }), 'Thu Lan', /Nguyễn Thu Lan/);
    await expect(alert).not.toContainText('chưa chọn người nhận');
    await expect(alert).toContainText('chưa có đường nào đi tới');
    await page.getByTestId(`add-next-${a}`).click();
    await page.getByTestId('quick-connect-end').click();
    await hasErrors(false);
    await expect(publish).toHaveAttribute('data-blocked', 'false');
    await expect(alert).toHaveCount(0);
  });

  await test.step('bước mồ côi (không nối từ Bắt đầu): báo lỗi; xoá bằng phím Delete thì hết lỗi', async () => {
    await page.getByTestId('palette-task').click();
    const b = await selectedNodeId(page);
    await expect(alert).toContainText('chưa được nối từ ô “Bắt đầu”');
    await hasErrors(true);
    await selectNode(page, b);
    await page.keyboard.press('Delete');
    await expect(node(page, b)).toHaveCount(0);
    await hasErrors(false);
  });

  let c = '';
  await test.step('nối thành vòng: báo lỗi; hoàn tác thì hết lỗi', async () => {
    await selectNode(page, a);
    await page.getByTestId(`add-next-${a}`).click();
    await page.getByTestId('quick-task').click();
    c = await selectedNodeId(page);
    await page.getByTestId('node-title').fill('Việc C');
    await pickPerson(page.getByRole('combobox', { name: 'Người nhận: Người' }), 'Phương', /Đặng Mai Phương/);
    await page.getByTestId(`add-next-${c}`).click();
    await page.getByTestId('quick-connect-end').click();
    await hasErrors(false);
    // Nối ngược từ Việc C về Việc A bằng bảng "Bước tiếp theo".
    await panel.getByRole('button', { name: /^Bước tiếp theo/ }).click();
    await choose(panel.getByRole('combobox', { name: 'Nối tới một bước khác' }), 'Việc: Việc A');
    await hasErrors(true);
    await page.getByTestId('issues-toggle').click();
    await expect(page.getByTestId('issues-list')).toContainText('nối thành vòng');
    await expect(page.locator('.react-flow__node [data-issue="error"]').first()).toBeVisible();
    await page.keyboard.press('Control+z');
    await hasErrors(false);
  });

  await test.step('rẽ nhánh chưa nối “Còn lại”: báo lỗi; nối xong thì hết câu báo đó', async () => {
    await selectNode(page, a);
    await page.getByTestId(`add-next-${a}`).click();
    await page.getByTestId('quick-condition').click();
    const d = await selectedNodeId(page);
    await expect(alert).toContainText('chưa có đường “Trường hợp còn lại”');
    await page.getByTestId(`add-next-${d}-else`).click();
    await page.getByTestId('quick-connect-end').click();
    await expect(alert).not.toContainText('chưa có đường “Trường hợp còn lại”');
  });

  await test.step('bước duyệt chưa nối “Đồng ý”: báo lỗi; nối xong thì hết câu báo đó', async () => {
    await selectNode(page, a);
    await page.getByTestId(`add-next-${a}`).click();
    await page.getByTestId('quick-approval').click();
    const e = await selectedNodeId(page);
    await expect(alert).toContainText('chưa có đường đi tiếp khi “Đồng ý”');
    await page.getByTestId(`add-next-${e}-approved`).click();
    await page.getByTestId('quick-connect-end').click();
    await expect(alert).not.toContainText('chưa có đường đi tiếp khi “Đồng ý”');
    await hasErrors(true);
  });

  expect(consoleErrors, 'lỗi trên bảng điều khiển của trình duyệt').toEqual([]);
  await context.close();
});

// ───────────────────────── Thêm, hoàn tác, làm lại, xoá bằng phím, nối nhanh ─────────────────────────

test('hoàn tác và làm lại nhiều bước (nút và phím tắt), thả bước mới, xoá bằng Delete và Backspace, bước Bắt đầu không xoá được', async ({ browser }) => {
  const { context, page } = await login(browser, 'thietke');
  const consoleErrors = watchConsole(page);
  const tpl = await createTemplate(page, named('Hoàn tác và xoá'));
  await openDesigner(page, tpl.id);
  const nodes = page.locator('.react-flow__node');
  const panel = page.getByTestId('properties-panel');

  await test.step('thêm năm bước bằng bàn phím, kéo thả, bấm khối; bước mới thả vào được chọn sẵn và mở thuộc tính', async () => {
    await expect(nodes).toHaveCount(2);
    // Bàn phím: Enter trên khối "Việc" ở cột trái.
    await page.getByTestId('palette-task').focus();
    await page.keyboard.press('Enter');
    await expect(nodes).toHaveCount(3);
    await expect(page.getByTestId('node-title')).toBeFocused();
    await page.getByTestId('node-title').fill('Việc thử hoàn tác');
    // Kéo thả khối "Duyệt" vào khung vẽ.
    await page.getByTestId('palette-approval').dragTo(page.getByTestId('designer-canvas'), { targetPosition: { x: 520, y: 180 } });
    await expect(nodes).toHaveCount(4);
    await expect(page.locator('.react-flow__node.selected [data-kind="approval"]')).toBeVisible();
    await expect(page.locator('.react-flow__node.selected [data-issue="error"]')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Bước duyệt mới' })).toBeVisible();
    await expect(page.getByTestId('node-title')).toBeVisible();
    await page.getByTestId('palette-timer').click();
    await page.getByTestId('palette-notify').click();
    await expect(nodes).toHaveCount(6);
    // Sáu bước chưa nối, mỗi bước báo lỗi ngay trên thẻ. Chờ dải báo lỗi hiện đủ và được đo xong (kiểm tra trực tiếp trễ 0,3 giây),
    // rồi bấm "Tự sắp xếp" cho gọn và chụp cả sơ đồ.
    await expect(page.locator('.react-flow__node [data-issue="error"]')).toHaveCount(6);
    await page.waitForTimeout(600);
    await page.getByTestId('auto-layout').click();
    await page.waitForTimeout(500);
    await shotBoth(page, 'new-nodes');
  });

  await test.step('hoàn tác từng bước bằng nút, rồi làm lại từng bước', async () => {
    // Bước hoàn tác đầu tiên lấy lại bố cục trước khi "Tự sắp xếp"; số bước vẫn là sáu.
    await page.getByTestId('undo').click();
    await expect(nodes).toHaveCount(6);
    await page.getByTestId('undo').click();
    await expect(nodes).toHaveCount(5);
    await page.getByTestId('undo').click();
    await expect(nodes).toHaveCount(4);
    await page.getByTestId('undo').click();
    await expect(nodes).toHaveCount(3);
    await page.getByTestId('undo').click();
    await expect(page.locator('.react-flow__node [data-kind="task"]')).toContainText('Việc mới');
    await page.getByTestId('undo').click();
    await expect(nodes).toHaveCount(2);
    await expect(page.getByTestId('undo')).toBeDisabled();
    for (let i = 0; i < 6; i += 1) await page.getByTestId('redo').click();
    await expect(nodes).toHaveCount(6);
    await expect(page.locator('.react-flow__node [data-kind="task"]')).toContainText('Việc thử hoàn tác');
    await expect(page.getByTestId('redo')).toBeDisabled();
  });

  await test.step('hoàn tác và làm lại bằng phím tắt (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y), khi con trỏ không nằm trong ô nhập', async () => {
    await page.locator('.react-flow__pane').click({ position: { x: 300, y: 500 } });
    // Ba lần Ctrl+Z: bỏ "Tự sắp xếp", rồi bỏ bước Thông báo, rồi bỏ bước Hẹn giờ.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(nodes).toHaveCount(4);
    await page.keyboard.press('Control+Shift+z');
    await expect(nodes).toHaveCount(5);
    await page.keyboard.press('Control+y');
    await expect(nodes).toHaveCount(6);
    // Trong ô nhập, Ctrl+Z để trình duyệt hoàn tác chữ đang gõ, không đụng tới sơ đồ.
    await deselect(page);
    await page.getByTestId('process-name').click();
    await page.keyboard.press('Control+z');
    await expect(nodes).toHaveCount(6);
  });

  await test.step('không dùng chuột: chọn nút bằng Enter, dời bằng phím mũi tên, nối bằng bảng "Bước tiếp theo"', async () => {
    const taskNode = page.locator('.react-flow__node', { has: page.locator('[data-kind="task"]') });
    await taskNode.focus();
    await page.keyboard.press('Enter');
    await expect(taskNode).toHaveClass(/selected/);
    await expect(page.getByTestId('node-title')).toHaveValue('Việc thử hoàn tác');
    const before = await taskNode.evaluate((el) => (el as HTMLElement).style.transform);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => taskNode.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(before);

    // Nối Bắt đầu → việc → Hoàn tất bằng hộp chọn trong bảng thuộc tính.
    await node(page, 'start').focus();
    await page.keyboard.press('Enter');
    await panel.getByRole('button', { name: /^Bước tiếp theo/ }).click();
    await choose(panel.getByRole('combobox', { name: 'Nối tới một bước khác' }), 'Việc: Việc thử hoàn tác');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await taskNode.focus();
    await page.keyboard.press('Enter');
    await panel.getByRole('button', { name: /^Bước tiếp theo/ }).click();
    await choose(panel.getByRole('combobox', { name: 'Nối tới một bước khác' }), 'Hoàn tất: Hoàn tất');
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
    await expect(panel.getByText('Tới Hoàn tất')).toBeVisible();
  });

  await test.step('xoá bằng Delete và bằng Backspace; gõ Backspace trong ô nhập không xoá bước', async () => {
    await page.locator('.react-flow__node [data-kind="approval"]').click();
    await page.keyboard.press('Delete');
    await expect(nodes).toHaveCount(5);
    await page.locator('.react-flow__node [data-kind="timer"]').click();
    await page.keyboard.press('Backspace');
    await expect(nodes).toHaveCount(4);
    // Backspace trong ô tên việc chỉ xoá chữ.
    await page.locator('.react-flow__node [data-kind="task"]').click({ position: { x: 8, y: 8 } });
    await page.getByTestId('node-title').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('node-title')).toHaveValue('Việc thử hoàn tá');
    await expect(nodes).toHaveCount(4);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('node-title')).toHaveValue('');
    await expect(nodes).toHaveCount(4);
    // Lấy lại tên việc bằng nút Hoàn tác (các lần gõ liền nhau gộp thành một hoặc hai bước).
    for (let i = 0; i < 3 && (await page.getByTestId('node-title').inputValue()) !== 'Việc thử hoàn tác'; i += 1) await page.getByTestId('undo').click();
    await expect(page.getByTestId('node-title')).toHaveValue('Việc thử hoàn tác');
    // Đường nối: chọn bằng chuột ở giữa đường, xoá bằng Delete, hoàn tác lấy lại.
    const edges = page.locator('.react-flow__edge');
    const mid = await edges.first().locator('path.react-flow__edge-path').evaluate((path: SVGPathElement) => {
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      const m = path.getScreenCTM();
      return m ? { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f } : null;
    });
    if (!mid) throw new Error('không tính được điểm giữa đường nối');
    await page.mouse.click(mid.x, mid.y);
    await expect(panel).toContainText('Đường nối');
    await page.keyboard.press('Delete');
    await expect(edges).toHaveCount(1);
    await page.getByTestId('undo').click();
    await expect(edges).toHaveCount(2);
  });

  await test.step('ô Bắt đầu không xoá được', async () => {
    await node(page, 'start').click();
    await page.keyboard.press('Delete');
    await expect(page.getByText('Ô “Bắt đầu” không xoá được.')).toBeVisible();
    await page.keyboard.press('Backspace');
    await expect(node(page, 'start')).toBeVisible();
    await expect(nodes).toHaveCount(4);
    await expect(page.getByTestId('delete-node')).toHaveCount(0);
  });

  expect(consoleErrors, 'lỗi trên bảng điều khiển của trình duyệt').toEqual([]);
  await context.close();
});

// ───────────────────────── Tự lưu nháp mỗi 5 giây, If-Match, 412 ─────────────────────────

test('tự lưu nháp mỗi 5 giây khi có thay đổi, kèm If-Match; không lưu khi không có gì mới; rời trang thì lưu trước', async ({ browser }) => {
  const { context, page } = await login(browser, 'thietke');
  const tpl = await createTemplate(page, named('Tự lưu mỗi 5 giây'));
  const puts: { at: number; ifMatch: string; nodes: number }[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PUT' || !r.url().includes(`/v1/templates/${tpl.id}/draft`)) return;
    const body = r.postDataJSON() as { definition?: { nodes?: unknown[] } } | null;
    puts.push({ at: Date.now(), ifMatch: r.headers()['if-match'] ?? '', nodes: body?.definition?.nodes?.length ?? 0 });
  });
  await openDesigner(page, tpl.id);

  await test.step('chưa sửa gì thì không lưu', async () => {
    await page.waitForTimeout(6_500);
    expect(puts).toHaveLength(0);
    await expect(status(page)).toHaveAttribute('data-dirty', 'false');
  });

  await test.step('sửa liên tục 13 giây: cứ khoảng 5 giây lưu một lần, If-Match tăng dần', async () => {
    await page.getByTestId('palette-task').click();
    const firstChange = Date.now();
    await expect(status(page)).toHaveText('Chưa lưu');
    // Giữ đang sửa: dời bước bằng phím mũi tên, cứ 0,6 giây một lần.
    const taskNode = page.locator('.react-flow__node', { has: page.locator('[data-kind="task"]') });
    await taskNode.focus();
    await page.keyboard.press('Enter');
    for (let i = 0; i < 21; i += 1) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(600);
    }
    expect(puts.length, 'số lần tự lưu trong 13 giây sửa liên tục').toBeGreaterThanOrEqual(2);
    expect(puts.length).toBeLessThanOrEqual(3);
    expect(puts[0] ? puts[0].at - firstChange : Infinity, 'lần lưu đầu phải tới trong vòng một nhịp 5 giây').toBeLessThan(5_800);
    for (const [i, p] of puts.entries()) expect(p.ifMatch, `If-Match của lần lưu thứ ${i + 1}`).toBe(String(i));
    for (let i = 1; i < puts.length; i += 1) {
      const gap = (puts[i]?.at ?? 0) - (puts[i - 1]?.at ?? 0);
      expect(gap, `khoảng cách giữa lần lưu ${i} và ${i + 1}`).toBeGreaterThan(4_300);
      expect(gap).toBeLessThan(6_300);
    }
    expect(puts[0]?.nodes).toBe(3);
    await waitSaved(page);
    const detail = await detailOf(page, tpl.id);
    expect(detail.draft?.rev, 'rev trên máy chủ bằng số lần lưu').toBe(puts.length);
    expect(detail.draft?.definition.nodes).toHaveLength(3);
  });

  await test.step('không có thay đổi mới thì không gửi thêm yêu cầu lưu', async () => {
    const count = puts.length;
    await page.waitForTimeout(6_500);
    expect(puts).toHaveLength(count);
  });

  await test.step('sai If-Match: máy chủ trả 412 precondition_failed', async () => {
    const detail = await detailOf(page, tpl.id);
    const wrong = await api<{ code: string }>(page, 'PUT', `/v1/templates/${tpl.id}/draft`, { definition: detail.draft?.definition }, { 'If-Match': '999' });
    expect(wrong.status).toBe(412);
    expect(wrong.json.code).toBe('precondition_failed');
  });

  await test.step('rời trang khi còn thay đổi chưa lưu: lưu trước rồi mới đi', async () => {
    await page.reload();
    await page.getByTestId('designer').waitFor();
    await page.locator('.react-flow__node').first().waitFor();
    const before = await detailOf(page, tpl.id);
    await page.getByTestId('palette-notify').click();
    await expect(status(page)).toHaveText('Chưa lưu');
    await page.getByTestId('back-to-list').click();
    await page.waitForURL(/\/quy-trinh$/);
    const after = await detailOf(page, tpl.id);
    expect(after.draft?.rev).toBe((before.draft?.rev ?? 0) + 1);
    expect(after.draft?.definition.nodes.some((n) => n.type === 'notify')).toBe(true);
  });
  await context.close();
});

test('hai thẻ cùng sửa một mẫu: thẻ sau nhận 412, báo rõ, không ghi đè âm thầm, tải lại được bản mới', async ({ browser }) => {
  const { context, page: a } = await login(browser, 'thietke');
  const tpl = await createTemplate(a, named('Hai thẻ cùng sửa'));
  await openDesigner(a, tpl.id);
  // Thẻ B không nhận được luồng cập nhật trực tiếp (SSE) nên chỉ biết người khác đã lưu khi lần tự lưu của mình bị từ chối.
  const b = await context.newPage();
  await b.route('**/v1/stream', (route) => route.abort());
  await openDesigner(b, tpl.id);
  const putsB: string[] = [];
  b.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes(`/v1/templates/${tpl.id}/draft`)) putsB.push(r.headers()['if-match'] ?? '');
  });

  await test.step('thẻ A sửa trước (thêm một việc) và tự lưu', async () => {
    await a.getByTestId('palette-task').click();
    await a.getByTestId('node-title').fill('Việc của thẻ A');
    await waitSaved(a);
    expect((await detailOf(a, tpl.id)).draft?.rev).toBe(1);
  });

  await test.step('thẻ B sửa khi chưa biết: lần tự lưu bị 412, báo rõ, không lưu thêm, không xuất bản được', async () => {
    const conflict = b.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/v1/templates/${tpl.id}/draft`) && r.status() === 412, { timeout: 15_000 });
    await b.getByTestId('palette-timer').click();
    await expect(b.locator('.react-flow__node')).toHaveCount(3);
    const res = await conflict;
    expect(res.request().headers()['if-match'], 'thẻ B vẫn giữ rev cũ').toBe('0');
    await expect(b.getByText('Bản nháp vừa được người khác sửa')).toBeVisible();
    await expect(b.getByTestId('conflict-reload')).toBeVisible();
    await expect(b.getByTestId('save-draft')).toBeDisabled();
    await expect(b.getByTestId('publish')).toHaveAttribute('data-blocked', 'true');
    await expect(status(b)).toHaveText('Chưa lưu');
    await fitAll(b);
    await shotBoth(b, 'conflict');
    // Không ghi đè: bản trên máy chủ vẫn là của thẻ A (có việc, không có hẹn giờ), và thẻ B không thử lưu lại.
    await b.waitForTimeout(6_000);
    expect(putsB, 'thẻ B chỉ gửi đúng một lần lưu, bị từ chối').toEqual(['0']);
    const server = await detailOf(a, tpl.id);
    expect(server.draft?.rev).toBe(1);
    expect(server.draft?.definition.nodes.map((n) => n.type).sort()).toEqual(['end', 'start', 'task']);
  });

  await test.step('thẻ B tải bản mới: thấy việc của A, mất phần chưa lưu, sửa tiếp được và lưu thành công với If-Match = 1', async () => {
    await b.getByTestId('conflict-reload').click();
    await expect(b.getByText('Đã tải bản nháp mới nhất.')).toBeVisible();
    await expect(b.getByTestId('conflict-reload')).toHaveCount(0);
    await expect(b.locator('.react-flow__node')).toHaveCount(3);
    await expect(b.locator('.react-flow__node [data-kind="task"]')).toContainText('Việc của thẻ A');
    await expect(b.locator('.react-flow__node [data-kind="timer"]')).toHaveCount(0);
    const saved = b.waitForRequest((r) => r.method() === 'PUT' && r.url().includes(`/v1/templates/${tpl.id}/draft`), { timeout: 15_000 });
    await b.getByTestId('palette-notify').click();
    expect((await saved).headers()['if-match']).toBe('1');
    await waitSaved(b);
    expect((await detailOf(a, tpl.id)).draft?.rev).toBe(2);
  });

  await test.step('thẻ A (nghe được luồng cập nhật, chưa sửa gì thêm) tự nhận bản mới của B, không có cảnh báo', async () => {
    await expect(a.locator('.react-flow__node')).toHaveCount(4, { timeout: 15_000 });
    await expect(a.locator('.react-flow__node [data-kind="notify"]')).toHaveCount(1);
    await expect(a.getByTestId('conflict-reload')).toHaveCount(0);
  });
  await context.close();
});

// ───────────────────────── Rẽ nhánh theo ô biểu mẫu, nối nhanh, chạy thử hai nhánh, xuất bản hai lần, so sánh ─────────────────────────

test('rẽ nhánh theo ô biểu mẫu "Số tiền > 50.000.000": chạy thử thấy cả hai nhánh; xuất bản hai lần rồi so sánh phiên bản', async ({ browser }) => {
  const { context, page } = await login(browser, 'thietke', WIDE);
  const consoleErrors = watchConsole(page);
  const tpl = await createTemplate(page, named('Rẽ nhánh theo số tiền'));
  await openDesigner(page, tpl.id);
  const panel = page.getByTestId('properties-panel');

  await test.step('biểu mẫu khởi chạy có ô "Số tiền" (loại số tiền)', async () => {
    await page.getByTestId('inputs-new-label').fill('Số tiền');
    await choose(page.getByTestId('inputs').getByRole('combobox', { name: 'Loại ô', exact: true }), 'Số tiền (đồng)');
    await page.getByTestId('inputs-add').click();
    await expect(page.getByTestId('inputs-row')).toHaveCount(1);
  });

  let conditionId = '';
  let approvalId = '';
  let directId = '';
  await test.step('rẽ nhánh: Số tiền lớn hơn 50.000.000 thì duyệt; kéo nối ra khoảng trống mở trình đơn bước kế tiếp', async () => {
    await page.getByTestId('add-next-start').click();
    await page.getByTestId('quick-condition').click();
    conditionId = await selectedNodeId(page);
    await page.getByRole('textbox', { name: 'Nhánh 1: Tên nhánh' }).fill('Trên 50 triệu');
    await choose(panel.getByRole('combobox', { name: 'Nhánh 1: Điều cần xét' }), 'Khởi chạy: Số tiền');
    await choose(panel.getByRole('combobox', { name: 'Nhánh 1: Phép so sánh' }), 'lớn hơn');
    await panel.getByRole('textbox', { name: 'Nhánh 1: Giá trị so sánh' }).fill('50000000');
    await expect(panel.getByText('50.000.000 đồng')).toBeVisible();

    // Kéo từ cổng "Trên 50 triệu" ra khoảng trống: hiện trình đơn chọn loại bước kế tiếp.
    const handle = node(page, conditionId).locator('.react-flow__handle[data-handleid="b1"]');
    const box = await handle.boundingBox();
    if (!box) throw new Error('không thấy cổng nhánh');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y - 120, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId('quick-add')).toBeVisible();
    await shot(page, 'quick-add-1440');
    await page.getByTestId('quick-approval').click();
    approvalId = await selectedNodeId(page);
    await page.getByTestId('node-title').fill('Duyệt chi trên 50 triệu');
    await choose(panel.getByRole('combobox', { name: 'Người duyệt 1', exact: true }), 'Cấp trên của người khởi chạy');
    await page.getByTestId(`add-next-${approvalId}-approved`).click();
    await page.getByTestId('quick-connect-end').click();

    // Nhánh "Còn lại" bắt buộc: chưa nối thì báo lỗi ngay trên nút rẽ nhánh.
    await expect(node(page, conditionId).locator('[data-issue="error"]')).toContainText('Trường hợp còn lại');
    await page.getByTestId(`add-next-${conditionId}-else`).click();
    await page.getByTestId('quick-task').click();
    directId = await selectedNodeId(page);
    await page.getByTestId('node-title').fill('Chi trực tiếp');
    await choose(panel.getByRole('combobox', { name: 'Người nhận', exact: true }), 'Người khởi chạy');
    await page.getByTestId(`add-next-${directId}`).click();
    await page.getByTestId('quick-connect-end').click();

    await expect(page.getByTestId('issues-bar')).toHaveAttribute('data-errors', '0');
    await expect(page.locator('[data-edge-label]').filter({ hasText: 'Còn lại' })).toHaveCount(1);
    await expect(page.locator('[data-edge-label]').filter({ hasText: 'Trên 50 triệu' })).toHaveCount(1);
    await expect(page.locator('[data-edge-label]').filter({ hasText: 'Đồng ý' })).toHaveCount(1);
    await page.getByTestId('auto-layout').click();
    await page.waitForTimeout(500);
    await deselect(page);
    await shotBoth(page, 'condition');
  });

  await test.step('điều kiện sinh ra Expr an toàn; đường nối mang nhánh', async () => {
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    const def = (await detailOf(page, tpl.id)).draft?.definition as Def;
    const condition = def.nodes.find((n) => n.id === conditionId);
    const key = def.inputs[0]?.key;
    expect(key).toBe('so_tien');
    expect(condition?.branches).toEqual([{ id: 'b1', label: 'Trên 50 triệu', when: { op: 'gt', left: { ref: `inputs.${key}` }, right: { value: 50_000_000 } } }]);
    expect(def.edges.filter((e) => e.from === conditionId).map((e) => e.branch).sort()).toEqual(['b1', 'else']);
    expect(def.edges.find((e) => e.outcome)?.outcome).toBe('approved');
  });

  await test.step('chạy thử: số tiền 100.000.000 chỉ thấy nhánh duyệt; 10.000.000 và đúng 50.000.000 chỉ thấy nhánh còn lại', async () => {
    await page.getByTestId('simulate').click();
    const dialog = page.getByTestId('simulate-dialog');
    const money = dialog.locator('[data-input-type="money"]');
    const result = page.getByTestId('simulate-result');
    const rows = result.locator('tbody tr');
    await money.fill('100000000');
    await page.getByTestId('simulate-run').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Duyệt chi trên 50 triệu');
    await shot(page, 'simulate-branch-big-1440');
    await money.fill('10000000');
    await page.getByTestId('simulate-run').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Chi trực tiếp');
    await money.fill('50000000');
    await page.getByTestId('simulate-run').click();
    await expect(rows.first()).toContainText('Chi trực tiếp');
    await expect(result).not.toContainText('Duyệt chi trên 50 triệu');
    await dialog.getByRole('button', { name: 'Đóng' }).last().click();
  });

  await test.step('chọn đường nối để sửa nhãn và xoá, hoàn tác', async () => {
    await page.locator('[data-edge-label]').filter({ hasText: 'Đồng ý' }).click();
    await expect(panel).toContainText('Đường nối');
    await choose(panel.getByRole('combobox', { name: 'Đi theo đường này khi' }), 'Chưa đồng ý');
    await expect(page.locator('[data-edge-label]').filter({ hasText: 'Chưa đồng ý' })).toHaveCount(1);
    // Mất đường "Đồng ý": bước duyệt báo lỗi, không xuất bản được.
    await expect(page.getByTestId('publish')).toHaveAttribute('data-blocked', 'true');
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('publish')).toHaveAttribute('data-blocked', 'false');
    const edges = page.locator('.react-flow__edge');
    await expect(edges).toHaveCount(5);
    await page.locator('[data-edge-label]').filter({ hasText: 'Còn lại' }).click();
    await page.getByTestId('delete-edge').click();
    await expect(edges).toHaveCount(4);
    await page.getByTestId('undo').click();
    await expect(edges).toHaveCount(5);
  });

  await test.step('xuất bản phiên bản 1, sửa tiếp, xuất bản phiên bản 2, so sánh', async () => {
    await page.getByTestId('publish').click();
    await page.getByRole('button', { name: 'Xuất bản phiên bản 1' }).click();
    await expect(page.getByTestId('published-dialog')).toContainText('Đã xuất bản phiên bản 1');
    await page.getByTestId('published-dialog').getByRole('button', { name: 'Đóng' }).first().click();

    // Sửa tiếp trên bản đã xuất bản: lần lưu đầu tạo bản nháp phiên bản 2.
    await expect(page.getByTestId('publish')).toHaveAttribute('data-blocked', 'true');
    await page.locator('.react-flow__node [data-kind="approval"]').click();
    await page.getByTestId('node-title').fill('Duyệt chi trên 50 triệu (đổi tên)');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    const drafted = await detailOf(page, tpl.id);
    expect(drafted.latestPublishedVersion).toBe(1);
    expect(drafted.draft?.version).toBe(2);
    await page.getByTestId('publish').click();
    await page.getByRole('button', { name: 'Xuất bản phiên bản 2' }).click();
    await expect(page.getByTestId('published-dialog')).toContainText('Đã xuất bản phiên bản 2');
    await page.getByTestId('published-dialog').getByRole('button', { name: 'Đóng' }).first().click();
    const published = await detailOf(page, tpl.id);
    expect(published.latestPublishedVersion).toBe(2);
    expect(published.draft).toBeNull();

    await page.getByTestId('more').click();
    await page.getByTestId('compare').click();
    const diff = page.getByTestId('diff-dialog');
    await expect(diff.getByRole('combobox', { name: 'Phiên bản cũ' })).toHaveText('Phiên bản 1');
    await expect(diff.getByRole('combobox', { name: 'Phiên bản mới' })).toHaveText('Phiên bản 2');
    await expect(diff.getByTestId('diff-result')).toBeVisible();
    await expect(diff.locator('[data-change="changed"]')).toHaveCount(1);
    await expect(diff.locator('[data-change="changed"]')).toContainText('Duyệt chi trên 50 triệu (đổi tên)');
    await expect(diff.locator('[data-change="changed"]')).toContainText('tên việc');
    await shotBoth(page, 'diff', false);
    await diff.getByRole('button', { name: 'Đóng' }).last().click();

    // Xem lại phiên bản 1 ở chế độ chỉ đọc qua ô chọn phiên bản.
    await page.getByRole('combobox', { name: 'Phiên bản đang xem' }).click();
    await page.getByRole('option', { name: /^Phiên bản 1,/ }).click();
    await expect(page.getByTestId('designer')).toHaveAttribute('data-mode', 'view');
    await expect(page.getByTestId('readonly-note')).toContainText('Đang xem phiên bản 1 đã xuất bản');
    await expect(page.locator('.react-flow__node [data-kind="approval"]')).toContainText('Duyệt chi trên 50 triệu');
    await expect(page.locator('.react-flow__node [data-kind="approval"]')).not.toContainText('đổi tên');
    await expect(page.getByTestId('palette-task')).toHaveCount(0);
  });

  expect(consoleErrors, 'lỗi trên bảng điều khiển của trình duyệt').toEqual([]);
  await context.close();
});

// ───────────────────────── Trợ năng: bàn phím, tên cho điều khiển, focus, tương phản ─────────────────────────

test('trợ năng: dùng bàn phím từ đầu tới cuối, mọi điều khiển có tên, focus nhìn thấy, tương phản đạt AA', async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await login(browser, 'thietke');
  const consoleErrors = watchConsole(page);
  const seed = (await api<{ items: Summary[] }>(page, 'GET', '/v1/templates')).json.items.find((x) => x.name === SEED_NAME);
  expect(seed, 'mẫu Đón đoàn của dữ liệu mẫu').toBeTruthy();
  const sample = await cloneTemplate(page, named('Trợ năng trên bản sao Đón đoàn'), seed?.id ?? '');
  await openDesigner(page, sample.id);
  const designer = '[data-testid="designer"]';

  await test.step('các bộ dò tự kiểm: phải bắt được nút không tên, chữ nhạt, nút mất viền focus (để kết quả sạch bên dưới có ý nghĩa)', async () => {
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'canary';
      box.innerHTML =
        '<button type="button" id="canary-btn"></button>' +
        '<p style="color:#aaaaaa;background:#ffffff;font-size:14px">Chữ nhạt thử</p>' +
        '<button type="button" id="canary-ring" aria-label="Nút mất viền focus" style="outline:none !important;box-shadow:none !important">x</button>';
      document.querySelector('[data-testid="designer"]')?.appendChild(box);
    });
    expect((await unnamedControls(page)).join('\n'), 'bộ dò nút không tên').toContain('canary-btn');
    expect((await lowContrast(page, '[data-testid="designer"]')).map((x) => x.text), 'bộ dò chữ nhạt').toContain('Chữ nhạt thử');
    await page.locator('#canary-ring').focus();
    expect((await activeStop(page))?.ring, 'bộ dò viền focus').toBe(false);
    await page.evaluate(() => document.getElementById('canary')?.remove());
  });

  await test.step('đi Tab qua màn hình: mọi điểm dừng có viền focus rõ, không rơi vào vùng bị khoá, đều nhìn thấy', async () => {
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const stops: Stop[] = [];
    // Một vòng Tab của màn này khoảng 55 điểm dừng; đi hơn một vòng để thấy focus quay lại đầu trang (không bị kẹt).
    for (let i = 0; i < 62; i += 1) {
      await page.keyboard.press('Tab');
      const stop = await activeStop(page);
      if (stop) stops.push(stop);
    }
    const ids = stops.map((s) => s.id);
    expect(ids, 'khối nút ở cột trái nhận focus').toContain('palette-task');
    expect(ids, 'nút thanh công cụ nhận focus').toContain('fit-view');
    expect(ids, 'nút trên thanh trên nhận focus').toContain('validate');
    expect(new Set(ids.filter((id) => id.startsWith('rf__node-'))).size, 'các bước trên khung vẽ nhận focus').toBe(8);
    expect(new Set(ids.filter((id) => id.startsWith('rf__edge-'))).size, 'các đường nối nhận focus').toBe(9);
    expect(ids, 'ô nhập của bảng thuộc tính nhận focus').toContain('process-name');
    expect(ids, 'nút nhảy tới bảng thuộc tính nhận focus').toContain('skip-to-panel');
    expect(stops.filter((s) => !s.ring).map((s) => `${s.id} "${s.name}"`), 'điểm dừng không có viền focus rõ').toEqual([]);
    expect(stops.filter((s) => s.inert).map((s) => `${s.id} "${s.name}"`), 'điểm dừng nằm trong vùng bị khoá').toEqual([]);
    expect(stops.filter((s) => !s.visible).map((s) => `${s.id} "${s.name}"`), 'điểm dừng không nhìn thấy').toEqual([]);
    expect(stops.length, 'số điểm dừng khi Tab').toBeGreaterThan(25);
  });

  await test.step('từ khối nút nhảy thẳng tới bảng thuộc tính, không phải Tab qua mọi bước và đường nối', async () => {
    await page.getByTestId('palette-end').focus();
    await page.keyboard.press('Tab');
    const skip = page.getByTestId('skip-to-panel');
    await expect(skip).toBeFocused();
    await expect(skip, 'chỉ hiện ra khi nhận focus').toBeVisible();
    expect((await skip.boundingBox())?.width ?? 0).toBeGreaterThan(80);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('aside[aria-label="Thuộc tính"]'))).toBe(true);
    // Rời khỏi bảng bằng Shift+Tab vẫn về được khung vẽ.
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('aside[aria-label="Thuộc tính"]')), 'Shift+Tab ra khỏi bảng').toBe(false);
  });

  await test.step('mọi điều khiển đang hiện đều có tên (cây trợ năng của Chromium)', async () => {
    expect(await unnamedControls(page), 'nghỉ').toEqual([]);
    await node(page, 'start').locator('[data-kind]').click({ position: { x: 8, y: 8 } });
    await page.locator('.react-flow__node [data-kind="task"]').first().click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('node-title')).toBeVisible();
    expect(await unnamedControls(page), 'đang chọn một việc').toEqual([]);
    await page.locator('.react-flow__node [data-kind="approval"]').click({ position: { x: 8, y: 8 } });
    expect(await unnamedControls(page), 'đang chọn bước duyệt').toEqual([]);
  });

  await test.step('tương phản chữ đạt AA: màn nghỉ, đang chọn việc, đang chọn bước duyệt', async () => {
    expect(await lowContrast(page, designer), 'đang chọn bước duyệt').toEqual([]);
    await page.locator('.react-flow__node [data-kind="task"]').first().click({ position: { x: 8, y: 8 } });
    expect(await lowContrast(page, designer), 'đang chọn một việc').toEqual([]);
    await deselect(page);
    expect(await lowContrast(page, designer), 'không chọn gì').toEqual([]);
  });

  await test.step('khung vẽ bằng bàn phím: Enter chọn bước, mũi tên dời, Delete xoá, Ctrl+Z lấy lại; đường nối cũng chọn và xoá được', async () => {
    const nodes = page.locator('.react-flow__node');
    const edges = page.locator('.react-flow__edge');
    const first = node(page, 'start');
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveClass(/selected/);
    const targetTask = page.locator('.react-flow__node', { has: page.locator('[data-kind="task"]') }).first();
    await targetTask.focus();
    await page.keyboard.press('Space');
    await expect(targetTask).toHaveClass(/selected/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Delete');
    await expect(nodes).toHaveCount(7);
    await page.keyboard.press('Control+z');
    await expect(nodes).toHaveCount(8);
    // Bước đã xoá rồi hoàn tác: chờ các đường nối vẽ lại đủ chín đường rồi mới đếm.
    const total = 9;
    await expect(edges).toHaveCount(total);
    await edges.first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('properties-panel')).toContainText('Đường nối');
    await page.keyboard.press('Delete');
    await expect(edges).toHaveCount(total - 1);
    await page.keyboard.press('Control+z');
    await expect(edges).toHaveCount(total);
  });

  await test.step('hộp thoại "Chạy thử": mở bằng bàn phím, Tab quay vòng trong hộp, Esc đóng và trả focus về nút cũ', async () => {
    const trigger = page.getByTestId('simulate');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByTestId('simulate-dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(300);
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    expect(await inside(), 'focus vào hộp thoại khi mở').toBe(true);
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab lần ${i + 1} vẫn trong hộp thoại`).toBe(true);
    }
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside(), `Shift+Tab lần ${i + 1} vẫn trong hộp thoại`).toBe(true);
    }
    // Điền và chạy hoàn toàn bằng bàn phím.
    await dialog.locator('[data-input-type="text"]').focus();
    await page.keyboard.type('Đoàn thử bàn phím');
    await page.keyboard.press('Tab');
    await page.keyboard.type('15102026');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('simulate-result').locator('tbody tr')).toHaveCount(6);
    expect(await unnamedControls(page), 'hộp thoại chạy thử').toEqual([]);
    expect(await lowContrast(page, '[data-testid="simulate-dialog"]'), 'hộp thoại chạy thử có kết quả').toEqual([]);
    // Mốc đích đã qua: lời cảnh báo và nhãn "Hạn đã qua" cũng phải đủ tương phản.
    await dialog.locator('[data-input-type="date"]').fill(vnDay(2));
    await page.getByTestId('simulate-run').click();
    await expect(page.getByText('Có 6 việc hạn đã qua ngay lúc khởi chạy')).toBeVisible();
    expect(await lowContrast(page, '[data-testid="simulate-dialog"]'), 'hộp thoại chạy thử có cảnh báo hạn đã qua').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  await test.step('hộp thoại xác nhận xuất bản: Esc đóng và trả focus về nút Xuất bản', async () => {
    const publish = page.getByTestId('publish');
    await expect(publish).toHaveAttribute('data-blocked', 'false');
    await publish.focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]'))).toBe(true);
    expect(await unnamedControls(page), 'hộp thoại xác nhận').toEqual([]);
    expect(await lowContrast(page, '[role="alertdialog"]'), 'hộp thoại xác nhận').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(publish).toBeFocused();
  });

  await test.step('vẽ một việc hoàn toàn bằng bàn phím: thêm, đặt tên, chọn người, nối Bắt đầu → Việc → Hoàn tất', async () => {
    const blank = await createTemplate(page, named('Trợ năng vẽ bằng bàn phím'));
    await openDesigner(page, blank.id);
    const panel = page.getByTestId('properties-panel');
    await page.getByTestId('palette-task').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('node-title')).toBeFocused();
    await page.keyboard.type('Việc làm bằng phím');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Người nhận: Người' })).toBeFocused();
    await page.keyboard.type('Thu Lan');
    // Nhấn Enter quá sớm, khi danh sách còn là kết quả của chữ gõ trước: không được chọn nhầm người đứng đầu danh sách cũ.
    await page.keyboard.press('Enter');
    await expect(page.locator('.react-flow__node [data-kind="task"]')).not.toContainText('Trần Đức Minh');
    // Chờ kết quả tìm của chữ vừa gõ (ô tìm đợi ngừng gõ 0,2 giây): người khớp nhất đứng đầu danh sách. Chọn bằng Enter.
    await expect(page.getByRole('option').first()).toContainText('Nguyễn Thu Lan');
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page.locator('.react-flow__node [data-kind="task"]')).toContainText('chị Nguyễn Thu Lan');
    const taskId = await selectedNodeId(page);
    // Nối bằng bàn phím: mở mục "Bước tiếp theo", chọn bước đích trong hộp chọn.
    const connect = async (fromId: string, toLabel: string): Promise<void> => {
      await node(page, fromId).focus();
      await page.keyboard.press('Enter');
      const toggle = panel.getByRole('button', { name: /^Bước tiếp theo/ });
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.focus();
        await page.keyboard.press('Enter');
      }
      const select = panel.getByRole('combobox', { name: 'Nối tới một bước khác' });
      await select.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('option', { name: toLabel, exact: true }).focus();
      await page.keyboard.press('Enter');
    };
    await connect('start', 'Việc: Việc làm bằng phím');
    await connect(taskId, 'Hoàn tất: Hoàn tất');
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
    await expect(page.getByTestId('issues-bar')).toHaveAttribute('data-errors', '0');
    await expect(page.getByTestId('publish')).toHaveAttribute('data-blocked', 'false');
  });

  await test.step('màn có lỗi: tên điều khiển, tương phản của viền, dải báo lỗi và cảnh báo', async () => {
    const bad = await createTemplate(page, named('Trợ năng màn có lỗi'), BAD_DRAFTS[4]?.definition);
    await openDesigner(page, bad.id);
    await page.getByTestId('issues-toggle').click();
    await expect(page.getByTestId('issues-list')).toBeVisible();
    expect(await unnamedControls(page), 'màn có lỗi').toEqual([]);
    expect(await lowContrast(page, designer), 'màn có lỗi').toEqual([]);
    const warn = await createTemplate(page, named('Trợ năng màn cảnh báo'), BAD_DRAFTS[7]?.definition);
    await openDesigner(page, warn.id);
    await page.getByTestId('issues-toggle').click();
    expect(await lowContrast(page, designer), 'màn có cảnh báo').toEqual([]);
  });

  expect(consoleErrors, 'lỗi trên bảng điều khiển của trình duyệt').toEqual([]);
  await context.close();
});

// ───────────────────────── Danh sách mẫu và người chỉ đọc ─────────────────────────

test('danh sách: lọc theo tên, nhân bản, lưu trữ và bỏ lưu trữ', async ({ browser }) => {
  const { context, page } = await login(browser, 'thietke');
  await page.goto('/quy-trinh');
  const table = page.getByRole('table');
  await expect(table).toContainText(SEED_NAME);
  await shotBoth(page, 'templates-list', false);

  await test.step('lọc theo tên, không phân biệt dấu', async () => {
    await page.getByTestId('template-search').fill(`ve lai ${stamp}`);
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table).toContainText(TEMPLATE_NAME);
    await expect(table.locator('tbody tr')).toContainText('Phiên bản 1');
    await expect(table.locator('tbody tr td').nth(2)).toHaveText('6');
  });

  let cloneId = '';
  await test.step('nhân bản từ mẫu khác rồi vào trình thiết kế', async () => {
    await page.getByTestId('row-menu').click();
    await page.getByRole('menuitem', { name: 'Nhân bản' }).click();
    const dialog = page.getByTestId('create-dialog');
    await expect(dialog.getByLabel('Tên quy trình')).toHaveValue(`${TEMPLATE_NAME} (bản sao)`);
    await dialog.getByLabel('Tên quy trình').fill(named('Bản sao Đón đoàn'));
    await page.getByTestId('create-submit').click();
    await page.getByTestId('designer').waitFor();
    cloneId = page.url().split('/quy-trinh/')[1]?.split('?')[0] ?? '';
    created.push(cloneId);
    await expect(page.locator('.react-flow__node')).toHaveCount(8);
    await expect(page.locator('.react-flow__edge')).toHaveCount(9);
    await expect(page.getByTestId('designer-name')).toHaveText(named('Bản sao Đón đoàn'));
    await expect(page.getByTestId('issues-bar')).toHaveAttribute('data-errors', '0');
  });

  await test.step('lưu trữ, hiện mẫu đã lưu trữ, bỏ lưu trữ', async () => {
    await page.getByTestId('back-to-list').click();
    await page.getByTestId('template-search').fill(named('Bản sao Đón đoàn'));
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr')).toContainText('Chưa xuất bản');
    await expect(table.locator('tbody tr')).toContainText('Có bản nháp');
    await page.getByTestId('row-menu').click();
    await page.getByRole('menuitem', { name: 'Lưu trữ', exact: true }).click();
    await page.getByRole('button', { name: 'Lưu trữ quy trình' }).click();
    await expect(page.getByText('Không có quy trình nào khớp')).toBeVisible();
    await page.getByTestId('show-archived').click();
    await expect(table.locator('tbody tr')).toContainText('Đã lưu trữ');
    await shotBoth(page, 'templates-archived', false);
    await page.getByTestId('row-menu').click();
    await page.getByRole('menuitem', { name: 'Bỏ lưu trữ' }).click();
    await expect(table.locator('tbody tr')).not.toContainText('Đã lưu trữ');
    expect((await detailOf(page, cloneId)).archivedAt).toBeNull();
  });
  await context.close();
});

test('Văn phòng chỉ xem bản đã xuất bản, chạy thử và khởi chạy', async ({ browser }) => {
  const { context, page } = await login(browser, 'vanphong', WIDE);
  await page.goto('/quy-trinh');
  const table = page.getByRole('table');
  await expect(table).toContainText(TEMPLATE_NAME);
  // Không thấy nút tạo, không thấy mẫu chưa xuất bản.
  await expect(page.getByTestId('create-template')).toHaveCount(0);
  await expect(table).not.toContainText(`${PREFIX} - Nháp sai`);
  await expect(table).not.toContainText('Chưa xuất bản');
  await shotBoth(page, 'templates-list-reader', false);

  await page.getByRole('link', { name: TEMPLATE_NAME, exact: true }).click();
  await expect(page.getByTestId('designer')).toHaveAttribute('data-mode', 'view');
  await expect(page.getByTestId('readonly-note')).toContainText('chỉ xem');
  await expect(page.locator('.react-flow__node')).toHaveCount(8);
  await expect(page.getByTestId('palette-task')).toHaveCount(0);
  await expect(page.getByTestId('publish')).toHaveCount(0);
  await expect(page.getByTestId('save-draft')).toHaveCount(0);
  await expect(page.getByTestId('process-name')).toBeDisabled();
  // Chọn một nút vẫn xem được thuộc tính, nhưng không sửa được.
  await page.locator('.react-flow__node [data-kind="approval"]').click();
  await expect(page.getByTestId('node-title')).toHaveValue('Duyệt đề nghị tạm ứng');
  await expect(page.getByTestId('node-title')).toBeDisabled();
  await expect(page.getByTestId('delete-node')).toHaveCount(0);
  expect(await unnamedControls(page), 'điều khiển không có tên (người chỉ đọc)').toEqual([]);
  expect(await lowContrast(page, '[data-testid="designer"]'), 'tương phản (người chỉ đọc)').toEqual([]);
  await shotBoth(page, 'reader');

  await page.getByTestId('simulate').click();
  const dialog = page.getByTestId('simulate-dialog');
  await expect(dialog).toContainText('Đang chạy thử phiên bản 1 đã xuất bản');
  await dialog.locator('[data-input-type="text"]').fill('Đoàn thử');
  await dialog.locator('[data-input-type="date"]').fill('2026-12-17');
  await page.getByTestId('simulate-run').click();
  await expect(page.getByTestId('simulate-result').locator('tbody tr')).toHaveCount(6);
  await dialog.getByRole('button', { name: 'Đóng' }).last().click();

  await page.getByTestId('start-run').click();
  await page.waitForURL((url) => url.pathname === '/luot-chay/moi' && url.searchParams.get('templateId') === mainTemplateId);
  await context.close();
});
