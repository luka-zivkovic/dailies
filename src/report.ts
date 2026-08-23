import { z } from 'zod';
import {
  coevalAssessmentReceiptSchema,
  coevalEvidenceOperationSchema,
  verifyCoevalReceipt,
} from './coeval.js';
import {
  scopeConfigSchema,
  scopeKindSchema,
  timeWindowSchema,
  trustClassSchema,
  trustPolicySchema,
  type ScopeConfig,
  type TrustClass,
} from './config.js';
import { ERROR_KINDS, type ErrorKind } from './errors.js';
import { judgeResultSchema } from './judge.js';
import { attemptLedgerSchema } from './retry.js';
import {
  reportV5Schema,
  SUITE_REPORT_SCHEMA_VERSION,
  type SuiteReport,
} from './report-v5.js';
import {
  CALIBRATION_REPORT_SCHEMA_VERSION,
  reportV6Schema,
  type CalibrationSuiteReport,
} from './report-v6.js';

export const LEGACY_REPORT_SCHEMA_VERSION = 3;
export const REPORT_SCHEMA_VERSION = 4;

export const itemOutcomeSchema = z.enum(['pass', 'fail', 'error']);
export const comparisonSchema = z.enum([
  'regression',
  'improvement',
  'stable_pass',
  'stable_fail',
  'unpaired',
]);
export const errorStageSchema = z.enum(['candidate', 'judge']);
export const errorKindSchema = z.enum(ERROR_KINDS);

export function compareOutcome(
  baselineLabel: 'pass' | 'fail' | undefined,
  outcome: 'pass' | 'fail' | 'error',
): z.infer<typeof comparisonSchema> {
  if (baselineLabel === undefined || outcome === 'error') return 'unpaired';
  if (baselineLabel === 'pass') return outcome === 'pass' ? 'stable_pass' : 'regression';
  return outcome === 'pass' ? 'improvement' : 'stable_fail';
}

const itemResultFields = {
  id: z.string(),
  input: z.string(),
  baseline_label: z.enum(['pass', 'fail']).optional(),
  baseline_output: z.string().optional(),
  candidate_output: z.string().optional(),
  judge: judgeResultSchema.optional(),
  /** Set when the candidate or judge failed after retry; the item counts as a failure. */
  error: z.string().optional(),
  /** Machine-readable outcome. Errors mean the item was not fully evaluated. */
  outcome: itemOutcomeSchema,
  /** Stage that prevented the item from being fully evaluated. Present only for errors. */
  errorStage: errorStageSchema.optional(),
  /** Coarse machine-readable error classification. Present only for errors. */
  errorKind: errorKindSchema.optional(),
  pass: z.boolean(),
  /** Candidate quality relative to an explicit historical label. */
  comparison: comparisonSchema,
  /** Compatibility projection; true iff comparison is regression. */
  regression: z.boolean(),
  /** Ordered, timestamp-free operation attempts for deterministic retry auditing. */
  attempts: z.object({
    candidate: attemptLedgerSchema,
    judge: attemptLedgerSchema.optional(),
  }).strict(),
};

const itemResultBaseSchema = z.object(itemResultFields).strict();
// V3 used Zod's default object behavior for judge payloads. Keep that exact
// inspection behavior even though current HTTP responses are strict.
const judgeResultV3Schema = z.object({
  score: z.number(),
  pass: z.boolean(),
  reason: z.string().optional(),
});
const itemResultV3BaseSchema = z.object({
  ...itemResultFields,
  judge: judgeResultV3Schema.optional(),
}).strict();

