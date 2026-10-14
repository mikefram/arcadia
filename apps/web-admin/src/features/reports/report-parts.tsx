import type { ReactNode } from 'react';
import { Download, Info } from 'lucide-react';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

const t = vi.admin.org.reports;

/** Tỷ lệ 0..1 → "90%"; chưa có mẫu số thì "Chưa có". */
export const percent = (rate: number | null): string => (rate === null ? t.noRate : `${Math.round(rate * 100)}%`);
/** Số thập phân viết theo tiếng Việt: 1,5. */
export const decimal = (n: number): string => n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/**
 * Tỷ lệ kèm thanh ngang (CSS, màu token; không dùng thư viện biểu đồ). Con số luôn hiện bằng chữ mực;
 * thanh chỉ để so nhanh giữa các dòng. `late` chỉ dùng cho tỷ lệ quá hạn.
 */
export function RateMeter({ rate, tone = 'primary' }: { rate: number | null; tone?: 'primary' | 'late' }) {
  if (rate === null) return <span className="text-ink-sub">{t.noRate}</span>;
  const pct = Math.round(rate * 100);
  return (
    <div className="flex items-center gap-2.5">
      <span className="tabular w-10 shrink-0 text-right font-medium">{pct}%</span>
      <span aria-hidden="true" className={cn('h-2 min-w-12 flex-1 overflow-hidden rounded-r-[4px]', tone === 'late' ? 'bg-late-bg' : 'bg-primary-tint')}>
        <span className={cn('block h-full rounded-r-[4px]', tone === 'late' ? 'bg-late' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

/** Độ lớn không có trần (số ngày xử lý): số đứng trước, thanh ngang so với giá trị lớn nhất trong nhóm. */
export function MagnitudeBar({ value, max, label }: { value: number | null; max: number; label: string }) {
  if (value === null) return <span className="text-ink-sub">{t.noRate}</span>;
  const pct = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2.5">
      <span className="tabular w-[4.75rem] shrink-0 text-right font-medium whitespace-nowrap">{label}</span>
      <span aria-hidden="true" className="block min-w-12 flex-1">
        <span className="block h-2 rounded-r-[4px] bg-gold" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

/** Nhãn thẻ số kèm nút ⓘ: rê chuột hoặc focus để đọc định nghĩa của chỉ số (SPEC 9.6). */
export function StatLabel({ label, definition }: { label: string; definition: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <Tooltip content={definition}>
        <button type="button" aria-label={fmt(t.definitionOf, { tên: label })} className="relative z-10 inline-flex size-5 items-center justify-center rounded-full text-ink-sub transition-colors hover:bg-surface-alt hover:text-ink">
          <Info aria-hidden="true" className="size-3.5" />
        </button>
      </Tooltip>
    </span>
  );
}

/** Một khối bảng của báo cáo: tiêu đề, dòng định nghĩa, nút "Xuất CSV", rồi bảng. */
export function ReportSection({ id, title, description, onExport, canExport, children }: { id: string; title: string; description: string; onExport: () => void; canExport: boolean; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          <p className="max-w-[80ch] text-sm text-ink-sub">{description}</p>
        </div>
        <Button size="sm" disabled={!canExport} aria-label={fmt(t.exportFor, { tên: title })} onClick={onExport}>
          <Download aria-hidden="true" />
          {t.exportCsv}
        </Button>
      </div>
      {children}
    </section>
  );
}
