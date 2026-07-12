import { z } from 'zod';
import { judgeResultSchema } from './judge.js';

export const REPORT_SCHEMA_VERSION = 1;

export const itemResultSchema = z.object({
  id: z.string(),
  input: z.string(),
  baseline_output: z.string().optional(),
  candidate_output: z.string().optional(),
  judge: judgeResultSchema.optional(),
  /** Set when the candidate or judge failed after retry; the item counts as a failure. */
  error: z.string().optional(),
  pass: z.boolean(),
  /** A failing item that has a baseline_output (behavior we used to get right). */
  regression: z.boolean(),
});

export const reportSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  startedAt: z.string(),
  finishedAt: z.string(),
  thresholds: z.object({
    minPassRate: z.number(),
    maxRegressions: z.number(),
  }),
  totals: z.object({
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    /** Subset of `failed` where the candidate or judge errored after retry. */
    errored: z.number().int(),
    passRate: z.number(),
    regressions: z.number().int(),
  }),
  verdict: z.enum(['promote', 'block']),
  items: z.array(itemResultSchema),
});

export type ItemResult = z.infer<typeof itemResultSchema>;
export type Report = z.infer<typeof reportSchema>;

export interface Totals {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  regressions: number;
}

export function aggregate(items: ItemResult[]): Totals {
  const total = items.length;
  const passed = items.filter((i) => i.pass).length;
  const failed = total - passed;
  const errored = items.filter((i) => i.error !== undefined).length;
  const regressions = items.filter((i) => i.regression).length;
  const passRate = total === 0 ? 0 : passed / total;
  return { total, passed, failed, errored, passRate, regressions };
}

export function decideVerdict(
  totals: Totals,
  thresholds: { minPassRate: number; maxRegressions: number },
): 'promote' | 'block' {
  return totals.passRate >= thresholds.minPassRate &&
    totals.regressions <= thresholds.maxRegressions
    ? 'promote'
    : 'block';
}

const MAX_FAILING_EXAMPLES = 10;

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function renderMarkdown(report: Report): string {
  const { totals, thresholds } = report;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const emoji = report.verdict === 'promote' ? 'PROMOTE' : 'BLOCK';

  const lines: string[] = [
    `# Shadow run report: ${emoji}`,
    '',
    `- Verdict: **${report.verdict}**`,
    `- Pass rate: **${pct(totals.passRate)}** (${totals.passed}/${totals.total}) — threshold: ≥ ${pct(thresholds.minPassRate)}`,
    `- Regressions vs baseline: **${totals.regressions}** — threshold: ≤ ${thresholds.maxRegressions}`,
    `- Errored items (counted as failures): ${totals.errored}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    '',
  ];

  const failing = report.items.filter((i) => !i.pass);
  if (failing.length > 0) {
    lines.push(`## Failing items (${failing.length}${failing.length > MAX_FAILING_EXAMPLES ? `, showing first ${MAX_FAILING_EXAMPLES}` : ''})`, '');
    for (const item of failing.slice(0, MAX_FAILING_EXAMPLES)) {
      lines.push(`### ${item.id}${item.regression ? ' (regression)' : ''}`, '');
      lines.push(`- input: \`${truncate(item.input)}\``);
      if (item.baseline_output !== undefined) {
        lines.push(`- baseline_output: \`${truncate(item.baseline_output)}\``);
      }
      if (item.candidate_output !== undefined) {
        lines.push(`- candidate_output: \`${truncate(item.candidate_output)}\``);
      }
      if (item.judge) {
        lines.push(`- judge: score=${item.judge.score}${item.judge.reason ? `, reason: ${truncate(item.judge.reason)}` : ''}`);
      }
      if (item.error) {
        lines.push(`- error: ${truncate(item.error)}`);
      }
      lines.push('');
    }
  } else {
    lines.push('All items passed.', '');
  }

  return lines.join('\n');
}
