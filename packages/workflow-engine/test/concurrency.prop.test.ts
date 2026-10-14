import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Thuộc tính 7 (SPEC 4.10), Hai người cùng lúc: hai CompleteStep song song trên hai việc của một lượt chạy
 * cho kết quả giống chạy tuần tự, nhờ khoá hàng `SELECT ... FOR UPDATE` ở SPEC 4.4.
 *
 * Thuộc tính này phụ thuộc khoá của PostgreSQL nên được kiểm ở tầng tích hợp với CSDL thật, không chạy trên bộ nhớ
 * (SPEC 13.4): xem `packages/backend/test/engine-db.test.ts` ("thuộc tính 7: hai người cùng lúc"). Test này chỉ giữ
 * cho dấu vết không mất: nếu ai xoá hoặc đổi tên test tích hợp thì ở đây đỏ.
 */
describe('thuộc tính 7: hai người cùng lúc', () => {
  it('có test tích hợp với PostgreSQL thật ở packages/backend', () => {
    const file = join(__dirname, '..', '..', 'backend', 'test', 'engine-db.test.ts');
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('thuộc tính 7: hai người cùng lúc');
    expect(source).toContain('Promise.all([complete(');
  });
});
