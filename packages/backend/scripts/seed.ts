import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@mihato/domain';
import { eq, sql } from 'drizzle-orm';
import { createActivation } from '../src/auth/service';
import { hashPassword } from '../src/auth/crypto';
import { closeDb, schema, withOrg } from '../src/db/client';
import { env } from '../src/env';
import { SEED_USERS, generateSeedIds, seedDemoOrg, type SeedIds } from '../src/seed/org';
import { devDatabaseName, devOnlyViolation } from './guard';
import { seedDemoRuns } from '../src/seed/scenario';
import { seedVrgScenario } from '../src/seed/vrg';

/**
 * pnpm db:seed (SPEC 15.4). Chạy lặp lại không tạo trùng. Từ chối chạy ở production hoặc khi tên CSDL
 * không phải môi trường phát triển hay thử nghiệm.
 *   --no-runs   không tạo ba lượt chạy mẫu
 *   --links     tạo lại và in đường dẫn kích hoạt thiết bị cho mọi người dùng mẫu
 */
type IdsFile = { demo: SeedIds; other: { ORG: string; unit: string; admin: string } };

// Chốt chặn phải đứng trước mọi thao tác khác: ở production, tạo tổ chức bằng `pnpm db:bootstrap`, không bao giờ bằng seed.
const violation = devOnlyViolation({ isProd: env.isProd, nodeEnv: env.nodeEnv, databaseUrl: env.databaseUrl });
if (violation) {
  console.error(`Từ chối seed: ${violation}. Seed chỉ chạy ở phát triển hoặc thử nghiệm. Tạo tổ chức thật: pnpm db:bootstrap.`);
  process.exit(1);
}
const dbName = devDatabaseName(env.databaseUrl);

const args = new Set(process.argv.slice(2));
const password = process.env.SEED_PASSWORD ?? 'mihato-demo-2026';
const seedDir = join(env.root, 'db', 'seed');
const idsPath = join(seedDir, 'ids.json');

function loadIds(): IdsFile {
  if (existsSync(idsPath)) return JSON.parse(readFileSync(idsPath, 'utf8')) as IdsFile;
  const ids: IdsFile = { demo: generateSeedIds(), other: { ORG: newId(), unit: newId(), admin: newId() } };
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(idsPath, `${JSON.stringify(ids, null, 2)}\n`);
  return ids;
}

async function seedOtherOrg(ids: IdsFile['other']): Promise<void> {
  const passwordHash = await hashPassword(password);
  await withOrg(ids.ORG, async (tx) => {
    await tx.insert(schema.organizations).values({ id: ids.ORG, code: 'other', name: 'Tổ chức thứ hai (kiểm chéo tổ chức)', settings: {} }).onConflictDoNothing();
    await tx.insert(schema.units).values({ id: ids.unit, orgId: ids.ORG, name: 'Văn phòng' }).onConflictDoNothing();
    await tx
      .insert(schema.users)
      .values({ id: ids.admin, orgId: ids.ORG, fullName: 'Tài khoản văn phòng', givenName: 'Văn phòng', email: 'vanphong@other.mihato.local', unitId: ids.unit, status: 'active', passwordHash })
      .onConflictDoNothing();
    const roles = await tx.select({ id: schema.userRoles.id }).from(schema.userRoles).where(eq(schema.userRoles.userId, ids.admin));
    if (roles.length === 0) await tx.insert(schema.userRoles).values({ id: newId(), orgId: ids.ORG, userId: ids.admin, role: 'office_admin', unitId: null });
  });
}

async function main() {
  const ids = loadIds();
  await seedDemoOrg(ids.demo, { code: 'demo', name: 'MIHATO (dữ liệu mẫu)', emailDomain: 'demo.mihato.local', password });
  await seedOtherOrg(ids.other);

  const runCount = await withOrg(ids.demo.ORG, async (tx) => {
    const res = await tx.execute<{ n: string }>(sql`select count(*) as n from process_runs`);
    return Number(res.rows[0]?.n ?? 0);
  });
  if (!args.has('--no-runs') && runCount === 0) {
    await seedDemoRuns(ids.demo);
    console.log('Đã tạo ba lượt chạy mẫu (một đang chậm, một vừa khởi chạy, một đã hoàn tất).');
  }

  // Kịch bản theo đề cương VRG: Chủ tịch ra chỉ thị, Giám đốc nhận, Phó giám đốc và các trưởng phòng thực hiện, Văn phòng làm văn thư.
  const vrg = await seedVrgScenario(ids.demo, { password, withRuns: !args.has('--no-runs') });
  console.log('Đã nạp kịch bản văn thư và chỉ thị (3 quy trình mẫu, 3 sổ văn bản, các lượt chạy minh hoạ).');

  console.log(`\nDữ liệu mẫu đã sẵn sàng trong CSDL "${dbName}".`);
  console.log(`Đăng nhập web (${env.webOrigin}), mật khẩu chung cho tài khoản mẫu: ${password}`);
  for (const u of SEED_USERS) console.log(`  ${`${u.email}@demo.mihato.local`.padEnd(34)} ${u.role.padEnd(17)} ${u.fullName}`);
  for (const u of vrg.users) console.log(`  ${u.email.padEnd(34)} ${u.role.padEnd(17)} ${u.fullName}`);
  console.log('  vanphong@other.mihato.local        office_admin      (tổ chức thứ hai, để kiểm chéo tổ chức)');

  // Mã kích hoạt chỉ in ở môi trường phát triển, để dựng nhanh app trên máy thử (SPEC 15.4).
  if (args.has('--links')) {
    const lines: string[] = [];
    await withOrg(ids.demo.ORG, async (tx) => {
      for (const u of SEED_USERS) {
        const a = await createActivation(tx, ids.demo.ORG, ids.demo.users[u.code], ids.demo.users.U_IT);
        lines.push(`${u.fullName} (${u.role}): ${a.url}`);
        // Người điều hành dùng app Chủ tịch; in thêm mã cho app nhân viên để chạy kịch bản vàng ở vai người duyệt (SPEC 8.6).
        if (u.role === 'director' || u.role === 'deputy') {
          const staff = await createActivation(tx, ids.demo.ORG, ids.demo.users[u.code], ids.demo.users.U_IT, 'staff');
          lines.push(`${u.fullName} (${u.role}, app nhân viên): ${staff.url}`);
        }
      }
    });
    writeFileSync(join(seedDir, 'activation-links.txt'), `${lines.join('\n')}\n`);
    console.log('\nĐường dẫn kích hoạt thiết bị (hết hạn sau 72 giờ, dùng một lần), cũng được ghi vào db/seed/activation-links.txt:');
    for (const l of lines) console.log(`  ${l}`);
  } else {
    console.log('\nCần đường dẫn kích hoạt app: pnpm db:seed -- --links');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeDb);
