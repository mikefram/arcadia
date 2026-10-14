import { useEffect, useRef } from 'react';
import { renderAsync } from 'docx-preview';
import { safeHref } from '@/lib/file-preview';
import type { ViewProps } from './types';

/**
 * Rà DOM sau khi dựng: bỏ phần tử chạy được hoặc nhúng được, bỏ mọi thuộc tính on*, và chỉ giữ liên kết tuyệt đối http, https, mailto
 * (mở ở thẻ mới, không gửi nguồn tham chiếu). Là lớp thứ hai: lớp thứ nhất là CSP của ứng dụng (script-src 'self' chặn mã nội tuyến).
 */
export function sanitizeRendered(root: HTMLElement): void {
  root.querySelectorAll('script, iframe, object, embed, link, form, input, button, textarea, select, base, meta, svg').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
  });
  root.querySelectorAll('a').forEach((a) => {
    const safe = safeHref(a.getAttribute('href'));
    if (safe) {
      a.setAttribute('href', safe);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    } else {
      a.removeAttribute('href');
      a.removeAttribute('target');
    }
  });
}

/** Tệp Word (.docx): dựng ra các trang bằng docx-preview vào một khung riêng, rồi rà DOM. Không nhận khối nhúng HTML (altChunk). */
export default function DocxView({ blob, onFail }: ViewProps) {
  const body = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bodyEl = body.current;
    const styleEl = styles.current;
    if (!bodyEl || !styleEl) return;
    let cancelled = false;
    renderAsync(blob, bodyEl, styleEl, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderChanges: false,
      renderComments: false,
      renderAltChunks: false,
      useBase64URL: true,
      experimental: false,
      debug: false,
    })
      .then(() => {
        if (!cancelled) sanitizeRendered(bodyEl);
      })
      .catch(() => {
        if (!cancelled) onFail();
      });
    return () => {
      cancelled = true;
      bodyEl.replaceChildren();
      styleEl.replaceChildren();
    };
  }, [blob, onFail]);
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg bg-canvas" tabIndex={0}>
      <div ref={styles} hidden />
      <div ref={body} className="docx-host" />
    </div>
  );
}
