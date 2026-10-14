import { describe, expect, it } from 'vitest';
import { NON_STRICT_TOOL_NAMES, claudeToolDefinitions } from '../src/tools';

/**
 * Giới hạn của `strict: true` (tài liệu Claude "structured outputs", SPEC 6.3): không quá 20 công cụ strict, không quá 24 tham số
 * TUỲ CHỌN cộng dồn trong mọi schema, không quá 16 tham số kiểu hợp (anyOf, mảng kiểu), không dùng các từ khoá không hỗ trợ,
 * và mọi object đều `additionalProperties: false`. Vượt giới hạn thì Claude trả 400 "Schema is too complex for compilation" cho CẢ yêu
 * cầu, tức là trợ lý hỏng hoàn toàn: test này đỏ trước khi chuyện đó xảy ra ở môi trường thật.
 */
type Schema = Record<string, unknown>;
const isRecord = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(schema: unknown, visit: (node: Schema, path: string) => void, path = '$'): void {
  if (!isRecord(schema)) return;
  visit(schema, path);
  if (isRecord(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) walk(child, visit, `${path}.${key}`);
  if (schema.items !== undefined) walk(schema.items, visit, `${path}[]`);
}

const tools = claudeToolDefinitions();

function optionalParameters(): { total: number; byTool: Record<string, number> } {
  const byTool: Record<string, number> = {};
  for (const tool of tools) {
    let n = 0;
    walk(tool.input_schema, (node) => {
      if (!isRecord(node.properties)) return;
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
      n += Object.keys(node.properties).filter((key) => !required.has(key)).length;
    });
    byTool[tool.name] = n;
  }
  return { total: Object.values(byTool).reduce((a, b) => a + b, 0), byTool };
}

describe('schema công cụ gửi cho Claude (strict: true)', () => {
  it('không quá 20 công cụ; hai công cụ mang mảng các bước quy trình và công cụ giao việc lẻ được gửi không strict', () => {
    // `propose_assign_task` (04/10/2026) cũng không strict: đã đủ 16 công cụ strict ở mức Claude nhận; thêm một công cụ strict nữa là mức Claude từ chối.
    // Dữ liệu vào vẫn do Zod ở máy chủ kiểm kỹ (tên việc, người nhận, ngày hạn), sai thì trả mã từng ô cho trợ lý hỏi lại.
    expect(tools.length).toBeLessThanOrEqual(20);
    expect(tools.filter((t) => t.strict !== true).map((t) => t.name)).toEqual(['preview_process', 'propose_assign_task', 'propose_create_process']);
    expect([...NON_STRICT_TOOL_NAMES]).toEqual(['preview_process', 'propose_assign_task', 'propose_create_process']);
  });

  it('TỔNG CỠ các công cụ strict không vượt trần đã đo với Claude thật (04/10/2026); vượt thì cả yêu cầu bị 400 "compiled grammar is too large"', () => {
    // Đo bằng chính JSON của từng định nghĩa công cụ. Claude NHẬN: 16 công cụ strict, 7.772 ký tự. Claude TỪ CHỐI: 17 công cụ
    // strict, 9.833 ký tự, và cả 18 công cụ strict, 12.020 ký tự. Trần thật nằm trong khoảng giữa nhưng chưa đo chính xác, nên giữ
    // sát mức đã được nhận: thêm công cụ strict hoặc nới schema thì test này đỏ, và phải thử lại với Claude thật trước khi nâng trần
    // (`pnpm evals` hoặc một lượt gọi tối thiểu), chứ không được nâng cho qua.
    const strictChars = tools.filter((t) => t.strict === true).reduce((sum, t) => sum + JSON.stringify(t).length, 0);
    expect(strictChars, `tổng cỡ các công cụ strict là ${strictChars} ký tự`).toBeLessThanOrEqual(8_000);
  });

  it('không quá 24 tham số tuỳ chọn cộng dồn (giữ chừa chỗ: tối đa 20)', () => {
    const { total, byTool } = optionalParameters();
    expect(total, JSON.stringify(byTool)).toBeLessThanOrEqual(20);
  });

  it('không có tham số kiểu hợp, từ khoá không hỗ trợ; mọi object đóng additionalProperties', () => {
    const banned = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'anyOf', 'oneOf', 'allOf', '$ref', 'pattern', 'minItems', 'maxItems'];
    for (const tool of tools) {
      walk(tool.input_schema, (node, path) => {
        const where = `${tool.name} ${path}`;
        for (const key of banned) expect(node, `${where} dùng ${key}`).not.toHaveProperty(key);
        expect(Array.isArray(node.type), `${where} có type dạng mảng (kiểu hợp)`).toBe(false);
        if (node.type === 'object') expect(node.additionalProperties, `${where} phải đóng additionalProperties`).toBe(false);
      });
    }
  });

  it('mọi tham số được liệt kê ở `required` đều có trong `properties`', () => {
    for (const tool of tools) {
      walk(tool.input_schema, (node, path) => {
        if (!Array.isArray(node.required)) return;
        const props = isRecord(node.properties) ? Object.keys(node.properties) : [];
        for (const key of node.required as string[]) expect(props, `${tool.name} ${path}: required "${key}" không có trong properties`).toContain(key);
      });
    }
  });
});