function refineItemResult(
  item: z.infer<typeof itemResultBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  const expectedComparison = compareOutcome(item.baseline_label, item.outcome);
  if (item.comparison !== expectedComparison) {
    ctx.addIssue({ code: 'custom', message: `comparison must be ${expectedComparison}` });
  }
  if (item.regression !== (item.comparison === 'regression')) {
    ctx.addIssue({ code: 'custom', message: 'regression must agree with comparison' });
  }
  const candidateFinal = item.attempts.candidate.at(-1);
  const judgeFinal = item.attempts.judge?.at(-1);
  if (item.outcome === 'error') {
    if (item.error === undefined || item.errorStage === undefined || item.errorKind === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'errored items require error, errorStage, and errorKind',
      });
    }
    if (item.pass) {
      ctx.addIssue({ code: 'custom', message: 'errored items cannot pass' });
    }
    if (item.regression) {
      ctx.addIssue({ code: 'custom', message: 'unevaluated errors cannot be regressions' });
    }
    if (item.judge !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'errored items cannot carry a completed judge result' });
    }
    if (item.errorStage === 'candidate' && item.attempts.judge !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'candidate failures cannot have judge attempts' });
    }
    if (item.errorStage === 'candidate' && item.candidate_output !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'candidate failures cannot carry candidate_output' });
    }
    if (item.errorStage === 'candidate' && candidateFinal?.outcome !== 'error') {
      ctx.addIssue({ code: 'custom', message: 'candidate failure requires a final failed attempt' });
    }
    if (
      item.errorStage === 'candidate' &&
      candidateFinal?.errorKind !== item.errorKind
    ) {
      ctx.addIssue({ code: 'custom', message: 'candidate errorKind must match final attempt' });
    }
    if (item.errorStage === 'judge' && item.candidate_output === undefined) {
      ctx.addIssue({ code: 'custom', message: 'judge failures require candidate_output' });
    }
    if (item.errorStage === 'judge' && (
      candidateFinal?.outcome !== 'success' ||
      (judgeFinal !== undefined && judgeFinal.outcome !== 'error')
    )) {
      ctx.addIssue({ code: 'custom', message: 'judge failure requires candidate success and any judge ledger to end failed' });
    }
    if (
      item.errorStage === 'judge' &&
      judgeFinal !== undefined &&
      judgeFinal.errorKind !== item.errorKind
    ) {
      ctx.addIssue({ code: 'custom', message: 'judge errorKind must match final attempt' });
    }
    return;
  }

  if (item.error !== undefined || item.errorStage !== undefined || item.errorKind !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'completed items cannot carry error fields' });
  }
  if ((item.outcome === 'pass') !== item.pass) {
    ctx.addIssue({ code: 'custom', message: 'outcome and pass must agree' });
  }
  if (item.candidate_output === undefined || item.judge === undefined) {
    ctx.addIssue({ code: 'custom', message: 'completed items require candidate and judge output' });
  } else if (item.judge.pass !== item.pass) {
    ctx.addIssue({ code: 'custom', message: 'judge pass must agree with item outcome' });
  }
  if (
    candidateFinal?.outcome !== 'success' ||
    (judgeFinal !== undefined && judgeFinal.outcome !== 'success')
  ) {
    ctx.addIssue({ code: 'custom', message: 'completed items require candidate success and any judge ledger to end successful' });
  }
}

/** Frozen v3 item contract, available only for historical inspection. */
export const itemResultV3Schema = itemResultV3BaseSchema.superRefine(refineItemResult);

/** Current v4 item contract. Trust is attached only to completed evidence. */
export const itemResultSchema = itemResultBaseSchema.extend({
  trustClass: trustClassSchema.optional(),
}).strict().superRefine(refineItemResult);

const thresholdsSchema = z.object({
  minPassRate: z.number().min(0).max(1),
  maxRegressions: z.number().int().nonnegative(),
}).strict();

const totalsSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Subset of `failed` where the candidate or judge errored after retry. */
  errored: z.number().int().nonnegative(),
  /** Required candidate executions that failed before judging. */
  candidateErrored: z.number().int().nonnegative(),
  /** Judge executions that failed, leaving release evidence unknown. */
  judgeErrored: z.number().int().nonnegative(),
  /** Protocol errors at either stage; these indicate a broken evidence contract. */
  protocolErrored: z.number().int().nonnegative(),
  /** Items that received a completed judge result (pass or fail). */
  evaluated: z.number().int().nonnegative(),
  /** Fraction of all items that received a completed judge result. */
  evaluationCoverage: z.number().min(0).max(1),
  passRate: z.number().min(0).max(1),
  regressions: z.number().int().nonnegative(),
  comparisonCounts: z.object({
    regression: z.number().int().nonnegative(),
    improvement: z.number().int().nonnegative(),
    stable_pass: z.number().int().nonnegative(),
    stable_fail: z.number().int().nonnegative(),
    unpaired: z.number().int().nonnegative(),
  }).strict(),
  /** True when every item errored. */
  allErrored: z.boolean(),
}).strict();

