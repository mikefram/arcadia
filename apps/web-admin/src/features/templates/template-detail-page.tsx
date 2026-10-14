import { useCallback, useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { TEMPLATE_DRAFT_ACTIONS, type DraftDefinition, type TemplateVersion } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useCan } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useApiQuery } from '@/lib/query';
import { Designer, type DesignerInit } from './designer/designer';

const t = vi.admin.designer.editor;
const route = getRouteApi('/shell/quy-trinh/$templateId');

/** DTO của máy chủ đọc nháp bằng schema lỏng; trình thiết kế dùng kiểu nháp của engine. Dữ liệu là một. */
const asDraft = (definition: TemplateVersion['definition']): DraftDefinition => definition as unknown as DraftDefinition;

/**
 * Một mẫu quy trình. Người có `template.edit` mở bản đang sửa (nháp, hoặc bản xuất bản mới nhất khi chưa có nháp);
 * người chỉ có `template.publish` mở bản nháp để xem và xuất bản, không sửa được; người chỉ có `template.read_published`,
 * hoặc khi có `?phienBan=n`, xem một phiên bản đã xuất bản ở chế độ chỉ đọc.
 */
export function TemplateDetailPage() {
  const { templateId } = route.useParams();
  const { phienBan } = route.useSearch();
  const can = useCan();
  const canEdit = can('template.edit');
  const canSeeDraft = can(TEMPLATE_DRAFT_ACTIONS);
  // Tăng lên mỗi lần "Tải bản mới": trình thiết kế dựng lại từ dữ liệu vừa tải.
  const [session, setSession] = useState(0);

  const detail = useApiQuery('templates.get', { params: { id: templateId } });
  const template = detail.data;
  const editing = canEdit && phienBan === undefined;
  // Người chỉ xuất bản (không sửa) mà mẫu có nháp thì xem nháp để duyệt.
  const reviewing = !canEdit && canSeeDraft && phienBan === undefined && !!template?.draft;
  // Phiên bản cần tải definition: bản được chỉ định, hoặc bản xuất bản mới nhất khi người vẽ chưa có nháp.
  const wanted = phienBan ?? (template && !((editing || reviewing) && template.draft) ? template.latestPublishedVersion : null);
  const version = useApiQuery('templates.version', { params: { id: templateId, n: wanted ?? 0 } }, { enabled: wanted !== null && wanted !== undefined });

  const { refetch: refetchDetail } = detail;
  const { refetch: refetchVersion } = version;
  const reload = useCallback(() => {
    void Promise.all([refetchDetail(), refetchVersion()]).then(() => {
      setSession((n) => n + 1);
      toast.info(t.conflict.reloaded);
    });
  }, [refetchDetail, refetchVersion]);

  const back = (
    <Button asChild variant="secondary">
      <Link to="/quy-trinh">
        <ArrowLeft aria-hidden="true" />
        {t.backToList}
      </Link>
    </Button>
  );

  let init: DesignerInit | null = null;
  if (template) {
    if (editing && template.draft) {
      init = { mode: 'edit', definition: asDraft(template.draft.definition), rev: template.draft.rev, draftVersion: template.draft.version, savedAt: template.draft.updatedAt };
    } else if (reviewing && template.draft) {
      init = { mode: 'review', definition: asDraft(template.draft.definition), rev: template.draft.rev, draftVersion: template.draft.version, savedAt: template.draft.updatedAt };
    } else if (version.data && version.data.version === wanted) {
      init = editing
        ? { mode: 'edit', definition: asDraft(version.data.definition), rev: 0, draftVersion: null, savedAt: null }
        : { mode: 'view', definition: asDraft(version.data.definition), version: version.data.version };
    }
  }

  // Trình thiết kế nhận dữ liệu khởi đầu MỘT lần cho mỗi khoá (mẫu, bản đang xem, lần tải lại). Sau đó dữ liệu tự làm mới
  // (SSE, sau khi lưu hoặc xuất bản) không được dựng lại màn hình, nếu không người vẽ mất lịch sử hoàn tác và hộp thoại đang mở.
  // Khoá không phụ thuộc việc mẫu còn nháp hay không: xuất bản xong thì nháp biến mất, mà màn hình (và hộp thoại "Đã xuất bản") không được dựng lại.
  const key = `${templateId}:${editing ? 'edit' : canSeeDraft && phienBan === undefined ? 'review' : `view-${wanted ?? ''}`}:${session}`;
  const [frozen, setFrozen] = useState<{ key: string; init: DesignerInit } | null>(null);
  if (init && frozen?.key !== key) setFrozen({ key, init });
  const active = frozen?.key === key ? frozen.init : init;

  if (!template || !active) {
    const error = detail.error ?? (wanted ? version.error : null);
    return (
      <div className="flex min-h-[60dvh] items-center justify-center">
        {error ? <EmptyState title={t.loadFailed} description={errorMessage(error)} action={back} /> : <Spinner showLabel />}
      </div>
    );
  }

  return <Designer key={key} template={template} init={active} onReload={reload} />;
}
