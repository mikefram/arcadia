import { newId, type RunDetail, type StepView } from '@mihato/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb } from '../src/db/client';
import { compileStep } from '../src/services/compile';
import { downloadFile, listRunFiles } from '../src/services/files';
import { actOnStep, getRun, getStepDetail } from '../src/services/runs';
import { startRun } from '../src/services/runs';
import { setRunShare } from '../src/services/shares';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { MemoryFileStorage, setFileStorage } from '../src/storage';
import { createTestOrg, type TestOrg, type TestUserKey } from '../src/testing';
import { expectApiError } from './helpers';

/**
 * Bộ che phần của người đóng góp (docs/DECISIONS.md, 06/10/2026) khép các lỗ của đợt rà soát 07/10/2026:
 * - runs-1: cấp trên trực tiếp (trưởng đơn vị) của người góp, không có vai nào trong lượt, vẫn không đọc được phần của người khác;
 * - files-3: tệp Word và PDF tổng hợp chứa phần của mọi người, nên người bị che phần của người khác cũng không thấy và không tải được tệp đó.
 */
let org: TestOrg;
const storage = new MemoryFileStorage();
const asV = (who: TestUserKey) => org.viewer(who);
const stepOf = (run: RunDetail, nodeId: string): StepView => run.steps.find((s) => s.nodeId === nodeId)!;
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };

let runId: string;
let gopId: string;
let tonghopId: string;
let compiledId: string;
let compiledPdfId: string;

beforeAll(async () => {
  setFileStorage(storage);
  setFakeNow('2026-10-07T03:00:00.000Z');
  org = await createTestOrg({ name: 'Công ty thử che phần góp' });
  const def = {
    schemaVersion: 1,
    name: 'Văn bản đi thử',
    starters: [{ kind: 'everyone' }],
    inputs: [
      { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
      { key: 'phoiHop', label: 'Phối hợp', type: 'users', required: true },
    ],
    nodes: [
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      {
        id: 'gop',
        type: 'approval',
        label: 'Góp',
        title: 'Góp nội dung',
        action: 'contribute',
        approvers: [{ kind: 'form_field', field: 'phoiHop' }],
        mode: 'all',
        due: DUE,
        form: [{ key: 'noiDung', label: 'Nội dung', type: 'longtext', required: true }],
      },
      {
        id: 'tonghop',
        type: 'task',
        label: 'Tổng hợp',
        title: 'Tổng hợp',
        assignee: { kind: 'user', userId: org.users.deputy },
        due: DUE,
        compile: { layout: 'report', title: '{trichYeu}', required: true, sections: [{ heading: 'Nội dung', ref: 'responses.gop.noiDung' }] },
      },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 's>g', from: 'start', to: 'gop' },
      { id: 'g>t', from: 'gop', to: 'tonghop', outcome: 'approved' },
      { id: 't>e', from: 'tonghop', to: 'end' },
    ],
  };
  const created = await org.run((tx, ctx) => createTemplate(tx, ctx, asV('designer'), { name: def.name, description: null, definition: def as never }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, asV('designer'), created.id));
  const run = await org.run((tx, ctx) => startRun(tx, ctx, asV('designer'), { templateId: created.id, title: 'Báo cáo tổng hợp', inputs: { trichYeu: 'Báo cáo quý', phoiHop: [org.users.employee, org.users.employee2] } }, newId()));
  runId = run.id;
  gopId = stepOf(run, 'gop').id;
  await org.run((tx, ctx) => actOnStep(tx, ctx, asV('employee'), gopId, newId(), { type: 'ApproveStep', result: { noiDung: 'PHẦN RIÊNG CỦA LAN' } }));
});
afterAll(async () => {
  setFileStorage(null);
  setFakeNow(null);
  await closeDb();
});

