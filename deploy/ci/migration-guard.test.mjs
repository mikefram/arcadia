import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAll, checkMigration } from './migration-guard.mjs';

test('thao tác cộng thêm thì cho qua', () => {
  const sql = 'CREATE TABLE "x" ("id" uuid PRIMARY KEY);\nALTER TABLE "y" ADD COLUMN "z" text;\nALTER TABLE "y" ADD COLUMN "n" integer DEFAULT 0 NOT NULL;\nCREATE INDEX "i" ON "y" ("z");';
  assert.deepEqual(checkMigration('0009.sql', sql), []);
});

test('bắt các thao tác phá vỡ', () => {
  for (const sql of [
    'ALTER TABLE "y" DROP COLUMN "z";',
    'DROP TABLE "y";',
    'ALTER TABLE "y" RENAME COLUMN "a" TO "b";',
    'ALTER TABLE "y" RENAME TO "w";',
    'ALTER TABLE "y" ALTER COLUMN "a" SET DATA TYPE bigint;',
    'ALTER TABLE "y" ALTER COLUMN "a" TYPE bigint;',
    'ALTER TABLE "y" ALTER COLUMN "a" SET NOT NULL;',
    'TRUNCATE "y";',
    'ALTER TABLE "y" ADD COLUMN "n" text NOT NULL;',
  ]) {
    assert.ok(checkMigration('0009.sql', sql).length > 0, `phải bắt: ${sql}`);
  }
});

test('chữ trong chú thích không bị bắt nhầm', () => {
  assert.deepEqual(checkMigration('0009.sql', '-- không DROP COLUMN ở bản này\nCREATE TABLE "x" ("id" uuid);'), []);
});

test('có dòng approved thì cho qua', () => {
  assert.deepEqual(checkMigration('0010.sql', '-- zero-downtime: approved bản 1.4 đã thôi dùng cột này\nALTER TABLE "y" DROP COLUMN "z";'), []);
});

test('migration thuộc baseline không bị kiểm lại; migration mới thì bị kiểm', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
  mkdirSync(join(root, 'deploy', 'ci'), { recursive: true });
  writeFileSync(join(root, 'db', 'migrations', '0001_cu.sql'), 'DROP TABLE "x";');
  writeFileSync(join(root, 'deploy', 'ci', 'migration-baseline.txt'), '0001_cu.sql\n');
  assert.deepEqual(checkAll(root), []);
  writeFileSync(join(root, 'db', 'migrations', '0002_moi.sql'), 'ALTER TABLE "x" DROP COLUMN "a";');
  assert.equal(checkAll(root).length, 1);
});
