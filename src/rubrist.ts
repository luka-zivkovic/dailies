import { z } from 'zod';
import type { RubristJudgeConfig } from './config.js';
import {
  OperationError,
  classifyOperationError,
  httpOperationError,
} from './errors.js';
import { fetchWithTimeout } from './http.js';
import {
  RetryFailure,
  attemptLedgerSchema,
  attemptRecordSchema,
  MAX_RETRY_ATTEMPTS,
  runWithRetry,
  type AttemptRecord,
} from './retry.js';
import { RubristProtocolError } from './rubrist-canonical.js';
import {
  rubristReceiptV2Schema,
  verifyRubristReceiptV2,
  type RubristOutcome,
  type RubristReceiptV2,
  type RubristReceiptV2Verification,
} from './rubrist-receipt-v2.js';

export { RubristProtocolError, canonicalJson, sha256Digest } from './rubrist-canonical.js';

export const RUBRIST_CLIENT_ITEM_ID_MAX_LENGTH = 240;
export const MAX_RUBRIST_EVIDENCE_OPERATIONS = 10_000;
const evalRunStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'canceled']);
const batchResponseSchema = z.object({
  evalRunId: z.string().min(1),
  status: evalRunStatusSchema,
  totalItems: z.number().int().nonnegative(),
  cachedItems: z.number().int().nonnegative(),
  skippedItems: z.number().int().nonnegative(),
  pollUrl: z.string().min(1),
}).passthrough();

const pollResponseSchema = z.object({
  id: z.string().min(1),
  status: evalRunStatusSchema,
}).passthrough();

const rubristOperationAttemptsSchema = z
  .array(attemptRecordSchema)
  .max(MAX_RETRY_ATTEMPTS)
  .superRefine((attempts, ctx) => {
    if (attempts.length === 0) return;
    const ledger = attemptLedgerSchema.safeParse(attempts);
    if (!ledger.success) {
      for (const issue of ledger.error.issues) ctx.addIssue(issue);
    }
  });

const rubristOperationTerminationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preflight'), errorKind: z.literal('protocol') }).strict(),
  z.object({ kind: z.literal('deadline'), errorKind: z.literal('timeout') }).strict(),
]);

export const rubristEvidenceOperationSchema = z
  .object({
    phase: z.enum(['submit', 'poll', 'receipt']),
    policy: z.enum(['single_non_idempotent', 'retry_transient']),
    /** Actual provider request attempts; empty only for an explicit local termination. */
    attempts: rubristOperationAttemptsSchema,
    termination: rubristOperationTerminationSchema.optional(),
    status: z
      .enum(['pending', 'running', 'completed', 'failed', 'canceled', 'complete', 'incomplete'])
      .optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    const expectedPolicy = operation.phase === 'submit'
      ? 'single_non_idempotent'
      : 'retry_transient';
    if (operation.policy !== expectedPolicy) {
      ctx.addIssue({ code: 'custom', message: `${operation.phase} requires ${expectedPolicy}` });
    }
    if (
      operation.phase === 'submit' &&
      (operation.attempts.length !== 1 || operation.termination !== undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'submit is intentionally single-attempt' });
    }
    if (operation.attempts.length === 0 && operation.termination === undefined) {
      ctx.addIssue({ code: 'custom', message: 'zero-request operations require a termination' });
    }
    if (operation.attempts.length > 0 && operation.termination !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'request attempts and local termination are exclusive' });
    }
    const finalOutcome = operation.attempts.at(-1)?.outcome;
    if (finalOutcome === 'success' && operation.status === undefined) {
      ctx.addIssue({ code: 'custom', message: 'successful operations require a result status' });
    }
    if (finalOutcome === 'error' && operation.status !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'failed operations cannot carry a result status' });
    }
    if (operation.termination !== undefined && operation.status !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'terminated operations cannot carry a result status' });
    }
    const receiptStatus = operation.status === 'complete' || operation.status === 'incomplete';
    if (operation.phase === 'receipt' && operation.status !== undefined && !receiptStatus) {
      ctx.addIssue({ code: 'custom', message: 'receipt status must be complete or incomplete' });
    }
    if (operation.phase !== 'receipt' && receiptStatus) {
      ctx.addIssue({ code: 'custom', message: 'only receipt operations may use receipt statuses' });
    }
  });

