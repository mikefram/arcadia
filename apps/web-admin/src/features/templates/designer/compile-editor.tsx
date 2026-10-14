import { useMemo, useRef } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { DocSection, DocSpec } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/features/templates/field-select';
import { useDesigner } from './context';
import { sectionOf } from './form-model';
import { compileSources, defaultCompile, insertToken, moveItem, normalizeCompile, titleTokens } from './form-sources';
import { IconButton, SwitchRow } from './ui';

const t = vi.admin.designer.editor.panel.task.compile;

/** Giá trị của hộp chọn nguồn khi mục là chữ nhập tay (mục không có `ref`). */
const MANUAL = '__manual__';

const LAYOUTS = ['official', 'report'] as const;
const LAYOUT_OPTIONS = LAYOUTS.map((layout) => ({ value: layout, label: t.layouts[layout] }));

function isLayout(v: string | null): v is DocSpec['layout'] {
  return v !== null && (LAYOUTS as readonly string[]).includes(v);
}

export type CompileEditorProps = {
  /** việc đang sửa: để liệt kê dữ liệu của các bước đứng trước và của chính việc này */
  nodeId: string;
  value: DocSpec | undefined;
  /** `undefined`: tắt xuất tệp */
  onChange: (spec: DocSpec | undefined) => void;
};

/**
 * Cấu hình "Xuất tệp Word tổng hợp" của một việc: kiểu trình bày, tiêu đề, các mục (tiêu đề và nguồn dữ liệu, sắp xếp được),
 * danh mục tệp đính kèm, và có bắt buộc xuất tệp trước khi báo xong hay không (`TaskNode.compile`, `DocSpec`).
 */
