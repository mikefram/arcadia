/**
 * Xuất CSV cho Excel (SPEC 9.8): UTF-8 có BOM để Excel mở đúng dấu tiếng Việt, xuống dòng CRLF,
 * thoát dấu phẩy, dấu nháy kép và xuống dòng theo RFC 4180.
 */
export type CsvValue = string | number | bigint | boolean | null | undefined;
export type CsvColumn<T> = { header: string; value: (row: T) => CsvValue };

const BOM = '﻿';

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  // Chuẩn NFC để dấu tiếng Việt không bị tách rời khi mở bằng Excel.
  let text = value.normalize('NFC');
  // Ô chữ bắt đầu bằng = + - @ bị Excel hiểu là công thức: chèn dấu nháy đơn để giữ nguyên là chữ.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

/** Tải tệp CSV về máy. `fileName` không cần đuôi. */
export function downloadCsv<T>(fileName: string, rows: readonly T[], columns: readonly CsvColumn<T>[]): void {
  const blob = new Blob([toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
