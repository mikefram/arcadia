import type { ReactNode } from 'react';
import { FilePlus2, LibraryBig } from 'lucide-react';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const t = vi.admin.designer.list.chooser;

export type CreateChooserDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBlank: () => void;
  onPreset: () => void;
};

function Choice({ icon, title, hint, onClick, testId }: { icon: ReactNode; title: string; hint: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex h-full flex-col items-start gap-2 rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-primary-tint/50"
    >
      <span aria-hidden="true" className="inline-flex size-10 items-center justify-center rounded-lg bg-primary-tint text-on-primary-tint [&_svg]:size-5">
        {icon}
      </span>
      <span className="text-lg font-semibold text-ink">{title}</span>
      <span className="text-base text-ink-sub">{hint}</span>
    </button>
  );
}

/** Bấm “Tạo quy trình”: chọn bắt đầu từ bản trống hay từ thư viện mẫu có sẵn. */
export function CreateChooserDialog({ open, onOpenChange, onBlank, onPreset }: CreateChooserDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-chooser">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.intro}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice icon={<FilePlus2 />} title={t.blank} hint={t.blankHint} onClick={onBlank} testId="create-blank" />
            <Choice icon={<LibraryBig />} title={t.preset} hint={t.presetHint} onClick={onPreset} testId="create-from-preset" />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
