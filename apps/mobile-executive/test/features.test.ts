import { PROPOSAL_TOOLS, type Me, type PersonRef, type ProposalView, type RunSummary, type SimulationRowView, type StepView } from '@mihato/domain';
import { vi as strings } from '@mihato/i18n';
import { describe, expect, it } from 'vitest';
import { shouldPersistQuery } from '../src/data/persist';
import { addressForRoles, capitalizeFirst, createNamer, fullPersonName, shortPersonName } from '../src/features/address';
import { officeAction, telUrl } from '../src/features/office';
import { DEFAULT_LOCAL_PROFILE, LocalProfileStore, assistantEnabledFor, localProfileFromMe } from '../src/features/local-profile';
import { buildConfirmCalls, draftStepAssignees, failedReasonOf, failedReasonText, groupPendingProposals, groupRisk, groupState, processAppliedText, reviewBody, reviewItemText, reviewLabels } from '../src/features/proposals';
import { ATTENTION_PREVIEW, attentionPreview, lateSteps, scheduleLine, sortRuns, stepChip } from '../src/features/steps';
import { notificationIdOf, proposalIdFromLink, targetForNotification } from '../src/push/route';
import { KV_KEYS, createMemoryKV } from '../src/session/kv';

const id = (n: number) => `0199c000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number, fullName: string, givenName: string, honorific: PersonRef['honorific']): PersonRef => ({ id: id(n), fullName, givenName, honorific });
const LAN = person(1, 'Nguyễn Thu Lan', 'Lan', 'chi');
const LAN2 = person(2, 'Phạm Thị Lan', 'Lan', 'chi');
const TUAN = person(3, 'Bùi Quốc Tuấn', 'Tuấn', 'anh');
const OFFICE = person(4, 'Tài khoản văn phòng', 'Văn phòng', null);

describe('cách gọi và tên người (SPEC 6.6, 7.5)', () => {
  it('gọi người dùng bằng chức danh; nhiều vai trò thì lấy vai trò cao nhất', () => {
    const grant = (role: Me['roles'][number]['role']) => ({ role, unitId: null });
    expect(addressForRoles([grant('chairman')])).toBe('Chủ tịch');
    expect(addressForRoles([grant('director')])).toBe('Giám đốc');
    expect(addressForRoles([grant('deputy')])).toBe('Phó giám đốc');
    expect(addressForRoles([grant('deputy'), grant('director')])).toBe('Giám đốc');
    expect(addressForRoles([grant('employee')])).toBe('Chủ tịch');
  });

  it('lần đầu "anh Bùi Quốc Tuấn", sau đó "anh Tuấn"', () => {
    const name = createNamer([TUAN, LAN]);
    expect(name(TUAN)).toBe('anh Bùi Quốc Tuấn');
    expect(name(LAN)).toBe('chị Nguyễn Thu Lan');
    expect(name(TUAN)).toBe('anh Tuấn');
    expect(name(LAN)).toBe('chị Lan');
  });

  it('hai "chị Lan" trên cùng màn hình: luôn viết đủ họ tên để không lẫn', () => {
    const name = createNamer([LAN, LAN2, TUAN]);
    expect([name(LAN), name(LAN2), name(LAN), name(LAN2)]).toEqual(['chị Nguyễn Thu Lan', 'chị Phạm Thị Lan', 'chị Nguyễn Thu Lan', 'chị Phạm Thị Lan']);
  });

  it('tài khoản dùng chung không có xưng hô: giữ tên đầy đủ, không viết tên trống không', () => {
    expect(fullPersonName(OFFICE)).toBe('Tài khoản văn phòng');
    expect(shortPersonName(OFFICE)).toBe('Tài khoản văn phòng');
    expect(capitalizeFirst('ông Huy')).toBe('Ông Huy');
  });
});

const proposal = (n: number, over: Partial<ProposalView> = {}): ProposalView => ({
  id: id(100 + n),
  batchId: id(900),
  tool: 'propose_nudge',
  risk: 1,
  summary: `Gửi lời nhắc số ${n}.`,
  items: [{ text: `Mục ${n}`, stepId: id(200 + n), runId: id(300), toUser: TUAN, message: `Lời nhắc ${n}`, editable: true, lateWorkingDays: 2 }],
  preview: null,
  source: 'ai',
  createdBy: null,
  state: 'pending',
  requiresStepUp: false,
  createdAt: `2026-10-15T03:00:0${n}.000Z`,
  expiresAt: '2026-10-15T03:10:00.000Z',
  effectiveAt: null,
  undoUntil: null,
  result: null,
  ...over,
});
const NOW = Date.parse('2026-10-15T03:01:00.000Z');

const draftItem = (text: string, toUser: PersonRef | null): ProposalView['items'][number] => ({ text, stepId: null, runId: null, toUser, message: null, editable: false, lateWorkingDays: null });
const previewRow = (order: number, title: string, assignee: PersonRef | null, over: Partial<SimulationRowView> = {}): SimulationRowView => ({
  nodeId: `s${order}`,
  kind: 'task',
  title,
  assignee,
  onBehalfOf: null,
  dueAt: '2026-10-19T10:00:00.000Z',
  pastDue: false,
  order,
  ...over,
});

/** Tạo bản nháp quy trình: đề xuất lẻ (không có lô), mỗi bước một mục; người làm là vai trò thì `toUser` là null. */
const createProcess = (over: Partial<ProposalView> = {}): ProposalView =>
  proposal(1, {
    batchId: null,
    tool: 'propose_create_process',
    summary: 'Tạo bản nháp quy trình ‘Họp hội đồng quản trị’ gồm 3 bước. Bản nháp chưa giao việc cho ai.',
    items: [
      draftItem('Bước 1: ‘Soạn tài liệu họp’, anh Bùi Quốc Tuấn làm, hạn 3 ngày làm việc.', TUAN),
      draftItem('Bước 2: ‘Duyệt tài liệu’, Giám đốc duyệt, hạn 2 ngày làm việc.', null),
      draftItem('Bước 3: ‘Gửi giấy mời’, chị Nguyễn Thu Lan làm, hạn 1 ngày làm việc. Làm cùng lúc với bước trước.', LAN),
    ],
    ...over,
  });

const PUBLISH_SUMMARY = 'Xuất bản quy trình ‘Họp hội đồng quản trị’, phiên bản 1, để có thể giao việc theo quy trình này.';
/** Chỉ xuất bản: một mục (chính câu tóm tắt), không có bản xem trước. */
const publishOnly = (over: Partial<ProposalView> = {}): ProposalView =>
  proposal(1, { batchId: null, tool: 'propose_publish_process', summary: PUBLISH_SUMMARY, items: [draftItem(PUBLISH_SUMMARY, null)], preview: null, ...over });
/** Xuất bản và giao việc ngay: mỗi dòng của bản xem trước là một mục, như `propose_start_run`. */
const publishAndAssign = (over: Partial<ProposalView> = {}): ProposalView =>
  proposal(1, {
    batchId: null,
    tool: 'propose_publish_process',
    summary: 'Xuất bản quy trình ‘Họp hội đồng quản trị’, phiên bản 1, và giao việc ngay với tên ‘Họp tháng 10’, gồm 2 việc.',
    items: [draftItem('‘Soạn tài liệu họp’: anh Bùi Quốc Tuấn, hạn Thứ Hai, ngày 19 tháng 10 năm 2026.', TUAN), draftItem('‘Duyệt tài liệu’: chưa xác định người nhận, chưa có hạn.', null)],
    preview: [previewRow(1, 'Soạn tài liệu họp', TUAN), previewRow(2, 'Duyệt tài liệu', null, { kind: 'approval', dueAt: null })],
    ...over,
  });

describe('M3: dựng lời gọi xác nhận (SPEC 10.6)', () => {
  it('lô mức 1: MỘT lời gọi cả lô, kèm mục đã bỏ và lời đã sửa', () => {
    const list = [proposal(1), proposal(2), proposal(3)];
    const calls = buildConfirmCalls(list, new Set([id(102)]), new Map([[id(103), '  Nhờ anh Tuấn báo lại trong hôm nay.  ']]), null);
    expect(calls).toEqual([{ kind: 'batch', batchId: id(900), body: { via: 'touch', dropProposalIds: [id(102)], editedMessages: { [id(103)]: 'Nhờ anh Tuấn báo lại trong hôm nay.' } } }]);
  });

  it('không bỏ, không sửa: thân chỉ có via; lời sửa mà không khác lời máy chủ soạn thì không gửi', () => {
    const list = [proposal(1), proposal(2)];
    expect(buildConfirmCalls(list, new Set(), new Map([[id(101), 'Lời nhắc 1']]), null)).toEqual([{ kind: 'batch', batchId: id(900), body: { via: 'touch' } }]);
  });

  it('không gửi lời sửa của mục đã bỏ', () => {
    const calls = buildConfirmCalls([proposal(1), proposal(2)], new Set([id(101)]), new Map([[id(101), 'đã sửa']]), null);
    expect(calls[0]?.body).toEqual({ via: 'touch', dropProposalIds: [id(101)] });
  });

  it('xác nhận bằng giọng: gửi via voice kèm bản chép chữ và độ tin cậy để máy chủ tự kiểm', () => {
    const calls = buildConfirmCalls([proposal(1)], new Set(), new Map(), { transcript: 'đồng ý', sttConfidence: 0.96 });
    expect(calls).toEqual([{ kind: 'batch', batchId: id(900), body: { via: 'voice', transcript: 'đồng ý', sttConfidence: 0.96 } }]);
  });

  it('đề xuất lẻ (không có lô) và mọi đề xuất mức 2: từng lời gọi riêng, không đi theo lô', () => {
    const single = proposal(1, { batchId: null });
    expect(buildConfirmCalls([single], new Set(), new Map(), null)).toEqual([{ kind: 'single', proposalId: id(101), body: { via: 'touch' } }]);
    const level2 = [proposal(1, { tool: 'propose_cancel_run', risk: 2 }), proposal(2, { tool: 'propose_cancel_run', risk: 2 })];
    expect(buildConfirmCalls(level2, new Set(), new Map(), null).map((c) => c.kind)).toEqual(['single', 'single']);
    expect(groupRisk(level2)).toBe(2);
  });

  it('mục không còn chờ thì không gửi lại', () => {
    const list = [proposal(1, { state: 'confirmed' }), proposal(2)];
    const calls = buildConfirmCalls(list, new Set(), new Map(), null);
    expect(calls).toEqual([{ kind: 'batch', batchId: id(900), body: { via: 'touch' } }]);
  });

  it('soạn quy trình (đề xuất lẻ, nhiều bước): một đề xuất là một khối nên chỉ MỘT lời gọi riêng, không theo lô', () => {
    const draft = createProcess();
    expect(draft.items).toHaveLength(3);
    expect(groupRisk([draft])).toBe(1);
    expect(buildConfirmCalls([draft], new Set(), new Map(), null)).toEqual([{ kind: 'single', proposalId: draft.id, body: { via: 'touch' } }]);
    for (const p of [publishOnly(), publishAndAssign()]) {
      expect(groupRisk([p])).toBe(1);
      expect(buildConfirmCalls([p], new Set(), new Map(), null), p.tool).toEqual([{ kind: 'single', proposalId: p.id, body: { via: 'touch' } }]);
    }
    // đã đồng ý hoặc đã xong thì không gửi lại
    expect(buildConfirmCalls([createProcess({ state: 'confirmed' })], new Set(), new Map(), null)).toEqual([]);
    expect(buildConfirmCalls([publishOnly({ state: 'failed', result: { reason: 'template_not_draft' } })], new Set(), new Map(), null)).toEqual([]);
  });

  it('soạn quy trình, xác nhận bằng giọng: như mọi đề xuất mức 1, via voice kèm bản chép chữ và độ tin cậy để máy chủ tự kiểm', () => {
    const voice = { transcript: 'đồng ý', sttConfidence: 0.93 };
    for (const p of [createProcess(), publishOnly(), publishAndAssign()]) {
      expect(buildConfirmCalls([p], new Set(), new Map(), voice), p.tool).toEqual([{ kind: 'single', proposalId: p.id, body: { via: 'voice', transcript: 'đồng ý', sttConfidence: 0.93 } }]);
    }
  });
});

describe('M3: câu đầu thẻ của từng mục', () => {
  it('nhiều lời nhắc: dùng câu tóm tắt của máy chủ vì chỉ câu đó có tên lượt (hai lời nhắc cùng người, cùng tên việc ở hai lượt)', () => {
    const a = proposal(1, { summary: 'Gửi lời nhắc tới anh Tuấn về việc ‘Kiểm tra tuyến’ của lượt ‘Đón đoàn Úc’.' });
    const b = proposal(2, { summary: 'Gửi lời nhắc tới anh Tuấn về việc ‘Kiểm tra tuyến’ của lượt ‘Đón đoàn Thái Lan’.' });
    expect(reviewItemText(a, true)).toBe(a.summary);
    expect(reviewItemText(b, true)).toBe(b.summary);
    expect(reviewItemText(a, true)).not.toBe(reviewItemText(b, true));
  });

  it('một lời nhắc: câu đầu màn hình đã nói đủ nên thẻ không nhắc lại', () => {
    expect(reviewItemText(proposal(1), false)).toBeNull();
  });

  it('mục khác: chỉ giữ phần chữ nối thêm sau câu tóm tắt; không trùng thì giữ nguyên', () => {
    const base = { tool: 'propose_cancel_run' as const, summary: 'Dừng hẳn lượt ‘Đón đoàn Úc’.' };
    const withReason = { ...proposal(1), ...base, items: [{ ...proposal(1).items[0]!, text: 'Dừng hẳn lượt ‘Đón đoàn Úc’. Lý do ghi lại: “Theo yêu cầu”.' }] };
    expect(reviewItemText(withReason, false)).toBe('Lý do ghi lại: “Theo yêu cầu”.');
    const same = { ...proposal(1), ...base, items: [{ ...proposal(1).items[0]!, text: base.summary }] };
    expect(reviewItemText(same, false)).toBeNull();
    const other = { ...proposal(1), tool: 'propose_reassign' as const, summary: 'Đổi người.', items: [{ ...proposal(1).items[0]!, text: 'Chuyển ‘Kiểm tra tuyến’ từ anh Tuấn sang chị Lan' }] };
    expect(reviewItemText(other, false)).toBe('Chuyển ‘Kiểm tra tuyến’ từ anh Tuấn sang chị Lan');
  });
});

describe('M3: tình trạng của nhóm đề xuất', () => {
  it('còn mục chờ và chưa hết hạn: chờ xem lại', () => {
    expect(groupState([proposal(1), proposal(2, { state: 'rejected' })], NOW)).toBe('pending');
  });
  it('để quá 10 phút: hết hiệu lực, dù máy chủ chưa kịp chuyển trạng thái', () => {
    expect(groupState([proposal(1)], Date.parse('2026-10-15T03:10:01.000Z'))).toBe('expired');
    expect(groupState([proposal(1, { state: 'expired' })], NOW)).toBe('expired');
    expect(groupState([], NOW)).toBe('expired');
  });
  it('đã đồng ý mà chưa thực hiện: mở cửa hoàn tác; đã thực hiện: báo đã gửi', () => {
    expect(groupState([proposal(1, { state: 'confirmed', undoUntil: '2026-10-15T03:01:30.000Z' })], NOW)).toBe('confirmed');
    expect(groupState([proposal(1, { state: 'confirmed', result: { nudgeId: 'x' } })], NOW)).toBe('applied');
  });
  it('không làm được, đã hoàn tác, không gửi', () => {
    expect(groupState([proposal(1, { state: 'failed', result: { reason: 'step_not_open' } })], NOW)).toBe('failed');
    expect(groupState([proposal(1, { state: 'undone' })], NOW)).toBe('undone');
    expect(groupState([proposal(1, { state: 'rejected' })], NOW)).toBe('rejected');
  });

  it('soạn quy trình: đi qua đủ các tình trạng như đề xuất mức 1 khác', () => {
    const done = { applied: true, at: '2026-10-15T03:02:00.000Z', templateId: id(500) };
    expect(groupState([createProcess()], NOW)).toBe('pending');
    expect(groupState([createProcess({ state: 'confirmed', undoUntil: '2026-10-15T03:01:30.000Z' })], NOW)).toBe('confirmed');
    expect(groupState([createProcess({ state: 'confirmed', result: { ...done, name: 'Họp hội đồng quản trị' } })], NOW)).toBe('applied');
    expect(groupState([publishOnly({ state: 'confirmed', result: { ...done, version: 1 } })], NOW)).toBe('applied');
    expect(groupState([publishAndAssign({ state: 'confirmed', result: { ...done, version: 1, runId: id(600) } })], NOW)).toBe('applied');
    expect(groupState([createProcess({ state: 'failed', result: { reason: 'name_taken' } })], NOW)).toBe('failed');
    expect(groupState([publishOnly({ state: 'failed', result: { reason: 'template_not_draft' } })], NOW)).toBe('failed');
    expect(groupState([publishAndAssign({ state: 'undone' })], NOW)).toBe('undone');
    expect(groupState([createProcess({ state: 'rejected' })], NOW)).toBe('rejected');
    expect(groupState([createProcess()], Date.parse('2026-10-15T03:10:01.000Z'))).toBe('expired');
  });
});

describe('M3, M3b: soạn quy trình bằng hội thoại', () => {
  it('thân màn hình theo loại: các bước của bản nháp, các việc sẽ giao, hoặc chỉ câu tóm tắt khi chỉ xuất bản', () => {
    expect(reviewBody([createProcess()])).toBe('processSteps');
    expect(reviewBody([publishAndAssign()])).toBe('runPreview');
    expect(reviewBody([publishOnly()])).toBe('summaryOnly');
    // giao việc mới vẫn dùng bản xem trước như trước đây
    expect(reviewBody([proposal(1, { batchId: null, tool: 'propose_start_run', preview: [previewRow(1, 'Soạn tài liệu họp', TUAN)] })])).toBe('runPreview');
  });

  it('các loại còn lại là danh sách mục; nhiều đề xuất cùng lô luôn là danh sách mục, kể cả khi là loại có thân riêng', () => {
    expect(reviewBody([proposal(1), proposal(2)])).toBe('items');
    expect(reviewBody([proposal(1)])).toBe('items');
    expect(reviewBody([proposal(1, { tool: 'propose_reassign' })])).toBe('items');
    expect(reviewBody([proposal(1, { tool: 'propose_extend_due' })])).toBe('items');
    expect(reviewBody([proposal(1, { tool: 'propose_cancel_run', risk: 2 })])).toBe('items');
    expect(reviewBody([createProcess(), createProcess({ id: id(102) })])).toBe('items');
    expect(reviewBody([])).toBe('items');
  });

  it('tên người làm từng bước: lần đầu viết đủ, bước sau viết gọn; vai trò hoặc người giao việc thì không có tên', () => {
    expect(draftStepAssignees(createProcess().items)).toEqual(['anh Bùi Quốc Tuấn', null, 'chị Nguyễn Thu Lan']);
    // một người làm hai bước
    expect(draftStepAssignees([draftItem('Bước 1', TUAN), draftItem('Bước 2', null), draftItem('Bước 3', TUAN)])).toEqual(['anh Bùi Quốc Tuấn', null, 'anh Tuấn']);
    // hai người trùng tên gọi và xưng hô: luôn viết đủ họ tên để không lẫn
    expect(draftStepAssignees([draftItem('Bước 1', LAN), draftItem('Bước 2', LAN2), draftItem('Bước 3', LAN)])).toEqual(['chị Nguyễn Thu Lan', 'chị Phạm Thị Lan', 'chị Nguyễn Thu Lan']);
    expect(draftStepAssignees([])).toEqual([]);
    // không giữ trạng thái giữa các lần dựng màn hình: dựng lại vẫn ra đúng như lần đầu
    const items = createProcess().items;
    expect(draftStepAssignees(items)).toEqual(draftStepAssignees(items));
  });

  it('chữ sau cửa hoàn tác nói đúng việc đã làm: tạo bản nháp, chỉ xuất bản, xuất bản và giao việc', () => {
    const at = '2026-10-15T03:02:00.000Z';
    const created = createProcess({ state: 'confirmed', result: { applied: true, at, templateId: id(500), name: 'Họp hội đồng quản trị' } });
    const published = publishOnly({ state: 'confirmed', result: { applied: true, at, templateId: id(500), version: 1 } });
    const assigned = publishAndAssign({ state: 'confirmed', result: { applied: true, at, templateId: id(500), version: 1, runId: id(600) } });
    expect(processAppliedText(created.tool, [created])).toBe('Đã tạo bản nháp quy trình.');
    expect(processAppliedText(published.tool, [published])).toBe('Đã xuất bản quy trình.');
    expect(processAppliedText(assigned.tool, [assigned])).toBe('Đã xuất bản quy trình và giao việc.');
    // phân biệt "có giao việc" bằng `result.runId` của đề xuất đã áp; `runId` rỗng hay thiếu thì là chỉ xuất bản
    expect(processAppliedText('propose_publish_process', [{ result: { applied: true, version: 1, runId: null } }])).toBe('Đã xuất bản quy trình.');
    expect(processAppliedText('propose_publish_process', [{ result: null }])).toBe('Đã xuất bản quy trình.');
    expect(processAppliedText('propose_publish_process', [])).toBe('Đã xuất bản quy trình.');
  });

  it('các loại khác trả null để màn hình giữ câu cũ ("Đã gửi.", "Đã thực hiện."); giao việc mới có `runId` cũng không bị nhận nhầm', () => {
    expect(processAppliedText('propose_nudge', [{ result: { nudgeId: id(700) } }])).toBeNull();
    expect(processAppliedText('propose_start_run', [{ result: { runId: id(600) } }])).toBeNull();
    expect(processAppliedText('propose_reassign', [{ result: { ok: true } }])).toBeNull();
    expect(processAppliedText('propose_cancel_run', [{ result: null }])).toBeNull();
    expect(processAppliedText('', [])).toBeNull();
    expect(processAppliedText(undefined, [])).toBeNull();
  });
});

describe('M3: lý do chưa làm được và chữ trên nút', () => {
  const r = strings.executive.review.failedReasons;
  it('mọi mã lý do của máy chủ có câu tiếng Việt; mã lạ dùng câu dự phòng, không hiện mã', () => {
    const codes = [
      'step_not_open',
      'assignee_changed',
      'forbidden',
      'user_inactive',
      'not_found',
      'already_nudged_today',
      'quiet_hours',
      'extension_pending',
      'not_overdue',
      'template_archived',
      'template_invalid',
      'assignee_unavailable',
      'same_assignee',
      'due_in_past',
      'run_not_running',
      'name_taken',
      'template_not_draft',
    ];
    for (const code of codes) expect(Object.values(r), code).toContain(failedReasonText(code));
    for (const code of codes) expect(failedReasonText(code), code).not.toBe(r.other);
    expect(failedReasonText('step_not_open')).toBe(r.alreadyDone);
    expect(failedReasonText('already_nudged_today')).toBe(r.throttled);
    expect(failedReasonText('forbidden')).toBe(r.noPermission);
    expect(failedReasonText('ma_la_chua_biet')).toBe(r.other);
    expect(failedReasonText(undefined)).toBe(r.other);
  });

  it('soạn quy trình: trùng tên và bản nháp không còn có câu riêng; các mã khác của hai việc này dùng câu chung, không hiện mã', () => {
    expect(failedReasonText('name_taken')).toBe(r.nameTaken);
    expect(failedReasonText('template_not_draft')).toBe(r.notDraft);
    expect(r.nameTaken).toMatch(/trùng tên/);
    expect(r.notDraft).toMatch(/đã được xuất bản hoặc không còn/);
    expect(new Set([r.nameTaken, r.notDraft, r.changed, r.noPermission]).size).toBe(4);
    // Người trong đề xuất đã nghỉ, và mẫu chưa dùng được, có câu riêng thay cho câu chung về "việc".
    expect(failedReasonText('assignee_unavailable')).toBe(r.personGone);
    expect(failedReasonText('template_invalid')).toBe(r.templateNotUsable);
    // Mọi mã máy chủ có thể trả khi tạo bản nháp hoặc xuất bản đều ra câu tiếng Việt, không hiện mã.
    for (const code of ['forbidden', 'name_taken', 'assignee_unavailable', 'not_found', 'template_invalid', 'template_archived', 'template_not_draft']) {
      expect(failedReasonText(code), code).not.toBe(r.other);
      expect(failedReasonText(code), code).not.toContain(code);
    }
    // Lý do nằm ở `result.reason` của đề xuất không làm được (`state` là failed); thiếu lý do thì dùng câu dự phòng.
    expect(failedReasonOf(createProcess({ state: 'failed', result: { reason: 'name_taken', stage: 'confirm' } }))).toBe(r.nameTaken);
    expect(failedReasonOf(publishOnly({ state: 'failed', result: { reason: 'template_not_draft', stage: 'apply' } }))).toBe(r.notDraft);
    expect(failedReasonOf(publishAndAssign({ state: 'failed', result: { stage: 'apply' } }))).toBe(r.other);
    expect(failedReasonOf(publishOnly({ state: 'failed', result: null }))).toBe(r.other);
  });

  it('hai nút là "Đồng ý gửi" và "Không gửi"; mức 2 nói rõ là dừng lượt; không có nút "Hủy"', () => {
    expect(reviewLabels('propose_nudge')).toMatchObject({ confirm: 'Đồng ý gửi', reject: 'Không gửi' });
    expect(reviewLabels('propose_cancel_run')).toMatchObject({ confirm: 'Đồng ý dừng lượt này', reject: 'Không dừng' });
    // Mọi loại đề xuất, kể cả hai loại soạn quy trình, có hay không có `preview`.
    for (const tool of PROPOSAL_TOOLS) {
      for (const labels of [reviewLabels(tool), reviewLabels(tool, { preview: [] })]) {
        expect(`${labels.confirm} ${labels.reject}`).not.toMatch(/Hủy|Huỷ|Từ chối/);
      }
    }
  });

  it('soạn quy trình: nút nói rõ đồng ý việc gì; xuất bản và giao việc khác chỉ xuất bản ở chỗ có bản xem trước', () => {
    expect(reviewLabels('propose_create_process', createProcess())).toEqual({ confirm: 'Đồng ý tạo bản nháp', reject: 'Không tạo', heading: 'Các bước của quy trình' });
    expect(reviewLabels('propose_publish_process', publishOnly())).toEqual({ confirm: 'Đồng ý xuất bản', reject: 'Không xuất bản', heading: null });
    expect(reviewLabels('propose_publish_process', publishAndAssign())).toEqual({ confirm: 'Đồng ý xuất bản và giao việc', reject: 'Không xuất bản', heading: 'Các việc sẽ giao' });
    // Chưa có đề xuất trong tay (đang tải) thì coi là chỉ xuất bản; bản xem trước rỗng vẫn là có giao việc.
    expect(reviewLabels('propose_publish_process')).toMatchObject({ confirm: 'Đồng ý xuất bản' });
    expect(reviewLabels('propose_publish_process', { preview: [] })).toMatchObject({ confirm: 'Đồng ý xuất bản và giao việc' });
    // Giao việc mới (có `preview`) không đổi.
    expect(reviewLabels('propose_start_run', { preview: [previewRow(1, 'Soạn tài liệu họp', TUAN)] })).toEqual({ confirm: 'Đồng ý giao việc', reject: 'Không giao', heading: 'Các việc sẽ giao' });
  });

  it('giao một việc lẻ (propose_assign_task): nút nói rõ giao việc, thân là danh sách mục, báo "Đã giao việc."', () => {
    expect(reviewLabels('propose_assign_task')).toEqual({ confirm: 'Đồng ý giao việc', reject: 'Không giao', heading: 'Việc sẽ giao' });
    expect(reviewBody([proposal(1, { tool: 'propose_assign_task' })])).toBe('items');
    expect(processAppliedText('propose_assign_task', [{ result: { applied: true, runId: id(600), stepId: id(601) } }])).toBe('Đã giao việc.');
    // Câu đầu màn hình của máy chủ đã nói đủ người nhận và hạn; phần ghi kèm là chữ nối thêm duy nhất của thẻ.
    const summary = 'Giao việc ‘Gửi báo giá’ cho anh Võ Hoàng Hùng, hạn Thứ Hai, ngày 12 tháng 10 năm 2026.';
    const withNote = proposal(1, { tool: 'propose_assign_task', summary, items: [{ ...proposal(1).items[0]!, text: `${summary} Nội dung ghi kèm: “Kèm bảng giá”.` }] });
    expect(reviewItemText(withNote, false)).toBe('Nội dung ghi kèm: “Kèm bảng giá”.');
  });

  it('giao lại mà người nhận không được bổ nhiệm (ủy quyền bị thu hồi lúc chờ) có câu riêng, không hiện mã của máy chủ', () => {
    expect(failedReasonText('not_appointed')).toBe('Việc này thuộc quy trình, chỉ giao lại được cho người được bổ nhiệm hoặc người được ủy quyền.');
    expect(failedReasonText('assignee_is_self')).toBe('Tình trạng của việc đã thay đổi.');
  });

  it('M6 gom đề xuất đang chờ theo lô: một lô là một việc cần xem', () => {
    const groups = groupPendingProposals([proposal(1), proposal(2), proposal(3, { batchId: null, source: 'office' })]);
    expect(groups.map((g) => [g.batchId, g.source, g.proposals.length])).toEqual([
      [id(900), 'ai', 2],
      [null, 'office', 1],
    ]);
  });
});

const step = (over: Partial<StepView>): Pick<StepView, 'state' | 'isOverdue' | 'lateWorkingDays'> => ({ state: 'ready', isOverdue: false, lateWorkingDays: 0, ...over });
const runOf = (status: RunSummary['schedule']['status'], lateWorkingDays: number, startedAt: string, state: RunSummary['state'] = 'running') => ({ state, schedule: { status, lateWorkingDays }, startedAt });

describe('M4, M5: trạng thái bằng chữ kèm hình (SPEC 7.3)', () => {
  it('Xong có dấu tích; Quá hạn có dấu cảnh báo và số ngày làm việc; còn lại chỉ khác chữ', () => {
    expect(stepChip(step({ state: 'done' }))).toEqual({ kind: 'done', label: 'Xong' });
    expect(stepChip(step({ isOverdue: true, lateWorkingDays: 2 }))).toEqual({ kind: 'late', label: 'Đã quá hạn 2 ngày làm việc' });
    expect(stepChip(step({ isOverdue: true, lateWorkingDays: 0 }))).toEqual({ kind: 'late', label: 'Vừa quá hạn' });
    expect(stepChip(step({ state: 'ready' }))).toEqual({ kind: 'open', label: 'Mới giao' });
    expect(stepChip(step({ state: 'in_progress' }))).toEqual({ kind: 'open', label: 'Đang làm' });
  });

  it('dòng trạng thái của lượt: "Đúng tiến độ", "Chậm 2 ngày làm việc"', () => {
    expect(scheduleLine(runOf('on_track', 0, ''))).toEqual({ late: false, done: false, label: 'Đúng tiến độ' });
    expect(scheduleLine(runOf('late', 2, ''))).toEqual({ late: true, done: false, label: 'Chậm 2 ngày làm việc' });
    expect(scheduleLine(runOf('late', 0, ''))).toMatchObject({ late: true, label: 'Đang chậm' });
    expect(scheduleLine(runOf('done', 0, '', 'completed'))).toMatchObject({ done: true, label: 'Đã hoàn tất' });
  });

  it('lượt chậm nhiều nhất đứng trước, rồi tới lượt mới bắt đầu', () => {
    const sorted = sortRuns([runOf('on_track', 0, '2026-10-01'), runOf('late', 1, '2026-09-20'), runOf('late', 3, '2026-09-10'), runOf('on_track', 0, '2026-10-03')]);
    expect(sorted.map((r) => `${r.schedule.lateWorkingDays}@${r.startedAt}`)).toEqual(['3@2026-09-10', '1@2026-09-20', '0@2026-10-03', '0@2026-10-01']);
  });

  it('nút đi thúc chỉ có khi lượt có việc đang chậm', () => {
    expect(lateSteps([step({ isOverdue: true }), step({}), step({ state: 'done', isOverdue: false })])).toHaveLength(1);
    expect(lateSteps([step({}), step({ state: 'done' })])).toHaveLength(0);
  });
});

describe('thông báo đẩy: chạm là mở đúng màn hình (SPEC 10.9)', () => {
  it('briefing → M1; approval → M6; proposal.office và proposal.failed → M3', () => {
    expect(targetForNotification({ type: 'briefing', link: 'mihato://home' })).toEqual({ screen: 'home' });
    expect(targetForNotification({ type: 'approval', link: `mihato://step/${id(5)}` })).toEqual({ screen: 'decisions' });
    expect(targetForNotification({ type: 'proposal.office', proposalId: id(7), batchId: id(8), link: `mihato://proposal/${id(7)}` })).toEqual({ screen: 'review', proposalId: id(7) });
    expect(targetForNotification({ type: 'proposal.failed', reason: 'step_not_open', link: `mihato://proposal/${id(9)}` })).toEqual({ screen: 'review', proposalId: id(9) });
  });

  it('thiếu mã đề xuất thì mở Việc cần quyết; loại lạ hoặc dữ liệu hỏng thì không điều hướng', () => {
    expect(targetForNotification({ type: 'proposal.office' })).toEqual({ screen: 'decisions' });
    expect(targetForNotification({ type: 'assigned', link: `mihato://step/${id(5)}` })).toBeNull();
    expect(targetForNotification(null)).toBeNull();
    expect(targetForNotification('briefing')).toBeNull();
    expect(proposalIdFromLink('mihato://proposal/khong-phai-uuid')).toBeNull();
    expect(proposalIdFromLink(`mihato-exec://proposal/${id(3)}`)).toBe(id(3));
  });

  it('lấy mã thông báo để ghi `opened`', () => {
    expect(notificationIdOf({ notificationId: id(11) })).toBe(id(11));
    expect(notificationIdOf({ notificationId: 'x' })).toBeNull();
    expect(notificationIdOf(undefined)).toBeNull();
  });
});

