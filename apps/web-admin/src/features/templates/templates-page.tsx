import { useMemo, useState, type MouseEvent } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Archive, ArchiveRestore, Copy, Ellipsis, PencilRuler, Play, Plus, Search, Workflow } from 'lucide-react';
import { TEMPLATE_MANAGE_ACTIONS, type TemplateSummary } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { PersonName } from '@/components/person-name';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, useAfterMenuClose } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Switch } from '@/components/ui/switch';
import { DataTable } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { useDebouncedValue } from '@/lib/hooks';
import { useApiMutation, useApiQuery } from '@/lib/query';
import { CategoryFilterBar } from './category-filter';
import { CreateChooserDialog } from './create-chooser-dialog';
import { CreateTemplateDialog } from './create-template-dialog';
import { PresetGalleryDialog } from './preset-gallery-dialog';
import { categoryLabel, countByCategory, filterByCategory, isStartable, type CategoryFilter } from './template-categories';

const t = vi.admin.designer.list;
const templateId = (x: TemplateSummary) => x.id;

type RowHandlers = {
  /** tạo và nhân bản */
  canEdit: boolean;
  canArchive: boolean;
  onStart: (e: MouseEvent, href: string) => void;
  onDuplicate: (template: TemplateSummary) => void;
  onArchive: (template: TemplateSummary) => void;
  onUnarchive: (template: TemplateSummary) => void;
};

const startHref = (id: string) => `/luot-chay/moi?templateId=${encodeURIComponent(id)}`;

function RowActions({ template, handlers }: { template: TemplateSummary; handlers: RowHandlers }) {
  const afterClose = useAfterMenuClose();
  // Quyền khởi chạy tính theo từng quy trình (người được phép khởi chạy do quy trình quy định), không theo quyền chung.
  const startable = isStartable(template);
  const hasMenu = handlers.canEdit || handlers.canArchive;
  return (
    <div className="flex items-center justify-end gap-1.5">
      {startable ? (
        <a
          href={startHref(template.id)}
          onClick={(e) => handlers.onStart(e, startHref(template.id))}
          aria-label={fmt(t.startHint, { tên: template.name })}
          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
          data-testid="row-start"
        >
          <Play aria-hidden="true" />
          {t.start}
        </a>
      ) : null}
      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={fmt(t.actionsFor, { tên: template.name })} data-testid="row-menu">
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent onCloseAutoFocus={afterClose.flush}>
            <DropdownMenuItem asChild>
              <Link to="/quy-trinh/$templateId" params={{ templateId: template.id }}>
                <PencilRuler aria-hidden="true" />
                {t.open}
              </Link>
            </DropdownMenuItem>
            {handlers.canEdit ? (
              <DropdownMenuItem onSelect={() => afterClose.run(() => handlers.onDuplicate(template))}>
                <Copy aria-hidden="true" />
                {t.duplicate}
              </DropdownMenuItem>
            ) : null}
            {handlers.canEdit && handlers.canArchive ? <DropdownMenuSeparator /> : null}
            {handlers.canArchive ? (
              template.archivedAt ? (
                <DropdownMenuItem onSelect={() => handlers.onUnarchive(template)}>
                  <ArchiveRestore aria-hidden="true" />
                  {t.unarchive}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => afterClose.run(() => handlers.onArchive(template))}>
                  <Archive aria-hidden="true" />
                  {t.archive}
                </DropdownMenuItem>
              )
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Link to="/quy-trinh/$templateId" params={{ templateId: template.id }} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}>
          {t.view}
        </Link>
      )}
    </div>
  );
}

/**
 * Huy hiệu nhóm cạnh tên chỉ hiện ở chế độ "Tất cả" (đang lọc một nhóm thì mọi dòng cùng nhóm, huy hiệu thừa) và bỏ qua nhóm "Khác"
 * (quy trình chưa phân nhóm, hiện huy hiệu chỉ thêm nhiễu).
 *
 * Bảng cố định cột (table-fixed): cột tên lấy phần còn lại, nên các cột phụ phải gọn. Ở màn 1280 bảng rộng khoảng 980px;
 * cột tên cần ít nhất 250px để tên quy trình không xuống quá hai dòng.
 */
