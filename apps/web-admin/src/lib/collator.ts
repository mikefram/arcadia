/** Sắp xếp chuỗi tiếng Việt đúng thứ tự chữ cái và dấu (SPEC 9.8): a ă â … d đ … o ô ơ … */
export const viCollator = new Intl.Collator('vi', { sensitivity: 'variant', numeric: true });

export function compareVi(a: string, b: string): number {
  return viCollator.compare(a, b);
}

/** Bản sao đã sắp theo một trường chữ. */
export function sortByVi<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => viCollator.compare(key(a), key(b)));
}
