import {
  confirmBatch,
  confirmProposal,
  createOfficeProposals,
  createScribeSession,
  deleteMyConversations,
  getProposal,
  currentBriefing,
  listProposals,
  rejectProposal,
  sendNowProposal,
  undoProposal,
} from '@mihato/backend';
import type { Registrar } from '../registrar';

/**
 * SPEC 10.6, 10.7.1, 10.9: cổng xác nhận, phiên Scribe, báo cáo đầu ngày.
 *
 * Mọi route ở đây là `auth: 'user'`: registrar chỉ nhận access token của thiết bị hoặc cookie phiên. Service token của
 * `ai_service` và token phiên Scribe không qua được bước xác thực, nên AI không tự xác nhận được đề xuất của chính nó
 * (SPEC 6.5 điều 1 và 2). Handler mỏng; toàn bộ luật của cổng nằm ở @mihato/backend/services/proposals.
 */
export function registerProposalRoutes(r: Registrar): void {
  r.user('proposals.list', async ({ tx, ctx, viewer, input }) => ({ items: await listProposals(tx, ctx, viewer, input.query) }));
  r.user('proposals.get', ({ tx, ctx, viewer, input }) => getProposal(tx, ctx, viewer, input.params.id));

  r.user('proposals.confirm', ({ tx, ctx, viewer, input, stepUpToken, meta }) => confirmProposal(tx, ctx, viewer, input.params.id, input.body, { stepUpToken, meta }));
  r.user('proposalBatches.confirm', ({ tx, ctx, viewer, input, stepUpToken, meta }) => confirmBatch(tx, ctx, viewer, input.params.id, input.body, { stepUpToken, meta }));
  r.user('proposals.reject', ({ tx, ctx, viewer, input, meta }) => rejectProposal(tx, ctx, viewer, input.params.id, input.body, { meta }));
  r.user('proposals.undo', ({ tx, ctx, viewer, input, meta }) => undoProposal(tx, ctx, viewer, input.params.id, { meta }));
  r.user('proposals.sendNow', ({ tx, ctx, viewer, input, meta }) => sendNowProposal(tx, ctx, viewer, input.params.id, { meta }));

  // "Trình" từ Văn phòng (Giai đoạn 3): quyền `proposal.create_office` kiểm ở registrar và kiểm lại trong service.
  r.user('proposals.create', async ({ tx, ctx, viewer, input }) => ({ items: await createOfficeProposals(tx, ctx, viewer, input.body) }));

  r.user('conversations.delete', async ({ tx, viewer, meta }) => {
    await deleteMyConversations(tx, viewer, { meta });
    return { ok: true };
  });

  r.user('scribe.createSession', ({ tx, ctx, viewer, input }) => createScribeSession(tx, ctx, viewer, input.body));
  r.user('briefings.latest', ({ tx, ctx, viewer }) => currentBriefing(tx, ctx, viewer));
}