const coevalEvidenceSchema = z.object({
  provider: z.literal('coeval'),
  /** Dailies-owned pinned judge identity, checked against any retained receipt. */
  skillVersionId: z.string().min(1),
  /** Eval run returned by the batch submit, independent of any retained receipt. */
  evalRunId: z.string().min(1).optional(),
  status: z.enum(['complete', 'incomplete', 'failed']),
  operations: z.array(coevalEvidenceOperationSchema).min(1).max(10_000),
  receipt: coevalAssessmentReceiptSchema.optional(),
}).strict();

const commonReportFields = {
  judgeType: z.enum(['exact-match', 'http', 'coeval']),
  startedAt: z.string(),
  finishedAt: z.string(),
  thresholds: thresholdsSchema,
  totals: totalsSchema,
  evidence: coevalEvidenceSchema.optional(),
};

const reportV3ShapeSchema = z.object({
  schemaVersion: z.literal(LEGACY_REPORT_SCHEMA_VERSION),
  ...commonReportFields,
  verdict: z.enum(['promote', 'block', 'inconclusive']),
  items: z.array(itemResultV3Schema),
}).strict();

export const reportV3Schema = reportV3ShapeSchema.superRefine((report, ctx) => {
  const expectedTotals = aggregate(report.items);
  if (JSON.stringify(report.totals) !== JSON.stringify(expectedTotals)) {
    ctx.addIssue({
      code: 'custom',
      path: ['totals'],
      message: 'totals must exactly equal aggregate(items)',
    });
  }
  const expectedVerdict = decideVerdict(expectedTotals, report.thresholds);
  if (report.verdict !== expectedVerdict) {
    ctx.addIssue({
      code: 'custom',
      path: ['verdict'],
      message: `verdict must be ${expectedVerdict}`,
    });
  }

  const evidence = report.evidence;
  const itemsNeedingJudgeEvidence = report.items.filter(
    (item) => item.outcome !== 'error' || item.errorStage === 'judge',
  );
  if (report.judgeType === 'coeval') {
    if (report.items.some((item) => item.attempts.judge !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Coeval items cannot fabricate per-item judge attempts; use evidence.operations',
      });
    }
  } else if (itemsNeedingJudgeEvidence.some((item) => item.attempts.judge === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['items'],
      message: 'non-Coeval completed and judge-error items require judge attempts',
    });
  }
  const submittedItems = report.items.filter(
    (item) => item.attempts.candidate.at(-1)?.outcome === 'success',
  );
  if (report.judgeType !== 'coeval') {
    if (evidence !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'non-Coeval reports cannot carry Coeval evidence',
      });
    }
    return;
  }
  if (submittedItems.length > 0 && evidence === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'Coeval reports with submitted candidates require evidence audit',
    });
    return;
  }
  if (submittedItems.length === 0) {
    if (evidence !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'all-candidate-failure Coeval reports cannot carry provider operations',
      });
    }
    return;
  }
  if (evidence === undefined) return;
  const operationFailed = (operation: (typeof evidence.operations)[number]) =>
    operation.termination !== undefined ||
    operation.attempts.at(-1)?.outcome === 'error';
  const operationErrorKind = (operation: (typeof evidence.operations)[number]) =>
    operation.termination?.errorKind ?? operation.attempts.at(-1)?.errorKind;
  const phases = evidence.operations.map((operation) => operation.phase);
  if (phases[0] !== 'submit' || phases.filter((phase) => phase === 'submit').length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'operations'],
      message: 'Coeval operations must start with exactly one submit',
    });
  }
  const firstReceipt = phases.indexOf('receipt');
  if (
    phases.some((phase, index) => (
      (index > 0 && phase === 'submit') ||
      (firstReceipt >= 0 && index > firstReceipt)
    )) ||
    phases.filter((phase) => phase === 'receipt').length > 1 ||
    (firstReceipt >= 0 && !phases.slice(1, firstReceipt).includes('poll'))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'operations'],
      message: 'Coeval operations must be submit, polls, then at most one receipt',
    });
  }
  const failedOperationIndex = evidence.operations.findIndex(operationFailed);
  if (failedOperationIndex >= 0 && failedOperationIndex !== evidence.operations.length - 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'operations'],
      message: 'a failed Coeval operation must terminate collection',
    });
  }
  const submitSucceeded = evidence.operations[0]?.attempts.at(-1)?.outcome === 'success';
  if (submitSucceeded !== (evidence.evalRunId !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'evalRunId'],
      message: 'evalRunId must exist exactly when batch submission succeeded',
    });
  }

  if (evidence.receipt === undefined) {
    if (evidence.status !== 'failed') {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence', 'status'],
        message: 'receipt-less evidence must be failed',
      });
    }
    const finalEvidenceOperation = evidence.operations.at(-1);
    if (finalEvidenceOperation === undefined || !operationFailed(finalEvidenceOperation)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence', 'operations'],
        message: 'receipt-less failed evidence must end in a failed operation',
      });
    }
    const expectedItemKind = finalEvidenceOperation !== undefined &&
      operationErrorKind(finalEvidenceOperation) === 'protocol'
      ? 'protocol'
      : 'incomplete';
    if (submittedItems.some(
      (item) =>
        item.outcome !== 'error' ||
        item.errorStage !== 'judge' ||
        item.errorKind !== expectedItemKind,
    )) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'failed Coeval collection must match every submitted item judge error',
      });
    }
    return;
  }
  if (evidence.status !== evidence.receipt.status) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'status'],
      message: 'evidence status must match retained receipt status',
    });
  }
  const receiptOperation = evidence.operations.at(-1);
  const pollOperations = evidence.operations.filter((operation) => operation.phase === 'poll');
  const lastPoll = pollOperations.at(-1);
  if (
    receiptOperation?.phase !== 'receipt' ||
    receiptOperation.status !== evidence.receipt.status ||
    lastPoll === undefined ||
    lastPoll.status !== evidence.receipt.run.status ||
    !['completed', 'failed', 'canceled'].includes(lastPoll.status ?? '')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'operations'],
      message: 'retained receipt requires a matching final receipt operation',
    });
  }
  if (pollOperations.slice(0, -1).some(
    (operation) => operation.status !== 'pending' && operation.status !== 'running',
  )) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'operations'],
      message: 'collection cannot poll again after a terminal eval-run status',
    });
  }

  const candidates = submittedItems.map((item) => ({
    id: item.id,
    input: item.input,
    output: item.candidate_output ?? '',
  }));
  if (submittedItems.some((item) => item.candidate_output === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['items'],
      message: 'Coeval-submitted items require candidate_output',
    });
    return;
  }
  if (evidence.evalRunId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'evalRunId'],
      message: 'retained receipt requires submitted evalRunId identity',
    });
    return;
  }
  try {
    const verification = verifyCoevalReceipt(
      evidence.receipt,
      evidence.receipt,
      evidence.evalRunId,
      evidence.skillVersionId,
      candidates,
    );
    if (verification.status !== evidence.status) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence', 'status'],
        message: 'evidence status disagrees with receipt verification',
      });
    }
    if (verification.status === 'complete') {
      for (const item of submittedItems) {
        const label = verification.labels.get(item.id);
        if (
          label === undefined ||
          item.outcome !== label ||
          item.judge?.pass !== (label === 'pass')
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['items'],
            message: `report outcome does not match Coeval receipt for ${item.id}`,
          });
        }
      }
    } else if (submittedItems.some(
      (item) =>
        item.outcome !== 'error' ||
        item.errorStage !== 'judge' ||
        item.errorKind !== 'incomplete',
    )) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'incomplete Coeval receipt requires incomplete judge errors',
      });
    }
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence', 'receipt'],
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export const reportTrustPolicySchema = z.object({
  admissibleClasses: z.array(trustClassSchema).min(1),
  selfReportedOverride: z.object({
    reason: z.string().min(1).refine((value) => value.trim().length > 0),
  }).strict().optional(),
}).strict().superRefine((policy, ctx) => {
  const parsed = trustPolicySchema.safeParse(policy);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: issue.path });
    }
  }
});

