/**
 * Điều phối dùng chung (SPEC 9.4): Tổng quan, Lượt chạy và Công việc cùng dùng các hộp thoại này.
 * Nút chỉ hiện khi việc có hành động tương ứng trong `allowedActions`.
 */
export { CancelRunDialog, type CancelRunDialogProps } from './cancel-run-dialog';
export { ExtendDialog } from './extend-dialog';
export { GiveTaskDialog, type GiveTaskDialogProps } from './give-task-dialog';
export { ExtensionDecisionDialog, type ExtensionDecisionDialogProps } from './extension-decision-dialog';
export { NudgeDialog } from './nudge-dialog';
export { ReassignDialog } from './reassign-dialog';
export { SubmitToExecutive, type SubmitToExecutiveProps } from './submit-to-executive';
export { SkipDialog, type SkipDialogProps } from './skip-dialog';
export { BulkStepActions, StepActionButtons, StepActionsMenu, StepDispatchProvider, useStepDispatch, type DispatchAction } from './step-actions';
export { allows, eligible, MAX_BATCH, STEP_INVALIDATE, type DispatchDialogProps } from './shared';
