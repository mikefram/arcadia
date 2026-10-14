import { inflateRawSync } from 'node:zlib';

/** Đọc một mục của tệp ZIP (docx là ZIP) bằng thư mục trung tâm. Chỉ dùng trong test để kiểm nội dung tệp Word đã dựng. */
export function readZipEntry(zip: Buffer, name: string): string | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entryName = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (entryName === name) {
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(dataStart, dataStart + compressed);
      return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Văn bản thuần trong document.xml của một tệp docx: nối nội dung các thẻ <w:t>, mỗi đoạn một dòng. */
export function docxText(zip: Buffer): string {
  const xml = readZipEntry(zip, 'word/document.xml') ?? '';
  return xml
    .split('</w:p>')
    .map((para) => [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
    .map((t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
    .filter(Boolean)
    .join('\n');
}
