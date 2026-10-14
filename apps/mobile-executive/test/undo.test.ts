import { describe, expect, it } from 'vitest';
import { UNDO_WINDOW_SECONDS, announcedSeconds, appliedOutcome, secondsLeft } from '../src/features/undo';

/** Cửa hoàn tác 30 giây của M3b (SPEC 6.5 điều 8, 10.6): đồng hồ tính theo `undoUntil` do máy chủ trả. */
const UNTIL = '2026-10-15T03:00:30.000Z';
const at = (iso: string) => Date.parse(iso);

describe('đếm ngược hoàn tác', () => {
  it('cửa hoàn tác là 30 giây', () => {
    expect(UNDO_WINDOW_SECONDS).toBe(30);
  });

  it('số giây còn lại làm tròn lên: còn 0,2 giây vẫn hiện "Còn 1 giây" vì vẫn hoàn tác được', () => {
    expect(secondsLeft(UNTIL, at('2026-10-15T03:00:00.000Z'))).toBe(30);
    expect(secondsLeft(UNTIL, at('2026-10-15T03:00:00.001Z'))).toBe(30);
    expect(secondsLeft(UNTIL, at('2026-10-15T03:00:12.500Z'))).toBe(18);
    expect(secondsLeft(UNTIL, at('2026-10-15T03:00:29.800Z'))).toBe(1);
  });

  it('hết giờ và quá giờ đều là 0, không âm', () => {
    expect(secondsLeft(UNTIL, at('2026-10-15T03:00:30.000Z'))).toBe(0);
    expect(secondsLeft(UNTIL, at('2026-10-15T03:05:00.000Z'))).toBe(0);
  });

  it('thiếu hoặc sai `undoUntil`: coi như đã hết giờ, không hiện số bừa', () => {
    expect(secondsLeft(null, 0)).toBe(0);
    expect(secondsLeft(undefined, 0)).toBe(0);
    expect(secondsLeft('không phải ngày', 0)).toBe(0);
  });

  it('không tự đếm bằng số lần hẹn giờ: app bị tạm dừng 20 giây rồi mở lại vẫn hiện đúng số giây còn lại', () => {
    const opened = at('2026-10-15T03:00:01.000Z');
    expect(secondsLeft(UNTIL, opened)).toBe(29);
    expect(secondsLeft(UNTIL, opened + 20_000)).toBe(9);
  });

  it('số giây nêu trong câu "Sẽ gửi sau {n} giây" không vượt 30 dù đồng hồ máy chạy chậm hơn máy chủ', () => {
    expect(announcedSeconds(UNTIL, at('2026-10-15T03:00:00.400Z'))).toBe(30);
    expect(announcedSeconds(UNTIL, at('2026-10-15T02:59:50.000Z'))).toBe(30);
    expect(announcedSeconds(UNTIL, at('2026-10-15T03:00:22.000Z'))).toBe(8);
  });
});

describe('sau khi hết giờ: máy chủ đã làm tới đâu', () => {
  const confirmed = { state: 'confirmed' as const, result: null };
  const applied = { state: 'confirmed' as const, result: { ok: true } };
  const failed = { state: 'failed' as const, result: { reason: 'step_not_open' } };
  const undone = { state: 'undone' as const, result: null };

  it('mọi đề xuất đã thực hiện thì mới báo "Đã gửi"', () => {
    expect(appliedOutcome([applied, applied])).toBe('sent');
    expect(appliedOutcome([applied, confirmed])).toBe('sending');
    expect(appliedOutcome([confirmed])).toBe('sending');
  });

  it('có mục không làm được thì báo rõ, không báo "Đã gửi"', () => {
    expect(appliedOutcome([applied, failed])).toBe('failed');
  });

  it('đã hoàn tác hết thì là đã hoàn tác; chưa biết gì thì vẫn là đang gửi', () => {
    expect(appliedOutcome([undone, undone])).toBe('undone');
    expect(appliedOutcome([undone, applied])).toBe('sent');
    expect(appliedOutcome([])).toBe('sending');
  });

  it('soạn quy trình (tạo bản nháp, xuất bản, giao việc ngay): kết quả có `applied`, `templateId`, `runId` cũng là đã thực hiện', () => {
    const at = '2026-10-15T03:00:31.000Z';
    expect(appliedOutcome([{ state: 'confirmed', result: { applied: true, at, templateId: 't1', name: 'Họp hội đồng quản trị' } }])).toBe('sent');
    expect(appliedOutcome([{ state: 'confirmed', result: { applied: true, at, templateId: 't1', version: 1 } }])).toBe('sent');
    expect(appliedOutcome([{ state: 'confirmed', result: { applied: true, at, templateId: 't1', version: 1, runId: 'r1' } }])).toBe('sent');
    // đã đồng ý mà máy chủ chưa áp: vẫn là đang gửi; trùng tên hoặc bản nháp không còn: báo rõ
    expect(appliedOutcome([confirmed])).toBe('sending');
    expect(appliedOutcome([{ state: 'failed', result: { reason: 'name_taken', stage: 'apply', at } }])).toBe('failed');
    expect(appliedOutcome([{ state: 'failed', result: { reason: 'template_not_draft', stage: 'apply', at } }])).toBe('failed');
  });
});
