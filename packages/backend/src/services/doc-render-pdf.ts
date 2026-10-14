import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import type { DocBlock, RenderInput } from './doc-render';

/**
 * Dựng bản PDF của tệp tổng hợp (docs/DECISIONS.md, 06/10/2026) từ cùng `RenderInput` với bản Word, nên hai tệp luôn cùng nội dung.
 * Bố cục theo bản Word: khổ A4, lề 2 / 2 / 3 / 1,5 cm, chữ 13 pt, giãn dòng 1,3. Phông Tinos (tương thích số đo với Times New Roman,
 * giấy phép OFL, có đủ chữ tiếng Việt) được nhúng vào tệp, nên PDF đọc đúng trên máy không có phông. Hàm này chỉ vẽ, không đọc CSDL;
 * ngày tạo lấy từ ngày lập của văn bản nên cùng đầu vào cho ra cùng tệp.
 */

const FONT_DIR = '../../assets/fonts/';
const fontFile = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`${FONT_DIR}${name}`, import.meta.url)));

let fonts: { regular: Buffer; bold: Buffer; italic: Buffer; boldItalic: Buffer } | null = null;
function loadFonts() {
  fonts ??= {
    regular: fontFile('Tinos_400Regular.ttf'),
    bold: fontFile('Tinos_700Bold.ttf'),
    italic: fontFile('Tinos_400Regular_Italic.ttf'),
    boldItalic: fontFile('Tinos_700Bold_Italic.ttf'),
  };
  return fonts;
}

const CM = 72 / 2.54;
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 2 * CM, bottom: 2 * CM, left: 3 * CM, right: 1.5 * CM };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right;
const BODY = 13;
/** Giãn dòng 1,3 như bản Word: phần thêm là 0,3 chiều cao một dòng của phông. */
const EXTRA_LEADING = 0.3;
const FIRST_LINE_INDENT = 1 * CM;

type Align = 'left' | 'center' | 'justify';
type Style = { size?: number; bold?: boolean; italic?: boolean; align?: Align; after?: number; indent?: boolean; /** tiêu đề: không đứng một mình cuối trang */ keepNext?: boolean };
type Line = { text: string; style?: Style };

const nfc = (s: string): string => s.normalize('NFC');
const toRoman = (n: number): string => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'][n - 1] ?? String(n);

/** Số `n` tính bằng nửa-twip của Word (1/20 điểm) sang điểm của PDF. */
const pt = (twips: number): number => twips / 20;

class Page {
  readonly doc: InstanceType<typeof PDFDocument>;

  constructor(input: RenderInput) {
    const f = loadFonts();
    this.doc = new PDFDocument({
      size: 'A4',
      margins: MARGIN,
      bufferPages: true,
      info: {
        Title: nfc(input.title),
        Author: nfc(input.orgName),
        Producer: 'MIHATO',
        Creator: 'MIHATO',
        CreationDate: new Date(Date.UTC(input.year, input.month - 1, input.day)),
      },
    });
    this.doc.registerFont('regular', f.regular);
    this.doc.registerFont('bold', f.bold);
    this.doc.registerFont('italic', f.italic);
    this.doc.registerFont('boldItalic', f.boldItalic);
  }

  private apply(s: Style): number {
    const family = s.bold && s.italic ? 'boldItalic' : s.bold ? 'bold' : s.italic ? 'italic' : 'regular';
    this.doc.font(family).fontSize(s.size ?? BODY);
    return this.doc.currentLineHeight() * EXTRA_LEADING;
  }

  private options(s: Style, width: number, leading: number) {
    return { width, align: s.align ?? 'left', lineGap: leading, indent: s.indent ? FIRST_LINE_INDENT : 0 };
  }

  /** Chiều cao một dòng chữ khi vẽ trong cột rộng `width`, chưa tính khoảng cách sau. */
  private heightOf(line: Line, width: number): number {
    const s = line.style ?? {};
    const leading = this.apply(s);
    return line.text === '' ? this.doc.currentLineHeight() : this.doc.heightOfString(nfc(line.text), this.options(s, width, leading));
  }

