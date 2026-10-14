/** Mọi trình xem một loại tệp nhận cùng một bộ thuộc tính. `onFail` gọi khi tệp hỏng hoặc không đọc được. */
export type ViewProps = { blob: Blob; name: string; onFail: () => void };
