import { Link } from '@tanstack/react-router';
import { FileSignature, Inbox, Play, type LucideIcon } from 'lucide-react';
import { TEMPLATE_VIEW_ACTIONS, type TemplateCategory } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { startableIn } from '@/features/templates/template-categories';
import { useCan } from '@/lib/auth';
import { useApiQuery } from '@/lib/query';

const t = vi.admin.documents.quickStart;

type Spec = { category: Extract<TemplateCategory, 'directive' | 'incoming'>; icon: LucideIcon; title: string; body: string };

/** Hai việc nhanh của văn thư và chỉ thị (docs/DECISIONS.md, 06/10/2026). Thêm nhóm khác thì thêm một dòng ở đây. */
const SPECS: readonly Spec[] = [
  { category: 'directive', icon: FileSignature, title: t.directive.title, body: t.directive.body },
  { category: 'incoming', icon: Inbox, title: t.incoming.title, body: t.incoming.body },
];

/** Tối đa bấy nhiêu nút mỗi thẻ; còn nữa thì dẫn sang danh sách quy trình. */
const MAX_LINKS = 3;

/**
 * Thẻ nhanh “Ra chỉ thị” và “Vào sổ văn bản đến”: chỉ hiện khi người đang đăng nhập có ít nhất một quy trình xuất bản
 * thuộc nhóm tương ứng mà mình được khởi chạy (`canStart` do máy chủ tính theo người được phép khởi chạy của quy trình).
 * Không có thì không hiện gì, không để lại khoảng trống.
 */
export function QuickStart() {
  const can = useCan();
  const list = useApiQuery('templates.list', { query: { archived: 'false' } }, { enabled: can(TEMPLATE_VIEW_ACTIONS), staleTime: 60_000 });
  const items = list.data?.items ?? [];
  const cards = SPECS.map((spec) => ({ spec, templates: startableIn(items, spec.category) })).filter((card) => card.templates.length > 0);
  if (cards.length === 0) return null;

  return (
    <section aria-label={t.label} data-testid="quick-start" className="grid gap-3 sm:grid-cols-2">
      {cards.map(({ spec, templates }) => {
        const Icon = spec.icon;
        const shown = templates.slice(0, MAX_LINKS);
        const more = templates.length - shown.length;
        return (
          <article key={spec.category} data-testid={`quick-${spec.category}`} className="flex items-start gap-4 rounded-xl border border-hairline bg-surface px-5 py-4">
            <span aria-hidden="true" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-on-primary-tint">
              <Icon className="size-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-ink">{spec.title}</h2>
              <p className="mt-0.5 text-base text-ink-sub">{spec.body}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {shown.map((template) => (
                  <Button key={template.id} asChild variant="primary" size="md" className="max-w-full">
                    <Link to="/luot-chay/moi" search={{ templateId: template.id }} data-testid={`quick-start-${template.id}`}>
                      <Play aria-hidden="true" />
                      {shown.length === 1 ? (
                        <>
                          <span>{t.startOne}</span>
                          <span className="sr-only">{fmt(t.start, { việc: spec.title, 'quy trình': template.name })}</span>
                        </>
                      ) : (
                        <span className="truncate">{template.name}</span>
                      )}
                    </Link>
                  </Button>
                ))}
                {more > 0 ? (
                  <Link to="/quy-trinh" className="text-base font-medium text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">
                    {fmt(t.more, { n: more })}
                  </Link>
                ) : null}
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
