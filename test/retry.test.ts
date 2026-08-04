import { describe, expect, it } from 'vitest';
import { withRetry } from '../src/retry.js';

/** Builds a fn that rejects for the first `failures` calls, then resolves, counting calls. */
function flaky<T>(failures: number, value: T) {
  const state = { calls: 0 };
  const fn = async (): Promise<T> => {
    state.calls++;
    if (state.calls <= failures) throw new Error(`attempt ${state.calls} failed`);
    return value;
  };
  return { fn, state };
}

describe('withRetry', () => {
  it('returns the value and calls once when the first attempt succeeds', async () => {
    const { fn, state } = flaky(0, 'ok');

    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(state.calls).toBe(1);
  });

  it('retries once after an initial failure and returns the value', async () => {
    const { fn, state } = flaky(1, 'ok');

    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(state.calls).toBe(2);
  });

  it('throws the last error after exhausting the default retry', async () => {
    const { fn, state } = flaky(2, 'never');

    await expect(withRetry(fn)).rejects.toThrow('attempt 2 failed');
    expect(state.calls).toBe(2);
  });

  it('makes exactly one attempt and propagates the rejection when retries is 0', async () => {
    const { fn, state } = flaky(1, 'never');

    await expect(withRetry(fn, 0)).rejects.toThrow('attempt 1 failed');
    expect(state.calls).toBe(1);
  });

  it('allows three total attempts when retries is 2', async () => {
    const { fn, state } = flaky(2, 'ok');

    await expect(withRetry(fn, 2)).resolves.toBe('ok');
    expect(state.calls).toBe(3);
  });

  it('throws the last error after three failed attempts when retries is 2', async () => {
    const { fn, state } = flaky(3, 'never');

    await expect(withRetry(fn, 2)).rejects.toThrow('attempt 3 failed');
    expect(state.calls).toBe(3);
  });

  it('propagates non-Error rejection values unchanged', async () => {
    const thrown = { code: 'ENOPE' };
    let calls = 0;
    const fn = async (): Promise<never> => {
      calls++;
      throw thrown;
    };

    await expect(withRetry(fn, 0)).rejects.toBe(thrown);
    expect(calls).toBe(1);
  });
});
