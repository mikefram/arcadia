import type { RegisterEntryView } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv';
import { choicesFor, entryText, filterEntries, hasFilters, NO_FILTERS, registerCsvColumns, registerCsvFileName } from '../src/features/documents/register-export';

const person = { id: '0198f1e0-0000-7000-8000-000000000001', fullName: 'Nguyễn Thị Văn Thư', givenName: 'Thư', honorific: null } as const;

function entry(over: Partial<RegisterEntryView> & { values?: Record<string, unknown> } = {}): RegisterEntryView {
  return {
    id: '0198f1e0-0000-7000-8000-0000000000aa',
    number: '0001',
    year: 2026,
    seq: 1,
    createdAt: '2026-10-07T03:00:00.000Z',
    subject: 'V/v kiểm tra phòng cháy chữa cháy',
    createdBy: person,
    run: { id: '0198f1e0-0000-7000-8000-0000000000bb', state: 'running' },
    values: {},
    ...over,
  };
}

const den = [
  entry({ id: 'a', number: '0001', createdAt: '2026-10-05T03:00:00.000Z', values: { noiGui: 'Sở Tài nguyên và Môi trường', loaiVanBan: 'cong_van', mucKhan: 'khan', mucMat: 'thuong', __nhan: { loaiVanBan: 'Công văn', mucKhan: 'Khẩn', mucMat: 'Thường' } } }),
  entry({ id: 'b', number: '0002', createdAt: '2026-10-07T03:00:00.000Z', values: { noiGui: 'Ủy ban nhân dân tỉnh', loaiVanBan: 'thong_bao', mucKhan: 'thuong', mucMat: 'mat', __nhan: { loaiVanBan: 'Thông báo', mucKhan: 'Thường', mucMat: 'Mật' } } }),
  entry({ id: 'c', number: '0003', createdAt: '2026-10-09T03:00:00.000Z', values: { noiGui: 'Tập đoàn Công nghiệp Cao su', loaiVanBan: 'cong_van', mucKhan: 'hoa_toc', mucMat: 'thuong', __nhan: { loaiVanBan: 'Công văn', mucKhan: 'Hỏa tốc', mucMat: 'Thường' } } }),
];

describe('sổ văn bản: chữ hiện ở ô', () => {
  it('có nhãn thì hiện nhãn, không hiện mã thô; không có nhãn thì định dạng giá trị', () => {
    const e = den[0]!;
    expect(entryText(e, 'mucKhan')).toBe('Khẩn');
    expect(entryText(e, 'loaiVanBan')).toBe('Công văn');
    expect(entryText(e, 'noiGui')).toBe('Sở Tài nguyên và Môi trường');
    expect(entryText(entry({ values: { hanXuLy: '2026-10-14', soLuongBan: 5 } }), 'hanXuLy')).toBe('14/10/2026');
    expect(entryText(entry({ values: { soLuongBan: 5 } }), 'soLuongBan')).toBe('5');
    expect(entryText(e, 'khongCo')).toBeNull();
  });

  it('dòng cũ chưa có nhãn vẫn hiện được (giá trị gốc)', () => {
    expect(entryText(entry({ values: { mucKhan: 'khan' } }), 'mucKhan')).toBe('khan');
  });
});

