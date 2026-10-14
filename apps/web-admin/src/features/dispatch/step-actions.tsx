import { createContext, use, useState, type ReactNode } from 'react';
import { BellRing, CalendarPlus, Ellipsis, SkipForward, UserRoundPen, type LucideIcon } from 'lucide-react';
import type { StepView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, useAfterMenuClose } from '@/components/ui/dropdown-menu';
import { useCan } from '@/lib/auth';
import { ExtendDialog } from './extend-dialog';
import { NudgeDialog } from './nudge-dialog';
import { ReassignDialog } from './reassign-dialog';
import { allows, MAX_BATCH } from './shared';
import { SkipDialog } from './skip-dialog';

const t = vi.admin.shell.dispatch;

/** Các hành động điều phối trên việc mà web quản trị có hộp thoại (SPEC 9.4). */
export type DispatchAction = 'nudge' | 'reassign' | 'extend' | 'skip';

const ACTIONS: readonly { action: DispatchAction; icon: LucideIcon }[] = [
  { action: 'nudge', icon: BellRing },
  { action: 'reassign', icon: UserRoundPen },
  { action: 'extend', icon: CalendarPlus },
  { action: 'skip', icon: SkipForward },
];

type OpenDispatch = (action: DispatchAction, steps: readonly StepView[], options?: { onDone?: () => void }) => void;

/**
 * Giữ trạng thái và vẽ các hộp thoại điều phối cho một nhóm việc:
 *   const dispatch = useStepDispatch();
 *   <Button onClick={() => dispatch.open('nudge', [step])}>Đi thúc</Button>
 *   {dispatch.dialogs}
 * Danh sách việc được chụp lại lúc mở, nên hộp thoại vẫn đứng yên khi bảng phía sau làm mới.
 */
export function useStepDispatch(): { open: OpenDispatch; dialogs: ReactNode } {
  const [current, setCurrent] = useState<{ action: DispatchAction; steps: readonly StepView[]; onDone?: () => void } | null>(null);
  const close = (isOpen: boolean) => {
    if (!isOpen) setCurrent(null);
  };
  const steps = current?.steps ?? [];
  const onDone = current?.onDone;
  const dialogs = (
    <>
      <NudgeDialog open={current?.action === 'nudge'} onOpenChange={close} steps={steps} onDone={onDone} />
      <ReassignDialog open={current?.action === 'reassign'} onOpenChange={close} steps={steps} onDone={onDone} />
      <ExtendDialog open={current?.action === 'extend'} onOpenChange={close} steps={steps} onDone={onDone} />
      <SkipDialog open={current?.action === 'skip'} onOpenChange={close} step={steps[0] ?? null} onDone={onDone} />
    </>
  );
  return { open: (action, selected, options) => setCurrent({ action, steps: selected, onDone: options?.onDone }), dialogs };
}

const DispatchContext = createContext<OpenDispatch | null>(null);

/**
 * Bọc một màn hình có danh sách việc: các hộp thoại điều phối được vẽ MỘT lần ở đây, nên không biến mất
 * khi dòng vừa thao tác bị gỡ khỏi bảng (ví dụ việc hết quá hạn sau khi gia hạn).
 * StepActionsMenu, StepActionButtons, BulkStepActions bên trong tự dùng chung.
 */
export function StepDispatchProvider({ children }: { children: ReactNode }) {
  const dispatch = useStepDispatch();
  return (
    <DispatchContext value={dispatch.open}>
      {children}
      {dispatch.dialogs}
    </DispatchContext>
  );
}

/** Dùng bộ hộp thoại của StepDispatchProvider nếu có; nếu không thì tự giữ bộ riêng. */
function useDispatch(): { open: OpenDispatch; dialogs: ReactNode } {
  const shared = use(DispatchContext);
  const local = useStepDispatch();
  return shared ? { open: shared, dialogs: null } : local;
}

/**
 * Trình đơn "⋯" ở cuối mỗi dòng việc. Chỉ hiện hành động có trong `allowedActions` của việc;
 * việc không có hành động điều phối nào thì không vẽ gì.
 */
export function StepActionsMenu({ step, onDone }: { step: StepView; onDone?: () => void }) {
  const dispatch = useDispatch();
  const afterClose = useAfterMenuClose();
  const available = ACTIONS.filter((a) => allows(step, a.action));
  if (available.length === 0) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={fmt(t.actionsFor, { việc: step.title })}>
            <Ellipsis aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onCloseAutoFocus={afterClose.flush}>
          {available.map(({ action, icon: Icon }) => (
            <DropdownMenuItem key={action} onSelect={() => afterClose.run(() => dispatch.open(action, [step], { onDone }))}>
              <Icon aria-hidden="true" />
              {vi.common.actions[action]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {dispatch.dialogs}
    </>
  );
}

/** Các nút hành động của một việc, xếp ngang (dùng ở trang chi tiết). Chỉ hiện nút có trong `allowedActions`. */
export function StepActionButtons({ step, onDone }: { step: StepView; onDone?: () => void }) {
  const dispatch = useDispatch();
  const available = ACTIONS.filter((a) => allows(step, a.action));
  if (available.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {available.map(({ action, icon: Icon }) => (
        <Button key={action} size="sm" onClick={() => dispatch.open(action, [step], { onDone })}>
          <Icon aria-hidden="true" />
          {vi.common.actions[action]}
        </Button>
      ))}
      {dispatch.dialogs}
    </div>
  );
}

/**
 * Thanh thao tác hàng loạt cho các dòng đang chọn: đi thúc, giao lại, gia hạn.
 * Giao lại và gia hạn nhiều việc cần quyền `step.batch`; mỗi lần tối đa 50 việc.
 */
export function BulkStepActions({ steps, onClear }: { steps: readonly StepView[]; onClear: () => void }) {
  const can = useCan();
  const dispatch = useDispatch();

  const tooMany = steps.length > MAX_BATCH;
  const count = (action: DispatchAction) => steps.filter((s) => allows(s, action)).length;
  const bulk: readonly { action: DispatchAction; icon: LucideIcon; n: number }[] = [
    { action: 'nudge', icon: BellRing, n: count('nudge') },
    { action: 'reassign', icon: UserRoundPen, n: count('reassign') },
    { action: 'extend', icon: CalendarPlus, n: count('extend') },
  ];
  const usable = (action: DispatchAction, n: number) => n > 0 && (action === 'nudge' || n === 1 || can('step.batch'));

  return (
    <>
      {steps.length > 0 ? (
        <div role="region" aria-label={t.bulkLabel} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-primary-tint px-3.5 py-2">
            <p aria-live="polite" className="mr-auto font-semibold text-on-primary-tint">
              {fmt(t.selected, { n: steps.length })}
            </p>
            {bulk
              .filter((b) => usable(b.action, b.n))
              .map(({ action, icon: Icon }) => (
                <Button key={action} size="sm" disabled={tooMany} onClick={() => dispatch.open(action, steps, { onDone: onClear })}>
                  <Icon aria-hidden="true" />
                  {vi.common.actions[action]}
                </Button>
              ))}
            <Button size="sm" variant="ghost" onClick={onClear}>
              {t.clearSelection}
            </Button>
          </div>
          {tooMany ? <Callout tone="warn">{t.tooMany}</Callout> : null}
        </div>
      ) : null}
      {/* Hộp thoại vẫn được vẽ khi không còn dòng nào được chọn: kết quả hàng loạt hiện sau khi đã bỏ chọn. */}
      {dispatch.dialogs}
    </>
  );
}
