import { bootstrapOrg, validateBootstrapInput, type BootstrapInput } from '../src/bootstrap';
import { closeDb } from '../src/db/client';
import { assertRuntime, env } from '../src/env';

/**
 * pnpm db:bootstrap: khởi tạo tổ chức thật và quản trị viên đầu tiên (it_admin), không dữ liệu mẫu.
 *   ORG_CODE=vrg ORG_NAME="Tổng công ty ..." ADMIN_EMAIL=... ADMIN_FULL_NAME="..." pnpm db:bootstrap
 *   ROOT_UNIT_NAME   tên đơn vị gốc (mặc định là tên tổ chức)
 *   --reissue-link   cấp lại đường dẫn đặt mật khẩu cho quản trị viên đã có (mất đường dẫn lần đầu)
 * Chạy lại với cùng ORG_CODE không tạo trùng. Đường dẫn đặt mật khẩu chỉ in MỘT lần, dùng một lần, hết hạn sau 72 giờ.
 * Quản trị viên phải bật TOTP ở lần đăng nhập đầu (ENFORCE_MFA mặc định bật ở production).
 */
async function main() {
  assertRuntime('bootstrap');
  const input: BootstrapInput = {
    orgCode: (process.env.ORG_CODE ?? '').trim(),
    orgName: process.env.ORG_NAME ?? '',
    rootUnitName: process.env.ROOT_UNIT_NAME || undefined,
    adminEmail: process.env.ADMIN_EMAIL ?? '',
    adminFullName: process.env.ADMIN_FULL_NAME ?? '',
    reissueLink: process.argv.includes('--reissue-link'),
  };
  const errors = validateBootstrapInput(input);
  if (errors.length > 0) {
    console.error(`Thiếu hoặc sai biến:\n  - ${errors.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  const r = await bootstrapOrg(input);
  console.log(r.orgCreated ? `Đã tạo tổ chức "${input.orgCode}".` : `Tổ chức "${input.orgCode}" đã có, giữ nguyên.`);
  if (r.adminCreated) console.log('Đã tạo quản trị viên (it_admin).');
  else console.log('Quản trị viên đã có, giữ nguyên.');
  if (r.passwordLink) {
    console.log('\nĐường dẫn đặt mật khẩu, dùng MỘT lần, hết hạn lúc ' + r.passwordLink.expiresAt.toISOString() + ' (UTC).');
    console.log('Chỉ in một lần ở đây: chuyển cho quản trị viên qua kênh riêng, không dán vào chat chung hay ticket.\n');
    console.log(`  ${r.passwordLink.url}\n`);
    console.log(`Địa chỉ web: ${env.webOrigin}. Lần đăng nhập đầu phải bật TOTP.`);
  } else if (r.adminCreated === false) {
    console.log('Không cấp đường dẫn mới. Mất đường dẫn: chạy lại với --reissue-link.');
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
