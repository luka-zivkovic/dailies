import { z } from 'zod';
import { canonicalJson, RubristProtocolError, sha256Digest, type RubristCandidateItem } from './rubrist.js';
import {
  rubristEvaluatorIdentitySchema,
  rubristSkillDigestV2,
  rubristV2CountSchema,
  rubristV2DigestSchema,
  withRubristV2RawGuards,
} from './rubrist-v2.js';

// Rubrist assessment receipt v2 (contracts/assessment-receipt-v2.md), verified
// independently of Rubrist's runtime. Dailies ADR-0008: vendored and verified
// now, consumed by the report formats when Rubrist emits v2.

export const RUBRIST_RECEIPT_V2_CONTRACT = 'rubrist/assessment-receipt/v2';

const identifierSchema = z.string().min(1);

const failureKinds = [
  'provider_rejected_request',
  'provider_unavailable',
  'provider_authentication',
  'provider_rate_limit',
  'provider_timeout',
  'provider_transport',
  'provider_protocol',
  'invalid_evaluator_output',
  'outcome_unknown',
  'internal',
] as const;

const itemSchema = z.object({
  clientItemId: identifierSchema,
  caseId: identifierSchema,
  contentDigest: rubristV2DigestSchema,
  result: z.discriminatedUnion('state', [
    z.object({ state: z.literal('outcome'), outcome: z.enum(['pass', 'fail', 'abstain']) }).strict(),
    z.object({ state: z.literal('failure'), failureKind: z.enum(failureKinds) }).strict(),
    z.object({ state: z.literal('not_attempted') }).strict(),
  ]),
  verdictId: identifierSchema.nullable(),
  evaluatorScore: z.object({
    value: z.number().min(0).max(1),
    kind: z.enum(['native_probability', 'self_reported_score']),
  }).strict().nullable(),
  observed: z.object({
    model: z.string().nullable(),
    requestId: z.string().nullable(),
    responseId: z.string().nullable(),
    systemFingerprint: z.string().nullable(),
    upstreamProvider: z.string().nullable(),
    thinkingReturned: z.boolean().nullable(),
    reasoningTokens: rubristV2CountSchema.nullable(),
  }).strict().nullable(),
}).strict();

const receiptObjectSchema = z.object({
  contract: z.literal(RUBRIST_RECEIPT_V2_CONTRACT),
  schemaVersion: z.literal(2),
  receiptId: identifierSchema,
  evalRunId: identifierSchema,
  projectId: identifierSchema,
  skillId: identifierSchema,
  skillVersionId: identifierSchema,
  status: z.enum(['complete', 'incomplete']),
  run: z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed', 'canceled']),
    totalItems: rubristV2CountSchema,
    passItems: rubristV2CountSchema,
    failItems: rubristV2CountSchema,
    abstainedItems: rubristV2CountSchema,
    failedItems: rubristV2CountSchema,
    notAttemptedItems: rubristV2CountSchema,
    agreedItems: rubristV2CountSchema,
  }).strict(),
  evaluator: rubristEvaluatorIdentitySchema,
  skillDigest: rubristV2DigestSchema,
  datasetDigest: rubristV2DigestSchema,
  items: z.array(itemSchema).min(1),
  evidenceDigest: rubristV2DigestSchema,
}).strict();

export const rubristReceiptV2Schema = withRubristV2RawGuards(receiptObjectSchema, 'assessment receipts');
export type RubristReceiptV2 = z.infer<typeof receiptObjectSchema>;
export type RubristReceiptV2Item = RubristReceiptV2['items'][number];

/** Identities the consumer already holds, such as the suite manifest member's skillDigest. */
export interface RubristReceiptV2Expectations {
  evalRunId?: string | undefined;
  skillVersionId?: string | undefined;
  skillDigest?: string | undefined;
  /** The submitted candidates, for exact coverage and content-digest linkage. */
  candidates?: RubristCandidateItem[] | undefined;
}

export interface RubristReceiptV2Verification {
  status: 'complete' | 'incomplete';
  /** Pass or fail per clientItemId; abstentions, failures, and unattempted items have no label. */
  labels: Map<string, 'pass' | 'fail'>;
}

const byCodeUnit = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function fail(message: string): never {
  throw new RubristProtocolError(`Rubrist receipt v2 ${message}`);
}

function verifyItem(item: RubristReceiptV2Item, receipt: RubristReceiptV2): void {
  const where = `item ${item.clientItemId}`;
  const hasOutcome = item.result.state === 'outcome';
  if (hasOutcome !== (item.verdictId !== null)) fail(`${where}: verdictId must be present exactly for items with an outcome`);
  if (!hasOutcome && item.evaluatorScore !== null) fail(`${where}: evaluatorScore is only recorded with an outcome`);
  const protocol = receipt.evaluator.executionBinding.verdictProtocol;
  const expectedKind = protocol === 'typed-question/v1' ? 'native_probability' : 'self_reported_score';
  if (item.evaluatorScore !== null && item.evaluatorScore.kind !== expectedKind) {
    fail(`${where}: evaluatorScore kind does not match the verdict protocol`);
  }
  if (protocol === 'typed-question/v1' && item.result.state === 'outcome' &&
      (item.result.outcome === 'abstain' || item.evaluatorScore === null)) {
    fail(`${where}: typed-question outcomes are pass or fail with a native probability`);
  }
  if ((item.result.state === 'not_attempted') !== (item.observed === null)) {
    fail(`${where}: observed provenance must be present exactly for attempted items`);
  }
  if (item.observed?.upstreamProvider != null && receipt.evaluator.executionBinding.provider !== 'openrouter') {
    fail(`${where}: upstreamProvider is recorded only for OpenRouter bindings`);
  }
}

