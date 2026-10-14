import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type Row,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { fmt, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { viCollator } from '@/lib/collator';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { EmptyState } from './empty-state';
import { Skeleton } from './skeleton';

const t = vi.admin.shell.ui;

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** canh lề của cột; số nên canh phải */
    align?: 'left' | 'right';
    /** lớp thêm cho ô đầu cột và ô dữ liệu, thường là độ rộng: 'w-40' */
    className?: string;
  }
}

// ───────────────────────── Các mảnh bảng thô, cho bảng tĩnh không cần TanStack Table ─────────────────────────

export function TableFrame({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('overflow-hidden rounded-xl border border-hairline bg-surface', className)} {...props} />;
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    // `relative`: phần tử sr-only (position: absolute) trong bảng phải bị cắt theo vùng cuộn ngang này, không làm trang tràn ngang.
    <div className="relative overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-base', className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return <th scope="col" className={cn('h-10 border-b border-hairline bg-surface-alt px-3 text-sm font-semibold whitespace-nowrap text-ink-sub first:pl-4 last:pr-4', className)} {...props} />;
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('border-b border-hairline px-3 py-2.5 align-top first:pl-4 last:pr-4', className)} {...props} />;
}

// ───────────────────────── DataTable ─────────────────────────

/** Sắp xếp mặc định: số theo số, chữ theo thứ tự tiếng Việt (Intl.Collator('vi')), ô trống xuống cuối. */
function viSortingFn<T>(a: Row<T>, b: Row<T>, columnId: string): number {
  const x = a.getValue(columnId);
  const y = b.getValue(columnId);
  if (x === null || x === undefined || x === '') return y === null || y === undefined || y === '' ? 0 : 1;
  if (y === null || y === undefined || y === '') return -1;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return viCollator.compare(String(x), String(y));
}

export type DataTableProps<T> = {
  /**
   * Khai báo cột kiểu `ColumnDef<T>[]`; trong `cell` đọc `row.original` (đã có kiểu T).
   * Cột sắp xếp được cần `accessorKey` hoặc `accessorFn`; cột không sắp đặt `enableSorting: false`.
   */
  columns: ColumnDef<T>[];
  data: readonly T[];
  getRowId: (row: T) => string;
  /** tên bảng cho trình đọc màn hình */
  caption: string;

  /** sắp xếp do máy chủ làm: truyền cả `sorting` và `onSortingChange`, đặt `manualSorting` */
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  manualSorting?: boolean;

  /** chọn nhiều dòng: bật `selectable` và giữ trạng thái ở màn hình (khoá là getRowId) */
  selectable?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  /** tên dòng cho nhãn ô chọn: "Chọn dòng: Đặt xe đón đoàn" */
  rowLabel?: (row: T) => string;

  /** lần tải đầu: hiện các dòng giữ chỗ */
  isLoading?: boolean;
  /** nội dung khi không có dòng nào; mặc định "Chưa có gì ở đây" */
  empty?: ReactNode;

  /** phân trang con trỏ (SPEC 10.1): còn trang sau thì hiện nút "Tải thêm" */
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;

  /** tô nền cả dòng; `late` CHỈ cho việc quá hạn */
  rowTone?: (row: T) => 'late' | 'warn' | undefined;
  onRowClick?: (row: T) => void;
  className?: string;
  /**
   * Lớp cho thẻ <table>. Bảng nhiều cột nên dùng 'table-fixed min-w-[880px]' và đặt độ rộng từng cột
   * bằng `meta.className` ('w-[170px]'): cột không đặt độ rộng nhận phần còn lại, chữ dài cắt được bằng `truncate`.
   */
  tableClassName?: string;
};

