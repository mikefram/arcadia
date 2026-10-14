import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { env } from './env';

/**
 * Kho tệp (docs/DECISIONS.md, 06/10/2026). Giao diện nhỏ để thay bằng kho đối tượng tương thích S3 (SPEC 12) mà không đổi
 * nơi gọi. Bản này ghi lên đĩa; khoá do máy chủ sinh từ id nên không bao giờ chứa tên tệp của người dùng.
 */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export class LocalFileStorage implements FileStorage {
  constructor(private readonly dir: string) {}

  /** Đường dẫn thật của khoá; từ chối khoá chạy ra ngoài thư mục gốc. */
  private pathOf(key: string): string {
    const root = resolve(this.dir);
    const full = resolve(join(root, key));
    if (full !== root && !full.startsWith(root + sep)) throw new Error('Khoá tệp không hợp lệ');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.pathOf(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

let current: FileStorage | null = null;

export function fileStorage(): FileStorage {
  current ??= new LocalFileStorage(env.fileStorageDir);
  return current;
}

/** Cho test thay bằng kho giả trong bộ nhớ. */
export function setFileStorage(storage: FileStorage | null): void {
  current = storage;
}

/** Kho trong bộ nhớ, dùng cho test. */
export class MemoryFileStorage implements FileStorage {
  readonly blobs = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    this.blobs.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const v = this.blobs.get(key);
    if (!v) throw new Error('Không có tệp');
    return Buffer.from(v);
  }
  async remove(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}
