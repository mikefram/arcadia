import { describe, expect, it } from 'vitest';
import type { RenderInput } from '../src/services/doc-render';
import { renderPdf } from '../src/services/doc-render-pdf';
import { readPdf } from './support/pdf';

/** Bản PDF của tệp tổng hợp (docs/DECISIONS.md, 06/10/2026): chữ tiếng Việt đủ dấu, hai kiểu trình bày, nhiều trang, cùng đầu vào cùng tệp. */
const PARA = 'Kính đề nghị Hội đồng quản trị xem xét, phê duyệt phương án đầu tư mở rộng khu công nghiệp theo đúng quy hoạch; các đơn vị phối hợp cung cấp số liệu, bảo đảm tiến độ và chất lượng.';

const base: RenderInput = {
  layout: 'official',
  orgName: 'Tổng công ty Cao su Việt Nam',
  title: 'Phương án đầu tư mở rộng khu công nghiệp',
  number: '12/VRG-VP',
  dateText: '06/10/2026',
  day: 6,
  month: 10,
  year: 2026,
  recipient: 'Hội đồng quản trị',
  preparedBy: 'Trần Thị Lan',
  sections: [{ heading: 'Nội dung', blocks: [{ kind: 'paragraph', text: PARA }] }],
  attachments: [],
};

const long = (n: number): RenderInput => ({
  ...base,
  sections: Array.from({ length: n }, (_, i) => ({
    heading: `Phần ${i + 1}`,
    blocks: [
      { kind: 'subheading' as const, text: `Nguyễn Hữu Phước (Phòng Vận hành ${i + 1})` },
      { kind: 'paragraph' as const, text: `${PARA} ${PARA} ${PARA}` },
      { kind: 'list' as const, items: ['Bảng dự toán.xlsx', 'Báo cáo tiến độ.pdf'] },
    ],
  })),
});

describe('dựng PDF tệp tổng hợp', () => {
  it('công văn: là PDF thật, đủ dấu tiếng Việt, đủ khối quốc hiệu, số, trích yếu, nơi nhận, chữ ký', async () => {
    const data = await renderPdf(base);
    expect(data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pdf = await readPdf(data);
    expect(pdf.pages).toBe(1);
    expect(pdf.title).toBe(base.title);
    for (const expected of [
      'TỔNG CÔNG TY CAO SU VIỆT NAM',
      'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',
      'Độc lập - Tự do - Hạnh phúc',
      'Số: 12/VRG-VP',
      'ngày 6 tháng 10 năm 2026',
      'V/v Phương án đầu tư mở rộng khu công nghiệp',
      'Kính gửi: Hội đồng quản trị',
      'Nội dung',
      PARA,
      'Nơi nhận:',
      '- Lưu: VT.',
      '(CHỨC VỤ NGƯỜI KÝ)',
      '(Ký, ghi rõ họ tên và đóng dấu)',
      'Người soạn thảo: Trần Thị Lan',
    ]) expect(pdf.text, expected).toContain(expected);
    expect(pdf.text).not.toContain('Trang 1/1');
  });

  it('chưa có số và chưa có nơi nhận thì chừa chỗ điền tay', async () => {
    const pdf = await readPdf(await renderPdf({ ...base, number: null, recipient: null, preparedBy: null }));
    expect(pdf.text).toContain('Số: ……');
    expect(pdf.text).toContain('- ……;');
    expect(pdf.text).not.toContain('Kính gửi');
    expect(pdf.text).not.toContain('Người soạn thảo');
  });

  it('báo cáo: tiêu đề in hoa, đánh số La Mã từng phần, có danh mục tài liệu đính kèm', async () => {
    const pdf = await readPdf(await renderPdf({ ...long(3), layout: 'report', attachments: ['Bản scan công văn.pdf'] }));
    expect(pdf.text).toContain('PHƯƠNG ÁN ĐẦU TƯ MỞ RỘNG KHU CÔNG NGHIỆP');
    expect(pdf.text).toContain('Ngày lập: 06/10/2026. Người tổng hợp: Trần Thị Lan');
    for (const heading of ['I. Phần 1', 'II. Phần 2', 'III. Phần 3']) expect(pdf.text, heading).toContain(heading);
    expect(pdf.text).toContain('Tài liệu đính kèm');
    expect(pdf.text).toContain('- Bản scan công văn.pdf');
    expect(pdf.text).not.toContain('CỘNG HÒA XÃ HỘI');
  });

  it('văn bản dài: sang trang, đánh số "Trang n/N", chữ ký không bị cắt, tiêu đề không đứng một mình cuối trang', async () => {
    const pdf = await readPdf(await renderPdf({ ...long(7), attachments: ['Bản scan công văn.pdf'] }));
    expect(pdf.pages).toBeGreaterThan(2);
    pdf.pageTexts.forEach((text, i) => expect(text, `trang ${i + 1}`).toContain(`Trang ${i + 1}/${pdf.pages}`));
    const last = pdf.pageTexts[pdf.pages - 1]!;
    // Khối nơi nhận và chữ ký nằm trọn trên một trang.
    const page = pdf.pageTexts.find((t) => t.includes('Nơi nhận:'))!;
    expect(page).toContain('(Ký, ghi rõ họ tên và đóng dấu)');
    expect(page).toContain('Người soạn thảo: Trần Thị Lan');
    expect(last).toContain('Nơi nhận:');
    // Cuối mỗi trang (trừ dòng số trang) không phải là tiêu đề phần hay tên người đóng góp.
    for (const [i, text] of pdf.pageTexts.entries()) {
      const body = text.replace(/ Trang \d+\/\d+$/, '');
      expect(body, `trang ${i + 1}`).not.toMatch(/(Phần \d+|\(Phòng Vận hành \d+\))$/);
    }
  });

  it('cùng đầu vào cho ra đúng cùng một tệp', async () => {
    const a = await renderPdf(long(2));
    const b = await renderPdf(long(2));
    expect(a.equals(b)).toBe(true);
    expect((await renderPdf({ ...long(2), title: 'Tiêu đề khác' })).equals(a)).toBe(false);
  });

  it('chữ lạ không làm hỏng tệp: ký tự đặc biệt giữ nguyên, chữ rất dài không có khoảng trắng vẫn ra', async () => {
    const odd = 'Tổng hợp <b>đậm</b> & "trích dẫn" \\ (ngoặc) %PDF- 100% ừ ữ ẳ Đ';
    const pdf = await readPdf(await renderPdf({ ...base, sections: [{ heading: odd, blocks: [{ kind: 'paragraph', text: odd }, { kind: 'paragraph', text: 'x'.repeat(600) }, { kind: 'list', items: [] }] }] }));
    expect(pdf.text).toContain(odd);
    expect(pdf.text).toContain('x'.repeat(50));
  });
});
