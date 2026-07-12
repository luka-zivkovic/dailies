import { runCandidate } from './candidate.js';
import type { Config, InputItem } from './config.js';
import { judgeItem } from './judge.js';
import { loadInputs } from './inputs.js';
import { mapPool } from './pool.js';
import {
  aggregate,
  decideVerdict,
  REPORT_SCHEMA_VERSION,
  reportSchema,
  type ItemResult,
  type Report,
} from './report.js';
import { withRetry } from './retry.js';

async function runOneItem(config: Config, item: InputItem): Promise<ItemResult> {
  const base: Pick<ItemResult, 'id' | 'input' | 'baseline_output'> = {
    id: item.id,
    input: item.input,
    ...(item.baseline_output !== undefined ? { baseline_output: item.baseline_output } : {}),
  };

  let candidateOutput: string;
  try {
    candidateOutput = await withRetry(() =>
      runCandidate(config.candidate, item.input, config.timeoutMs),
    );
  } catch (err) {
    return {
      ...base,
      error: `candidate failed after retry: ${err instanceof Error ? err.message : String(err)}`,
      pass: false,
      regression: item.baseline_output !== undefined,
    };
  }

  try {
    const judge = await withRetry(() =>
      judgeItem(config.judge, item.input, candidateOutput, item.baseline_output, config.timeoutMs),
    );
    return {
      ...base,
      candidate_output: candidateOutput,
      judge,
      pass: judge.pass,
      regression: !judge.pass && item.baseline_output !== undefined,
    };
  } catch (err) {
    return {
      ...base,
      candidate_output: candidateOutput,
      error: `judge failed after retry: ${err instanceof Error ? err.message : String(err)}`,
      pass: false,
      regression: item.baseline_output !== undefined,
    };
  }
}

/** Run the full shadow evaluation. Throws on run errors (bad inputs file, etc.). */
export async function runShadow(config: Config): Promise<Report> {
  const startedAt = new Date().toISOString();
  const inputs = await loadInputs(config.inputs.path);

  const items = await mapPool(inputs, config.concurrency, (item) => runOneItem(config, item));

  const totals = aggregate(items);
  const report: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    thresholds: config.thresholds,
    totals,
    verdict: decideVerdict(totals, config.thresholds),
    items,
  };
  // Validate the report against its versioned schema before anyone consumes it.
  return reportSchema.parse(report);
}