/**
 * Bảng dữ liệu bọc TanStack Table: sắp xếp, chọn nhiều dòng, "Tải thêm", trạng thái rỗng và đang tải.
 * Mẫu dùng ở src/features/overview/overdue-table.tsx.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  caption,
  sorting,
  onSortingChange,
  manualSorting = false,
  selectable = false,
  rowSelection,
  onRowSelectionChange,
  rowLabel,
  isLoading = false,
  empty,
  hasMore = false,
  onLoadMore,
  isLoadingMore = false,
  rowTone,
  onRowClick,
  className,
  tableClassName,
}: DataTableProps<T>) {
  const [innerSorting, setInnerSorting] = useState<SortingState>([]);
  const [innerSelection, setInnerSelection] = useState<RowSelectionState>({});

  const table = useReactTable<T>({
    data: data as T[],
    columns,
    getRowId,
    state: { sorting: sorting ?? innerSorting, rowSelection: rowSelection ?? innerSelection },
    onSortingChange: onSortingChange ?? setInnerSorting,
    onRowSelectionChange: onRowSelectionChange ?? setInnerSelection,
    enableRowSelection: selectable,
    manualSorting,
    enableSortingRemoval: true,
    defaultColumn: { sortingFn: viSortingFn },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const columnCount = table.getVisibleLeafColumns().length + (selectable ? 1 : 0);
  const allSelected = table.getIsAllRowsSelected();
  const someSelected = table.getIsSomeRowsSelected();

  return (
    <TableFrame className={className}>
      <Table aria-busy={isLoading || undefined} className={tableClassName}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {selectable ? (
                <Th className="w-10 pr-0">
                  <Checkbox
                    aria-label={t.selectAllRows}
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)}
                    disabled={rows.length === 0}
                    className="align-middle"
                  />
                </Th>
              ) : null}
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                const sorted = header.column.getIsSorted();
                const label = header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext());
                return (
                  <Th
                    key={header.id}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : header.column.getCanSort() ? 'none' : undefined}
                    className={cn(meta?.align === 'right' && 'text-right', meta?.className)}
                  >
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        title={typeof header.column.columnDef.header === 'string' ? fmt(t.sortBy, { cột: header.column.columnDef.header }) : undefined}
                        className={cn(
                          '-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-semibold transition-colors hover:bg-hairline/60 hover:text-ink',
                          meta?.align === 'right' && 'flex-row-reverse',
                          sorted && 'text-ink',
                        )}
                      >
                        {label}
                        {sorted === 'asc' ? (
                          <ArrowUp aria-hidden="true" className="size-3.5" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown aria-hidden="true" className="size-3.5" />
                        ) : (
                          <ArrowUpDown aria-hidden="true" className="size-3.5 opacity-60" />
                        )}
                      </button>
                    ) : (
                      label
                    )}
                  </Th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {isLoading ? (
            Array.from({ length: 5 }, (_, i) => (
              <tr key={i}>
                {Array.from({ length: columnCount }, (_, j) => (
                  <Td key={j}>
                    <Skeleton className={cn('h-5', j === 0 && selectable ? 'w-5' : 'w-full max-w-48')} />
                  </Td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount}>{empty ?? <EmptyState title={t.emptyTitle} />}</td>
            </tr>
          ) : (
            rows.map((row) => {
              const tone = rowTone?.(row.original);
              const selected = row.getIsSelected();
              return (
                <tr
                  key={row.id}
                  data-selected={selected || undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cn(
                    'transition-colors [&:last-child>td]:border-b-0 hover:bg-canvas',
                    tone === 'late' && 'bg-late-bg/45 hover:bg-late-bg/70',
                    tone === 'warn' && 'bg-warn-bg/45 hover:bg-warn-bg/70',
                    selected && 'bg-primary-tint/60 hover:bg-primary-tint/80',
                    onRowClick && 'cursor-pointer',
                  )}
                >
                  {selectable ? (
                    <Td className="w-10 pr-0" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        aria-label={rowLabel ? fmt(t.selectRow, { tên: rowLabel(row.original) }) : t.selectRowPlain}
                        checked={selected}
                        disabled={!row.getCanSelect()}
                        onCheckedChange={(v) => row.toggleSelected(v === true)}
                        className="mt-0.5"
                      />
                    </Td>
                  ) : null}
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta;
                    return (
                      <Td key={cell.id} className={cn(meta?.align === 'right' && 'text-right', meta?.className)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </Td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </Table>
      {hasMore && !isLoading ? (
        <div className="flex justify-center border-t border-hairline bg-canvas px-4 py-2.5">
          <Button variant="ghost" size="sm" loading={isLoadingMore} onClick={onLoadMore}>
            {isLoadingMore ? t.loadingMore : t.loadMore}
          </Button>
        </div>
      ) : null}
    </TableFrame>
  );
}

/** Các dòng đang được chọn, theo đúng thứ tự của `data`. */
export function selectedRows<T>(data: readonly T[], selection: RowSelectionState, getRowId: (row: T) => string): T[] {
  return data.filter((row) => selection[getRowId(row)]);
}