export const reportScopeSchema = z.object({
  id: z.string().min(1).refine((value) => value.trim().length > 0),
  kind: scopeKindSchema,
  collectionProcedure: z.string().min(1).refine((value) => value.trim().length > 0),
  population: z.string().min(1).refine((value) => value.trim().length > 0),
  timeWindow: timeWindowSchema,
  inputArtifact: z.object({
    type: z.literal('jsonl'),
    /** Digest observed from the one byte snapshot that was parsed. */
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** Customer-declared digest retained separately so drift is detectable. */
    declaredDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    byteLength: z.number().int().nonnegative(),
    itemCount: z.number().int().positive(),
  }).strict(),
  coverage: z.object({
    expectedItems: z.number().int().positive(),
    observedItems: z.number().int().nonnegative(),
    evaluatedItems: z.number().int().nonnegative(),
  }).strict(),
  producerProvenance: z.object({
    datasetRevision: z.literal('not_provided'),
    exposure: z.literal('not_provided'),
    review: z.literal('not_provided'),
  }).strict(),
}).strict().superRefine((scope, ctx) => {
  const declared: ScopeConfig = {
    id: scope.id,
    kind: scope.kind,
    expectedItems: scope.coverage.expectedItems,
    collectionProcedure: scope.collectionProcedure,
    population: scope.population,
    timeWindow: scope.timeWindow,
  };
  const parsed = scopeConfigSchema.safeParse(declared);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: issue.path });
    }
  }
});