function buildColumns(handlers: RowHandlers, hasStart: boolean, showCategory: boolean): ColumnDef<TemplateSummary>[] {
  return [
    {
      id: 'name',
      accessorFn: (x) => x.name,
      header: t.colName,
      cell: ({ row }) => (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to="/quy-trinh/$templateId" params={{ templateId: row.original.id }} className="font-semibold text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">
              {row.original.name}
            </Link>
            {showCategory && row.original.category !== 'general' ? (
              <Badge tone="muted" data-testid="row-category">
                {categoryLabel(row.original.category)}
              </Badge>
            ) : null}
          </div>
          <p className={cn('truncate text-sm text-ink-sub', !row.original.description && 'italic')} title={row.original.description ?? undefined}>
            {row.original.description || t.noDescription}
          </p>
        </>
      ),
    },
    {
      id: 'version',
      accessorFn: (x) => x.latestPublishedVersion ?? 0,
      header: t.colVersion,
      meta: { className: 'w-[172px]' },
      cell: ({ row }) => {
        const x = row.original;
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            {x.latestPublishedVersion !== null ? <Badge tone="primary">{fmt(t.version, { n: x.latestPublishedVersion })}</Badge> : <Badge tone="muted">{t.notPublished}</Badge>}
            {x.hasDraft ? <Badge tone="gold">{t.hasDraft}</Badge> : null}
            {x.archivedAt ? <Badge tone="neutral">{t.archived}</Badge> : null}
          </div>
        );
      },
    },
    {
      id: 'steps',
      accessorFn: (x) => x.stepCount,
      header: t.colSteps,
      meta: { align: 'right', className: 'w-[76px]' },
      cell: ({ row }) => <span className="tabular">{row.original.stepCount}</span>,
    },
    {
      id: 'runs',
      accessorFn: (x) => x.runCount,
      header: t.colRuns,
      meta: { align: 'right', className: 'w-[88px]' },
      cell: ({ row }) => <span className="tabular">{row.original.runCount}</span>,
    },
    {
      id: 'createdBy',
      accessorFn: (x) => x.createdBy.givenName,
      header: t.colCreatedBy,
      meta: { className: 'w-[168px]' },
      cell: ({ row }) => (
        <span className="block" title={row.original.createdBy.fullName || undefined}>
          <PersonName person={row.original.createdBy.fullName ? row.original.createdBy : null} fallback="" />
        </span>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">{vi.admin.shell.ui.rowActions}</span>,
      enableSorting: false,
      // Người chỉ xem có hai nút chữ ("Khởi chạy", "Xem sơ đồ"); người vẽ có nút "Khởi chạy" (nếu được) và trình đơn.
      meta: { align: 'right', className: handlers.canEdit || handlers.canArchive ? (hasStart ? 'w-[176px]' : 'w-[64px]') : hasStart ? 'w-[236px]' : 'w-[124px]' },
      cell: ({ row }) => <RowActions template={row.original} handlers={handlers} />,
    },
  ];
}

/**
 * Danh sách mẫu quy trình (SPEC 9.2). Người sửa hoặc xuất bản thấy cả nháp; `template.edit` cho tạo mới và nhân bản;
 * `template.archive` cho lưu trữ và thấy cả mẫu đã lưu trữ; người chỉ có `template.read_published` thấy các mẫu đã xuất bản
 * và xem sơ đồ. Nút "Khởi chạy" hiện theo `canStart` của từng quy trình (quy trình có thể giới hạn người khởi chạy).
 * Lọc theo nhóm làm ở máy khách trên danh sách đã tải (vài chục quy trình), nên đổi nhóm không gọi lại máy chủ và số đếm
 * của các nhóm luôn khớp với ô tìm và công tắc "Hiện quy trình đã lưu trữ".
 */
