/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advance, createRun, replay, simulate, validate } from '../src';
import { drive, fcParams, newRun, scenarioArb } from './support/arb';

/**
 * Thuộc tính 6 (SPEC 4.10), Không rò rỉ: engine không gọi Date.now(), Math.random(), mạng hay CSDL.
 * Kiểm bằng hai cách: luật lint của repo (ESLint API), và chạy engine khi các cửa ra thế giới bên ngoài
 * đã bị gài bẫy.
 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ENGINE_FILE = 'packages/workflow-engine/src/__vi_pham__.ts';
const CALENDAR_FILE = 'packages/domain/src/calendar/__vi_pham__.ts';

async function lint(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => `${m.ruleId}: ${m.message}`);
}

describe('thuộc tính 6: không rò rỉ (luật lint)', () => {
  const VIOLATIONS: [string, string, string][] = [
    ['Date.now()', 'export const t = Date.now();\n', 'no-restricted-syntax'],
    ['new Date() không tham số', 'export const t = new Date();\n', 'no-restricted-syntax'],
    ['Math.random()', 'export const r = Math.random();\n', 'no-restricted-syntax'],
    ['crypto.randomUUID()', 'export const id = crypto.randomUUID();\n', 'no-restricted-syntax'],
    ["import 'pg'", "import { Client } from 'pg';\nexport const c = Client;\n", 'no-restricted-imports'],
    ["import 'node:fs'", "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n", 'no-restricted-imports'],
    ['import drizzle-orm', "import { sql } from 'drizzle-orm';\nexport const s = sql;\n", 'no-restricted-imports'],
    ['import @mihato/backend', "import { db } from '@mihato/backend';\nexport const d = db;\n", 'no-restricted-imports'],
    ['fetch', "export const p = fetch('https://example.invalid');\n", 'no-restricted-globals'],
    ['setTimeout', 'export const h = setTimeout(() => undefined, 1);\n', 'no-restricted-globals'],
    ['process.env', "export const e = process.env['X'];\n", 'no-restricted-globals'],
  ];

  it.each(VIOLATIONS)('mã vi phạm trong packages/workflow-engine/src bị bắt: %s', async (_name, code, rule) => {
    const errors = await lint(code, ENGINE_FILE);
    expect(errors.some((e) => e.startsWith(rule))).toBe(true);
  }, 30_000);

  it('một tệp vi phạm cả bốn kiểu (Date.now, Math.random, import pg, fetch) bị bắt đủ cả bốn', async () => {
    const code = [
      "import { Client } from 'pg';",
      'export function leak(): number {',
      '  const now = Date.now();',
      "  void fetch('https://example.invalid');",
      '  void Client;',
      '  return now + Math.random();',
      '}',
      '',
    ].join('\n');
    const errors = await lint(code, ENGINE_FILE);
    expect(errors.filter((e) => e.startsWith('no-restricted-syntax'))).toHaveLength(2);
    expect(errors.filter((e) => e.startsWith('no-restricted-imports'))).toHaveLength(1);
    expect(errors.filter((e) => e.startsWith('no-restricted-globals'))).toHaveLength(1);
  }, 30_000);

  it('luật thuần cũng áp cho packages/domain/src/calendar', async () => {
    const errors = await lint('export const t = Date.now() + Math.random();\n', CALENDAR_FILE);
    expect(errors.filter((e) => e.startsWith('no-restricted-syntax'))).toHaveLength(2);
  }, 30_000);

  it('mã thuần cùng chỗ thì không bị bắt; cùng mã vi phạm ở gói khác thì không bị luật này chặn', async () => {
    expect(await lint('export const iso = (ms: number): string => new Date(ms).toISOString();\n', ENGINE_FILE)).toEqual([]);
    expect(await lint('export const t = Date.now();\n', 'packages/backend/src/__duoc_phep__.ts')).toEqual([]);
  }, 30_000);

  it('mã nguồn thật của engine và của lịch làm việc sạch lỗi lint', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const results = await eslint.lintFiles(['packages/workflow-engine/src', 'packages/domain/src/calendar']);
    expect(results.length).toBeGreaterThan(5);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.ruleId}`))).toEqual([]);
  }, 60_000);
});

describe('thuộc tính 6: không rò rỉ (chạy với các cửa ra đã gài bẫy)', () => {
  /** Chạy `fn` khi Date.now, new Date() không tham số, Math.random và fetch đều ném lỗi. */
  function trapped<T>(fn: () => T): T {
    const RealDate = Date;
    const realRandom = Math.random;
    const realFetch = globalThis.fetch;
    const TrapDate = new Proxy(RealDate, {
      construct(target, args: unknown[]) {
        if (args.length === 0) throw new Error('rò rỉ: new Date() không tham số');
        return Reflect.construct(target, args) as object;
      },
      get(target, prop, receiver) {
        if (prop === 'now') return () => { throw new Error('rò rỉ: Date.now()'); };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    globalThis.Date = TrapDate;
    Math.random = () => { throw new Error('rò rỉ: Math.random()'); };
    globalThis.fetch = (() => { throw new Error('rò rỉ: fetch'); }) as typeof fetch;
    try {
      return fn();
    } finally {
      globalThis.Date = RealDate;
      Math.random = realRandom;
      globalThis.fetch = realFetch;
    }
  }

  it('bẫy hoạt động: mã có rò rỉ thì bị bắt', () => {
    expect(() => trapped(() => Date.now())).toThrow('rò rỉ');
    expect(() => trapped(() => new Date())).toThrow('rò rỉ');
    expect(() => trapped(() => Math.random())).toThrow('rò rỉ');
    expect(trapped(() => new Date(0).toISOString())).toBe('1970-01-01T00:00:00.000Z');
  });

  it('createRun, advance, validate, simulate, replay chạy trọn kịch bản ngẫu nhiên mà không chạm đồng hồ, số ngẫu nhiên hay mạng', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        // dựng kịch bản bình thường (bộ chạy thử có thể dùng tiện ích khác), rồi áp lại từng sự kiện trong bẫy
        const trace = drive(scenario);
        const final = trapped(() => {
          let run = createRun(scenario.def, { id: trace.initial.id, orgId: trace.initial.orgId, templateId: trace.initial.templateId, templateVersionId: trace.initial.templateVersionId, title: trace.initial.title, initiatorId: trace.initial.initiatorId, inputs: scenario.inputs });
          for (const step of trace.steps) run = advance({ def: scenario.def, run, event: step.event, ctx: scenario.ctx, now: step.now }).run;
          validate(scenario.def, { now: scenario.startAt, calendar: scenario.ctx.calendar });
          simulate({ def: scenario.def, inputs: scenario.inputs, initiatorId: scenario.initiatorId, ctx: scenario.ctx, now: scenario.startAt });
          return [run, replay({ def: scenario.def, initial: newRun(scenario), events: trace.records, ctx: scenario.ctx })];
        });
        expect(JSON.stringify(final[0])).toBe(JSON.stringify(trace.final));
        expect(JSON.stringify(final[1])).toBe(JSON.stringify(trace.final));
      }),
      fcParams,
    );
  });

  it('cùng đầu vào thì cùng đầu ra: chạy hai lần cho kết quả giống hệt, cả effect lẫn sự kiện', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const a = drive(scenario);
        const b = drive(scenario);
        expect(JSON.stringify(b.final)).toBe(JSON.stringify(a.final));
        expect(JSON.stringify(b.steps.map((s) => [s.out.effects, s.out.events]))).toBe(JSON.stringify(a.steps.map((s) => [s.out.effects, s.out.events])));
      }),
      fcParams,
    );
  });
});