export type RubristEvidenceOperation = z.infer<typeof rubristEvidenceOperationSchema>;

export interface RubristCandidateItem {
  id: string;
  input: string;
  output: string;
}

export interface RubristAssessment {
  /** Eval-run identity returned by the independently recorded batch submission. */
  evalRunId: string;
  receipt: RubristReceiptV2;
  /** Every item's verified outcome; collection returns only complete receipts. */
  outcomes: Map<string, RubristOutcome>;
  operations: RubristEvidenceOperation[];
}

export class RubristIncompleteError extends OperationError {
  readonly receipt: RubristReceiptV2;

  constructor(receipt: RubristReceiptV2) {
    super('Rubrist assessment receipt is structurally valid but incomplete', 'incomplete');
    this.name = 'RubristIncompleteError';
    this.receipt = receipt;
  }
}

export class RubristCollectionError extends OperationError {
  readonly operations: RubristEvidenceOperation[];
  readonly receipt?: RubristReceiptV2;
  readonly evalRunId?: string;
  readonly originalError: unknown;

  constructor(
    error: unknown,
    operations: RubristEvidenceOperation[],
    receipt?: RubristReceiptV2,
    evalRunId?: string,
  ) {
    const detail = classifyOperationError(error);
    super(
      error instanceof Error ? error.message : String(error),
      detail.kind,
      {
        ...(detail.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
        ...(detail.retryAfterMs === undefined ? {} : { retryAfterMs: detail.retryAfterMs }),
        cause: error,
      },
    );
    this.name = 'RubristCollectionError';
    this.operations = operations;
    this.receipt = receipt;
    this.evalRunId = evalRunId;
    this.originalError = error;
  }
}

class RubristOperationFailure extends Error {
  readonly operation: RubristEvidenceOperation;
  readonly originalError: unknown;

