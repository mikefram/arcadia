import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Đọc một tệp PDF đã dựng: số trang, tiêu đề trong hồ sơ tệp và chữ của mọi trang (khoảng trắng gộp lại). Chỉ dùng trong test. */
export async function readPdf(data: Buffer): Promise<{ pages: number; title: string; text: string; pageTexts: string[] }> {
  const task = getDocument({ data: new Uint8Array(data), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const parts: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      parts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }
    const meta = await doc.getMetadata();
    const info = meta.info as { Title?: string };
    const clean = (s: string) => s.replace(/\s+/g, ' ').normalize('NFC').trim();
    return { pages: doc.numPages, title: info.Title ?? '', text: clean(parts.join(' ')), pageTexts: parts.map(clean) };
  } finally {
    await task.destroy();
  }
}
