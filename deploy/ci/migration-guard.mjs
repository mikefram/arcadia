#!/usr/bin/env node
// Chặn migration MỚI làm bản api cũ hỏng khi hai bản chạy song song lúc đổi bản không gián đoạn (SPEC 12.3: mở rộng rồi thu hẹp).
// Migration đã có (deploy/ci/migration-baseline.txt) không kiểm lại. Migration mới có thao tác phá vỡ thì CI đỏ, trừ khi tệp có dòng
//   -- zero-downtime: approved <lý do>
// nghĩa là người viết đã chia việc thành nhiều bản phát hành (bản trước thôi dùng cột, bản sau mới bỏ) và chịu trách nhiệm.
// Dùng: node deploy/ci/migration-guard.mjs        Kiểm thử: node --test deploy/ci/migration-guard.test.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RULES = [
  { re: /\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b/i, why: 'bỏ bảng/cột: bản api cũ đang chạy còn đọc nó' },
  { re: /\bRENAME\b/i, why: 'đổi tên bảng/cột: bản api cũ gọi tên cũ' },
  { re: /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, why: 'đổi kiểu cột: khoá bảng và có thể làm bản cũ lỗi' },
  { re: /\bSET\s+NOT\s+NULL\b/i, why: 'thêm ràng buộc NOT NULL lên cột có sẵn: bản api cũ vẫn ghi NULL' },
  { re: /\bTRUNCATE\b/i, why: 'xoá sạch dữ liệu bảng' },
];
const APPROVED = /^\s*--\s*zero-downtime:\s*approved\b/im;

/** Bỏ chú thích để không bắt nhầm chữ trong lời giải thích. */
const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** ADD COLUMN ... NOT NULL mà không có DEFAULT: bản api cũ không biết cột này nên INSERT sẽ lỗi. */
function addNotNullWithoutDefault(sql) {
  const out = [];
  for (const m of sql.matchAll(/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)([^;]*?)(?:,\s*ADD\b|;|$)/gi)) {
    const rest = m[2];
    if (/\bNOT\s+NULL\b/i.test(rest) && !/\bDEFAULT\b/i.test(rest)) out.push(m[1]);
  }
  return out;
}

export function checkMigration(name, text) {
  if (APPROVED.test(text)) return [];
  const sql = stripComments(text);
  const problems = RULES.filter((r) => r.re.test(sql)).map((r) => `${name}: ${r.why}`);
  for (const col of addNotNullWithoutDefault(sql)) problems.push(`${name}: cột ${col} NOT NULL không có DEFAULT: bản api cũ không ghi được`);
  return problems;
}

export function checkAll(root) {
  const dir = join(root, 'db', 'migrations');
  const baselineFile = join(root, 'deploy', 'ci', 'migration-baseline.txt');
  const baseline = new Set(existsSync(baselineFile) ? readFileSync(baselineFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : []);
  const problems = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (baseline.has(f)) continue;
    problems.push(...checkMigration(f, readFileSync(join(dir, f), 'utf8')));
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const problems = checkAll(root);
  if (problems.length > 0) {
    console.error('Migration mới có thao tác làm bản api cũ hỏng khi đổi bản không gián đoạn:\n  - ' + problems.join('\n  - '));
    console.error('\nChia việc làm hai bản phát hành (thêm trước, bỏ sau), hoặc thêm dòng "-- zero-downtime: approved <lý do>" nếu đã chắc chắn.');
    process.exit(1);
  }
  console.log('Migration không có thao tác phá vỡ (so với deploy/ci/migration-baseline.txt).');
}