const trustDerivationSchema = z.enum([
  'exact_match_v1',
  'coeval_receipt_v1',
  'http_judge_v1',
]);

const trustSummarySchema = z.discriminatedUnion('status', [z.object({
  status: z.literal('complete'),
  class: trustClassSchema,
  derivation: trustDerivationSchema,
  admissible: z.boolean(),
}).strict(), z.object({
  status: z.literal('unavailable'),
  derivation: trustDerivationSchema,
  admissible: z.literal(false),
  reason: z.literal('no_completed_evidence'),
}).strict()]);

const reportV4ShapeSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  ...commonReportFields,
  scope: reportScopeSchema,
  trustPolicy: reportTrustPolicySchema,
  trust: trustSummarySchema,
  decision: z.enum(['promote', 'block', 'inconclusive']),
  decisionStatement: z.string().min(1),
  items: z.array(itemResultSchema),
}).strict();

function expectedTrust(judgeType: 'exact-match' | 'http' | 'coeval'): {
  class: TrustClass;
  derivation: 'exact_match_v1' | 'coeval_receipt_v1' | 'http_judge_v1';
} {
  if (judgeType === 'exact-match') {
    return { class: 'deterministic', derivation: 'exact_match_v1' };
  }
  if (judgeType === 'coeval') {
    return { class: 'verified', derivation: 'coeval_receipt_v1' };
  }
  return { class: 'self_reported', derivation: 'http_judge_v1' };
}

