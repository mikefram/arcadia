import { useEffect, useState } from 'react';
import type { ViewProps } from './types';

/** Ảnh: thẻ <img> với địa chỉ tạm của Blob (CSP cho phép img-src blob:). Không có đường nào chèn HTML. */
export default function ImageView({ blob, name, onFail }: ViewProps) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  if (!url) return null;
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto rounded-lg bg-canvas p-4">
      <img src={url} alt={name} className="h-auto max-w-full" onError={onFail} />
    </div>
  );
}
