// Cổng quét phụ thuộc cho CI: đọc `pnpm audit --prod --json` từ stdin, thất bại nếu có lỗ hổng từ mức MIN_SEVERITY trở lên
// nằm trong phần chạy trên máy chủ hoặc web (api, worker, scribe, web-admin, các gói dùng chung).
// Lỗ hổng chỉ nằm trong chuỗi công cụ của hai app Expo (apps/mobile-*; không chạy trên máy chủ, không có bản vá) được in ra
// nhưng không chặn; chúng được xem xét ở bước dựng app (docs/security/checklist.md).
//   pnpm audit --prod --json | node deploy/ci/audit-gate.mjs
import { readFileSync } from 'node:fs';

const ORDER = ['info', 'low', 'moderate', 'high', 'critical'];
const min = ORDER.indexOf(process.env.MIN_SEVERITY ?? 'high');
const IGNORED_ROOT = /^apps__mobile-/;

let report;
try {
  report = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  console.error('Không đọc được kết quả pnpm audit (JSON). Kiểm tra mạng tới registry.');
  process.exit(2);
}

const blocking = [];
const mobileOnly = [];
for (const a of Object.values(report.advisories ?? {})) {
  if (ORDER.indexOf(a.severity) < min) continue;
  const paths = (a.findings ?? []).flatMap((f) => f.paths ?? []);
  const outside = paths.filter((p) => !IGNORED_ROOT.test(p));
  const line = `${a.severity} ${a.module_name} ${a.vulnerable_versions} (vá: ${a.patched_versions || 'chưa có'})`;
  if (outside.length > 0) blocking.push(`${line}\n    ví dụ: ${outside[0]}`);
  else mobileOnly.push(line);
}
for (const l of mobileOnly) console.log(`Chỉ trong chuỗi công cụ app Expo (không chặn): ${l}`);
if (blocking.length > 0) {
  console.error(`Lỗ hổng mức ${ORDER[min]} trở lên ở phần máy chủ hoặc web:\n  ${blocking.join('\n  ')}`);
  process.exit(1);
}
console.log(`Không có lỗ hổng mức ${ORDER[min]} trở lên ở phần máy chủ hoặc web.`);
