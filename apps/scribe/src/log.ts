/**
 * Nhật ký của scribe (SPEC 6.8, 6.10, CLAUDE.md luật 6): KHÔNG chứa văn bản câu nói, tên người, tên việc, số tiền.
 * Chỉ có id, độ dài, độ trễ từng chặng và mã lỗi. Mỗi dòng là một object JSON.
 *
 * Lưới an toàn: giá trị chuỗi chỉ được là mã hoặc id (không khoảng trắng, không quá 80 ký tự). Chuỗi nào trông như
 * văn bản tự do thì bị thay bằng "[bỏ]" trước khi ghi, để một lỗi lập trình không làm lộ câu nói ra nhật ký.
 */
export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue | undefined>;
export type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const SAFE_STRING = /^[\w.:@/+-]{0,80}$/;

export function sanitizeLogFields(fields: LogFields): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = typeof value === 'string' && !SAFE_STRING.test(value) ? '[bỏ]' : value;
  }
  return out;
}

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(sink: LogSink = stdoutSink, base: LogFields = {}): Logger {
  const write = (level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}) => {
    sink(JSON.stringify({ t: new Date().toISOString(), level, svc: 'scribe', event, ...sanitizeLogFields({ ...base, ...fields }) }));
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

/** Tên lớp của một lỗi, để ghi nhật ký thay cho thông điệp (thông điệp có thể chứa nội dung). */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
