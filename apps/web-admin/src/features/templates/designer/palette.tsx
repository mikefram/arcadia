import type { DragEvent, KeyboardEvent } from 'react';
import { fmt, vi } from '@mihato/i18n';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { PALETTE_MIME } from './canvas';
import { ADDABLE_ICON, ADDABLE_TINT } from './flow-node';
import { kindLabel, STEP_KINDS, type AddableKind } from './model';

const t = vi.admin.designer.editor;
const KINDS: readonly AddableKind[] = [...STEP_KINDS, 'end'];

/**
 * Cột trái (SPEC 9.3): các khối nút. Kéo một khối vào khung vẽ, hoặc bấm (hay nhấn Enter) để thêm vào giữa khung.
 * Dùng thẻ div có role="button" vì Firefox không cho kéo thẻ <button>.
 */
export function Palette({ onAdd }: { onAdd: (kind: AddableKind) => void }) {
  return (
    <aside aria-label={t.regionPalette} className="flex w-[104px] shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-hairline bg-surface px-2 py-3">
      <h2 className="px-1 text-sm font-semibold">{t.palette.title}</h2>
      {KINDS.map((kind) => {
        const Icon = ADDABLE_ICON[kind];
        const name = kindLabel(kind);
        return (
          <Tooltip key={kind} content={t.palette.desc[kind]} side="right">
            <div
              role="button"
              tabIndex={0}
              draggable
              aria-label={fmt(t.palette.add, { tên: name })}
              data-testid={`palette-${kind}`}
              onDragStart={(e: DragEvent) => {
                e.dataTransfer.setData(PALETTE_MIME, kind);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onAdd(kind)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onAdd(kind);
                }
              }}
              className="flex cursor-grab flex-col items-center gap-1 rounded-lg border border-line bg-surface px-1 pt-2 pb-1.5 text-center text-sm font-medium transition-colors select-none hover:bg-surface-alt active:cursor-grabbing"
            >
              <span className={cn('inline-flex size-7 items-center justify-center rounded-md', kind === 'end' ? 'border-2 border-primary text-primary' : ADDABLE_TINT[kind])}>
                <Icon aria-hidden="true" className="size-4" />
              </span>
              {name}
            </div>
          </Tooltip>
        );
      })}
      <p className="mt-1 px-0.5 text-xs text-ink-sub">{t.palette.hint}</p>
    </aside>
  );
}