  constructor(error: unknown, operation: RubristEvidenceOperation) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'RubristOperationFailure';
    this.operation = operation;
    this.originalError = error;
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function sameOriginUrl(baseUrl: string, value: string): string {
  const resolved = new URL(value, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (resolved.origin !== new URL(baseUrl).origin) {
    throw new RubristProtocolError('Rubrist pollUrl must have the same origin as judge.url');
  }
  return resolved.toString();
}

async function readJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    throw new RubristProtocolError(
      `${what} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<unknown> {
  const res = await fetchWithTimeout(url, init, timeoutMs, what);
  if (!res.ok) throw httpOperationError(what, url, res);
  return readJson(res, what);
}

function protocolParse<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RubristProtocolError(
      `${what} does not match the Rubrist contract: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeEvidenceOperation<T>(
  phase: RubristEvidenceOperation['phase'],
  policy: RubristEvidenceOperation['policy'],
  fn: () => Promise<T>,
  options: {
    maxAttempts: number;
    maxDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
    canRetry?: (delayBeforeNextMs: number) => boolean;
  },
): Promise<{ value: T; operation: RubristEvidenceOperation }> {
  try {
    const result = await runWithRetry(fn, options);
    return {
      value: result.value,
      operation: { phase, policy, attempts: result.attempts },
    };
  } catch (error) {
    const retryFailure = error instanceof RetryFailure ? error : undefined;
    const originalError = retryFailure?.originalError ?? error;
    const detail = classifyOperationError(originalError);
    const attempts: AttemptRecord[] = retryFailure?.attempts ?? [{
      attempt: 1,
      outcome: 'error',
      errorKind: detail.kind,
      ...(detail.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
      retryable: false,
    }];
    throw new RubristOperationFailure(originalError, { phase, policy, attempts });
  }
}

function collectOperationFailure(
  error: unknown,
  operations: RubristEvidenceOperation[],
  receipt?: RubristReceiptV2,
  evalRunId?: string,
): never {
  if (error instanceof RubristOperationFailure) {
    throw new RubristCollectionError(
      error.originalError,
      [...operations, error.operation],
      receipt,
      evalRunId,
    );
  }
  throw new RubristCollectionError(error, operations, receipt, evalRunId);
}

function terminatedEvidenceOperation(
  phase: 'poll' | 'receipt',
  kind: 'preflight' | 'deadline',
): RubristEvidenceOperation {
  return {
    phase,
    policy: 'retry_transient',
    attempts: [],
    termination: kind === 'preflight'
      ? { kind, errorKind: 'protocol' }
      : { kind, errorKind: 'timeout' },
  };
}

/** Submit one release-evidence batch, wait for it, then verify its receipt independently. */
export async function collectRubristAssessment(
  judge: RubristJudgeConfig,
  candidates: RubristCandidateItem[],
  requestTimeoutMs: number,
): Promise<RubristAssessment> {
  if (candidates.length === 0) {
    throw new RubristProtocolError('cannot submit an empty Rubrist release-evidence batch');
  }
  const operations: RubristEvidenceOperation[] = [];
  const headers = { ...judge.headers, 'content-type': 'application/json' };
  const batchUrl = apiUrl(judge.url, '/api/v1/judge/batch');
  let batch: z.infer<typeof batchResponseSchema>;
  try {
    const submitted = await executeEvidenceOperation(
      'submit',
      'single_non_idempotent',
      async () => {
        const batchRaw = await requestJson(
          batchUrl,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              purpose: 'release_evidence',
              skillVersionId: judge.skillVersionId,
              items: candidates.map((item) => ({
                clientItemId: item.id,
                input: item.input,
                output: item.output,
              })),
            }),
          },
          requestTimeoutMs,
          'Rubrist batch submit',
        );
        const parsedBatch = protocolParse(
          batchResponseSchema,
          batchRaw,
          'Rubrist batch response',
        );
        if (
          parsedBatch.totalItems !== candidates.length ||
          parsedBatch.cachedItems > parsedBatch.totalItems ||
          parsedBatch.skippedItems !== 0
        ) {
          throw new RubristProtocolError(
            'Rubrist batch response counters do not cover every submitted item',
          );
        }
        return parsedBatch;
      },
      { maxAttempts: 1 },
    );
    batch = submitted.value;
    operations.push({ ...submitted.operation, status: batch.status });
  } catch (error) {
    collectOperationFailure(error, operations);
  }
  let pollUrl: string;
  try {
    pollUrl = sameOriginUrl(judge.url, batch.pollUrl);
  } catch (error) {
    const typed = error instanceof OperationError
      ? error
      : new RubristProtocolError(error instanceof Error ? error.message : String(error));
    throw new RubristCollectionError(
      typed,
      [...operations, terminatedEvidenceOperation('poll', 'preflight')],
      undefined,
      batch.evalRunId,
    );
  }
  const deadline = Date.now() + judge.pollTimeoutMs;
  let terminalPollStatus: z.infer<typeof pollResponseSchema>['status'] | undefined;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const timeout = new OperationError(
        `Rubrist polling timed out after ${judge.pollTimeoutMs}ms`,
        'timeout',
      );
      throw new RubristCollectionError(
        timeout,
        [...operations, terminatedEvidenceOperation('poll', 'deadline')],
        undefined,
        batch.evalRunId,
      );
    }
    if (operations.length >= MAX_RUBRIST_EVIDENCE_OPERATIONS - 1) {
      const timeout = new OperationError(
        `Rubrist polling exceeded the ${MAX_RUBRIST_EVIDENCE_OPERATIONS}-operation evidence limit`,
        'timeout',
      );
      throw new RubristCollectionError(
        timeout,
        [...operations, terminatedEvidenceOperation('poll', 'deadline')],
        undefined,
        batch.evalRunId,
      );
    }
    let poll: z.infer<typeof pollResponseSchema>;
    try {
      const polled = await executeEvidenceOperation(
        'poll',
        'retry_transient',
        async () => {
          const attemptRemainingMs = Math.max(0, deadline - Date.now());
          const pollRaw = await requestJson(
            pollUrl,
            { method: 'GET', headers: judge.headers },
            Math.min(requestTimeoutMs, attemptRemainingMs),
            'Rubrist eval-run poll',
          );
          const parsedPoll = protocolParse(
            pollResponseSchema,
            pollRaw,
            'Rubrist eval-run poll response',
          );
          if (parsedPoll.id !== batch.evalRunId) {
            throw new RubristProtocolError(
              `poll evalRunId mismatch: expected ${batch.evalRunId}`,
            );
          }
          return parsedPoll;
        },
        {
          maxAttempts: 2,
          maxDelayMs: Math.min(5_000, remainingMs),
          canRetry: (delayMs) => Date.now() + delayMs < deadline,
          sleep: async (delayMs) => {
            await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
          },
        },
      );
      poll = polled.value;
      operations.push({ ...polled.operation, status: poll.status });
    } catch (error) {
      collectOperationFailure(error, operations, undefined, batch.evalRunId);
    }
    if (poll.status === 'completed' || poll.status === 'failed' || poll.status === 'canceled') {
      terminalPollStatus = poll.status;
      break;
    }
    await sleep(Math.min(judge.pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  const receiptUrl = apiUrl(
    judge.url,
    `/api/v1/eval-runs/${encodeURIComponent(batch.evalRunId)}/assessment-receipt`,
  );
  let receipt: RubristReceiptV2;
  let verification: RubristReceiptV2Verification;
  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const timeout = new OperationError(
        `Rubrist polling timed out before receipt after ${judge.pollTimeoutMs}ms`,
        'timeout',
      );
      throw new RubristCollectionError(
        timeout,
        [...operations, terminatedEvidenceOperation('receipt', 'deadline')],
        undefined,
        batch.evalRunId,
      );
    }
    const received = await executeEvidenceOperation(
      'receipt',
        'retry_transient',
        async () => {
          const attemptRemainingMs = Math.max(0, deadline - Date.now());
          const receiptRaw = await requestJson(
          receiptUrl,
          { method: 'GET', headers: judge.headers },
          Math.min(requestTimeoutMs, attemptRemainingMs),
          'Rubrist assessment receipt',
        );
        const parsedReceipt = protocolParse(
          rubristReceiptV2Schema,
          receiptRaw,
          'Rubrist assessment receipt',
        );
        if (
          terminalPollStatus === undefined ||
          parsedReceipt.run.status !== terminalPollStatus
        ) {
          throw new RubristProtocolError(
            `receipt run status ${parsedReceipt.run.status} does not match terminal poll ${terminalPollStatus ?? 'missing'}`,
          );
        }
        return {
          receipt: parsedReceipt,
          verification: verifyRubristReceiptV2(receiptRaw, {
            evalRunId: batch.evalRunId,
            skillVersionId: judge.skillVersionId,
            candidates,
          }),
        };
      },
      {
        maxAttempts: 2,
        maxDelayMs: Math.min(5_000, Math.max(0, remainingMs)),
        canRetry: (delayMs) => Date.now() + delayMs < deadline,
        sleep: async (delayMs) => {
          await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
        },
      },
    );
    receipt = received.value.receipt;
    verification = received.value.verification;
    operations.push({ ...received.operation, status: receipt.status });
  } catch (error) {
    if (error instanceof RubristCollectionError) throw error;
    collectOperationFailure(error, operations, undefined, batch.evalRunId);
  }
  if (verification.status === 'incomplete') {
    throw new RubristCollectionError(
      new RubristIncompleteError(receipt),
      operations,
      receipt,
      batch.evalRunId,
    );
  }
  return { evalRunId: batch.evalRunId, receipt, outcomes: verification.outcomes, operations };
}
