import { Hammer } from 'lucide-react';
import { vi } from '@mihato/i18n';
import { EmptyState } from './ui/empty-state';
import { PageHeader } from './ui/page-header';

/** Trang giữ chỗ cho màn hình chưa viết. Agent của từng phần thay bằng màn hình thật trong thư mục tính năng của mình. */
export function PlaceholderPage({ title, description }: { title: string; description?: string }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <div className="rounded-xl border border-dashed border-line bg-surface">
        <EmptyState icon={Hammer} title={vi.admin.shell.ui.building} />
      </div>
    </>
  );
}