export function TemplatesPage() {
  const can = useCan();
  const router = useRouter();
  const canEdit = can('template.edit');
  const canArchive = can('template.archive');
  const canManage = can(TEMPLATE_MANAGE_ACTIONS);
  const [text, setText] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [chooserOpen, setChooserOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [cloneFrom, setCloneFrom] = useState<TemplateSummary | null>(null);
  const [archiving, setArchiving] = useState<TemplateSummary | null>(null);
  const q = useDebouncedValue(text.trim(), 250);

  const list = useApiQuery('templates.list', { query: { q: q || undefined, archived: showArchived ? undefined : 'false' } }, { placeholderData: (prev) => prev });
  // Nguồn để nhân bản: mọi mẫu, không theo ô tìm.
  const all = useApiQuery('templates.list', { query: {} }, { enabled: canEdit && (createOpen || galleryOpen), staleTime: 60_000 });
  const archive = useApiMutation('templates.archive', { invalidate: ['templates.list', 'templates.get'] });
  const { mutate: sendArchive } = archive;

  const handlers = useMemo<RowHandlers>(
    () => ({
      canEdit,
      canArchive,
      onStart: (e, href) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        router.history.push(href);
      },
      onDuplicate: (template) => {
        setCloneFrom(template);
        setCreateOpen(true);
      },
      onArchive: setArchiving,
      onUnarchive: (template) =>
        sendArchive({ params: { id: template.id }, body: { archived: false } }, { onSuccess: () => toast.success(fmt(t.unarchived_done, { tên: template.name })) }),
    }),
    [canEdit, canArchive, router, sendArchive],
  );
  const loaded = list.data?.items;
  const counts = useMemo(() => countByCategory(loaded ?? []), [loaded]);
  const items = useMemo(() => filterByCategory(loaded ?? [], category), [loaded, category]);
  const hasStart = useMemo(() => items.some(isStartable), [items]);
  const columns = useMemo(() => buildColumns(handlers, hasStart, category === 'all'), [handlers, hasStart, category]);
  const filtered = q !== '' || showArchived;
  const openCreate = () => {
    setCloneFrom(null);
    setChooserOpen(true);
  };

  return (
    <>
      <PageHeader
        title={t.title}
        description={canManage ? t.descriptionEditor : t.descriptionReader}
        actions={
          canEdit ? (
            <Button variant="primary" onClick={openCreate} data-testid="create-template">
              <Plus aria-hidden="true" />
              {t.create}
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="relative w-full max-w-xs">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-sub" />
          <Input type="search" aria-label={t.search} placeholder={t.searchPlaceholder} value={text} onChange={(e) => setText(e.target.value)} className="pl-9" data-testid="template-search" />
        </div>
        {canManage ? (
          <label className="flex items-center gap-2 text-base">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} data-testid="show-archived" />
            {t.showArchived}
          </label>
        ) : null}
      </div>

      <CategoryFilterBar value={category} onChange={setCategory} counts={counts} />
      <p role="status" className="sr-only">
        {list.isPending ? '' : category === 'all' ? fmt(t.categoryStatusAll, { n: items.length }) : fmt(t.categoryStatus, { n: items.length, nhóm: t.category[category] })}
      </p>

      {list.isError ? (
        <Callout
          tone="error"
          title={vi.admin.shell.ui.loadFailedTitle}
          action={
            <Button size="sm" onClick={() => void list.refetch()}>
              {vi.admin.shell.ui.retry}
            </Button>
          }
        >
          {errorMessage(list.error)}
        </Callout>
      ) : (
        <DataTable
          caption={t.caption}
          tableClassName="min-w-[960px] table-fixed"
          columns={columns}
          data={items}
          getRowId={templateId}
          isLoading={list.isPending}
          empty={
            loaded && loaded.length > 0 && items.length === 0 && category !== 'all' ? (
              <EmptyState
                title={fmt(t.emptyCategoryTitle, { nhóm: t.category[category] })}
                description={t.emptyCategoryBody}
                action={<Button onClick={() => setCategory('all')}>{t.showAllCategories}</Button>}
              />
            ) : filtered ? (
              <EmptyState
                title={t.emptyFilteredTitle}
                description={t.emptyFilteredBody}
                action={
                  q !== '' ? (
                    <Button onClick={() => setText('')}>{t.clearSearch}</Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                icon={Workflow}
                title={t.emptyTitle}
                description={canManage ? t.emptyBodyEditor : t.emptyBodyReader}
                action={
                  canEdit ? (
                    <Button variant="primary" onClick={openCreate}>
                      <Plus aria-hidden="true" />
                      {t.create}
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        />
      )}

      {canEdit ? (
        <>
          <CreateChooserDialog
            open={chooserOpen}
            onOpenChange={setChooserOpen}
            onBlank={() => {
              setChooserOpen(false);
              setCreateOpen(true);
            }}
            onPreset={() => {
              setChooserOpen(false);
              setGalleryOpen(true);
            }}
          />
          <CreateTemplateDialog open={createOpen} onOpenChange={setCreateOpen} templates={all.data?.items ?? loaded ?? []} cloneFrom={cloneFrom} />
          <PresetGalleryDialog open={galleryOpen} onOpenChange={setGalleryOpen} templates={all.data?.items ?? loaded ?? []} />
        </>
      ) : null}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={fmt(t.archiveTitle, { tên: archiving?.name ?? '' })}
        description={t.archiveBody}
        confirmLabel={t.archiveConfirm}
        loading={archive.isPending}
        onConfirm={() => {
          if (!archiving) return;
          const target = archiving;
          sendArchive(
            { params: { id: target.id }, body: { archived: true } },
            {
              onSuccess: () => toast.success(fmt(t.archived_done, { tên: target.name })),
              onSettled: () => setArchiving(null),
            },
          );
        }}
      />
    </>
  );
}
