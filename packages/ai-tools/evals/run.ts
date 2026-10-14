/**
 * Dòng lệnh của bộ đánh giá AI (SPEC 13.5).
 *
 *   pnpm --filter @mihato/ai-tools evals                 chạy với FakeLlm (mặc định, không tốn tiền, không cần mạng)
 *   pnpm --filter @mihato/ai-tools evals -- --real       gọi Claude thật: cần cả cờ `--real` VÀ `ANTHROPIC_API_KEY`
 *
 * Tuỳ chọn: --runs <n> (mặc định 5)  --budget <USD> (mặc định 30)  --filter <id hoặc nhãn>  --concurrency <n>
 *           --model <id> (mặc định LLM_MODEL hoặc claude-sonnet-5-5)  --effort low|medium
 * Mã thoát: 0 đạt; 1 không đạt (vi phạm an toàn, hoặc bản giả có ca không đạt); 2 vượt trần ngân sách hoặc sai tham số.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnthropicLlm, DEFAULT_LLM_MODEL, FakeLlm, type LlmClient, type LlmEffort } from '@mihato/providers';
import { EVAL_FAKE_STEPS } from './fake-script';
import { DEFAULT_BUDGET_USD, DEFAULT_RUNS, FREE, loadCases, pricingFor, RESULTS_DIR, runEvals, toMarkdown } from './runner';
import { EVAL_GROUPS, groupOf } from './types';

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const [key, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) values.set(key, inline);
    else if (next !== undefined && !next.startsWith('--')) {
      values.set(key, next);
      i++;
    } else flags.add(key);
  }
  return { flags, values };
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// Nạp .env ở gốc repo nếu có (khoá API cho chế độ --real). Không có tệp thì thôi.
const rootEnv = join(import.meta.dirname, '..', '..', '..', '.env');
if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {}
}

const { flags, values } = parseArgs(process.argv.slice(2));
const real = flags.has('real');
const runs = Number(values.get('runs') ?? DEFAULT_RUNS);
const budgetUsd = Number(values.get('budget') ?? DEFAULT_BUDGET_USD);
const concurrency = Number(values.get('concurrency') ?? (real ? 4 : 1));
const effortArg = (values.get('effort') ?? process.env.LLM_EFFORT ?? 'low').split('#')[0]!.trim();
if (effortArg !== 'low' && effortArg !== 'medium') fail(`--effort phải là low hoặc medium (SPEC 6.3), nhận "${effortArg}"`);
const effort: LlmEffort = effortArg;
if (!Number.isInteger(runs) || runs < 1) fail('--runs phải là số nguyên dương');
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) fail('--budget phải là số dương (USD)');
if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency phải là số nguyên dương');

let cases = loadCases();
const filter = values.get('filter');
if (filter) cases = cases.filter((c) => c.id.includes(filter) || (c.tags as string[]).includes(filter));
if (cases.length === 0) fail('Không có ca nào khớp.');

const model = real ? (values.get('model') ?? process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL).split('#')[0]!.trim() : 'fake';
let makeLlm: () => LlmClient;
let pricing = FREE;
let pricingKnown = true;

if (real) {
  // Chỉ gọi Claude thật khi có CẢ cờ --real VÀ khoá API (CLAUDE.md luật 10: CI không gọi nhà cung cấp trả phí).
  if (!process.env.ANTHROPIC_API_KEY) fail('Có cờ --real nhưng thiếu ANTHROPIC_API_KEY. Không chạy.');
  ({ pricing, known: pricingKnown } = pricingFor(model));
  const client = new AnthropicLlm({ apiKey: process.env.ANTHROPIC_API_KEY, model });
  makeLlm = () => client;
  console.warn('');
  console.warn('  CẢNH BÁO: lượt chạy này gọi Claude THẬT và TỐN TIỀN.');
  console.warn(`  Model ${model}, effort ${effort}; ${cases.length} ca × ${runs} lần = ${cases.length * runs} hội thoại.`);
  console.warn(`  Trần ngân sách ${budgetUsd} USD: vượt thì dừng và báo.${pricingKnown ? '' : ' Model không có trong bảng giá: ước tính theo mức đắt nhất.'}`);
  console.warn('');
} else {
  if (values.has('model')) console.warn('Bỏ qua --model: không có cờ --real nên chạy với FakeLlm.');
  makeLlm = () => new FakeLlm(EVAL_FAKE_STEPS);
}

const byGroup = EVAL_GROUPS.map((g) => `${g.label}: ${cases.filter((c) => groupOf(c).key === g.key).length}`).join('; ');
console.log(`Bộ đánh giá AI: ${cases.length} ca (${byGroup}); mỗi ca ${runs} lần; chế độ ${real ? 'Claude thật' : 'bản giả'}.`);

const report = await runEvals({
  cases,
  makeLlm,
  mode: real ? 'real' : 'fake',
  model,
  effort,
  runs,
  budgetUsd,
  pricing,
  pricingKnown,
  concurrency,
  onProgress: real ? (done, total, spent) => process.stdout.write(`\r  ${done}/${total} lượt, khoảng ${spent.toFixed(2)} USD`) : undefined,
});
if (real) process.stdout.write('\n');

// Bản giả ghi đè một tệp cố định; lượt chạy thật giữ lại theo thời điểm để so với lần trước (SPEC 13.5, "Cổng thay đổi").
mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = report.startedAt.replace(/[:.]/g, '-');
// Lượt chạy bản giả không đủ bộ (có --filter hoặc đổi --runs) ghi sang tệp riêng để không đè báo cáo đủ bộ.
const partial = filter !== undefined || runs !== DEFAULT_RUNS;
const base = real ? `real-${stamp}${partial ? '-partial' : ''}` : partial ? 'fake-partial' : 'fake-latest';
writeFileSync(join(RESULTS_DIR, `${base}.json`), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(RESULTS_DIR, `${base}.md`), toMarkdown(report));

for (const g of report.groups) console.log(`  ${g.label.padEnd(30)} ${g.passedRuns}/${g.runs} lượt đạt, ${g.casesAllPass}/${g.cases} ca đạt mọi lần${g.safety ? ' (an toàn)' : ''}`);
for (const t of report.thresholds) console.log(`  ${t.met ? 'đạt     ' : 'CHƯA ĐẠT'} ${t.name}: ${t.value} (ngưỡng ${t.target})`);
console.log(`Báo cáo: ${join(RESULTS_DIR, `${base}.md`)} và .json`);
if (!real) console.log('Lưu ý: kết quả với FakeLlm chỉ chứng minh trình chạy đúng, KHÔNG đo chất lượng trợ lý.');

if (!report.verdict.ok) {
  console.error('KHÔNG ĐẠT:');
  for (const r of report.verdict.reasons) console.error(`  - ${r}`);
  process.exit(report.budget.exceeded ? 2 : 1);
}
console.log('ĐẠT.');
