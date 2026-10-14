import { fmt, vi } from '@mihato/i18n';

const t = vi.admin.runs.files.viewer;

export type Cell = string | number | boolean | Date | null | undefined;

function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : cell.toLocaleDateString('vi-VN');
  return String(cell);
}

/** Bảng chỉ đọc cho CSV và bảng tính: mọi ô là chữ do React thoát ký tự (ô công thức chỉ hiện giá trị đã tính, không chạy gì). */
export function TableView({ rows, truncated, caption }: { rows: readonly (readonly Cell[])[]; truncated: boolean; caption: string }) {
  if (rows.length === 0) return <p className="text-ink-sub">{t.sheetEmpty}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div tabIndex={0} className="min-h-0 flex-1 overflow-auto rounded-lg border border-hairline">
        <table className="min-w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className={r === 0 ? 'bg-surface-alt font-semibold' : 'odd:bg-canvas'}>
                {row.map((cell, c) => (
                  <td key={c} className="max-w-80 border border-hairline px-2.5 py-1.5 align-top [overflow-wrap:anywhere]">
                    {cellText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated ? <p className="text-sm text-ink-sub">{fmt(t.truncated, { n: rows.length.toLocaleString('vi-VN') })}</p> : null}
    </div>
  );
}