  /** Chiều cao cả cột gồm khoảng cách sau từng dòng. */
  columnHeight(lines: Line[], width: number): number {
    return lines.reduce((sum, l) => sum + this.heightOf(l, width) + pt(l.style?.after ?? 120), 0);
  }

  /** Vẽ một cột chữ tại (x, y); trả về y sau dòng cuối. */
  column(lines: Line[], x: number, y: number, width: number): number {
    let cursor = y;
    for (const l of lines) {
      const s = l.style ?? {};
      const leading = this.apply(s);
      const h = this.heightOf(l, width);
      if (l.text !== '') this.doc.text(nfc(l.text), x, cursor, this.options(s, width, leading));
      cursor += h + pt(s.after ?? 120);
    }
    return cursor;
  }

  /** Vẽ nối tiếp theo chiều dọc ở bề rộng cả trang chữ; chữ dài tự sang trang. */
  flow(lines: Line[]): void {
    for (const [i, l] of lines.entries()) {
      const s = l.style ?? {};
      if (s.keepNext && this.y > MARGIN.top) {
        // Chuỗi tiêu đề liên tiếp phải có chỗ cho ít nhất một dòng của đoạn nội dung liền sau, không thì sang trang mới.
        let need = 0;
        for (let j = i; j < lines.length; j++) {
          const lj = lines[j]!;
          const sj = lj.style ?? {};
          const lead = this.apply(sj);
          if (sj.keepNext) need += this.heightOf(lj, CONTENT_W) + pt(sj.after ?? 120);
          else {
            need += this.doc.currentLineHeight() + lead;
            break;
          }
        }
        if (this.y + need > this.bottom) this.doc.addPage();
      }
      const leading = this.apply(s);
      if (l.text === '') {
        this.doc.y += this.doc.currentLineHeight() + pt(s.after ?? 120);
        continue;
      }
      this.doc.text(nfc(l.text), MARGIN.left, this.doc.y, this.options(s, CONTENT_W, leading));
      this.doc.y += pt(s.after ?? 120);
    }
  }

  get y(): number {
    return this.doc.y;
  }
  set y(v: number) {
    this.doc.y = v;
  }
  get bottom(): number {
    return PAGE.height - MARGIN.bottom;
  }

  /** Hai cột cạnh nhau không bị cắt ngang trang: không đủ chỗ thì sang trang mới. */
  twoColumns(left: Line[], leftW: number, right: Line[], rightW: number): void {
    const height = Math.max(this.columnHeight(left, leftW), this.columnHeight(right, rightW));
    if (this.y + height > this.bottom && this.y > MARGIN.top) {
      this.doc.addPage();
      this.y = MARGIN.top;
    }
    const top = this.y;
    const a = this.column(left, MARGIN.left, top, leftW);
    const b = this.column(right, MARGIN.left + leftW, top, rightW);
    this.y = Math.max(a, b);
  }

  /** Đánh số trang "Trang n/N" ở lề dưới khi văn bản dài hơn một trang. */
  numberPages(): void {
    const range = this.doc.bufferedPageRange();
    if (range.count < 2) return;
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);
      const bottom = this.doc.page.margins.bottom;
      // Hạ lề dưới về 0 để chữ ở lề không làm PDFKit sang trang mới.
      this.doc.page.margins.bottom = 0;
      this.apply({ size: 11, italic: true });
      this.doc.text(`Trang ${i + 1}/${range.count}`, MARGIN.left, PAGE.height - 1.2 * CM, { width: CONTENT_W, align: 'center', lineBreak: false });
      this.doc.page.margins.bottom = bottom;
    }
  }

  async finish(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    this.doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(chunks)));
      this.doc.on('error', reject);
    });
    this.numberPages();
    this.doc.end();
    return done;
  }
}

function blockLines(blocks: DocBlock[]): Line[] {
  const out: Line[] = [];
  for (const b of blocks) {
    if (b.kind === 'paragraph') out.push({ text: b.text, style: { indent: true, align: 'justify' } });
    else if (b.kind === 'subheading') out.push({ text: b.text, style: { bold: true, italic: true, after: 60, keepNext: true } });
    else for (const item of b.items) out.push({ text: `- ${item}`, style: { after: 60 } });
  }
  return out;
}