describe('runs-1: người không có vai nào trong lượt cũng chỉ thấy phần của chính mình', () => {
  it('trưởng Phòng Kinh doanh (cấp trên của Lan và Tuấn) thấy việc nhưng phần của Lan bị che', async () => {
    const detail = await org.run((tx, ctx) => getStepDetail(tx, ctx, asV('head'), gopId));
    const lan = detail.participants!.find((p) => p.person.id === org.users.employee)!;
    expect(lan).toMatchObject({ decision: 'approved', result: null, comment: null, fileIds: [], contentHidden: true });
    expect(JSON.stringify(detail)).not.toContain('PHẦN RIÊNG CỦA LAN');
    const viaRun = await org.run((tx, ctx) => getRun(tx, ctx, asV('head'), runId));
    expect(JSON.stringify(viaRun)).not.toContain('PHẦN RIÊNG CỦA LAN');
  });

  it('người khởi chạy, Chủ tịch và Giám đốc (view_all) vẫn thấy hết', async () => {
    for (const who of ['designer', 'chairman', 'director'] as TestUserKey[]) {
      const detail = await org.run((tx, ctx) => getStepDetail(tx, ctx, asV(who), gopId));
      expect(JSON.stringify(detail), who).toContain('PHẦN RIÊNG CỦA LAN');
    }
  });

  it('người được chia sẻ (không có vai nào trong lượt) cũng bị che; chính Lan vẫn thấy phần của mình', async () => {
    await org.run((tx, ctx) => setRunShare(tx, ctx, asV('designer'), runId, org.users.itAdmin, 'viewer'));
    const shared = await org.run((tx, ctx) => getStepDetail(tx, ctx, asV('itAdmin'), gopId));
    expect(JSON.stringify(shared)).not.toContain('PHẦN RIÊNG CỦA LAN');
    const lan = await org.run((tx, ctx) => getStepDetail(tx, ctx, asV('employee'), gopId));
    expect(JSON.stringify(lan)).toContain('PHẦN RIÊNG CỦA LAN');
  });
});

describe('files-3: tệp tổng hợp chỉ cho người không bị che', () => {
  beforeAll(async () => {
    await org.run((tx, ctx) => actOnStep(tx, ctx, asV('employee2'), gopId, newId(), { type: 'ApproveStep', result: { noiDung: 'PHẦN RIÊNG CỦA TUẤN' } }));
    tonghopId = stepOf(await org.run((tx, ctx) => getRun(tx, ctx, asV('designer'), runId)), 'tonghop').id;
    const file = await org.run((tx, ctx) => compileStep(tx, ctx, asV('deputy'), tonghopId, {}));
    compiledId = file.id;
    compiledPdfId = file.pdf!.id;
  });

  it('người giữ việc tổng hợp, người khởi chạy và người xem mọi lượt thấy và tải được cả Word lẫn PDF', async () => {
    for (const who of ['deputy', 'designer', 'chairman', 'director'] as TestUserKey[]) {
      const files = await org.run((tx, ctx) => listRunFiles(tx, ctx, asV(who), runId));
      expect(files.filter((f) => f.compiled).map((f) => f.id).sort(), who).toEqual([compiledId, compiledPdfId].sort());
      for (const id of [compiledId, compiledPdfId]) expect((await org.run((tx, ctx) => downloadFile(tx, ctx, asV(who), id))).data.length).toBeGreaterThan(0);
      expect((await org.run((tx, ctx) => getRun(tx, ctx, asV(who), runId))).steps.some((st) => st.files?.some((f) => f.compiled)), `việc của lượt ← ${who}`).toBe(true);
    }
  });

  it('người chỉ góp (Lan, Tuấn), cấp trên của họ và người được chia sẻ không thấy và không tải được (404)', async () => {
    for (const who of ['employee', 'employee2', 'head', 'itAdmin'] as TestUserKey[]) {
      const files = await org.run((tx, ctx) => listRunFiles(tx, ctx, asV(who), runId));
      expect(files.some((f) => f.compiled), `danh sách ← ${who}`).toBe(false);
      for (const id of [compiledId, compiledPdfId]) await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, asV(who), id)), 'not_found');
      const detail = await org.run((tx, ctx) => getRun(tx, ctx, asV(who), runId));
      expect(detail.files?.some((f) => f.compiled), `chi tiết lượt ← ${who}`).toBeFalsy();
      // Cũng không lọt qua danh sách tệp gắn ở từng việc của lượt.
      expect(detail.steps.some((st) => st.files?.some((f) => f.compiled)), `việc của lượt ← ${who}`).toBe(false);
    }
  });
});
