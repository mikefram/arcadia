import {
  actOnStep,
  addRunNote,
  addStepComment,
  batchSteps,
  cancelRun,
  createAdhocTask,
  decideExtension,
  deleteStepComment,
  draftNudges,
  getOverview,
  getRun,
  getRunShares,
  getStepDetail,
  listActivity,
  listExtensionRequests,
  listRunEvents,
  listRuns,
  listSteps,
  listStepComments,
  removeRunShare,
  sendNudges,
  setRunShare,
  startRun,
  stepAssignees,
} from '@mihato/backend';
import { requestMeta, type Registrar } from '../registrar';

/**
 * SPEC 10.5 và 10.6. Mọi thay đổi trạng thái việc đi qua advance(); Idempotency-Key của yêu cầu chính là
 * eventId của sự kiện, nên hàng đợi ngoại tuyến gửi lại bao nhiêu lần cũng chỉ có hiệu lực một lần.
 */
export function registerRunRoutes(r: Registrar): void {
  r.user('overview.get', ({ tx, ctx, viewer, input }) => getOverview(tx, ctx, viewer, { unitId: input.query.unitId }));
  r.user('activity.list', async ({ tx, ctx, viewer, input }) => ({ items: await listActivity(tx, ctx, viewer, input.query.limit) }));

  r.user('runs.create', ({ tx, ctx, viewer, input, idempotencyKey }) => startRun(tx, ctx, viewer, input.body, idempotencyKey));
  r.user('tasks.create', ({ tx, ctx, viewer, input, idempotencyKey }) => createAdhocTask(tx, ctx, viewer, input.body, idempotencyKey));
  r.user('runs.list', ({ tx, ctx, viewer, input }) => listRuns(tx, ctx, viewer, input.query));
  r.user('runs.get', ({ tx, ctx, viewer, input }) => getRun(tx, ctx, viewer, input.params.id));
  r.user('runs.events', ({ tx, ctx, viewer, input }) => listRunEvents(tx, ctx, viewer, input.params.id, input.query));
  r.user('runs.cancel', ({ tx, ctx, viewer, input, idempotencyKey }) => cancelRun(tx, ctx, viewer, input.params.id, input.body, idempotencyKey));
  r.user('runs.note', async ({ tx, ctx, viewer, input, idempotencyKey }) => {
    await addRunNote(tx, ctx, viewer, input.params.id, input.body.text, idempotencyKey);
    return { ok: true };
  });

  r.user('runs.shares.list', ({ tx, ctx, viewer, input }) => getRunShares(tx, ctx, viewer, input.params.id));
  r.user('runs.shares.set', ({ tx, ctx, viewer, input, req }) => setRunShare(tx, ctx, viewer, input.params.id, input.params.userId, input.body.role, requestMeta(req)));
  r.user('runs.shares.remove', ({ tx, ctx, viewer, input, req }) => removeRunShare(tx, ctx, viewer, input.params.id, input.params.userId, requestMeta(req)));

  r.user('steps.list', ({ tx, ctx, viewer, input }) => listSteps(tx, ctx, viewer, input.query));
  r.user('steps.get', ({ tx, ctx, viewer, input }) => getStepDetail(tx, ctx, viewer, input.params.id));
  r.user('steps.comments.list', ({ tx, ctx, viewer, input }) => listStepComments(tx, ctx, viewer, input.params.id, input.query));
  r.user('steps.comments.add', ({ tx, ctx, viewer, input, req }) => addStepComment(tx, ctx, viewer, input.params.id, input.body, requestMeta(req)));
  r.user('steps.comments.delete', async ({ tx, ctx, viewer, input, req }) => {
    await deleteStepComment(tx, ctx, viewer, input.params.id, input.params.commentId, requestMeta(req));
    return { ok: true };
  });
  r.user('steps.accept', ({ tx, ctx, viewer, input, idempotencyKey }) => actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'AcceptStep' }));
  r.user('steps.complete', ({ tx, ctx, viewer, input, idempotencyKey }) =>
    actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'CompleteStep', ...input.body }),
  );
  r.user('steps.approve', ({ tx, ctx, viewer, input, idempotencyKey, stepUpToken }) =>
    actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'ApproveStep', ...input.body }, { stepUpToken }),
  );
  r.user('steps.reject', ({ tx, ctx, viewer, input, idempotencyKey }) => actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'RejectStep', ...input.body }));
  r.user('steps.requestExtension', ({ tx, ctx, viewer, input, idempotencyKey }) =>
    actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'RequestExtension', ...input.body }),
  );
  r.user('steps.block', ({ tx, ctx, viewer, input, idempotencyKey }) => actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'ReportBlocked', ...input.body }));
  r.user('steps.reassign', ({ tx, ctx, viewer, input, idempotencyKey }) => actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'Reassign', ...input.body }));
  r.user('steps.extend', ({ tx, ctx, viewer, input, idempotencyKey }) => actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'ExtendDue', ...input.body }));
  r.user('steps.skip', ({ tx, ctx, viewer, input, idempotencyKey }) => actOnStep(tx, ctx, viewer, input.params.id, idempotencyKey, { type: 'SkipStep', ...input.body }));
  r.user('steps.assignees', ({ tx, ctx, viewer, input }) => stepAssignees(tx, ctx, viewer, input.body.stepIds));
  r.user('steps.batch', ({ tx, ctx, viewer, input, idempotencyKey }) => batchSteps(tx, ctx, viewer, input.body, idempotencyKey));

  r.user('extensionRequests.list', async ({ tx, ctx, viewer, input }) => ({ items: await listExtensionRequests(tx, ctx, viewer, input.query.state) }));
  r.user('extensionRequests.decide', ({ tx, ctx, viewer, input, idempotencyKey }) => decideExtension(tx, ctx, viewer, input.params.id, input.body, idempotencyKey));

  r.user('nudges.drafts', ({ tx, ctx, viewer, input }) => draftNudges(tx, ctx, viewer, input.body));
  r.user('nudges.send', ({ tx, ctx, viewer, input, idempotencyKey }) => sendNudges(tx, ctx, viewer, input.body, idempotencyKey));
}
