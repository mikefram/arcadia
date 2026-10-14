import { useEffect, useState } from 'react';
import { limitTable, parseCsv } from '@/lib/file-preview';
import { TableView } from './table-view';
import type { ViewProps } from './types';

export default function CsvView({ blob, name, onFail }: ViewProps) {
  const [table, setTable] = useState<{ rows: string[][]; truncated: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    blob
      .text()
      .then((text) => {
        if (cancelled) return;
        const parsed = parseCsv(text);
        const cut = limitTable(parsed.rows);
        setTable({ rows: cut.rows, truncated: parsed.truncated || cut.truncated });
      })
      .catch(() => onFail());
    return () => {
      cancelled = true;
    };
  }, [blob, onFail]);
  if (!table) return null;
  return <TableView rows={table.rows} truncated={table.truncated} caption={name} />;
}
