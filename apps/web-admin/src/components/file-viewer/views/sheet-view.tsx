import { useEffect, useState } from 'react';
import readXlsxFile from 'read-excel-file/browser';
import { cn } from '@/lib/cn';
import { limitTable } from '@/lib/file-preview';
import { TableView, type Cell } from './table-view';
import type { ViewProps } from './types';

type Sheet = { name: string; rows: Cell[][]; truncated: boolean };

/** Bảng tính .xlsx: đọc bằng read-excel-file (không chạy macro, không đọc công thức ngoài giá trị đã tính), mỗi trang tính một thẻ. */
export default function SheetView({ blob, name, onFail }: ViewProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readXlsxFile(blob)
      .then((parsed) => {
        if (cancelled) return;
        setSheets(
          parsed.map((s) => {
            const cut = limitTable<Cell>(s.data as Cell[][]);
            return { name: s.sheet, rows: cut.rows, truncated: cut.truncated };
          }),
        );
      })
      .catch(() => onFail());
    return () => {
      cancelled = true;
    };
  }, [blob, onFail]);
  if (!sheets) return null;
  const current = sheets[Math.min(active, sheets.length - 1)];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {sheets.length > 1 ? (
        <div role="tablist" className="flex flex-wrap gap-1">
          {sheets.map((s, i) => (
            <button
              key={`${i}-${s.name}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={cn('min-h-9 rounded-lg border px-3 text-sm font-medium', i === active ? 'border-primary bg-primary-tint text-on-primary-tint' : 'border-hairline bg-surface hover:bg-surface-alt')}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      {current ? <TableView rows={current.rows} truncated={current.truncated} caption={`${name}: ${current.name}`} /> : null}
    </div>
  );
}
