/**
 * Manifest của bộ ghi âm (SPEC 6.2.1 điều 1): mỗi mục là một câu đã ghi, kèm câu chuẩn bằng chữ và các thực thể
 * (tên người, tên đơn vị, số tiền, ngày) mà bài đo phải bắt đúng. Kiểm bằng Zod; sai chỗ nào báo rõ chỗ đó.
 *
 * Quyền riêng tư (SPEC 11, 13.6): `id` và `speaker` chỉ nhận mã ẩn danh (S01, tc-12), KHÔNG nhận tên thật, vì
 * báo cáo kết quả đi vào repo. Thông báo lỗi chỉ nêu đường dẫn tới trường sai, không chép lại giá trị.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { InstantSchema } from '@mihato/domain';
import { z } from 'zod';

/** Mã an toàn để in ra nhật ký và báo cáo: không dấu, không khoảng trắng. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SAFE_ID_MESSAGE = 'chỉ nhận mã ẩn danh gồm chữ không dấu, số, dấu chấm, gạch ngang, gạch dưới (ví dụ S01, tc-12); không ghi tên thật';

/** `YYYY-MM-DD` và đúng lịch (không có 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
}

const nonBlank = z.string().trim().min(1, 'không được để trống');

export const EntitiesSchema = z.strictObject({
  /** tên người đúng như được NÓI trong câu: "Tuấn", "Phương" hoặc cả họ tên nếu người nói đọc cả họ tên */
  people: z.array(nonBlank).default([]),
  /** tên phòng, ban, đơn vị đúng như được nói: "Kinh doanh", "Hành chính nhân sự" */
  units: z.array(nonBlank).optional(),
  /** số tiền VND nguyên dương; câu có nhiều số tiền thì liệt kê đủ (so theo tập) */
  amountsVnd: z.array(z.number().int('số tiền phải là số nguyên VND').positive('số tiền phải dương').max(Number.MAX_SAFE_INTEGER)).default([]),
  /** ngày mà câu nói nhắc tới, đã quy ra 'YYYY-MM-DD' theo mốc `now` của manifest */
  dates: z.array(z.string().refine(isCalendarDate, 'ngày phải có dạng YYYY-MM-DD và đúng lịch')).default([]),
});

/** Bản ghi sẵn cho cấu hình `fake` (FakeStt): chỉ để chứng minh công cụ đúng, KHÔNG phải số đo thật. */
export const FakeTranscriptSchema = z.strictObject({
  /** câu mà STT giả "nghe được"; chuỗi rỗng là im lặng */
  final: z.string(),
  interim: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const ManifestItemSchema = z.strictObject({
  id: z.string().regex(SAFE_ID, SAFE_ID_MESSAGE),
  /** tệp âm thanh, tính từ thư mục chứa manifest: WAV PCM16 mono 16 kHz (.wav) hoặc PCM thô (.pcm, .raw) */
  file: nonBlank,
  speaker: z.string().regex(SAFE_ID, SAFE_ID_MESSAGE),
  age: z.number().int().min(0).max(120).optional(),
  region: nonBlank.optional(),
  /** câu chuẩn bằng chữ, đúng như người nói được yêu cầu đọc */
  reference: z.string().refine((s) => /[\p{L}\p{N}]/u.test(s), 'câu chuẩn phải có chữ'),
  entities: EntitiesSchema.default({ people: [], amountsVnd: [], dates: [] }),
  fake: FakeTranscriptSchema.optional(),
});

export const ManifestSchema = z
  .strictObject({
    description: z.string().optional(),
    /** mốc "bây giờ" khi các câu được nói, để quy "ngày mai", "thứ Tư", "ngày bảy tháng mười" ra ngày cụ thể */
    now: InstantSchema.optional(),
    items: z.array(ManifestItemSchema).min(1, 'manifest phải có ít nhất một mục'),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.items.forEach((item, index) => {
      if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: ['items', index, 'id'], message: 'id bị trùng' });
      seen.add(item.id);
    });
  });

