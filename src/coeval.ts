import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CoevalJudgeConfig } from './config.js';
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

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const COEVAL_CLIENT_ITEM_ID_MAX_LENGTH = 240;
export const MAX_COEVAL_EVIDENCE_OPERATIONS = 10_000;
const evalRunStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'canceled']);
const evalRunItemStatusSchema = z.enum(['pending', 'completed', 'failed', 'skipped']);

const requestedModelBindingSchema = z
  .object({
    provider: z.string(),
    modelId: z.string(),
    modelVersion: z.string(),
    temperature: z.number(),
    topP: z.number().optional(),
    baseUrl: z.string().optional(),
  })
  .strict();

const providerMetadataSchema = z
  .object({
    model: z.string().nullable(),
    requestId: z.string().nullable(),
    responseId: z.string().nullable(),
    systemFingerprint: z.string().nullable(),
  })
  .strict();

export const coevalReceiptItemSchema = z
  .object({
    clientItemId: z.string().min(1),
    caseId: z.string().min(1),
    status: evalRunItemStatusSchema,
    judgedLabel: z.enum(['pass', 'fail', 'ambiguous']).nullable(),
    verdictId: z.string().nullable(),
    error: z.string().nullable(),
    contentDigest: digestSchema,
    providerMetadata: providerMetadataSchema,
  })
  .strict();

export const coevalAssessmentReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: z.string().min(1),
    evalRunId: z.string().min(1),
    projectId: z.string().min(1),
    skillId: z.string().min(1),
    skillVersionId: z.string().min(1),
    status: z.enum(['complete', 'incomplete']),
    run: z
      .object({
        status: evalRunStatusSchema,
        totalItems: z.number().int().nonnegative(),
        completedItems: z.number().int().nonnegative(),
        failedItems: z.number().int().nonnegative(),
        agreedItems: z.number().int().nonnegative(),
      })
      .strict(),
    requestedModelBinding: requestedModelBindingSchema,
    skillDigest: digestSchema,
    datasetDigest: digestSchema,
    items: z.array(coevalReceiptItemSchema),
    evidenceDigest: digestSchema,
  })
  .strict();

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

const coevalOperationAttemptsSchema = z
  .array(attemptRecordSchema)
  .max(MAX_RETRY_ATTEMPTS)
  .superRefine((attempts, ctx) => {
    if (attempts.length === 0) return;
    const ledger = attemptLedgerSchema.safeParse(attempts);
    if (!ledger.success) {
      for (const issue of ledger.error.issues) ctx.addIssue(issue);
    }
  });

const coevalOperationTerminationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preflight'), errorKind: z.literal('protocol') }).strict(),
  z.object({ kind: z.literal('deadline'), errorKind: z.literal('timeout') }).strict(),
]);

