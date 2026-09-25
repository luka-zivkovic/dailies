import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import {
  compareOutcome,
  decideDecision,
  type Comparison,
  type Totals,
} from '../src/report.js';
import { runShadow } from '../src/runner.js';
import { v4ContractForPath } from './v4-fixture.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function completeTotals(total: number, passed: number, regressions: number): Totals {
  const comparisonCounts: Record<Comparison, number> = {
    regression: regressions,
    improvement: 0,
    stable_pass: passed,
    stable_fail: total - passed - regressions,
    unpaired: 0,
  };
  return {
    total,
    passed,
    failed: total - passed,
    errored: 0,
    candidateErrored: 0,
    judgeErrored: 0,
    protocolErrored: 0,
    evaluated: total,
    evaluationCoverage: 1,
    passRate: passed / total,
    regressions,
    comparisonCounts,
    allErrored: false,
  };
}

async function writeInputs(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-properties-'));
  tempDirs.push(dir);
  const path = join(dir, 'inputs.jsonl');
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return path;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server did not bind');
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): void {
  server.closeAllConnections();
  server.close();
}

function exactConfig(
  path: string,
  concurrency: number,
  thresholds = { minPassRate: 1, maxRegressions: 0 },
): Config {
  return {
    ...v4ContractForPath(path),
    candidate: { type: 'command', template: 'printf %s {input}' },
    judge: { type: 'exact-match' },
    thresholds,
    concurrency,
    timeoutMs: 2_000,
    output: { dir: 'unused' },
  };
}

describe('paired comparison semantics', () => {
  it.each([
    ['pass', 'pass', 'stable_pass'],
    ['pass', 'fail', 'regression'],
    ['fail', 'pass', 'improvement'],
    ['fail', 'fail', 'stable_fail'],
    [undefined, 'pass', 'unpaired'],
    [undefined, 'fail', 'unpaired'],
    ['pass', 'error', 'unpaired'],
  ] as const)('%s → %s is %s', (baseline, outcome, expected) => {
    expect(compareOutcome(baseline, outcome)).toBe(expected);
  });

  it('never infers a passing baseline from baseline_output alone', async () => {
    const path = await writeInputs([
      { id: 'output-only', input: 'candidate', baseline_output: 'production' },
    ]);
    const report = await runShadow(exactConfig(path, 1));
    expect(report.decision).toBe('block');
    expect(report.items[0]).toMatchObject({
      outcome: 'fail',
      comparison: 'unpaired',
      regression: false,
    });
    expect(report.totals).toMatchObject({
      regressions: 0,
      comparisonCounts: { unpaired: 1 },
    });
  });

  it('keeps stable fails visible in pass rate and requires explicit threshold tolerance', async () => {
    const path = await writeInputs([
      {
        id: 'known-failure',
        input: 'still-bad',
        baseline_label: 'fail',
        baseline_output: 'different',
      },
    ]);
    const strict = await runShadow(exactConfig(path, 1));
    const tolerant = await runShadow(
      exactConfig(path, 1, { minPassRate: 0, maxRegressions: 0 }),
    );
    expect(strict.decision).toBe('block');
    expect(tolerant.decision).toBe('promote');
    expect(tolerant.totals).toMatchObject({
      passRate: 0,
      regressions: 0,
      comparisonCounts: { stable_fail: 1 },
    });
  });

  it('counts an explicitly failing baseline that now passes as an improvement', async () => {
    const path = await writeInputs([
      {
        id: 'fixed',
        input: 'good-now',
        baseline_label: 'fail',
        baseline_output: 'good-now',
      },
    ]);
    const report = await runShadow(exactConfig(path, 1));
    expect(report.decision).toBe('promote');
    expect(report.items[0]).toMatchObject({ comparison: 'improvement', regression: false });
    expect(report.totals.comparisonCounts.improvement).toBe(1);
  });
});

