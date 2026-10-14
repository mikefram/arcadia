import { useEffect, useState } from 'react';
import { fmt, vi } from '@mihato/i18n';
import { PREVIEW_LIMITS, stripBom } from '@/lib/file-preview';
import type { ViewProps } from './types';

const t = vi.admin.runs.files.viewer;

/** Văn bản thuần (.txt): hiện đúng chữ trong tệp, giữ xuống dòng; React thoát mọi ký tự nên không dựng được HTML. */
export default function TextView({ blob, onFail }: ViewProps) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    blob
      .text()
      .then((value) => {
        if (!cancelled) setText(stripBom(value));
      })
      .catch(() => onFail());
    return () => {
      cancelled = true;
    };
  }, [blob, onFail]);
  if (text === null) return null;
  const cut = text.length > PREVIEW_LIMITS.textChars;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <pre tabIndex={0} className="min-h-0 flex-1 overflow-auto rounded-lg bg-canvas p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {cut ? text.slice(0, PREVIEW_LIMITS.textChars) : text}
      </pre>
      {cut ? <p className="text-sm text-ink-sub">{fmt(t.truncated, { n: PREVIEW_LIMITS.textChars.toLocaleString('vi-VN') })}</p> : null}
    </div>
  );
}
