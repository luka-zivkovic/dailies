import { describe, expect, it } from 'vitest';
import { judgeItem } from '../src/judge.js';

const exactMatch = { type: 'exact-match' } as const;

describe('exact-match judge', () => {
  it('passes when candidate output equals baseline output', async () => {
    const result = await judgeItem(exactMatch, 'in', 'same', 'same');
    expect(result).toEqual({ score: 1, pass: true });
  });

  it('fails with a reason when outputs differ', async () => {
    const result = await judgeItem(exactMatch, 'in', 'a', 'b');
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reason).toMatch(/does not exactly match/);
  });

  it('fails with a reason when baseline_output is missing', async () => {
    const result = await judgeItem(exactMatch, 'in', 'a', undefined);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/requires baseline_output/);
  });

  it('is strict about whitespace', async () => {
    const result = await judgeItem(exactMatch, 'in', 'a ', 'a');
    expect(result.pass).toBe(false);
  });
});
