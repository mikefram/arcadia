import { AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

/**
 * Dựng tệp Word (.docx) từ nội dung đã giải quyết xong (docs/DECISIONS.md, 06/10/2026). Hàm này chỉ vẽ, không đọc CSDL:
 * việc lấy dữ liệu của lượt chạy nằm ở compile.ts. Hai kiểu trình bày: `official` theo khổ công văn (quốc hiệu, tiêu ngữ, số,
 * trích yếu, nơi nhận, chữ ký; Times New Roman 13) và `report` cho báo cáo tổng hợp. Mọi chữ do người dùng nhập đi qua
 * TextRun nên không thể chèn định dạng hay macro.
 */
export type DocBlock = { kind: 'paragraph'; text: string } | { kind: 'subheading'; text: string } | { kind: 'list'; items: string[] };
export type DocSectionOut = { heading: string; blocks: DocBlock[] };

export type RenderInput = {
  layout: 'official' | 'report';
  orgName: string;
  /** trích yếu (official) hoặc tiêu đề báo cáo (report) */
  title: string;
  /** số văn bản đã cấp; trống thì in chỗ trống để điền tay */
  number: string | null;
  /** ngày lập, đã định dạng dd/mm/yyyy */
  dateText: string;
  day: number;
  month: number;
  year: number;
  recipient: string | null;
  preparedBy: string | null;
  sections: DocSectionOut[];
  attachments: string[];
};

const FONT = 'Times New Roman';
const SIZE = 26; // 13 pt tính bằng nửa điểm
const run = (text: string, o: { bold?: boolean; italics?: boolean; size?: number; underline?: boolean } = {}) =>
  new TextRun({ text, font: FONT, size: o.size ?? SIZE, bold: o.bold, italics: o.italics, ...(o.underline ? { underline: {} } : {}) });
const line = (text: string, o: { bold?: boolean; italics?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number; indent?: boolean } = {}) =>
  new Paragraph({
    alignment: o.align ?? AlignmentType.LEFT,
    spacing: { after: o.after ?? 120, line: 312 },
    ...(o.indent ? { indent: { firstLine: 567 } } : {}),
    children: [run(text, o)],
  });

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE } as const;
const cell = (children: Paragraph[], width: number) => new TableCell({ width: { size: width, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, children });

function blocksToParagraphs(blocks: DocBlock[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const b of blocks) {
    if (b.kind === 'paragraph') out.push(line(b.text, { indent: true, align: AlignmentType.JUSTIFIED }));
    else if (b.kind === 'subheading') out.push(line(b.text, { bold: true, italics: true, after: 60 }));
    else for (const item of b.items) out.push(line(`- ${item}`, { after: 60 }));
  }
  return out;
}

function official(input: RenderInput): Paragraph[] | (Paragraph | Table)[] {
  const header = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { ...NO_BORDERS, insideHorizontal: NONE, insideVertical: NONE },
    rows: [
      new TableRow({
        children: [
          cell(
            [
              line(input.orgName.toLocaleUpperCase('vi-VN'), { bold: true, align: AlignmentType.CENTER, after: 40 }),
              line(`Số: ${input.number ?? '……'}`, { align: AlignmentType.CENTER, after: 40 }),
            ],
            42,
          ),
          cell(
            [
              line('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', { bold: true, align: AlignmentType.CENTER, after: 0, size: 24 }),
              line('Độc lập - Tự do - Hạnh phúc', { bold: true, align: AlignmentType.CENTER, after: 40 }),
              line(`……………, ngày ${input.day} tháng ${input.month} năm ${input.year}`, { italics: true, align: AlignmentType.CENTER }),
            ],
            58,
          ),
        ],
      }),
    ],
  });
  const body: (Paragraph | Table)[] = [header, line('', { after: 120 }), line(`V/v ${input.title}`, { bold: true, align: AlignmentType.CENTER, after: 240 })];
  if (input.recipient) body.push(line(`Kính gửi: ${input.recipient}`, { bold: true, align: AlignmentType.CENTER, after: 240 }));
  for (const s of input.sections) {
    if (s.heading) body.push(line(s.heading, { bold: true, after: 80 }));
    body.push(...blocksToParagraphs(s.blocks));
  }
  if (input.attachments.length > 0) {
    body.push(line('Tài liệu đính kèm:', { bold: true, after: 60 }));
    for (const a of input.attachments) body.push(line(`- ${a}`, { after: 40 }));
  }
  const footer = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { ...NO_BORDERS, insideHorizontal: NONE, insideVertical: NONE },
    rows: [
      new TableRow({
        children: [
          cell(
            [line('Nơi nhận:', { bold: true, italics: true, after: 40, size: 24 }), line(input.recipient ? `- ${input.recipient};` : '- ……;', { after: 20, size: 22 }), line('- Lưu: VT.', { after: 20, size: 22 })],
            50,
          ),
          cell(
            [
              line('(CHỨC VỤ NGƯỜI KÝ)', { bold: true, align: AlignmentType.CENTER, after: 40 }),
              line('(Ký, ghi rõ họ tên và đóng dấu)', { italics: true, align: AlignmentType.CENTER, after: 600 }),
              ...(input.preparedBy ? [line(`Người soạn thảo: ${input.preparedBy}`, { align: AlignmentType.CENTER, size: 22 })] : []),
            ],
            50,
          ),
        ],
      }),
    ],
  });
  body.push(line('', { after: 240 }), footer);
  return body;
}

function report(input: RenderInput): Paragraph[] {
  const body: Paragraph[] = [
    line(input.orgName.toLocaleUpperCase('vi-VN'), { bold: true, align: AlignmentType.CENTER, after: 40 }),
    line(input.title.toLocaleUpperCase('vi-VN'), { bold: true, align: AlignmentType.CENTER, size: 30, after: 120 }),
    line(`Ngày lập: ${input.dateText}${input.preparedBy ? `. Người tổng hợp: ${input.preparedBy}` : ''}`, { italics: true, align: AlignmentType.CENTER, after: 240 }),
  ];
  input.sections.forEach((s, i) => {
    if (s.heading) body.push(line(`${toRoman(i + 1)}. ${s.heading}`, { bold: true, after: 80 }));
    body.push(...blocksToParagraphs(s.blocks));
  });
  if (input.attachments.length > 0) {
    body.push(line('Tài liệu đính kèm', { bold: true, after: 60 }));
    for (const a of input.attachments) body.push(line(`- ${a}`, { after: 40 }));
  }
  return body;
}

const toRoman = (n: number): string => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'][n - 1] ?? String(n);

export async function renderDocx(input: RenderInput): Promise<Buffer> {
  const children = input.layout === 'official' ? official(input) : report(input);
  const doc = new Document({
    creator: input.orgName,
    title: input.title,
    styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1701, right: 850 } } }, children }],
  });
  return Packer.toBuffer(doc);
}
