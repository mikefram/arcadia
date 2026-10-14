import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, ProblemSchema, requiresIdempotencyKey, routes, type RouteDef } from '@mihato/domain';
import { z } from 'zod';

/**
 * Sinh OpenAPI 3.1 từ bảng route Zod (SPEC 10, 10.11 điều 1). Chạy: pnpm --filter @mihato/api openapi
 *   --check  so với apps/api/openapi.json đã duyệt; khác thì thoát mã 1 (CI đỏ khi hợp đồng đổi ngoài ý muốn).
 */
const jsonSchema = (s: z.ZodType, io: 'input' | 'output') => {
  const { $schema: _s, ...rest } = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
};

function parameters(def: RouteDef): unknown[] {
  const out: unknown[] = [];
  const add = (schemaDef: z.ZodType | undefined, where: 'path' | 'query') => {
    if (!schemaDef) return;
    const js = jsonSchema(schemaDef, 'input') as { properties?: Record<string, unknown>; required?: string[] };
    for (const [name, schema] of Object.entries(js.properties ?? {})) {
      out.push({ name, in: where, required: where === 'path' || (js.required ?? []).includes(name), schema });
    }
  };
  add(def.params, 'path');
  add(def.query, 'query');
  if (requiresIdempotencyKey(def)) out.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } });
  if (def.ifMatch) out.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } });
  if (def.stepUp) out.push({ name: 'X-Step-Up-Token', in: 'header', required: true, schema: { type: 'string' } });
  return out;
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, def] of Object.entries(routes) as [string, RouteDef][]) {
    const path = def.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const status = String(def.status ?? 200);
    paths[path] ??= {};
    paths[path][def.method.toLowerCase()] = {
      operationId: key,
      tags: [def.tag],
      summary: def.summary,
      'x-permission': def.permission ?? def.anyPermission ?? null,
      security: def.auth === 'none' ? [] : def.auth === 'service' ? [{ serviceToken: [] }] : [{ sessionCookie: [] }, { bearer: [] }],
      parameters: parameters(def),
      ...(def.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(def.body, 'input') } } } } : {}),
      responses: {
        [status]: { description: 'Thành công', content: { 'application/json': { schema: jsonSchema(def.response, 'output') } } },
        default: { description: 'Lỗi theo RFC 9457', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'MIHATO Điều hành API', version: '1.0.0', description: 'Hợp đồng sinh từ packages/domain/src/contract.ts. Không sửa tay.' },
    paths,
    components: {
      schemas: { Problem: jsonSchema(ProblemSchema, 'output') },
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'mihato_session' },
        bearer: { type: 'http', scheme: 'bearer' },
        serviceToken: { type: 'http', scheme: 'bearer', description: 'Service token của ai_service, chỉ ở /internal/v1/*' },
      },
    },
    'x-error-codes': ERROR_CODES,
  };
}

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const { readFileSync } = await import('node:fs');
    const current = readFileSync(file, 'utf8');
    if (current !== next) {
      console.error('Hợp đồng API đã đổi so với apps/api/openapi.json. Chạy `pnpm --filter @mihato/api openapi` rồi xem lại thay đổi.');
      process.exit(1);
    }
    console.log('Hợp đồng API khớp bản đã duyệt.');
  } else {
    writeFileSync(file, next);
    console.log(`Đã ghi ${file}`);
  }
}
