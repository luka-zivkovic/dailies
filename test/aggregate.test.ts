import { describe, expect, it } from 'vitest';
import {
  aggregate,
  compareOutcome,
  decideExitCode,
  decideDecision,
  EXIT_BLOCK,
  EXIT_PROMOTE,
  EXIT_RUN_ERROR,
  type ItemResult,
  type Totals,
} from '../src/report.js';

function item(overrides: Partial<ItemResult> & { id: string }): ItemResult {
  const errored = overrides.error !== undefined;
  const outcome = errored ? 'error' : overrides.pass === false ? 'fail' : 'pass';
  const baselineLabel = overrides.baseline_label ?? (overrides.regression ? 'pass' : undefined);
  const errorStage = overrides.errorStage ?? (errored ? 'judge' : undefined);
  return {
    input: 'x',
    ...(baselineLabel === undefined ? {} : { baseline_label: baselineLabel }),
    outcome,
    ...(errored
      ? { errorStage: errorStage!, errorKind: 'unknown' as const }
      : {}),
    pass: true,
    comparison: compareOutcome(baselineLabel, outcome),
    regression: compareOutcome(baselineLabel, outcome) === 'regression',
    attempts: {
      candidate: [{ attempt: 1, outcome: errorStage === 'candidate' ? 'error' : 'success', ...(errorStage === 'candidate' ? { errorKind: 'unknown' as const, retryable: false } : {}) }],
      ...(errorStage === 'candidate'
        ? {}
        : { judge: [{ attempt: 1, outcome: errored ? 'error' as const : 'success' as const, ...(errored ? { errorKind: 'unknown' as const, retryable: false } : {}) }] }),
    },
    ...overrides,
  };
}

describe('aggregate', () => {
  it('computes totals, pass rate, regressions, and errored counts', () => {
    const items: ItemResult[] = [
      item({ id: 'a', pass: true }),
      item({ id: 'b', pass: true }),
      item({ id: 'c', pass: false, baseline_label: 'pass', baseline_output: 'y' }),
      item({
        id: 'd',
        pass: false,
        error: 'candidate failed after retry: boom',
        errorStage: 'candidate',
        errorKind: 'execution',
      }),
    ];
    const totals = aggregate(items);
    expect(totals).toEqual({
      total: 4,
      passed: 2,
      failed: 2,
      errored: 1,
      candidateErrored: 1,
      judgeErrored: 0,
      protocolErrored: 0,
      evaluated: 3,
      evaluationCoverage: 0.75,
      passRate: 0.5,
      regressions: 1,
      comparisonCounts: {
        regression: 1,
        improvement: 0,
        stable_pass: 0,
        stable_fail: 0,
        unpaired: 3,
      },
      allErrored: false,
    });
  });

  it('errored items are counted as failures, never skipped', () => {
    const totals = aggregate([item({ id: 'a', pass: false, error: 'judge failed after retry' })]);
    expect(totals.total).toBe(1);
    expect(totals.failed).toBe(1);
    expect(totals.errored).toBe(1);
    expect(totals.candidateErrored).toBe(0);
    expect(totals.judgeErrored).toBe(1);
    expect(totals.evaluated).toBe(0);
    expect(totals.evaluationCoverage).toBe(0);
    expect(totals.passRate).toBe(0);
  });

  it('counts every explicit comparison category without inferring from baseline_output', () => {
    const totals = aggregate([
      item({ id: 'stable-pass', baseline_label: 'pass', pass: true }),
      item({ id: 'regression', baseline_label: 'pass', pass: false }),
      item({ id: 'improvement', baseline_label: 'fail', pass: true }),
      item({ id: 'stable-fail', baseline_label: 'fail', pass: false }),
      item({ id: 'unpaired', baseline_output: 'context-only', pass: false }),
    ]);
    expect(totals.comparisonCounts).toEqual({
      regression: 1,
      improvement: 1,
      stable_pass: 1,
      stable_fail: 1,
      unpaired: 1,
    });
    expect(totals.regressions).toBe(1);
  });
});

describe('aggregate allErrored', () => {
  it('is true when every item errored (systemic failure)', () => {
    const totals = aggregate([
      item({ id: 'a', pass: false, error: 'candidate failed after retry: down' }),
      item({ id: 'b', pass: false, error: 'candidate failed after retry: down' }),
    ]);
    expect(totals.allErrored).toBe(true);
  });

  it('is false when at least one item did not error', () => {
    const totals = aggregate([
      item({ id: 'a', pass: false, error: 'candidate failed after retry: down' }),
      item({ id: 'b', pass: true }),
    ]);
    expect(totals.allErrored).toBe(false);
  });

  it('is false for an empty item list', () => {
    expect(aggregate([]).allErrored).toBe(false);
  });
});