describe('sổ văn bản: lọc', () => {
  const ids = (rows: RegisterEntryView[]) => rows.map((r) => r.id);

  it('không điều kiện thì giữ nguyên', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(ids(filterEntries(den, NO_FILTERS))).toEqual(['a', 'b', 'c']);
  });

  it('theo nơi gửi (không phân biệt hoa thường và dấu), loại, mức khẩn, mức mật', () => {
    expect(ids(filterEntries(den, { ...NO_FILTERS, place: 'tai nguyen' }))).toEqual(['a']);
    expect(ids(filterEntries(den, { ...NO_FILTERS, place: 'CAO SU' }))).toEqual(['c']);
    expect(ids(filterEntries(den, { ...NO_FILTERS, type: 'cong_van' }))).toEqual(['a', 'c']);
    expect(ids(filterEntries(den, { ...NO_FILTERS, urgency: 'hoa_toc' }))).toEqual(['c']);
    expect(ids(filterEntries(den, { ...NO_FILTERS, secrecy: 'mat' }))).toEqual(['b']);
    expect(ids(filterEntries(den, { ...NO_FILTERS, type: 'cong_van', urgency: 'khan' }))).toEqual(['a']);
  });

  it('theo khoảng ngày cấp số, tính theo giờ Việt Nam, gồm cả hai đầu', () => {
    expect(ids(filterEntries(den, { ...NO_FILTERS, from: '2026-10-06', to: '2026-10-08' }))).toEqual(['b']);
    expect(ids(filterEntries(den, { ...NO_FILTERS, from: '2026-10-07' }))).toEqual(['b', 'c']);
    expect(ids(filterEntries(den, { ...NO_FILTERS, to: '2026-10-05' }))).toEqual(['a']);
    // 20:00 UTC ngày 7 đã là ngày 8 ở Việt Nam.
    const late = entry({ id: 'late', createdAt: '2026-10-07T20:00:00.000Z' });
    expect(ids(filterEntries([late], { ...NO_FILTERS, from: '2026-10-08', to: '2026-10-08' }))).toEqual(['late']);
  });

  it('lựa chọn của bộ lọc lấy từ các dòng đã tải: giá trị gốc kèm nhãn, bỏ trùng', () => {
    expect(choicesFor(den, 'mucKhan')).toEqual([
      { value: 'hoa_toc', label: 'Hỏa tốc' },
      { value: 'khan', label: 'Khẩn' },
      { value: 'thuong', label: 'Thường' },
    ]);
    expect(choicesFor(den, 'loaiVanBan').map((c) => c.label)).toEqual(['Công văn', 'Thông báo']);
  });
});

describe('sổ văn bản: tệp CSV', () => {
  const register = { code: 'VBDEN', columns: [{ key: 'noiGui', label: 'Nơi gửi' }, { key: 'mucKhan', label: 'Mức khẩn' }] };

  it('UTF-8 có BOM, dòng đầu là tên cột, nhãn thay mã thô, ngày dd/mm/yyyy', () => {
    const csv = toCsv(den.slice(0, 1), registerCsvColumns(register));
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Số,Ngày cấp,Trích yếu,Người tạo,Tình trạng,Nơi gửi,Mức khẩn');
    expect(lines[1]).toBe('0001,05/10/2026,V/v kiểm tra phòng cháy chữa cháy,Nguyễn Thị Văn Thư,Đang xử lý,Sở Tài nguyên và Môi trường,Khẩn');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('chống chèn công thức: ô bắt đầu bằng = + - @ được đặt dấu nháy', () => {
    for (const evil of ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)']) {
      const csv = toCsv([entry({ subject: evil, values: { noiGui: evil } })], registerCsvColumns(register));
      const body = csv.slice(1).split('\r\n')[1]!;
      // Mỗi ô nguy hiểm được bọc bằng dấu nháy đơn đứng đầu, không còn ô nào bắt đầu bằng ký tự công thức.
      expect(body, evil).not.toMatch(/(^|,)"?[=+\-@]/);
      expect(body, evil).toContain(`'${evil.replace(/"/g, '""')}`);
    }
  });

  it('dấu phẩy, nháy kép và xuống dòng trong trích yếu được bọc đúng', () => {
    const csv = toCsv([entry({ subject: 'V/v "khẩn", xin ý kiến\nNgày mai' })], registerCsvColumns({ columns: [] }));
    expect(csv).toContain('"V/v ""khẩn"", xin ý kiến\nNgày mai"');
  });

  it('tên tệp theo mã sổ và năm', () => {
    expect(registerCsvFileName({ code: 'VBDEN' }, 2026)).toBe('so-van-ban-vbden-2026');
    expect(registerCsvFileName({ code: 'VBDI' }, null)).toBe('so-van-ban-vbdi-tat-ca');
  });
});
