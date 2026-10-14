import { defineConfig } from 'drizzle-kit';

/** Sinh migration bảng và chỉ mục từ schema: `pnpm --filter @mihato/backend db:generate -- --name <tên>`. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: '../../db/migrations',
});
