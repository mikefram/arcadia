import { useState } from 'react';
import { fmt, formatDateFull, formatTime, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { PageHeader } from '@/components/ui/page-header';
import { StepDispatchProvider } from '@/features/dispatch';
import { errorMessage } from '@/lib/errors';
import { useApiQuery } from '@/lib/query';
import { ExtensionRequestsSheet } from './extension-requests-sheet';
import { NeedsAttention } from './needs-attention';
import { OverdueSection } from './overdue-section';
import { QuickStart } from './quick-start';
import { RecentActivity } from './recent-activity';
import { StatBand } from './stat-band';

const t = vi.admin.shell.overview;

/**
 * Tổng quan (SPEC 9.2): thẻ số, "Cần Chủ tịch biết", bảng việc quá hạn với thao tác hàng loạt,
 * hoạt động gần đây. Số liệu tự làm mới khi có sự kiện SSE (useLiveUpdates ở bố cục chính).
 */
export function OverviewPage() {
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const overview = useApiQuery('overview.get', {});
  const data = overview.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title={t.title}
        description={formatDateFull(Date.now())}
        meta={data ? <time dateTime={data.asOf}>{fmt(t.asOf, { giờ: formatTime(data.asOf) })}</time> : undefined}
      />

      <QuickStart />

      {overview.isError ? (
        <Callout
          tone="error"
          title={vi.admin.shell.ui.loadFailedTitle}
          action={
            <Button size="sm" onClick={() => void overview.refetch()}>
              {vi.admin.shell.ui.retry}
            </Button>
          }
        >
          {errorMessage(overview.error)}
        </Callout>
      ) : (
        <StatBand overview={data} onOpenExtensions={() => setExtensionsOpen(true)} />
      )}

      <StepDispatchProvider>
        {data ? <NeedsAttention steps={data.needsAttention} /> : null}

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 min-[1680px]:grid-cols-[minmax(0,1fr)_22rem]">
          <OverdueSection />
          <RecentActivity />
        </div>
      </StepDispatchProvider>

      <ExtensionRequestsSheet open={extensionsOpen} onOpenChange={setExtensionsOpen} />
    </div>
  );
}
