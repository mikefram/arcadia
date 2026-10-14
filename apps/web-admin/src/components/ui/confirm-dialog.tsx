import type { ReactNode } from 'react';
import { AlertDialog } from 'radix-ui';
import { vi } from '@mihato/i18n';
import { Button } from './button';
import { useReturnFocus } from './dialog';

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** nhãn nút xác nhận: nói rõ việc sẽ xảy ra ("Thu hồi thiết bị"), không ghi chung chung */
  confirmLabel: string;
  /** mặc định "Đóng" */
  dismissLabel?: string;
  /** `danger` cho thao tác không hoàn tác được */
  tone?: 'primary' | 'danger';
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
};

/** Hỏi lại trước một thao tác hệ trọng. Focus ban đầu nằm ở nút đóng, không nằm ở nút xác nhận. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, dismissLabel, tone = 'primary', loading, onConfirm, children }: ConfirmDialogProps) {
  const returnFocus = useReturnFocus();
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-scrim" />
        <AlertDialog.Content
          onOpenAutoFocus={returnFocus.onOpenAutoFocus}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-dialog-in flex-col rounded-2xl border border-line bg-surface shadow-dialog outline-none"
        >
          <div className="flex flex-col gap-1.5 px-6 pt-5 pb-5">
            <AlertDialog.Title className="text-xl font-semibold text-ink">{title}</AlertDialog.Title>
            {description ? <AlertDialog.Description className="text-base text-ink-sub">{description}</AlertDialog.Description> : null}
            {children ? <div className="mt-2">{children}</div> : null}
          </div>
          <div className="flex flex-col-reverse gap-2 rounded-b-2xl border-t border-hairline bg-canvas px-6 py-3.5 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">{dismissLabel ?? vi.admin.shell.ui.close}</Button>
            </AlertDialog.Cancel>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={loading}
              onClick={() => {
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
