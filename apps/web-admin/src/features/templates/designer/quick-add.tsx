import { useRef } from 'react';
import { CornerDownRight } from 'lucide-react';
import { fmt, vi } from '@mihato/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useDesigner, type QuickAddRequest } from './context';
import { ADDABLE_ICON } from './flow-node';
import { canConnect, kindLabel, nodeTitle, STEP_KINDS, type AddableKind } from './model';

const t = vi.admin.designer.editor.canvas;

export type QuickAddChoice = { kind: AddableKind } | { connectTo: string };

/**
 * Trình đơn "bước kế tiếp": mở khi bấm dấu cộng cạnh một bước, hoặc khi kéo một đường nối ra khoảng trống.
 * Chọn một loại thì bước mới được tạo và nối luôn; cũng nối được thẳng tới ô Hoàn tất đã có.
 */
export function QuickAddMenu({ request, onClose, onPick }: { request: QuickAddRequest | null; onClose: () => void; onPick: (choice: QuickAddChoice) => void }) {
  const { def } = useDesigner();
  // Giữ yêu cầu gần nhất để trình đơn không nhảy về góc màn hình trong lúc đang đóng.
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  const from = shown?.from;
  const ends = from ? def.nodes.filter((n) => n.type === 'end' && canConnect(def, from.nodeId, n.id, from.handle)) : [];
  const EndIcon = ADDABLE_ICON.end;

  return (
    <DropdownMenu open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden="true" tabIndex={-1} className="pointer-events-none fixed size-0" style={{ left: shown?.screen.x ?? 0, top: shown?.screen.y ?? 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" sideOffset={4} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="quick-add">
        <DropdownMenuLabel>{from ? t.quickAddTitle : t.quickAddNewTitle}</DropdownMenuLabel>
        {STEP_KINDS.map((kind) => {
          const Icon = ADDABLE_ICON[kind];
          return (
            <DropdownMenuItem key={kind} onSelect={() => onPick({ kind })} data-testid={`quick-${kind}`}>
              <Icon aria-hidden="true" />
              {kindLabel(kind)}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {ends.map((end) => (
          <DropdownMenuItem key={end.id} onSelect={() => onPick({ connectTo: end.id })} data-testid={`quick-connect-${end.id}`}>
            <CornerDownRight aria-hidden="true" />
            {fmt(t.connectToEnd, { tên: nodeTitle(end) })}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => onPick({ kind: 'end' })} data-testid="quick-end">
          <EndIcon aria-hidden="true" />
          {t.newEnd}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