export const coevalEvidenceOperationSchema = z
  .object({
    phase: z.enum(['submit', 'poll', 'receipt']),
    policy: z.enum(['single_non_idempotent', 'retry_transient']),
    /** Actual provider request attempts; empty only for an explicit local termination. */
    attempts: coevalOperationAttemptsSchema,
    termination: coevalOperationTerminationSchema.optional(),
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

export type CoevalAssessmentReceipt = z.infer<typeof coevalAssessmentReceiptSchema>;
export type CoevalReceiptItem = z.infer<typeof coevalReceiptItemSchema>;
export type CoevalEvidenceOperation = z.infer<typeof coevalEvidenceOperationSchema>;

export interface CoevalCandidateItem {
  id: string;
  input: string;
  output: string;
}

export interface CoevalAssessment {
  /** Eval-run identity returned by the independently recorded batch submission. */
  evalRunId: string;
  receipt: CoevalAssessmentReceipt;
  labels: Map<string, 'pass' | 'fail'>;
  operations: CoevalEvidenceOperation[];
}

export class CoevalProtocolError extends OperationError {
  constructor(message: string) {
    super(message, 'protocol');
    this.name = 'CoevalProtocolError';
  }
}

export class CoevalIncompleteError extends OperationError {
  readonly receipt: CoevalAssessmentReceipt;

  constructor(receipt: CoevalAssessmentReceipt) {
    super('Coeval assessment receipt is structurally valid but incomplete', 'incomplete');
    this.name = 'CoevalIncompleteError';
    this.receipt = receipt;
  }
}

export class CoevalCollectionError extends OperationError {
  readonly operations: CoevalEvidenceOperation[];
  readonly receipt?: CoevalAssessmentReceipt;
  readonly evalRunId?: string;
  readonly originalError: unknown;

  constructor(
    error: unknown,
    operations: CoevalEvidenceOperation[],
    receipt?: CoevalAssessmentReceipt,
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
    this.name = 'CoevalCollectionError';
    this.operations = operations;
    this.receipt = receipt;
    this.evalRunId = evalRunId;
    this.originalError = error;
  }
}

class CoevalOperationFailure extends Error {
  readonly operation: CoevalEvidenceOperation;
  readonly originalError: unknown;

  constructor(error: unknown, operation: CoevalEvidenceOperation) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'CoevalOperationFailure';
    this.operation = operation;
    this.originalError = error;
  }
}

/** Coeval's canonical JSON: recursive lexicographic object keys, stable array order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CoevalProtocolError('canonical JSON rejects non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => entry === undefined ? 'null' : canonicalJson(entry))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new CoevalProtocolError(`canonical JSON does not support ${typeof value}`);
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function apiUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function sameOriginUrl(baseUrl: string, value: string): string {
  const resolved = new URL(value, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (resolved.origin !== new URL(baseUrl).origin) {
    throw new CoevalProtocolError('Coeval pollUrl must have the same origin as judge.url');
  }
  return resolved.toString();
}

async function readJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    throw new CoevalProtocolError(
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
    throw new CoevalProtocolError(
      `${what} does not match receipt v1 contract: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export interface CoevalReceiptVerification {
  status: 'complete' | 'incomplete';
  labels: Map<string, 'pass' | 'fail'>;
}

/** Pure receipt integrity/linkage verification shared by collection and report parsing. */
export function verifyCoevalReceipt(
  raw: unknown,
  receipt: CoevalAssessmentReceipt,
  evalRunId: string,
  skillVersionId: string,
  candidates: CoevalCandidateItem[],
): CoevalReceiptVerification {
  if (receipt.evalRunId !== evalRunId) {
    throw new CoevalProtocolError(`receipt evalRunId mismatch: expected ${evalRunId}`);
  }
  if (receipt.skillVersionId !== skillVersionId) {
    throw new CoevalProtocolError(
      `receipt skillVersionId mismatch: expected pinned ${skillVersionId}`,
    );
  }

  const expectedById = new Map(candidates.map((item) => [item.id, item]));
  if (expectedById.size !== candidates.length) {
    throw new CoevalProtocolError('candidate clientItemId values must be unique');
  }
  const receiptIds = receipt.items.map((item) => item.clientItemId);
  const codeUnitOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const sortedReceiptIds = [...receiptIds].sort(codeUnitOrder);
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new CoevalProtocolError('receipt clientItemId values must be unique');
  }
  if (receiptIds.some((id, index) => id !== sortedReceiptIds[index])) {
    throw new CoevalProtocolError('receipt items are not ordered by clientItemId');
  }
  const expectedIds = [...expectedById.keys()].sort(codeUnitOrder);
  if (
    receiptIds.length !== expectedIds.length ||
    receiptIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new CoevalProtocolError('receipt does not have exact clientItemId coverage');
  }

  for (const item of receipt.items) {
    const candidate = expectedById.get(item.clientItemId);
    if (!candidate) throw new CoevalProtocolError(`unexpected receipt item ${item.clientItemId}`);
    const expectedContentDigest = sha256Digest({ input: candidate.input, output: candidate.output });
    if (item.contentDigest !== expectedContentDigest) {
      throw new CoevalProtocolError(`contentDigest mismatch for ${item.clientItemId}`);
    }
  }

  const expectedDatasetDigest = sha256Digest(
    receipt.items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })),
  );
  if (receipt.datasetDigest !== expectedDatasetDigest) {
    throw new CoevalProtocolError('datasetDigest mismatch');
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CoevalProtocolError('receipt is not an object');
  }
  const { evidenceDigest: _evidenceDigest, ...unsignedReceipt } = raw as Record<string, unknown>;
  const expectedEvidenceDigest = sha256Digest(unsignedReceipt);
  if (receipt.evidenceDigest !== expectedEvidenceDigest) {
    throw new CoevalProtocolError('evidenceDigest mismatch');
  }

  const completedItems = receipt.items.filter((item) => item.status === 'completed').length;
  const failedItems = receipt.items.filter((item) => item.status === 'failed').length;
  if (
    receipt.run.totalItems !== candidates.length ||
    receipt.run.completedItems !== completedItems ||
    receipt.run.failedItems !== failedItems ||
    receipt.run.agreedItems > receipt.run.completedItems
  ) {
    throw new CoevalProtocolError('receipt run counters are inconsistent with its items');
  }

  const labels = new Map<string, 'pass' | 'fail'>();
  const itemsComplete = receipt.items.every((item) => {
    const labelComplete = item.judgedLabel === 'pass' || item.judgedLabel === 'fail';
    if (item.judgedLabel === 'pass' || item.judgedLabel === 'fail') {
      labels.set(item.clientItemId, item.judgedLabel);
    }
    return item.status === 'completed' &&
      labelComplete &&
      item.verdictId !== null &&
      item.error === null;
  });
  const computedComplete = receipt.run.status === 'completed' &&
    receipt.run.completedItems === candidates.length &&
    receipt.run.failedItems === 0 &&
    itemsComplete;
  if (receipt.status === 'complete' && !computedComplete) {
    throw new CoevalProtocolError('receipt claims complete with incomplete run or item evidence');
  }
  if (receipt.status === 'incomplete' && computedComplete) {
    throw new CoevalProtocolError('receipt claims incomplete despite complete run and item evidence');
  }
  return {
    status: receipt.status,
    labels: receipt.status === 'complete' ? labels : new Map(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeEvidenceOperation<T>(
  phase: CoevalEvidenceOperation['phase'],
  policy: CoevalEvidenceOperation['policy'],
  fn: () => Promise<T>,
  options: {
    maxAttempts: number;
    maxDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
    canRetry?: (delayBeforeNextMs: number) => boolean;
  },
): Promise<{ value: T; operation: CoevalEvidenceOperation }> {
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
    throw new CoevalOperationFailure(originalError, { phase, policy, attempts });
  }
}

function collectOperationFailure(
  error: unknown,
  operations: CoevalEvidenceOperation[],
  receipt?: CoevalAssessmentReceipt,
  evalRunId?: string,
): never {
  if (error instanceof CoevalOperationFailure) {
    throw new CoevalCollectionError(
      error.originalError,
      [...operations, error.operation],
      receipt,
      evalRunId,
    );
  }
  throw new CoevalCollectionError(error, operations, receipt, evalRunId);
}

function terminatedEvidenceOperation(
  phase: 'poll' | 'receipt',
  kind: 'preflight' | 'deadline',
): CoevalEvidenceOperation {
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
export async function collectCoevalAssessment(
  judge: CoevalJudgeConfig,
  candidates: CoevalCandidateItem[],
  requestTimeoutMs: number,
): Promise<CoevalAssessment> {
  if (candidates.length === 0) {
    throw new CoevalProtocolError('cannot submit an empty Coeval release-evidence batch');
  }
  const operations: CoevalEvidenceOperation[] = [];
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
          'Coeval batch submit',
        );
        const parsedBatch = protocolParse(
          batchResponseSchema,
          batchRaw,
          'Coeval batch response',
        );
        if (
          parsedBatch.totalItems !== candidates.length ||
          parsedBatch.cachedItems > parsedBatch.totalItems ||
          parsedBatch.skippedItems !== 0
        ) {
          throw new CoevalProtocolError(
            'Coeval batch response counters do not cover every submitted item',
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
      : new CoevalProtocolError(error instanceof Error ? error.message : String(error));
    throw new CoevalCollectionError(
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
        `Coeval polling timed out after ${judge.pollTimeoutMs}ms`,
        'timeout',
      );
      throw new CoevalCollectionError(
        timeout,
        [...operations, terminatedEvidenceOperation('poll', 'deadline')],
        undefined,
        batch.evalRunId,
      );
    }
    if (operations.length >= MAX_COEVAL_EVIDENCE_OPERATIONS - 1) {
      const timeout = new OperationError(
        `Coeval polling exceeded the ${MAX_COEVAL_EVIDENCE_OPERATIONS}-operation evidence limit`,
        'timeout',
      );
      throw new CoevalCollectionError(
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
            'Coeval eval-run poll',
          );
          const parsedPoll = protocolParse(
            pollResponseSchema,
            pollRaw,
            'Coeval eval-run poll response',
          );
          if (parsedPoll.id !== batch.evalRunId) {
            throw new CoevalProtocolError(
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
  let receipt: CoevalAssessmentReceipt;
  let verification: CoevalReceiptVerification;
  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const timeout = new OperationError(
        `Coeval polling timed out before receipt after ${judge.pollTimeoutMs}ms`,
        'timeout',
      );
      throw new CoevalCollectionError(
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
          'Coeval assessment receipt',
        );
        const parsedReceipt = protocolParse(
          coevalAssessmentReceiptSchema,
          receiptRaw,
          'Coeval assessment receipt',
        );
        if (
          terminalPollStatus === undefined ||
          parsedReceipt.run.status !== terminalPollStatus
        ) {
          throw new CoevalProtocolError(
            `receipt run status ${parsedReceipt.run.status} does not match terminal poll ${terminalPollStatus ?? 'missing'}`,
          );
        }
        return {
          receipt: parsedReceipt,
          verification: verifyCoevalReceipt(
            receiptRaw,
            parsedReceipt,
            batch.evalRunId,
            judge.skillVersionId,
            candidates,
          ),
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
    if (error instanceof CoevalCollectionError) throw error;
    collectOperationFailure(error, operations, undefined, batch.evalRunId);
  }
  if (verification.status === 'incomplete') {
    throw new CoevalCollectionError(
      new CoevalIncompleteError(receipt),
      operations,
      receipt,
      batch.evalRunId,
    );
  }
  return { evalRunId: batch.evalRunId, receipt, labels: verification.labels, operations };
}
