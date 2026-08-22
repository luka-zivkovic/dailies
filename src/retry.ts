import { z } from 'zod';
import {
  ERROR_KINDS,
  classifyOperationError,
  isRetryableFailure,
} from './errors.js';

export const DEFAULT_MAX_ATTEMPTS = 2;
export const MAX_RETRY_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_DELAY_MS = 100;
export const MAX_RETRY_DELAY_MS = 5_000;

export const attemptRecordSchema = z
  .object({
    attempt: z.number().int().positive(),
    outcome: z.enum(['success', 'error']),
    errorKind: z.enum(ERROR_KINDS).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    retryable: z.boolean().optional(),
    delayBeforeNextMs: z.number().int().nonnegative().max(MAX_RETRY_DELAY_MS).optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.outcome === 'success') {
      if (
        record.errorKind !== undefined ||
        record.httpStatus !== undefined ||
        record.retryable !== undefined ||
        record.delayBeforeNextMs !== undefined
      ) {
        ctx.addIssue({ code: 'custom', message: 'successful attempts cannot carry error data' });
      }
      return;
    }
    if (record.errorKind === undefined || record.retryable === undefined) {
      ctx.addIssue({ code: 'custom', message: 'failed attempts require kind and retryability' });
    }
    if (record.errorKind === 'http' && record.httpStatus === undefined) {
      ctx.addIssue({ code: 'custom', message: 'HTTP failures require httpStatus' });
    }
    if (record.errorKind !== 'http' && record.httpStatus !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'only HTTP failures may carry httpStatus' });
    }
    if (
      record.errorKind !== undefined &&
      record.retryable !== undefined &&
      record.retryable !== isRetryableFailure(record.errorKind, record.httpStatus)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'retryable must exactly match the classified retry policy',
      });
    }
    if (record.delayBeforeNextMs !== undefined && !record.retryable) {
      ctx.addIssue({ code: 'custom', message: 'non-retryable attempts cannot schedule a retry' });
    }
  });

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export const attemptLedgerSchema = z
  .array(attemptRecordSchema)
  .min(1)
  .max(MAX_RETRY_ATTEMPTS)
  .superRefine((records, ctx) => {
    records.forEach((record, index) => {
      if (record.attempt !== index + 1) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'attempt'],
          message: 'attempt numbers must be contiguous and one-based',
        });
      }
      const hasNext = index < records.length - 1;
      if (hasNext && (record.outcome !== 'error' || record.delayBeforeNextMs === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'every non-final attempt must be a failed attempt scheduling a retry',
        });
      }
      if (!hasNext && record.delayBeforeNextMs !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'delayBeforeNextMs'],
          message: 'the final attempt cannot schedule another retry',
        });
      }
    });
  });

export interface RetryResult<T> {
  value: T;
  attempts: AttemptRecord[];
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  /** Optional operation budget check; false suppresses a retry without disguising retryability. */
  canRetry?: (delayBeforeNextMs: number) => boolean;
}

export class RetryFailure extends Error {
  readonly attempts: AttemptRecord[];
  readonly originalError: unknown;

  constructor(error: unknown, attempts: AttemptRecord[]) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'RetryFailure';
    this.attempts = attempts;
    this.originalError = error;
  }
}

export function isRetryableError(error: unknown): boolean {
  const detail = classifyOperationError(error);
  return isRetryableFailure(detail.kind, detail.httpStatus);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Run a bounded, classified retry loop and return deterministic attempt audit data. */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = Math.min(options.maxDelayMs ?? MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer from 1 to ${MAX_RETRY_ATTEMPTS}`);
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) {
    throw new Error('baseDelayMs must be a nonnegative integer');
  }
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < 0) {
    throw new Error('maxDelayMs must be a nonnegative integer');
  }

  const attempts: AttemptRecord[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await fn();
      attempts.push({ attempt, outcome: 'success' });
      return { value, attempts };
    } catch (error) {
      const detail = classifyOperationError(error);
      const retryable = isRetryableError(error);
      const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
      const requestedDelay = detail.retryAfterMs ?? exponentialDelay;
      const delayBeforeNextMs = Math.min(maxDelayMs, Math.max(0, Math.ceil(requestedDelay)));
      const hasNext = retryable &&
        attempt < maxAttempts &&
        (options.canRetry?.(delayBeforeNextMs) ?? true);
      attempts.push({
        attempt,
        outcome: 'error',
        errorKind: detail.kind,
        ...(detail.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
        retryable,
        ...(hasNext ? { delayBeforeNextMs } : {}),
      });
      if (!hasNext) throw new RetryFailure(error, attempts);
      await (options.sleep ?? defaultSleep)(delayBeforeNextMs);
    }
  }
  throw new Error('retry loop exhausted without an attempt');
}

/** Compatibility wrapper returning only the operation value. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  return (await runWithRetry(fn, { maxAttempts: retries + 1 })).value;
}