/** Every semantic rule of receipt v2, plus candidate linkage when the candidates are supplied. */
export function verifyRubristReceiptV2(
  raw: unknown,
  expected: RubristReceiptV2Expectations = {},
): RubristReceiptV2Verification {
  const parsed = rubristReceiptV2Schema.safeParse(raw);
  if (!parsed.success) fail(`is structurally invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`);
  const receipt = parsed.data;
  const { evidenceDigest: _excluded, ...unsigned } = receipt;
  if (receipt.evidenceDigest !== sha256Digest(unsigned)) fail('evidenceDigest mismatch');
  if (receipt.skillDigest !== rubristSkillDigestV2(receipt.evaluator)) fail('skillDigest mismatch');
  const ids = receipt.items.map((item) => item.clientItemId);
  if (new Set(ids).size !== ids.length) fail('clientItemId values must be unique');
  const sorted = [...ids].sort(byCodeUnit);
  if (ids.some((id, index) => id !== sorted[index])) fail('items are not ordered by clientItemId');
  const datasetDigest = sha256Digest(receipt.items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })));
  if (receipt.datasetDigest !== datasetDigest) fail('datasetDigest mismatch');
  for (const item of receipt.items) verifyItem(item, receipt);

  const outcomes = (outcome: 'pass' | 'fail' | 'abstain') =>
    receipt.items.filter((item) => item.result.state === 'outcome' && item.result.outcome === outcome).length;
  const run = receipt.run;
  if (
    run.totalItems !== receipt.items.length ||
    run.passItems !== outcomes('pass') ||
    run.failItems !== outcomes('fail') ||
    run.abstainedItems !== outcomes('abstain') ||
    run.failedItems !== receipt.items.filter((item) => item.result.state === 'failure').length ||
    run.notAttemptedItems !== receipt.items.filter((item) => item.result.state === 'not_attempted').length ||
    run.agreedItems > run.passItems + run.failItems
  ) {
    fail('run counters are inconsistent with its items');
  }
  const computedComplete = run.status === 'completed' && receipt.items.every((item) => item.result.state === 'outcome');
  if (receipt.status === 'complete' && !computedComplete) fail('claims complete with incomplete run or item evidence');
  if (receipt.status === 'incomplete' && computedComplete) fail('claims incomplete despite complete run and item evidence');

  if (expected.evalRunId !== undefined && receipt.evalRunId !== expected.evalRunId) {
    fail(`evalRunId mismatch: expected ${expected.evalRunId}`);
  }
  if (expected.skillVersionId !== undefined && receipt.skillVersionId !== expected.skillVersionId) {
    fail(`skillVersionId mismatch: expected ${expected.skillVersionId}`);
  }
  if (expected.skillDigest !== undefined && receipt.skillDigest !== expected.skillDigest) {
    fail(`skillDigest does not match the expected evaluator: expected ${expected.skillDigest}`);
  }
  if (expected.candidates !== undefined) {
    const candidates = new Map(expected.candidates.map((candidate) => [candidate.id, candidate]));
    const expectedIds = [...candidates.keys()].sort(byCodeUnit);
    if (ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) {
      fail('does not have exact clientItemId coverage');
    }
    for (const item of receipt.items) {
      const candidate = candidates.get(item.clientItemId)!;
      if (item.contentDigest !== sha256Digest({ input: candidate.input, output: candidate.output })) {
        fail(`contentDigest mismatch for ${item.clientItemId}`);
      }
    }
  }

  const labels = new Map<string, 'pass' | 'fail'>();
  for (const item of receipt.items) {
    if (item.result.state === 'outcome' && item.result.outcome !== 'abstain') labels.set(item.clientItemId, item.result.outcome);
  }
  return { status: receipt.status, labels };
}

/** Parse an exact canonical receipt v2 copy: valid UTF-8, no byte-order mark, canonical JSON, every rule. */
export function parseCanonicalRubristReceiptV2Bytes(
  bytes: Uint8Array,
  expected: RubristReceiptV2Expectations = {},
): { receipt: RubristReceiptV2; verification: RubristReceiptV2Verification } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('bytes are not valid UTF-8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('bytes are not valid JSON');
  }
  const verification = verifyRubristReceiptV2(raw, expected);
  if (canonicalJson(raw) !== text) fail('copy is not exact canonical JSON');
  return { receipt: raw as RubristReceiptV2, verification };
}
