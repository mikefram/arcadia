import { useEffect, useState, type FormEventHandler, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { OrgSettings, OrgSettingsPatch } from '@mihato/domain';
import { fmt, formatTime, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/errors';
import { apiKey, queryClient, useApiMutation } from '@/lib/query';

const t = vi.admin.org.settings;

/** Mỗi nhóm cài đặt nhận cấu hình hiện tại và báo lên trang khi có thay đổi chưa lưu. */
export type SectionProps = { settings: OrgSettings; onDirtyChange: (id: string, dirty: boolean) => void };

export type SectionFrameProps = {
  /** id của khối, cũng là đích của mục lục bên trái */
  id: string;
  title: string;
  description: string;
  dirty: boolean;
  saving: boolean;
  /** thời điểm lưu gần nhất trong phiên này */
  savedAt: string | null;
  error: unknown;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onDiscard: () => void;
  children: ReactNode;
};

/** Khung của một nhóm cài đặt: tiêu đề, lời giải thích, các ô, và hàng nút lưu riêng của nhóm (SPEC 9.2). */
export function SectionFrame({ id, title, description, dirty, saving, savedAt, error, onSubmit, onDiscard, children }: SectionFrameProps) {
  return (
    <Card id={id} aria-labelledby={`${id}-tieu-de`} className="scroll-mt-20">
      <form noValidate onSubmit={onSubmit}>
        <CardHeader className="flex-col gap-y-1">
          <CardTitle id={`${id}-tieu-de`}>{title}</CardTitle>
          <CardDescription className="max-w-[72ch] text-base">{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? <Callout tone="error">{errorMessage(error)}</Callout> : null}
          {children}
        </CardContent>
        <CardFooter className="min-h-14 flex-wrap justify-between gap-x-4 rounded-b-xl bg-canvas">
          <p role="status" className="flex items-center gap-1.5 text-sm text-ink-sub">
            {dirty ? (
              <span className="font-medium text-ink">{t.unsaved}</span>
            ) : savedAt ? (
              <>
                <Check aria-hidden="true" className="size-4 text-primary" />
                {fmt(t.savedAt, { giờ: formatTime(savedAt) })}
              </>
            ) : null}
          </p>
          <div className="flex items-center gap-2">
            {dirty ? (
              <Button variant="ghost" onClick={onDiscard}>
                {t.discard}
              </Button>
            ) : null}
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty} aria-label={fmt(t.saveGroup, { nhóm: title })}>
              {t.save}
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Lưu một nhóm: `org.settingsPatch` chỉ với các khoá đã đổi. Phản hồi là cấu hình mới, ghi thẳng vào bộ nhớ đệm
 * của `org.settingsGet` để mọi nhóm thấy ngay giá trị vừa lưu.
 */
export function useSectionSave(title: string) {
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const patch = useApiMutation('org.settingsPatch', { toastError: false, invalidate: ['me.get', 'admin.audit'] });
  const save = (body: OrgSettingsPatch) => {
    if (Object.keys(body).length === 0) return;
    patch.mutate(
      { body },
      {
        onSuccess: (next) => {
          queryClient.setQueryData(apiKey('org.settingsGet', {}), next);
          setSavedAt(new Date().toISOString());
          toast.success(fmt(t.saved, { nhóm: title }));
        },
      },
    );
  };
  return { save, saving: patch.isPending, error: patch.error, savedAt, clearError: patch.reset };
}

/** Báo lên trang khi nhóm có thay đổi chưa lưu, để mục lục đánh dấu nhóm đó. */
export function useReportDirty(id: string, dirty: boolean, onDirtyChange: SectionProps['onDirtyChange']): void {
  useEffect(() => {
    onDirtyChange(id, dirty);
  }, [id, dirty, onDirtyChange]);
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Các khoá của `next` có giá trị khác `prev`: phần thật sự cần gửi trong PATCH. */
export function changedKeys<T extends object>(next: T, prev: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (!same(next[key], prev[key])) out[key] = next[key];
  }
  return out;
}

/** Chữ trong ô nhập → chuỗi đã cắt khoảng trắng, hoặc null khi để trống. */
export const emptyToNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
