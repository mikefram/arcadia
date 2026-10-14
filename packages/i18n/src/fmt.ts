/** Thay {tên} trong mẫu bằng giá trị. Khoá thiếu thì giữ nguyên để dễ thấy khi kiểm. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{([^{}]+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}