export type Entities = z.infer<typeof EntitiesSchema>;
export type FakeTranscript = z.infer<typeof FakeTranscriptSchema>;
export type ManifestItem = z.infer<typeof ManifestItemSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export class ManifestError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Manifest không hợp lệ:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ManifestError';
    this.issues = issues;
  }
}

function formatPath(path: PropertyKey[], raw: unknown): string {
  let out = '';
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : out ? `.${String(part)}` : String(part);
  // Thêm id của mục (đã qua kiểm mã an toàn) để tìm cho nhanh trong tệp dài.
  if (path[0] === 'items' && typeof path[1] === 'number' && typeof raw === 'object' && raw !== null) {
    const items = (raw as { items?: unknown }).items;
    const item = Array.isArray(items) ? (items[path[1]] as unknown) : undefined;
    const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && SAFE_ID.test(id)) out += ` (${id})`;
  }
  return out || '(gốc)';
}

/** Kiểm dữ liệu đã đọc từ JSON. Ném `ManifestError` liệt kê mọi chỗ sai. */
export function parseManifest(raw: unknown): Manifest {
  const parsed = ManifestSchema.safeParse(raw, { error: z.locales.vi().localeError });
  if (!parsed.success) throw new ManifestError(parsed.error.issues.map((i) => `${formatPath(i.path, raw)}: ${i.message}`));
  return parsed.data;
}

export type LoadedManifest = {
  manifest: Manifest;
  /** thư mục chứa manifest, gốc để tìm tệp âm thanh */
  baseDir: string;
};

/** Đọc và kiểm tệp manifest. Không chép nội dung tệp vào thông báo lỗi (có thể chứa câu nói). */
export function loadManifest(path: string): LoadedManifest {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ManifestError([`không đọc được tệp manifest ${path}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManifestError([`${path} không phải JSON hợp lệ (kiểm dấu phẩy, ngoặc, dấu nháy)`]);
  }
  return { manifest: parseManifest(raw), baseDir: dirname(resolve(path)) };
}

export function resolveAudioPath(baseDir: string, file: string): string {
  return isAbsolute(file) ? file : resolve(baseDir, file);
}

/** Nhóm câu để tách số liệu (SPEC 6.2.1 điều 3): có tên, có tiền, có ngày. Một câu có thể thuộc nhiều nhóm. */
export type SentenceGroup = 'name' | 'money' | 'date';

export const SENTENCE_GROUPS: readonly SentenceGroup[] = ['name', 'money', 'date'];

export function itemGroups(item: Pick<ManifestItem, 'entities'>): Record<SentenceGroup, boolean> {
  const e = item.entities;
  return { name: e.people.length + (e.units?.length ?? 0) > 0, money: e.amountsVnd.length > 0, date: e.dates.length > 0 };
}

const keyOf = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Danh sách `keyterm` của cấu hình `deepgram-nova3-keyterm`: tên người rồi tên đơn vị của TOÀN BỘ manifest, bỏ trùng.
 * Cố ý KHÔNG riêng từng câu: scribe không biết trước người nói sẽ nhắc ai, nên dùng danh sách riêng từng câu là gian lận.
 */
export function collectKeyterms(manifest: Manifest): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (name: string) => {
    const key = keyOf(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name.normalize('NFC').replace(/\s+/g, ' ').trim());
  };
  for (const item of manifest.items) item.entities.people.forEach(add);
  for (const item of manifest.items) (item.entities.units ?? []).forEach(add);
  return out;
}

export type SpeakerInfo = { speaker: string; age?: number; region?: string; sentences: number };

/** Người nói theo thứ tự xuất hiện đầu tiên; tuổi và vùng lấy ở mục đầu có ghi. */
export function listSpeakers(manifest: Manifest): SpeakerInfo[] {
  const map = new Map<string, SpeakerInfo>();
  for (const item of manifest.items) {
    const cur = map.get(item.speaker) ?? { speaker: item.speaker, sentences: 0 };
    cur.sentences += 1;
    if (cur.age === undefined && item.age !== undefined) cur.age = item.age;
    if (cur.region === undefined && item.region !== undefined) cur.region = item.region;
    map.set(item.speaker, cur);
  }
  return [...map.values()];
}