describe('decision monotonicity', () => {
  it('never improves a decision when thresholds get stricter', () => {
    const rates = [0, 0.25, 0.5, 0.75, 1];
    for (let total = 1; total <= 12; total += 1) {
      for (let passed = 0; passed <= total; passed += 1) {
        for (let regressions = 0; regressions <= total - passed; regressions += 1) {
          const totals = completeTotals(total, passed, regressions);
          for (const lenientRate of rates) {
            for (const strictRate of rates.filter((rate) => rate >= lenientRate)) {
              for (let strictMax = 0; strictMax <= 3; strictMax += 1) {
                for (let lenientMax = strictMax; lenientMax <= 3; lenientMax += 1) {
                  const lenientDecision = decideDecision(totals, {
                    minPassRate: lenientRate,
                    maxRegressions: lenientMax,
                  }, true);
                  const strictDecision = decideDecision(totals, {
                    minPassRate: strictRate,
                    maxRegressions: strictMax,
                  }, true);
                  if (strictDecision === 'promote') {
                    expect(lenientDecision).toBe('promote');
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it('never turns promotion into block when a failure becomes a pass', () => {
    for (let total = 2; total <= 20; total += 1) {
      for (let passed = 0; passed < total; passed += 1) {
        for (let regressions = 0; regressions <= total - passed; regressions += 1) {
          const before = completeTotals(total, passed, regressions);
          const after = completeTotals(total, passed + 1, Math.max(0, regressions - 1));
          for (const minPassRate of [0, 0.5, 0.8, 1]) {
            for (const maxRegressions of [0, 1, 3]) {
              const thresholds = { minPassRate, maxRegressions };
              if (decideDecision(before, thresholds, true) === 'promote') {
                expect(decideDecision(after, thresholds, true)).toBe('promote');
              }
            }
          }
        }
      }
    }
  });

  it('never promotes complete self-reported evidence without admission', () => {
    for (let total = 1; total <= 20; total += 1) {
      for (let passed = 0; passed <= total; passed += 1) {
        const totals = completeTotals(total, passed, 0);
        for (const minPassRate of [0, 0.5, 0.8, 1]) {
          expect(decideDecision(totals, { minPassRate, maxRegressions: total }, false))
            .not.toBe('promote');
        }
      }
    }
  });

  it('keeps candidate failure blocking but makes judge/protocol integrity failure inconclusive', () => {
    const candidateFailure = {
      ...completeTotals(2, 1, 0),
      errored: 1,
      candidateErrored: 1,
      evaluated: 1,
      evaluationCoverage: 0.5,
    };
    expect(decideDecision(candidateFailure, { minPassRate: 0, maxRegressions: 9 }, true))
      .toBe('block');

    const mixedIntegrityFailure = {
      ...candidateFailure,
      judgeErrored: 1,
      protocolErrored: 1,
    };
    expect(decideDecision(mixedIntegrityFailure, { minPassRate: 0, maxRegressions: 9 }, true))
      .toBe('inconclusive');
  });
});

describe('output determinism across concurrency', () => {
  it('preserves input order and bytes despite provably out-of-order HTTP completion', async () => {
    const path = await writeInputs(
      Array.from({ length: 40 }, (_, index) => ({
        id: `item-${String(index).padStart(2, '0')}`,
        input: `value-${index}`,
        baseline_label: 'pass',
        baseline_output: `value-${index}`,
      })),
    );
    const executions = new Map<string, { inFlight: number; maxInFlight: number; completed: string[] }>();
    const candidateServer = createServer(async (req, res) => {
      const run = req.headers['x-test-run'];
      if (typeof run !== 'string') throw new Error('missing x-test-run header');
      const state = executions.get(run) ?? { inFlight: 0, maxInFlight: 0, completed: [] };
      executions.set(run, state);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const body = JSON.parse(await readBody(req)) as { prompt: string };
      const index = Number(body.prompt.slice('value-'.length));
      // Every group starts with a deliberately slow item, so concurrency > 1
      // must complete a later input first. This proves the pool actually overlaps.
      await new Promise((resolve) => setTimeout(resolve, index % 4 === 0 ? 30 : 1));
      state.completed.push(body.prompt);
      state.inFlight -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: body.prompt }));
    });
    const port = await listen(candidateServer);
    const now = () => new Date('2026-08-21T12:00:00.000Z');
    try {
      const reports = [];
      for (const concurrency of [1, 4, 32]) {
        const config = exactConfig(path, concurrency);
        config.candidate = {
          type: 'http',
          url: `http://127.0.0.1:${port}/candidate`,
          headers: { 'x-test-run': String(concurrency) },
          bodyTemplate: '{"prompt": {input}}',
        };
        reports.push(await runShadow(config, { now }));
      }

      expect(executions.get('1')?.maxInFlight).toBe(1);
      expect(executions.get('4')?.maxInFlight).toBeGreaterThan(1);
      expect(executions.get('32')?.maxInFlight).toBeGreaterThan(1);
      const inputOrder = reports[0]!.items.map((item) => item.input);
      expect(executions.get('4')?.completed).not.toEqual(inputOrder);
      expect(executions.get('32')?.completed).not.toEqual(inputOrder);
      expect(reports[1]!.items.map((item) => item.input)).toEqual(inputOrder);
      expect(reports[2]!.items.map((item) => item.input)).toEqual(inputOrder);
      expect(JSON.stringify(reports[1])).toBe(JSON.stringify(reports[0]));
      expect(JSON.stringify(reports[2])).toBe(JSON.stringify(reports[0]));
    } finally {
      closeServer(candidateServer);
    }
  });
});
