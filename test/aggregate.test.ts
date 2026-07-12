import { describe, expect, it } from 'vitest';
import { aggregate, decideVerdict, type ItemResult } from '../src/report.js';

function item(overrides: Partial<ItemResult> & { id: string }): ItemResult {
  return {
    input: 'x',
    pass: true,
    regression: false,
    ...overrides,
  };
}

describe('aggregate', () => {
  it('computes totals, pass rate, regressions, and errored counts', () => {
    const items: ItemResult[] = [
      item({ id: 'a', pass: true }),
      item({ id: 'b', pass: true }),
      item({ id: 'c', pass: false, regression: true, baseline_output: 'y' }),
      item({ id: 'd', pass: false, error: 'candidate failed after retry: boom' }),
    ];
    const totals = aggregate(items);
    expect(totals).toEqual({
      total: 4,
      passed: 2,
      failed: 2,
      errored: 1,
      passRate: 0.5,
      regressions: 1,
    });
  });

  it('errored items are counted as failures, never skipped', () => {
    const totals = aggregate([item({ id: 'a', pass: false, error: 'judge failed after retry' })]);
    expect(totals.total).toBe(1);
    expect(totals.failed).toBe(1);
    expect(totals.errored).toBe(1);
    expect(totals.passRate).toBe(0);
  });
});

describe('decideVerdict', () => {
  const totals = { total: 10, passed: 9, failed: 1, errored: 0, passRate: 0.9, regressions: 1 };

  it('promotes when pass rate and regressions are within thresholds', () => {
    expect(decideVerdict(totals, { minPassRate: 0.9, maxRegressions: 1 })).toBe('promote');
  });

  it('blocks when pass rate is below the threshold', () => {
    expect(decideVerdict(totals, { minPassRate: 0.95, maxRegressions: 5 })).toBe('block');
  });

  it('blocks when regressions exceed the threshold even if pass rate is fine', () => {
    expect(decideVerdict(totals, { minPassRate: 0.5, maxRegressions: 0 })).toBe('block');
  });
});