describe('lưu trên máy (SPEC 7.8)', () => {
  const ok = { status: 'success' };
  it('chỉ bản tiến độ gần nhất được ghi xuống máy', () => {
    expect(shouldPersistQuery({ queryKey: ['progress', 'runs'], state: ok })).toBe(true);
    expect(shouldPersistQuery({ queryKey: ['progress', 'run', id(1)], state: ok })).toBe(true);
    expect(shouldPersistQuery({ queryKey: ['progress', 'overview'], state: ok })).toBe(true);
  });
  it('việc cần quyết, đề xuất, bản tin, hồ sơ KHÔNG được lưu; truy vấn lỗi cũng không', () => {
    for (const key of [['decisions', 'approvals'], ['decisions', 'proposals'], ['proposal', id(1)], ['briefing'], ['me'], ['delegations'], ['people']]) {
      expect(shouldPersistQuery({ queryKey: key, state: ok }), key.join('/')).toBe(false);
    }
    expect(shouldPersistQuery({ queryKey: ['progress', 'runs'], state: { status: 'error' } })).toBe(false);
  });
});

const ME: Me = {
  permissions: ['self.read', 'step.act_own', 'delegation.self', 'assistant.use', 'briefing.view'],
  id: id(50),
  orgId: id(51),
  orgCode: 'demo',
  orgName: 'MIHATO',
  fullName: 'Phạm Quang Huy',
  givenName: 'Huy',
  honorific: 'ong',
  email: null,
  phone: null,
  unitId: null,
  unitName: null,
  isUnitHead: false,
  roles: [{ role: 'deputy', unitId: null }],
  uiProfile: 'standard',
  prefs: { fontScale: 'xlarge', speechRate: 'normal', voiceId: null, briefingTime: '07:30', quietHours: null, sendSound: true },
  activeDelegations: [],
  officePhone: '024 3999 0000',
  greeting: null,
  calendar: { workdays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00' },
  ai: { enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'vbee' },
  mfaEnabled: false,
  mfaRequired: false,
  mfaEnforced: false,
};

describe('bản nhớ trên máy cho màn khoá và lúc mất mạng', () => {
  it('nhớ cách gọi, hồ sơ giao diện, cỡ chữ, số Văn phòng; không nhớ dữ liệu công việc', async () => {
    const kv = createMemoryKV();
    const store = new LocalProfileStore(kv);
    await store.load();
    expect(store.getSnapshot()).toEqual(DEFAULT_LOCAL_PROFILE);
    await store.rememberMe(ME);
    expect(store.getSnapshot()).toEqual({ address: 'Phó giám đốc', uiProfile: 'standard', fontScale: 'xlarge', officePhone: '024 3999 0000', assistantEnabled: true, profileOverride: null });
    expect(Object.keys(JSON.parse(kv.dump()[KV_KEYS.localProfile] ?? '{}') as object).sort()).toEqual(['address', 'assistantEnabled', 'fontScale', 'officePhone', 'uiProfile']);

    const reopened = new LocalProfileStore(kv);
    await reopened.load();
    expect(reopened.getSnapshot()).toMatchObject({ address: 'Phó giám đốc', fontScale: 'xlarge' });
  });

  it('Phó giám đốc đổi sang hồ sơ senior ở Cài đặt: lựa chọn nằm trên máy và còn sau khi mở lại', async () => {
    const kv = createMemoryKV();
    const store = new LocalProfileStore(kv);
    await store.rememberMe(ME);
    await store.setProfileOverride('senior');
    const reopened = new LocalProfileStore(kv);
    await reopened.load();
    expect(reopened.getSnapshot().profileOverride).toBe('senior');
    await reopened.rememberMe({ ...ME, prefs: { ...ME.prefs, fontScale: 'xxlarge' } });
    expect(reopened.getSnapshot()).toMatchObject({ profileOverride: 'senior', fontScale: 'xxlarge' });
    reopened.reset();
    expect(reopened.getSnapshot()).toEqual(DEFAULT_LOCAL_PROFILE);
  });

  it('công tắc AI của tổ chức: tắt AI hoặc tắt LLM thì ẩn tab Trợ lý', () => {
    expect(assistantEnabledFor({ enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'vbee' })).toBe(true);
    // Tổ chức bật AI nhưng người này bị bớt quyền dùng Trợ lý AI: app ẩn tab Trợ lý.
    expect(assistantEnabledFor({ enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'vbee' }, ['self.read', 'assistant.use'])).toBe(true);
    expect(assistantEnabledFor({ enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'vbee' }, ['self.read'])).toBe(false);
    expect(assistantEnabledFor({ enabled: false, stt: 'deepgram', llm: 'anthropic', tts: 'vbee' })).toBe(false);
    expect(assistantEnabledFor({ enabled: true, stt: 'deepgram', llm: 'off', tts: 'vbee' })).toBe(false);
    // STT tắt thì vẫn có trợ lý, chỉ gõ chữ.
    expect(assistantEnabledFor({ enabled: true, stt: 'off', llm: 'anthropic', tts: 'device' })).toBe(true);
    expect(localProfileFromMe({ ...ME, ai: { ...ME.ai, enabled: false } }, DEFAULT_LOCAL_PROFILE).assistantEnabled).toBe(false);
  });
});

describe('Nhờ Văn phòng: đường dẫn gọi điện', () => {
  it('bỏ khoảng trắng, dấu chấm, gạch và ngoặc; giữ dấu cộng đầu', () => {
    expect(telUrl('0243 123 4567')).toBe('tel:02431234567');
    expect(telUrl('(024) 3123.4567')).toBe('tel:02431234567');
    expect(telUrl('+84 24 3123-4567')).toBe('tel:+842431234567');
    expect(telUrl('  0912345678  ')).toBe('tel:0912345678');
  });

  it('officeAction: có số gọi được thì gọi thẳng; chưa có số hoặc số hỏng thì mở màn hình giải thích, không bao giờ ẩn nút', () => {
    expect(officeAction('0243 123 4567')).toEqual({ kind: 'call', url: 'tel:02431234567' });
    expect(officeAction('+84 24 3123-4567')).toEqual({ kind: 'call', url: 'tel:+842431234567' });
    expect(officeAction(null)).toEqual({ kind: 'screen' });
    expect(officeAction(undefined)).toEqual({ kind: 'screen' });
    expect(officeAction('')).toEqual({ kind: 'screen' });
    expect(officeAction('gọi số nội bộ')).toEqual({ kind: 'screen' });
    expect(officeAction('12')).toEqual({ kind: 'screen' });
  });

  it('không phải số hoặc quá ngắn, quá dài thì không dựng đường dẫn (không gọi bừa)', () => {
    expect(telUrl('')).toBeNull();
    expect(telUrl('abc')).toBeNull();
    expect(telUrl('12')).toBeNull();
    expect(telUrl('1234567890123456')).toBeNull();
  });
});

describe('M4: mục Cần Chủ tịch biết gọn lại khi có nhiều việc chậm', () => {
  const steps = (days: number[]) => days.map((lateWorkingDays, i) => ({ id: `s${i}`, lateWorkingDays }));

  it('chỉ hiện vài việc chậm nhất, kèm số việc đang ẩn; việc chậm nhiều ngày nhất đứng đầu', () => {
    const p = attentionPreview(steps([3, 7, 4, 5, 3]), false);
    expect(p.shown.map((s) => s.lateWorkingDays)).toEqual([7, 5]);
    expect(p.hidden).toBe(3);
    expect(p.shown).toHaveLength(ATTENTION_PREVIEW);
  });

  it('bấm "Xem các việc này" thì hiện đủ; ít việc thì không ẩn gì', () => {
    expect(attentionPreview(steps([3, 7, 4, 5, 3]), true)).toMatchObject({ hidden: 0 });
    expect(attentionPreview(steps([3, 7, 4, 5, 3]), true).shown).toHaveLength(5);
    expect(attentionPreview(steps([4, 3]), false)).toMatchObject({ hidden: 0 });
    expect(attentionPreview(steps([]), false)).toEqual({ shown: [], hidden: 0 });
  });
});