function official(page: Page, input: RenderInput): void {
  const leftW = CONTENT_W * 0.42;
  const rightW = CONTENT_W * 0.58;
  page.twoColumns(
    [
      { text: input.orgName.toLocaleUpperCase('vi-VN'), style: { bold: true, align: 'center', after: 40 } },
      { text: `Số: ${input.number ?? '……'}`, style: { align: 'center', after: 40 } },
    ],
    leftW,
    [
      { text: 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', style: { bold: true, align: 'center', after: 0, size: 12 } },
      { text: 'Độc lập - Tự do - Hạnh phúc', style: { bold: true, align: 'center', after: 40 } },
      { text: `……………, ngày ${input.day} tháng ${input.month} năm ${input.year}`, style: { italic: true, align: 'center' } },
    ],
    rightW,
  );
  const body: Line[] = [{ text: '', style: { after: 120 } }, { text: `V/v ${input.title}`, style: { bold: true, align: 'center', after: 240 } }];
  if (input.recipient) body.push({ text: `Kính gửi: ${input.recipient}`, style: { bold: true, align: 'center', after: 240 } });
  for (const s of input.sections) {
    if (s.heading) body.push({ text: s.heading, style: { bold: true, after: 80, keepNext: true } });
    body.push(...blockLines(s.blocks));
  }
  if (input.attachments.length > 0) {
    body.push({ text: 'Tài liệu đính kèm:', style: { bold: true, after: 60, keepNext: true } });
    for (const a of input.attachments) body.push({ text: `- ${a}`, style: { after: 40 } });
  }
  body.push({ text: '', style: { after: 240 } });
  page.flow(body);
  page.twoColumns(
    [
      { text: 'Nơi nhận:', style: { bold: true, italic: true, after: 40, size: 12 } },
      { text: input.recipient ? `- ${input.recipient};` : '- ……;', style: { after: 20, size: 11 } },
      { text: '- Lưu: VT.', style: { after: 20, size: 11 } },
    ],
    CONTENT_W * 0.5,
    [
      { text: '(CHỨC VỤ NGƯỜI KÝ)', style: { bold: true, align: 'center', after: 40 } },
      { text: '(Ký, ghi rõ họ tên và đóng dấu)', style: { italic: true, align: 'center', after: 600 } },
      ...(input.preparedBy ? [{ text: `Người soạn thảo: ${input.preparedBy}`, style: { align: 'center' as const, size: 11 } }] : []),
    ],
    CONTENT_W * 0.5,
  );
}

function report(page: Page, input: RenderInput): void {
  const body: Line[] = [
    { text: input.orgName.toLocaleUpperCase('vi-VN'), style: { bold: true, align: 'center', after: 40 } },
    { text: input.title.toLocaleUpperCase('vi-VN'), style: { bold: true, align: 'center', size: 15, after: 120 } },
    { text: `Ngày lập: ${input.dateText}${input.preparedBy ? `. Người tổng hợp: ${input.preparedBy}` : ''}`, style: { italic: true, align: 'center', after: 240 } },
  ];
  input.sections.forEach((s, i) => {
    if (s.heading) body.push({ text: `${toRoman(i + 1)}. ${s.heading}`, style: { bold: true, after: 80, keepNext: true } });
    body.push(...blockLines(s.blocks));
  });
  if (input.attachments.length > 0) {
    body.push({ text: 'Tài liệu đính kèm', style: { bold: true, after: 60, keepNext: true } });
    for (const a of input.attachments) body.push({ text: `- ${a}`, style: { after: 40 } });
  }
  page.flow(body);
}

/** Dựng PDF; cùng đầu vào cho ra cùng tệp. */
export async function renderPdf(input: RenderInput): Promise<Buffer> {
  const page = new Page(input);
  if (input.layout === 'official') official(page, input);
  else report(page, input);
  return page.finish();
}