export const reportSchema = reportV4ShapeSchema.superRefine((report, ctx) => {
  // Reuse the frozen v3 integrity and Coeval-linkage contract without allowing
  // the v4 trust fields to mutate its semantics.
  const legacyItems = report.items.map(({ trustClass: _trustClass, ...item }) => item);
  const legacyCandidate = {
    schemaVersion: LEGACY_REPORT_SCHEMA_VERSION,
    judgeType: report.judgeType,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    thresholds: report.thresholds,
    totals: report.totals,
    verdict: decideVerdict(report.totals, report.thresholds),
    ...(report.evidence === undefined ? {} : { evidence: report.evidence }),
    items: legacyItems,
  };
  const legacy = reportV3Schema.safeParse(legacyCandidate);
  if (!legacy.success) {
    for (const issue of legacy.error.issues) {
      ctx.addIssue({ ...issue, path: issue.path });
    }
  }

  const expected = expectedTrust(report.judgeType);
  const hasCompletedEvidence = report.totals.evaluated > 0;
  if (report.trust.derivation !== expected.derivation) {
    ctx.addIssue({
      code: 'custom',
      path: ['trust'],
      message: `trust path must be derived as ${expected.derivation}`,
    });
  }
  const policyAdmissible = report.trustPolicy.admissibleClasses.includes(expected.class);
  if (hasCompletedEvidence) {
    if (
      report.trust.status !== 'complete' ||
      report.trust.class !== expected.class ||
      report.trust.admissible !== policyAdmissible
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['trust'],
        message: `completed evidence trust must be ${expected.class} with admissibility ${policyAdmissible}`,
      });
    }
  } else if (
    report.trust.status !== 'unavailable' ||
    report.trust.admissible !== false ||
    report.trust.reason !== 'no_completed_evidence'
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['trust'],
      message: 'a report with no completed evidence must retain unavailable trust',
    });
  }

  for (const [index, item] of report.items.entries()) {
    const expectedItemTrust = item.outcome === 'error' ? undefined : expected.class;
    if (item.trustClass !== expectedItemTrust) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', index, 'trustClass'],
        message: item.outcome === 'error'
          ? 'errored items cannot carry a trust class'
          : `completed items require ${expected.class} trust`,
      });
    }
  }

  if (report.judgeType === 'exact-match') {
    for (const [index, item] of report.items.entries()) {
      if (item.outcome === 'error') {
        if (item.errorStage === 'judge') {
          ctx.addIssue({
            code: 'custom',
            path: ['items', index],
            message: 'exact_match_v1 cannot produce a judge-stage error',
          });
        }
        continue;
      }
      const expectedPass =
        item.baseline_output !== undefined &&
        item.candidate_output === item.baseline_output;
      const expectedReason = expectedPass
        ? undefined
        : 'candidate output does not exactly match baseline output';
      if (
        item.baseline_output === undefined ||
        item.pass !== expectedPass ||
        item.outcome !== (expectedPass ? 'pass' : 'fail') ||
        item.judge?.pass !== expectedPass ||
        item.judge?.score !== (expectedPass ? 1 : 0) ||
        item.judge?.reason !== expectedReason ||
        JSON.stringify(item.attempts.judge) !==
          JSON.stringify([{ attempt: 1, outcome: 'success' }])
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'item must exactly reproduce exact_match_v1 from candidate and baseline output',
        });
      }
    }
  }

  const { inputArtifact, coverage } = report.scope;
  if (inputArtifact.digest !== inputArtifact.declaredDigest) {
    ctx.addIssue({
      code: 'custom',
      path: ['scope', 'inputArtifact'],
      message: 'observed input digest must match the declared digest',
    });
  }
  if (
    coverage.expectedItems !== coverage.observedItems ||
    coverage.observedItems !== inputArtifact.itemCount ||
    inputArtifact.itemCount !== report.items.length ||
    report.items.length !== report.totals.total
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['scope', 'coverage'],
      message: 'expected, observed, artifact, item, and total counts must agree',
    });
  }
  if (coverage.evaluatedItems !== report.totals.evaluated) {
    ctx.addIssue({
      code: 'custom',
      path: ['scope', 'coverage', 'evaluatedItems'],
      message: 'evaluated coverage must equal totals.evaluated',
    });
  }

  const expectedDecision = decideDecision(
    report.totals,
    report.thresholds,
    hasCompletedEvidence && policyAdmissible,
  );
  if (report.decision !== expectedDecision) {
    ctx.addIssue({
      code: 'custom',
      path: ['decision'],
      message: `decision must be ${expectedDecision}`,
    });
  }
  const expectedStatement = buildDecisionStatement(
    expectedDecision,
    report.scope.kind,
    report.scope.id,
    inputArtifact.digest,
  );
  if (report.decisionStatement !== expectedStatement) {
    ctx.addIssue({
      code: 'custom',
      path: ['decisionStatement'],
      message: 'decision statement must exactly bind the decision to scope and input digest',
    });
  }
});

export type ItemResult = z.infer<typeof itemResultSchema>;
export type ItemResultV3 = z.infer<typeof itemResultV3Schema>;
export type Report = z.infer<typeof reportSchema>;
export type ReportV3 = z.infer<typeof reportV3Schema>;
export type ItemOutcome = z.infer<typeof itemOutcomeSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;
export type ErrorStage = z.infer<typeof errorStageSchema>;
export type { ErrorKind };
export type Verdict = ReportV3['verdict'];
export type Decision = Report['decision'];

export type ReportInspection =
  | { schemaVersion: 3; readOnly: true; report: ReportV3 }
  | { schemaVersion: 4; readOnly: false; report: Report }
  | { schemaVersion: 5; readOnly: false; report: SuiteReport }
  | { schemaVersion: 6; readOnly: false; report: CalibrationSuiteReport };

