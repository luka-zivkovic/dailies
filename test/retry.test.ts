import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationError, parseRetryAfter } from '../src/errors.js';
import { itemResultSchema } from '../src/report.js';
import {
  RetryFailure,
  attemptRecordSchema,
  isRetryableError,
  runWithRetry,
} from '../src/retry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('classified retry policy', () => {
  it.each([
    ['rate limit', new OperationError('limited', 'http', { httpStatus: 429 }), true],
    ['provider 503', new OperationError('down', 'http', { httpStatus: 503 }), true],
    ['transport', new OperationError('reset', 'transport'), true],
    ['timeout', new OperationError('slow', 'timeout'), true],
    ['auth 401', new OperationError('unauthorized', 'http', { httpStatus: 401 }), false],
    ['request 422', new OperationError('invalid', 'http', { httpStatus: 422 }), false],
    ['malformed 200', new OperationError('bad payload', 'protocol'), false],
    ['execution', new OperationError('bad command', 'execution'), false],
  ])('%s retryability is %s', (_name, error, expected) => {
    expect(isRetryableError(error)).toBe(expected);
  });

  it('records Retry-After and succeeds on the bounded second attempt under a fake clock', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = runWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new OperationError('limited', 'http', {
            httpStatus: 429,
            retryAfterMs: 750,
          });
        }
        return 'ok';
      },
      { baseDelayMs: 100 },
    );

    await vi.advanceTimersByTimeAsync(749);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      value: 'ok',
      attempts: [
        {
          attempt: 1,
          outcome: 'error',
          errorKind: 'http',
          httpStatus: 429,
          retryable: true,
          delayBeforeNextMs: 750,
        },
        { attempt: 2, outcome: 'success' },
      ],
    });
  });

  it('does not retry a 4xx or malformed successful payload', async () => {
    const sleep = vi.fn(async () => {});
    for (const error of [
      new OperationError('unauthorized', 'http', { httpStatus: 401 }),
      new OperationError('malformed', 'protocol'),
    ]) {
      const operation = vi.fn(async () => {
        throw error;
      });
      const failure = await runWithRetry(operation, { sleep }).catch((caught) => caught);
      expect(failure).toBeInstanceOf(RetryFailure);
      expect(operation).toHaveBeenCalledTimes(1);
      expect((failure as RetryFailure).attempts).toHaveLength(1);
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it('caps provider Retry-After and attempt count', async () => {
    const delays: number[] = [];
    const operation = vi.fn(async () => {
      throw new OperationError('down', 'http', {
        httpStatus: 503,
        retryAfterMs: 60_000,
      });
    });
    const failure = await runWithRetry(operation, {
      maxAttempts: 2,
      sleep: async (delay) => {
        delays.push(delay);
      },
    }).catch((caught) => caught);
    expect(failure).toBeInstanceOf(RetryFailure);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([5_000]);
    expect((failure as RetryFailure).attempts).toEqual([
      {
        attempt: 1,
        outcome: 'error',
        errorKind: 'http',
        httpStatus: 503,
        retryable: true,
        delayBeforeNextMs: 5_000,
      },
      {
        attempt: 2,
        outcome: 'error',
        errorKind: 'http',
        httpStatus: 503,
        retryable: true,
      },
    ]);
  });

  it('suppresses a retry that cannot fit its enclosing operation budget', async () => {
    const operation = vi.fn(async () => {
      throw new OperationError('down', 'http', { httpStatus: 503 });
    });
    const failure = await runWithRetry(operation, {
      canRetry: (delayMs) => delayMs < 100,
      sleep: vi.fn(async () => {}),
    }).catch((caught) => caught);
    expect(failure).toBeInstanceOf(RetryFailure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect((failure as RetryFailure).attempts).toEqual([{
      attempt: 1,
      outcome: 'error',
      errorKind: 'http',
      httpStatus: 503,
      retryable: true,
    }]);
  });

  it('parses both Retry-After forms against an explicit clock', () => {
    const now = Date.parse('2026-08-21T12:00:00Z');
    expect(parseRetryAfter('1.5', now)).toBe(1_500);
    expect(parseRetryAfter('Fri, 21 Aug 2026 12:00:03 GMT', now)).toBe(3_000);
    expect(parseRetryAfter('not-a-delay', now)).toBeUndefined();
  });

  it('rejects retry budgets above the hard attempt bound', async () => {
    await expect(runWithRetry(async () => 'unused', { maxAttempts: 6 })).rejects.toThrow(
      /maxAttempts must be an integer from 1 to 5/,
    );
  });

  it.each([
    [{ attempt: 1, outcome: 'error', errorKind: 'http', retryable: true }, 'HTTP without status'],
    [{ attempt: 1, outcome: 'error', errorKind: 'timeout', httpStatus: 504, retryable: true }, 'non-HTTP with status'],
    [{ attempt: 1, outcome: 'error', errorKind: 'http', httpStatus: 401, retryable: true }, '401 retryable'],
    [{ attempt: 1, outcome: 'error', errorKind: 'http', httpStatus: 503, retryable: false }, '503 non-retryable'],
    [{ attempt: 1, outcome: 'error', errorKind: 'protocol', retryable: true }, 'protocol retryable'],
    [{ attempt: 1, outcome: 'error', errorKind: 'execution', retryable: true }, 'execution retryable'],
    [{ attempt: 1, outcome: 'error', errorKind: 'transport', retryable: false }, 'transport non-retryable'],
  ])('rejects policy-inconsistent attempt record: %s', (record) => {
    expect(attemptRecordSchema.safeParse(record).success).toBe(false);
  });

  it.each([
    { attempt: 1, outcome: 'error', errorKind: 'http', httpStatus: 429, retryable: true },
    { attempt: 1, outcome: 'error', errorKind: 'http', httpStatus: 500, retryable: true },
    { attempt: 1, outcome: 'error', errorKind: 'http', httpStatus: 400, retryable: false },
    { attempt: 1, outcome: 'error', errorKind: 'timeout', retryable: true },
    { attempt: 1, outcome: 'error', errorKind: 'transport', retryable: true },
    { attempt: 1, outcome: 'error', errorKind: 'incomplete', retryable: false },
  ])('accepts policy-consistent attempt record %#', (record) => {
    expect(attemptRecordSchema.safeParse(record).success).toBe(true);
  });

  it.each([
    {
      id: 'candidate-kind-mismatch',
      input: 'x',
      error: 'timed out',
      outcome: 'error',
      errorStage: 'candidate',
      errorKind: 'timeout',
      pass: false,
      comparison: 'unpaired',
      regression: false,
      attempts: {
        candidate: [{
          attempt: 1,
          outcome: 'error',
          errorKind: 'transport',
          retryable: true,
        }],
      },
    },
    {
      id: 'judge-kind-mismatch',
      input: 'x',
      candidate_output: 'y',
      error: 'timed out',
      outcome: 'error',
      errorStage: 'judge',
      errorKind: 'timeout',
      pass: false,
      comparison: 'unpaired',
      regression: false,
      attempts: {
        candidate: [{ attempt: 1, outcome: 'success' }],
        judge: [{
          attempt: 1,
          outcome: 'error',
          errorKind: 'transport',
          retryable: true,
        }],
      },
    },
  ] as const)('rejects an item whose errorKind differs from its final stage attempt: $id', (item) => {
    expect(itemResultSchema.safeParse(item).success).toBe(false);
  });
});
