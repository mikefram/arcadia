import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DraftDefinitionSchema, ProcessDefinitionSchema, TemplateCategorySchema, type DraftDefinition, type TemplatePreset } from '@mihato/domain';
import { validate } from '@mihato/workflow-engine';
import { z } from 'zod';
import { env } from '../env';

/**
 * Thư viện quy trình mẫu (docs/DECISIONS.md, 06/10/2026): Chỉ thị, Văn bản đến, Văn bản đi, đọc từ db/seed/templates/presets/*.json.
 * Mẫu chỉ dùng VAI TRÒ (không dùng id người) nên áp được cho mọi tổ chức; người điều hành chọn mẫu, hệ thống tạo bản nháp,
 * rồi họ sửa tiếp trong trình thiết kế. Mỗi mẫu được `validate()` lúc nạp: mẫu hỏng làm test đỏ ngay chứ không đến tay người dùng.
 */
const PresetFileSchema = z.object({
  meta: z.object({ id: z.string().regex(/^[a-z0-9-]+$/), name: z.string(), description: z.string(), category: TemplateCategorySchema, summary: z.array(z.string()) }),
  definition: DraftDefinitionSchema,
});

let cache: TemplatePreset[] | null = null;

export function loadPresets(): TemplatePreset[] {
  if (cache) return cache;
  const dir = join(env.root, 'db', 'seed', 'templates', 'presets');
  const out: TemplatePreset[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = PresetFileSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    const checked = validate(parsed.definition as unknown as DraftDefinition);
    if (checked.errors.length > 0 || !checked.definition) throw new Error(`Quy trình mẫu ${file} không hợp lệ: ${checked.errors.map((e) => `${e.code}@${e.nodeId ?? e.edgeId ?? ''}`).join(', ')}`);
    const def = ProcessDefinitionSchema.parse(checked.definition);
    out.push({
      id: parsed.meta.id,
      name: parsed.meta.name,
      description: parsed.meta.description,
      category: parsed.meta.category,
      steps: def.nodes.filter((n) => n.type === 'task' || n.type === 'approval').length,
      summary: parsed.meta.summary,
      definition: parsed.definition,
    });
  }
  cache = out;
  return out;
}

/** Bản đọc nguyên văn của một mẫu đã xác thực, dùng cho dữ liệu mẫu (ProcessDefinition đầy đủ). */
export function presetDefinition(id: string) {
  const hit = loadPresets().find((p) => p.id === id);
  if (!hit) throw new Error(`Không có quy trình mẫu ${id}`);
  return ProcessDefinitionSchema.parse(validate(hit.definition as unknown as DraftDefinition).definition);
}
