import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { PREVIEW_LIMITS } from '@/lib/file-preview';
import type { ViewProps } from './types';

// Dùng bản `legacy` của pdf.js: bản mới dùng tính năng JavaScript rất mới (Map.getOrInsertComputed) mà nhiều trình duyệt chưa có, bản legacy kèm bù tính năng.
// Worker cùng nguồn (CSP script-src 'self' cho phép); Vite đóng gói tệp worker thành tài sản riêng.
GlobalWorkerOptions.workerSrc = workerUrl;

const t = vi.admin.runs.files.viewer;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const PAGE_GAP = 12;

/**
 * PDF: pdf.js dựng từng trang lên <canvas> (không dùng trình xem PDF của trình duyệt, vì khung nhúng và `object` bị CSP chặn và khung
 * cách ly không chạy được trình xem PDF). Không chạy mã JavaScript trong PDF: chỉ trình xem đầy đủ của pdf.js mới có bộ chạy mã (sandbox), phần này chỉ dùng lõi dựng trang. Vừa khít chiều rộng khung,
 * phóng to và thu nhỏ theo bậc; hiện số trang đang xem.
 */
export default function PdfView({ blob, onFail }: ViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pagesHost = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [zoom, setZoom] = useState(2); // chỉ số trong ZOOM_STEPS, 2 = 100%
  const [current, setCurrent] = useState(1);
  const [width, setWidth] = useState(0);
  const fail = useCallback(() => onFail(), [onFail]);

  // Mở tệp.
  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | null = null;
    (async () => {
      const data = new Uint8Array(await blob.arrayBuffer());
      if (cancelled) return;
      loading = getDocument({ data });
      const loaded = await loading.promise;
      if (!cancelled) setDoc(loaded);
    })().catch(() => {
      if (!cancelled) fail();
    });
    return () => {
      cancelled = true;
      setDoc(null);
      // Huỷ tác vụ mở tệp cũng giải phóng worker và tài liệu đã mở.
      if (loading) void loading.destroy();
    };
  }, [blob, fail]);

  // Theo dõi chiều rộng khung để vừa khít.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Vẽ các trang mỗi khi đổi tệp, mức thu phóng hay chiều rộng.
  useEffect(() => {
    const host = pagesHost.current;
    if (!doc || !host || width === 0) return;
    let cancelled = false;
    let running: RenderTask | null = null;
    const pages = Math.min(doc.numPages, PREVIEW_LIMITS.pdfPages);
    const dpr = window.devicePixelRatio || 1;
    host.replaceChildren();
    (async () => {
      for (let n = 1; n <= pages; n++) {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const fit = (width - 32) / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale: Math.max(0.2, fit) * ZOOM_STEPS[zoom]! });
        const canvas = document.createElement('canvas');
        canvas.dataset.page = String(n);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.className = 'mx-auto block bg-white shadow-sm';
        canvas.style.marginBottom = `${PAGE_GAP}px`;
        host.append(canvas);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no_canvas');
        running = page.render({ canvas, canvasContext: context, viewport, ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}) });
        await running.promise;
        page.cleanup();
      }
    })().catch((err: unknown) => {
      // Huỷ giữa chừng (đổi mức thu phóng) không phải lỗi.
      if (!cancelled && !(err instanceof Error && err.name === 'RenderingCancelledException')) fail();
    });
    return () => {
      cancelled = true;
      running?.cancel();
    };
  }, [doc, zoom, width, fail]);

  // Số trang đang xem: trang chiếm nhiều chỗ nhất trong khung cuộn.
  useEffect(() => {
    const root = scroller.current;
    const host = pagesHost.current;
    if (!doc || !root || !host) return;
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRatio);
        let best = 1;
        let bestRatio = -1;
        for (const [page, ratio] of ratios) if (ratio > bestRatio) [best, bestRatio] = [page, ratio];
        setCurrent(best);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    const watch = new MutationObserver(() => host.querySelectorAll('canvas').forEach((c) => observer.observe(c)));
    watch.observe(host, { childList: true });
    return () => {
      watch.disconnect();
      observer.disconnect();
    };
  }, [doc]);

  const total = doc ? doc.numPages : 0;
  const shown = doc ? Math.min(total, PREVIEW_LIMITS.pdfPages) : 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="tabular text-sm text-ink-sub">
          {doc ? fmt(t.page, { n: Math.min(current, shown), tổng: total }) : null}
        </p>
        <div className="flex items-center gap-1" role="group" aria-label={fmt(t.zoomLevel, { n: Math.round(ZOOM_STEPS[zoom]! * 100) })}>
          <Button size="sm" variant="secondary" aria-label={t.zoomOut} disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
            <Minus aria-hidden="true" />
          </Button>
          <span className="tabular w-14 text-center text-sm">{Math.round(ZOOM_STEPS[zoom]! * 100)}%</span>
          <Button size="sm" variant="secondary" aria-label={t.zoomIn} disabled={zoom === ZOOM_STEPS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOM_STEPS.length - 1, z + 1))}>
            <Plus aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div ref={scroller} tabIndex={0} className="min-h-0 flex-1 overflow-auto rounded-lg bg-canvas p-4">
        <div ref={pagesHost} />
        {doc && total > shown ? <p className="text-center text-sm text-ink-sub">{fmt(t.pagesTruncated, { n: shown })}</p> : null}
      </div>
    </div>
  );
}