export function CompileEditor({ nodeId, value, onChange }: CompileEditorProps) {
  const { def } = useDesigner();
  const titleRef = useRef<HTMLInputElement>(null);
  // Vị trí con trỏ trong ô tiêu đề lần cuối; bấm nút chèn làm ô mất focus nên phải nhớ lại.
  const caret = useRef<number | undefined>(undefined);
  const sources = useMemo(() => compileSources(def, nodeId), [def, nodeId]);
  const tokens = useMemo(() => titleTokens(def), [def]);

  const toggle = (
    <SwitchRow label={t.toggle} checked={value !== undefined} onCheckedChange={(on) => onChange(on ? defaultCompile() : undefined)} testId="compile-toggle" />
  );
  if (!value) return toggle;

  const spec = normalizeCompile(value);
  const patch = (next: Partial<DocSpec>) => {
    const merged: DocSpec = { ...spec, ...next };
    // Công tắc đã tắt thì bỏ hẳn khoá, để JSON lưu đi không còn khoá thừa.
    if (!merged.includeAttachments) delete merged.includeAttachments;
    if (!merged.required) delete merged.required;
    onChange(merged);
  };
  const setSection = (index: number, next: DocSection) => patch({ sections: spec.sections.map((s, i) => (i === index ? next : s)) });

  const insert = (token: string) => {
    const result = insertToken(spec.title, token, caret.current);
    caret.current = result.caret;
    patch({ title: result.text });
    requestAnimationFrame(() => {
      const input = titleRef.current;
      input?.focus();
      input?.setSelectionRange(result.caret, result.caret);
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="compile-editor">
      {toggle}

      <Field label={t.layout} hint={t.layoutHints[spec.layout]}>
        <div data-testid="compile-layout">
          <Select value={spec.layout} options={LAYOUT_OPTIONS} onValueChange={(v) => isLayout(v) && patch({ layout: v })} />
        </div>
      </Field>

      <div className="flex flex-col gap-1.5">
        <Field label={t.title} hint={tokens.length > 0 ? t.titleHint : undefined} required>
          <Input ref={titleRef} value={spec.title} maxLength={300} placeholder={t.titlePlaceholder} onChange={(e) => patch({ title: e.target.value })} onSelect={(e) => (caret.current = e.currentTarget.selectionStart ?? undefined)} data-testid="compile-title" />
        </Field>
        {tokens.length > 0 ? (
          <div role="group" aria-label={t.titleInsertGroup} className="flex flex-wrap gap-1.5">
            {tokens.map((tk) => (
              <Button key={tk.token} size="sm" variant="secondary" className="h-7 px-2 font-medium" aria-label={fmt(t.titleInsert, { tên: tk.label })} onClick={() => insert(tk.token)}>
                <Plus aria-hidden="true" />
                <span className="max-w-32 truncate">{tk.label}</span>
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2" data-testid="compile-sections">
        <div>
          <h4 className="text-base font-medium">{t.sections}</h4>
          <p className="text-sm text-ink-sub">{t.sectionsHint}</p>
        </div>
        {sources.length === 0 ? <p className="rounded-lg border border-hairline bg-surface-alt px-3 py-2.5 text-sm">{t.noSources}</p> : null}
        {spec.sections.length === 0 ? <p className="text-sm text-ink-sub">{t.sectionsEmpty}</p> : null}
        <ul className="flex flex-col gap-2">
          {spec.sections.map((section, i) => {
            const n = i + 1;
            const known = section.ref === undefined || sources.some((s) => s.ref === section.ref);
            const options = [
              ...sources.map((s) => ({ value: s.ref, label: s.label })),
              ...(known || section.ref === undefined ? [] : [{ value: section.ref, label: t.sourceUnknown, disabled: true }]),
              { value: MANUAL, label: t.sourceManual },
            ];
            return (
              <li
                // Mục chưa có mã riêng; vị trí là khoá, vì mọi ô trong mục đều lấy giá trị từ props.
                key={i}
                className="flex flex-col gap-2 rounded-lg border border-hairline bg-canvas p-2.5"
                data-testid="compile-section"
              >
                <div className="flex items-center gap-1">
                  <Input
                    aria-label={fmt(t.sectionHeading, { n })}
                    placeholder={t.sectionHeadingPlaceholder}
                    value={section.heading}
                    maxLength={200}
                    onChange={(e) => setSection(i, { ...section, heading: e.target.value })}
                    className="h-9 min-w-0 flex-1"
                  />
                  <IconButton label={fmt(t.moveUp, { n })} disabled={i === 0} onClick={() => patch({ sections: moveItem(spec.sections, i, -1) })}>
                    <ArrowUp aria-hidden="true" />
                  </IconButton>
                  <IconButton label={fmt(t.moveDown, { n })} disabled={i === spec.sections.length - 1} onClick={() => patch({ sections: moveItem(spec.sections, i, 1) })}>
                    <ArrowDown aria-hidden="true" />
                  </IconButton>
                  <IconButton label={fmt(t.remove, { n })} onClick={() => patch({ sections: spec.sections.filter((_, j) => j !== i) })}>
                    <Trash2 aria-hidden="true" />
                  </IconButton>
                </div>
                <Select
                  aria-label={fmt(t.sectionSource, { n })}
                  placeholder={t.sectionSourcePlaceholder}
                  value={section.ref ?? MANUAL}
                  options={options}
                  onValueChange={(v) => {
                    if (v === null) return;
                    // Đổi nguồn thì bỏ phần của nguồn cũ: lấy từ ô thì không còn chữ nhập tay, và ngược lại.
                    if (v === MANUAL) setSection(i, sectionOf(section.heading, { text: section.text ?? '' }));
                    else setSection(i, sectionOf(section.heading, { ref: v }));
                  }}
                />
                {section.ref === undefined ? (
                  <Textarea
                    aria-label={fmt(t.sectionText, { n })}
                    placeholder={t.sectionTextPlaceholder}
                    rows={3}
                    maxLength={5000}
                    value={section.text ?? ''}
                    onChange={(e) => setSection(i, sectionOf(section.heading, { text: e.target.value }))}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        <Button size="sm" variant="ghost" className="self-start" onClick={() => patch({ sections: [...spec.sections, sectionOf('', { text: '' })] })} disabled={spec.sections.length >= 30} data-testid="compile-add-section">
          <Plus aria-hidden="true" />
          {t.addSection}
        </Button>
      </div>

      <SwitchRow label={t.includeAttachments} hint={t.includeAttachmentsHint} checked={spec.includeAttachments === true} onCheckedChange={(on) => patch({ includeAttachments: on })} testId="compile-attachments" />
      <SwitchRow label={t.required} hint={t.requiredHint} checked={spec.required === true} onCheckedChange={(on) => patch({ required: on })} testId="compile-required" />
    </div>
  );
}