/** Parse v3 through v6 reports without normalizing or upgrading versions. */
export function parseReportForInspection(raw: unknown): ReportInspection {
  if (typeof raw !== 'object' || raw === null || !('schemaVersion' in raw)) {
    throw new Error('unsupported report schema version: missing');
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version === LEGACY_REPORT_SCHEMA_VERSION) {
    reportV3Schema.parse(raw);
    return { schemaVersion: 3, readOnly: true, report: raw as ReportV3 };
  }
  if (version === REPORT_SCHEMA_VERSION) {
    reportSchema.parse(raw);
    return { schemaVersion: 4, readOnly: false, report: raw as Report };
  }
  if (version === SUITE_REPORT_SCHEMA_VERSION) {
    reportV5Schema.parse(raw);
    return { schemaVersion: 5, readOnly: false, report: raw as SuiteReport };
  }
  if (version === CALIBRATION_REPORT_SCHEMA_VERSION) {
    try {
      const report = reportV6Schema.parse(raw);
      return { schemaVersion: 6, readOnly: false, report };
    } catch (error) {
      throw new Error(
        `invalid report schema version 6: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  throw new Error(`unsupported report schema version: ${String(version)}`);
}

export interface Totals {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  candidateErrored: number;
  judgeErrored: number;
  protocolErrored: number;
  evaluated: number;
  evaluationCoverage: number;
  passRate: number;
  regressions: number;
  comparisonCounts: Record<Comparison, number>;
  allErrored: boolean;
}

export function aggregate(items: ItemResult[]): Totals {
  const total = items.length;
  const passed = items.filter((i) => i.pass).length;
  const failed = total - passed;
  const errored = items.filter((i) => i.outcome === 'error').length;
  const candidateErrored = items.filter(
    (i) => i.outcome === 'error' && i.errorStage === 'candidate',
  ).length;
  const judgeErrored = items.filter(
    (i) => i.outcome === 'error' && i.errorStage === 'judge',
  ).length;
  const protocolErrored = items.filter(
    (i) => i.outcome === 'error' && i.errorKind === 'protocol',
  ).length;
  const evaluated = total - errored;
  const comparisonCounts: Record<Comparison, number> = {
    regression: 0,
    improvement: 0,
    stable_pass: 0,
    stable_fail: 0,
    unpaired: 0,
  };
  for (const item of items) comparisonCounts[item.comparison] += 1;
  const regressions = comparisonCounts.regression;
  const passRate = total === 0 ? 0 : passed / total;
  const evaluationCoverage = total === 0 ? 0 : evaluated / total;
  const allErrored = total > 0 && errored === total;
  return {
    total,
    passed,
    failed,
    errored,
    candidateErrored,
    judgeErrored,
    protocolErrored,
    evaluated,
    evaluationCoverage,
    passRate,
    regressions,
    comparisonCounts,
    allErrored,
  };
}

export function decideVerdict(
  totals: Totals,
  thresholds: { minPassRate: number; maxRegressions: number },
): Verdict {
  // A judge/protocol error compromises the evidence, even when threshold slack
  // would otherwise allow the run to pass. Mixed candidate+judge failures are
  // therefore inconclusive too.
  if (totals.judgeErrored > 0 || totals.protocolErrored > 0) {
    return 'inconclusive';
  }
  // Every v0 input is required. A candidate that cannot execute one of them is
  // a release failure, even though it is not a judged baseline regression.
  if (totals.candidateErrored > 0) return 'block';
  // Defensive coverage guard for schema drift or a future non-error outcome.
  if (totals.evaluated < totals.total || totals.evaluationCoverage < 1) {
    return 'inconclusive';
  }
  return totals.passRate >= thresholds.minPassRate &&
    totals.regressions <= thresholds.maxRegressions
      ? 'promote'
      : 'block';
}

/** Apply the Batch 1B trust gate after the frozen v3 evidence precedence. */
export function decideDecision(
  totals: Totals,
  thresholds: { minPassRate: number; maxRegressions: number },
  trustAdmissible: boolean,
): Decision {
  if (totals.judgeErrored > 0 || totals.protocolErrored > 0) return 'inconclusive';
  if (totals.candidateErrored > 0) return 'block';
  if (totals.evaluated < totals.total || totals.evaluationCoverage < 1) return 'inconclusive';
  if (!trustAdmissible) return 'inconclusive';
  return totals.passRate >= thresholds.minPassRate &&
      totals.regressions <= thresholds.maxRegressions
    ? 'promote'
    : 'block';
}

export function buildDecisionStatement(
  decision: Decision,
  scopeKind: ScopeConfig['kind'],
  scopeId: string,
  inputDigest: string,
): string {
  return `Decision ${decision} for ${scopeKind} scope ${JSON.stringify(scopeId)} over exact JSONL input ${inputDigest}.`;
}

export const EXIT_PROMOTE = 0;
export const EXIT_BLOCK = 1;
export const EXIT_RUN_ERROR = 2;

/**
 * Map a finished report to the CLI exit code. Inconclusive evidence is a run
 * error, not a product-quality verdict.
 */
export function decideExitCode(report: Pick<Report, 'decision'>): number {
  if (report.decision === 'inconclusive') return EXIT_RUN_ERROR;
  return report.decision === 'promote' ? EXIT_PROMOTE : EXIT_BLOCK;
}

const MAX_FAILING_EXAMPLES = 10;

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function renderMarkdown(report: Report): string {
  const { totals, thresholds } = report;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const heading = report.decision.toUpperCase();
  const trustLine = report.trust.status === 'complete'
    ? `- Trust: **${report.trust.class}** (${report.trust.derivation}; ${report.trust.admissible ? 'admissible' : 'not admissible'})`
    : `- Trust: **unavailable** (${report.trust.derivation}; no completed evidence)`;
  const overrideReason = report.trustPolicy.selfReportedOverride?.reason;

  const lines: string[] = [
    `# Shadow run report: ${heading}`,
    '',
    `- Decision: **${report.decision}**`,
    `- Scope: **${report.scope.kind}** (${report.scope.id})`,
    `- Exact input: \`${report.scope.inputArtifact.digest}\``,
    trustLine,
    ...(overrideReason === undefined
      ? []
      : [`- Self-reported evidence override: ${overrideReason}`]),
    `- Pass rate: **${pct(totals.passRate)}** (${totals.passed}/${totals.total}) — threshold: ≥ ${pct(thresholds.minPassRate)}`,
    `- Regressions vs baseline: **${totals.regressions}** — threshold: ≤ ${thresholds.maxRegressions}`,
    `- Comparisons: ${totals.comparisonCounts.regression} regressions, ${totals.comparisonCounts.improvement} improvements, ${totals.comparisonCounts.stable_pass} stable passes, ${totals.comparisonCounts.stable_fail} stable fails, ${totals.comparisonCounts.unpaired} unpaired`,
    `- Errored items (not evaluated): ${totals.errored}`,
    `- Candidate execution errors: ${totals.candidateErrored}`,
    `- Judge errors: ${totals.judgeErrored}`,
    `- Evaluation coverage: **${pct(totals.evaluationCoverage)}** (${totals.evaluated}/${totals.total})`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    '',
    report.decisionStatement,
    '',
  ];

  if (report.evidence?.provider === 'coeval') {
    const { evalRunId, receipt, operations } = report.evidence;
    lines.push(
      '## Coeval evidence audit',
      '',
      `- Status: ${report.evidence.status}`,
      `- Pinned skill version: ${report.evidence.skillVersionId}`,
      ...(evalRunId === undefined ? [] : [`- Eval run: ${evalRunId}`]),
      `- Operations: ${operations.length} (${operations.map((operation) => operation.phase).join(' → ')})`,
      ...(receipt === undefined
        ? []
        : [
            `- Receipt: ${receipt.receiptId}`,
            `- Evidence digest: \`${receipt.evidenceDigest}\``,
          ]),
      '',
    );
  }

  const failing = report.items.filter((i) => !i.pass);
  if (failing.length > 0) {
    lines.push(`## Failing items (${failing.length}${failing.length > MAX_FAILING_EXAMPLES ? `, showing first ${MAX_FAILING_EXAMPLES}` : ''})`, '');
    for (const item of failing.slice(0, MAX_FAILING_EXAMPLES)) {
      lines.push(`### ${item.id}${item.regression ? ' (regression)' : ''}`, '');
      lines.push(`- input: \`${truncate(item.input)}\``);
      if (item.baseline_output !== undefined) {
        lines.push(`- baseline_output: \`${truncate(item.baseline_output)}\``);
      }
      lines.push(`- comparison: ${item.comparison}`);
      if (item.candidate_output !== undefined) {
        lines.push(`- candidate_output: \`${truncate(item.candidate_output)}\``);
      }
      if (item.judge) {
        lines.push(`- judge: score=${item.judge.score}${item.judge.reason ? `, reason: ${truncate(item.judge.reason)}` : ''}`);
      }
      if (item.error) {
        lines.push(`- error: ${truncate(item.error)}`);
      }
      lines.push('');
    }
  } else {
    lines.push('All items passed.', '');
  }

  return lines.join('\n');
}