describe('decideExitCode', () => {
  const baseTotals: Totals = {
    total: 2,
    passed: 0,
    failed: 2,
    errored: 2,
    candidateErrored: 0,
    judgeErrored: 2,
    protocolErrored: 0,
    evaluated: 0,
    evaluationCoverage: 0,
    passRate: 0,
    regressions: 0,
    comparisonCounts: {
      regression: 0,
      improvement: 0,
      stable_pass: 0,
      stable_fail: 0,
      unpaired: 2,
    },
    allErrored: true,
  };

  it('maps an inconclusive run to exit 2', () => {
    expect(decideExitCode({ decision: 'inconclusive', totals: baseTotals })).toBe(EXIT_RUN_ERROR);
  });

  it('maps a block with at least one non-errored item to exit 1', () => {
    expect(
      decideExitCode({
        decision: 'block',
        totals: {
          ...baseTotals,
          errored: 1,
          candidateErrored: 1,
          judgeErrored: 0,
          evaluated: 1,
          evaluationCoverage: 0.5,
          allErrored: false,
        },
      }),
    ).toBe(EXIT_BLOCK);
  });

  it('maps a promote to exit 0', () => {
    expect(
      decideExitCode({
        decision: 'promote',
        totals: {
          ...baseTotals,
          passed: 2,
          failed: 0,
          errored: 0,
          candidateErrored: 0,
          judgeErrored: 0,
          protocolErrored: 0,
          evaluated: 2,
          evaluationCoverage: 1,
          passRate: 1,
          allErrored: false,
        },
      }),
    ).toBe(EXIT_PROMOTE);
  });
});

describe('decideDecision thresholds with admissible trust', () => {
  const totals = {
    total: 10,
    passed: 9,
    failed: 1,
    errored: 0,
    candidateErrored: 0,
    judgeErrored: 0,
    protocolErrored: 0,
    evaluated: 10,
    evaluationCoverage: 1,
    passRate: 0.9,
    regressions: 1,
    comparisonCounts: {
      regression: 1,
      improvement: 0,
      stable_pass: 8,
      stable_fail: 0,
      unpaired: 1,
    },
    allErrored: false,
  };

  it('promotes when pass rate and regressions are within thresholds', () => {
    expect(decideDecision(totals, { minPassRate: 0.9, maxRegressions: 1 }, true)).toBe('promote');
  });

  it('blocks when pass rate is below the threshold', () => {
    expect(decideDecision(totals, { minPassRate: 0.95, maxRegressions: 5 }, true)).toBe('block');
  });

  it('blocks when regressions exceed the threshold even if pass rate is fine', () => {
    expect(decideDecision(totals, { minPassRate: 0.5, maxRegressions: 0 }, true)).toBe('block');
  });

  it('is inconclusive when any item lacks completed judge evidence', () => {
    const partial = {
      ...totals,
      passed: 8,
      failed: 2,
      errored: 1,
      judgeErrored: 1,
      evaluated: 9,
      evaluationCoverage: 0.9,
      passRate: 0.8,
    };
    expect(decideDecision(partial, { minPassRate: 0.5, maxRegressions: 10 }, true)).toBe(
      'inconclusive',
    );
  });

  it('blocks when a required candidate execution fails', () => {
    const candidateFailure = {
      ...totals,
      passed: 9,
      failed: 1,
      errored: 1,
      candidateErrored: 1,
      evaluated: 9,
      evaluationCoverage: 0.9,
      passRate: 0.9,
      regressions: 0,
    };
    expect(decideDecision(candidateFailure, { minPassRate: 0.5, maxRegressions: 10 }, true)).toBe(
      'block',
    );
  });

  it('is inconclusive on a candidate protocol error', () => {
    const protocolFailure = {
      ...totals,
      passed: 9,
      failed: 1,
      errored: 1,
      candidateErrored: 1,
      protocolErrored: 1,
      evaluated: 9,
      evaluationCoverage: 0.9,
      passRate: 0.9,
      regressions: 0,
    };
    expect(decideDecision(protocolFailure, { minPassRate: 0.5, maxRegressions: 10 }, true)).toBe(
      'inconclusive',
    );
  });
});
