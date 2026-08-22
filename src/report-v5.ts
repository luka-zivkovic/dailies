import { z } from 'zod';
import {
  coevalAssessmentReceiptSchema,
  coevalEvidenceOperationSchema,
  sha256Digest,
  verifyCoevalReceipt,
} from './coeval.js';
import {
  scopeConfigSchema,
  scopeKindSchema,
  timeWindowSchema,
  trustPolicySchema,
  type ScopeConfig,
} from './config.js';
import { ERROR_KINDS } from './errors.js';
import {
  applyReleasePolicy,
  releasePolicyDigest,
  releasePolicyV1Schema,
  verifyReleasePolicy,
  type CriterionPolicyInput,
} from './policy.js';
import { attemptLedgerSchema } from './retry.js';
import {
  evaluatorSuiteManifestSchema,
  verifyEvaluatorSuiteManifest,
  verifyReceiptManifestBinding,
} from './suite-manifest.js';

export const SUITE_REPORT_SCHEMA_VERSION = 5;
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const decisionSchema = z.enum(['promote', 'block', 'inconclusive']);
const comparisonSchema = z.enum([
  'regression', 'improvement', 'stable_pass', 'stable_fail', 'unpaired',
]);
const evidenceStateSchema = z.enum(['complete', 'incomplete', 'integrity_failure']);
const positiveIntegerTextSchema = z.string().regex(/^[1-9][0-9]*$/);

const suiteScopeSchema = z.object({
  id: z.string().min(1).refine((value) => value.trim().length > 0),
  kind: scopeKindSchema,
  collectionProcedure: z.string().min(1).refine((value) => value.trim().length > 0),
  population: z.string().min(1).refine((value) => value.trim().length > 0),
  timeWindow: timeWindowSchema,
  inputArtifact: z.object({
    type: z.literal('jsonl'),
    digest: digestSchema,
    declaredDigest: digestSchema,
    byteLength: z.number().int().nonnegative(),
    itemCount: z.number().int().positive(),
  }).strict(),
  coverage: z.object({
    expectedItems: z.number().int().positive(),
    observedItems: z.number().int().nonnegative(),
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
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
  }
});

const candidateItemSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  baseline_output: z.string().optional(),
  baseline_labels: z.record(z.enum(['pass', 'fail'])).optional(),
  status: z.enum(['success', 'error']),
  candidate_output: z.string().optional(),
  error: z.string().optional(),
  errorKind: z.enum(ERROR_KINDS).optional(),
  attempts: attemptLedgerSchema,
}).strict().superRefine((item, ctx) => {
  const final = item.attempts.at(-1);
  if (item.status === 'success') {
    if (item.candidate_output === undefined || item.error !== undefined || item.errorKind !== undefined ||
      final?.outcome !== 'success') {
      ctx.addIssue({ code: 'custom', message: 'successful candidate item is internally inconsistent' });
    }
  } else if (item.candidate_output !== undefined || item.error === undefined ||
    item.errorKind === undefined || final?.outcome !== 'error' || final.errorKind !== item.errorKind) {
    ctx.addIssue({ code: 'custom', message: 'failed candidate item is internally inconsistent' });
  }
});

const candidateExecutionSchema = z.object({
  total: z.number().int().positive(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(candidateItemSchema).min(1),
}).strict();

const criterionItemSchema = z.object({
  id: z.string().min(1),
  baselineLabel: z.enum(['pass', 'fail']).optional(),
  assessedLabel: z.enum(['pass', 'fail']).nullable(),
  comparison: comparisonSchema,
  regression: z.boolean(),
}).strict();

const criterionTotalsSchema = z.object({
  total: z.number().int().positive(),
  evaluated: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  regressions: z.number().int().nonnegative(),
  comparisonCounts: z.object({
    regression: z.number().int().nonnegative(),
    improvement: z.number().int().nonnegative(),
    stable_pass: z.number().int().nonnegative(),
    stable_fail: z.number().int().nonnegative(),
    unpaired: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const criterionTrustSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('complete'),
    class: z.literal('verified'),
    derivation: z.literal('coeval_receipt_v1'),
    admissible: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    derivation: z.literal('coeval_receipt_v1'),
    admissible: z.literal(false),
    reason: z.enum(['incomplete_evidence', 'integrity_failure', 'no_candidate_outputs']),
  }).strict(),
]);

const zeroRequestTerminationSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('candidate_filter'),
    reason: z.literal('no_candidate_outputs'),
  }).strict(),
  z.object({
    phase: z.literal('evidence_submission'),
    reason: z.literal('shared_evidence_deadline_elapsed'),
  }).strict(),
]);

const criterionEvidenceSchema = z.object({
  state: evidenceStateSchema,
  evalRunId: z.string().min(1).optional(),
  operations: z.array(coevalEvidenceOperationSchema).max(10_000),
  receipt: coevalAssessmentReceiptSchema.optional(),
  rejectedReceipt: coevalAssessmentReceiptSchema.optional(),
  rejection: z.object({
    kind: z.literal('manifest_binding'),
    reason: z.string().min(1),
  }).strict().optional(),
  zeroRequestTermination: zeroRequestTerminationSchema.optional(),
  error: z.string().min(1).optional(),
}).strict();

const criterionResultSchema = z.object({
  position: z.number().int().nonnegative(),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  criterionName: z.string().min(1),
  criterionDefinition: z.string().min(1),
  criterionDigest: digestSchema,
  skillId: z.string().min(1),
  skillVersionId: z.string().min(1),
  skillDigest: digestSchema,
  outputContractDigest: digestSchema,
  suite: z.object({ manifestId: z.string().min(1), manifestDigest: digestSchema }).strict(),
  scope: z.object({ id: z.string().min(1), kind: scopeKindSchema, inputDigest: digestSchema }).strict(),
  trust: criterionTrustSchema,
  evidence: criterionEvidenceSchema,
  totals: criterionTotalsSchema,
  items: z.array(criterionItemSchema).min(1),
  policyResult: z.object({
    evidenceRequirement: z.enum(['mandatory', 'optional']),
    consequence: z.enum(['blocking', 'advisory', 'compensatory']),
    rulePassed: z.boolean().nullable(),
  }).strict(),
}).strict();

const compensationResultSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['complete', 'incomplete']),
  weightedPassRate: z.number().min(0).max(1).nullable(),
  minimumPassRate: z.number().min(0).max(1),
  passed: z.boolean().nullable(),
  exactComparison: z.object({
    weightedNumerator: z.string().regex(/^[0-9]+$/),
    weightedDenominator: positiveIntegerTextSchema,
    minimumNumerator: z.string().regex(/^[0-9]+$/),
    minimumDenominator: positiveIntegerTextSchema,
  }).strict().nullable(),
}).strict();

const headerNamesSchema = z.array(z.string().min(1));

const providerExecutionIdentitySchema = z.object({
  type: z.literal('coeval'),
  url: z.string().url(),
  headerNames: headerNamesSchema,
  identityDigest: digestSchema,
}).strict();

const candidateExecutionIdentitySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'),
    template: z.string().min(1),
    identityDigest: digestSchema,
  }).strict(),
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    headerNames: headerNamesSchema,
    identityDigest: digestSchema,
  }).strict(),
]);

const executionPolicySchema = z.object({
  scheduling: z.literal('manifest_order_bounded_pool/v1'),
  deadlineStartsAt: z.literal('after_candidate_execution'),
  evidenceDeadlineMs: z.number().int().positive(),
  pollIntervalMs: z.number().int().positive(),
  perCallTimeoutMs: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  provider: providerExecutionIdentitySchema,
  candidate: candidateExecutionIdentitySchema,
}).strict();

// Reports must retain the resolved classes explicitly. The preliminary shape
// prevents the configuration schema's default from accepting an omitted audit
// field, while the shared schema remains the single source of policy rules.
const reportTrustPolicySchema = z.object({
  admissibleClasses: z.unknown(),
}).passthrough().pipe(trustPolicySchema);

const reportV5ShapeSchema = z.object({
  schemaVersion: z.literal(SUITE_REPORT_SCHEMA_VERSION),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  scope: suiteScopeSchema,
  trustPolicy: reportTrustPolicySchema,
  manifest: evaluatorSuiteManifestSchema,
  policy: releasePolicyV1Schema,
  policyDigest: digestSchema,
  executionPolicy: executionPolicySchema,
  executionPolicyDigest: digestSchema,
  candidateExecution: candidateExecutionSchema,
  candidateDatasetDigest: digestSchema.nullable(),
  criteria: z.array(criterionResultSchema).min(1),
  compensation: z.array(compensationResultSchema),
  decision: decisionSchema,
  decisionPrecedence: z.enum([
    'required_integrity_failure',
    'candidate_execution_failure',
    'complete_blocking_failure',
    'mandatory_evidence_incomplete',
    'compensation_failure',
    'policy_satisfied',
  ]),
  decisionStatement: z.string().min(1),
}).strict();

export type SuiteCandidateItem = z.infer<typeof candidateItemSchema>;
export type CriterionItem = z.infer<typeof criterionItemSchema>;
export type CriterionTotals = z.infer<typeof criterionTotalsSchema>;
export type SuiteReport = z.infer<typeof reportV5ShapeSchema>;

function sortedHeaderNames(headers: Record<string, string> | undefined): string[] {
  return [...new Set(Object.keys(headers ?? {}).map((name) => name.toLowerCase()))].sort();
}

export function providerExecutionIdentity(
  provider: { type: 'coeval'; url: string; headers?: Record<string, string> },
): SuiteReport['executionPolicy']['provider'] {
  const basis = {
    type: provider.type,
    url: provider.url,
    headerNames: sortedHeaderNames(provider.headers),
  } as const;
  return { ...basis, identityDigest: sha256Digest(basis) };
}

export function candidateExecutionIdentity(
  candidate:
    | { type: 'command'; template: string }
    | { type: 'http'; url: string; headers?: Record<string, string> },
): SuiteReport['executionPolicy']['candidate'] {
  if (candidate.type === 'command') {
    const basis = { type: candidate.type, template: candidate.template } as const;
    return { ...basis, identityDigest: sha256Digest(basis) };
  }
  const basis = {
    type: candidate.type,
    url: candidate.url,
    headerNames: sortedHeaderNames(candidate.headers),
  } as const;
  return { ...basis, identityDigest: sha256Digest(basis) };
}

export function suiteExecutionPolicyDigest(
  policy: z.infer<typeof executionPolicySchema>,
): string {
  return sha256Digest(policy);
}

export function suiteCandidateDatasetDigest(
  candidates: Array<{ id: string; input: string; output: string }>,
): string | null {
  if (candidates.length === 0) return null;
  const items = candidates.map((candidate) => ({
    clientItemId: candidate.id,
    contentDigest: sha256Digest({ input: candidate.input, output: candidate.output }),
  })).sort((left, right) => left.clientItemId < right.clientItemId
    ? -1
    : left.clientItemId > right.clientItemId ? 1 : 0);
  return sha256Digest(items);
}

export function compareCriterionOutcome(
  baseline: 'pass' | 'fail' | undefined,
  assessed: 'pass' | 'fail' | null,
): z.infer<typeof comparisonSchema> {
  if (baseline === undefined || assessed === null) return 'unpaired';
  if (baseline === 'pass') return assessed === 'pass' ? 'stable_pass' : 'regression';
  return assessed === 'pass' ? 'improvement' : 'stable_fail';
}

export function aggregateCriterionItems(items: CriterionItem[]): CriterionTotals {
  const evaluated = items.filter((item) => item.assessedLabel !== null);
  const passed = evaluated.filter((item) => item.assessedLabel === 'pass').length;
  const comparisonCounts = {
    regression: 0,
    improvement: 0,
    stable_pass: 0,
    stable_fail: 0,
    unpaired: 0,
  };
  for (const item of items) comparisonCounts[item.comparison] += 1;
  return {
    total: items.length,
    evaluated: evaluated.length,
    passed,
    failed: evaluated.length - passed,
    passRate: items.length === 0 ? 0 : passed / items.length,
    regressions: comparisonCounts.regression,
    comparisonCounts,
  };
}

export function buildSuiteDecisionStatement(
  decision: SuiteReport['decision'],
  policyId: string,
  policyVersion: string,
  policyDigest: string,
  manifestId: string,
  manifestDigest: string,
  scopeKind: ScopeConfig['kind'],
  scopeId: string,
  inputDigest: string,
): string {
  return `Decision ${decision} under policy ${JSON.stringify(`${policyId}@${policyVersion}`)} (${policyDigest}) ` +
    `for evaluator suite ${JSON.stringify(manifestId)} (${manifestDigest}) on ${scopeKind} scope ` +
    `${JSON.stringify(scopeId)} over exact JSONL input ${inputDigest}.`;
}

export const reportV5Schema = reportV5ShapeSchema.superRefine((report, ctx) => {
  let manifest;
  let policy;
  try {
    manifest = verifyEvaluatorSuiteManifest(report.manifest, {
      manifestId: report.manifest.manifestId,
      manifestDigest: report.manifest.manifestDigest,
    });
    policy = verifyReleasePolicy(report.policy, manifest);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (report.policyDigest !== releasePolicyDigest(policy)) {
    ctx.addIssue({ code: 'custom', path: ['policyDigest'], message: 'policyDigest mismatch' });
  }
  if (report.executionPolicyDigest !== suiteExecutionPolicyDigest(report.executionPolicy)) {
    ctx.addIssue({ code: 'custom', path: ['executionPolicyDigest'], message: 'executionPolicyDigest mismatch' });
  }
  const { identityDigest: providerIdentityDigest, ...providerIdentityBasis } =
    report.executionPolicy.provider;
  if (
    providerIdentityDigest !== sha256Digest(providerIdentityBasis) ||
    JSON.stringify(providerIdentityBasis.headerNames) !== JSON.stringify(
      sortedHeaderNames(Object.fromEntries(providerIdentityBasis.headerNames.map((name) => [name, '']))),
    )
  ) {
    ctx.addIssue({ code: 'custom', path: ['executionPolicy', 'provider'], message: 'provider identity mismatch' });
  }
  const { identityDigest: candidateIdentityDigest, ...candidateIdentityBasis } =
    report.executionPolicy.candidate;
  const candidateHeaderNamesValid = candidateIdentityBasis.type === 'command' ||
    JSON.stringify(candidateIdentityBasis.headerNames) === JSON.stringify(
      sortedHeaderNames(Object.fromEntries(candidateIdentityBasis.headerNames.map((name) => [name, '']))),
    );
  if (candidateIdentityDigest !== sha256Digest(candidateIdentityBasis) || !candidateHeaderNamesValid) {
    ctx.addIssue({ code: 'custom', path: ['executionPolicy', 'candidate'], message: 'candidate identity mismatch' });
  }
  if (manifest.trialPlan !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['manifest', 'trialPlan'],
      message: 'Dailies v5 reports do not support repeated-trial execution',
    });
  }
  const candidates = report.candidateExecution.items;
  if (new Set(candidates.map((item) => item.id)).size !== candidates.length) {
    ctx.addIssue({ code: 'custom', path: ['candidateExecution', 'items'], message: 'candidate ids must be unique' });
  }
  const succeeded = candidates.filter((item) => item.status === 'success');
  const expectedCriterionVersions = new Set(
    manifest.members.map((member) => member.criterionVersionId),
  );
  for (const [index, candidate] of candidates.entries()) {
    for (const criterionVersionId of Object.keys(candidate.baseline_labels ?? {})) {
      if (!expectedCriterionVersions.has(criterionVersionId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['candidateExecution', 'items', index, 'baseline_labels', criterionVersionId],
          message: 'baseline_labels contains an unknown manifest criterion version',
        });
      }
    }
  }
  const expectedDatasetDigest = suiteCandidateDatasetDigest(succeeded.map((candidate) => ({
    id: candidate.id,
    input: candidate.input,
    output: candidate.candidate_output!,
  })));
  if (report.candidateDatasetDigest !== expectedDatasetDigest) {
    ctx.addIssue({
      code: 'custom',
      path: ['candidateDatasetDigest'],
      message: 'candidateDatasetDigest does not match successful candidate content',
    });
  }
  if (
    report.candidateExecution.total !== candidates.length ||
    report.candidateExecution.succeeded !== succeeded.length ||
    report.candidateExecution.failed !== candidates.length - succeeded.length
  ) {
    ctx.addIssue({ code: 'custom', path: ['candidateExecution'], message: 'candidate totals mismatch' });
  }
  if (
    report.scope.inputArtifact.digest !== report.scope.inputArtifact.declaredDigest ||
    report.scope.inputArtifact.itemCount !== candidates.length ||
    report.scope.coverage.expectedItems !== candidates.length ||
    report.scope.coverage.observedItems !== candidates.length
  ) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'scope and candidate coverage mismatch' });
  }
  if (report.criteria.length !== manifest.members.length) {
    ctx.addIssue({ code: 'custom', path: ['criteria'], message: 'criterion result coverage mismatch' });
    return;
  }
  const policyInputs: CriterionPolicyInput[] = [];
  const retainedReceiptIds = new Set<string>();
  const retainedEvalRunIds = new Set<string>();
  const retainedDatasetDigests = new Set<string>();
  for (const [index, result] of report.criteria.entries()) {
    const member = manifest.members[index]!;
    if (
      result.position !== index ||
      result.criterionId !== member.criterionId ||
      result.criterionVersionId !== member.criterionVersionId ||
      result.criterionName !== member.criterionName ||
      result.criterionDefinition !== member.criterionDefinition ||
      result.criterionDigest !== member.criterionDigest ||
      result.skillId !== member.skillId ||
      result.skillVersionId !== member.skillVersionId ||
      result.skillDigest !== member.skillDigest ||
      result.outputContractDigest !== member.outputContractDigest
    ) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index], message: 'criterion identity mismatch' });
    }
    if (
      result.suite.manifestId !== manifest.manifestId ||
      result.suite.manifestDigest !== manifest.manifestDigest ||
      result.scope.id !== report.scope.id ||
      result.scope.kind !== report.scope.kind ||
      result.scope.inputDigest !== report.scope.inputArtifact.digest
    ) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index], message: 'suite or scope identity mismatch' });
    }
    if (result.items.length !== candidates.length ||
      result.items.some((item, itemIndex) => item.id !== candidates[itemIndex]?.id)) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'items'], message: 'criterion item coverage mismatch' });
    }
    for (const [itemIndex, item] of result.items.entries()) {
      const candidate = candidates[itemIndex]!;
      const expectedBaseline = candidate.baseline_labels?.[member.criterionVersionId];
      const expectedComparison = compareCriterionOutcome(expectedBaseline, item.assessedLabel);
      if (
        item.baselineLabel !== expectedBaseline ||
        item.comparison !== expectedComparison ||
        item.regression !== (expectedComparison === 'regression')
      ) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'items', itemIndex], message: 'criterion comparison mismatch' });
      }
    }
    const totals = aggregateCriterionItems(result.items);
    if (JSON.stringify(totals) !== JSON.stringify(result.totals)) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'totals'], message: 'criterion totals mismatch' });
    }

    const evidence = result.evidence;
    if (evidence.state === 'complete' && evidence.error !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'complete evidence cannot carry an error' });
    }
    if (evidence.state !== 'complete' && evidence.error === undefined) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'non-complete evidence requires an error' });
    }
    if (evidence.state !== 'complete' && result.items.some((item) => item.assessedLabel !== null)) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'items'], message: 'non-complete evidence cannot produce assessed labels' });
    }
    if (evidence.receipt !== undefined && evidence.rejectedReceipt !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'accepted and rejected receipts are mutually exclusive' });
    }
    if ((evidence.rejectedReceipt === undefined) !== (evidence.rejection === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'rejectedReceipt and rejection must appear together' });
    }
    if (evidence.rejectedReceipt !== undefined && evidence.state !== 'integrity_failure') {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'only integrity failures can retain rejected receipts' });
    }
    if (evidence.operations.length === 0 && evidence.zeroRequestTermination === undefined) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'zero-request evidence requires a typed termination' });
    }
    if (evidence.operations.length > 0 && evidence.zeroRequestTermination !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'typed zero-request termination requires an empty operation ledger' });
    }
    if (evidence.zeroRequestTermination?.reason === 'no_candidate_outputs' &&
      (succeeded.length !== 0 || evidence.state !== 'incomplete')) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'zeroRequestTermination'], message: 'no_candidate_outputs termination mismatch' });
    }
    if (evidence.zeroRequestTermination?.reason === 'shared_evidence_deadline_elapsed' &&
      evidence.state !== 'integrity_failure') {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'zeroRequestTermination'], message: 'deadline termination must be an integrity failure' });
    }
    const phases = evidence.operations.map((operation) => operation.phase);
    if (evidence.operations.length > 0 &&
      (phases[0] !== 'submit' || phases.filter((phase) => phase === 'submit').length !== 1)) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'operations'], message: 'criterion operations must begin with one submit' });
    }
    const firstReceipt = phases.indexOf('receipt');
    if (
      phases.filter((phase) => phase === 'receipt').length > 1 ||
      (firstReceipt >= 0 && firstReceipt !== phases.length - 1) ||
      (firstReceipt >= 0 && !phases.slice(1, firstReceipt).includes('poll'))
    ) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'operations'], message: 'criterion operations must be submit, polls, then at most one receipt' });
    }
    const operationFailed = (operation: (typeof evidence.operations)[number]) =>
      operation.termination !== undefined || operation.attempts.at(-1)?.outcome === 'error';
    const failedOperation = evidence.operations.findIndex(operationFailed);
    if (failedOperation >= 0 && failedOperation !== evidence.operations.length - 1) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'operations'], message: 'failed criterion operation must terminate collection' });
    }
    const submitSucceeded = evidence.operations[0]?.attempts.at(-1)?.outcome === 'success';
    if (evidence.operations.length > 0 && submitSucceeded !== (evidence.evalRunId !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'evalRunId'], message: 'evalRunId must exist exactly when criterion submit succeeded' });
    }
    const retainedReceipt = evidence.receipt ?? evidence.rejectedReceipt;
    if (retainedReceipt !== undefined && evidence.evalRunId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'retained receipt requires evalRunId' });
    }
    if (retainedReceipt !== undefined && evidence.operations.at(-1)?.phase !== 'receipt') {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'operations'], message: 'retained receipt requires a final receipt operation' });
    }
    const pollOperations = evidence.operations.filter((operation) => operation.phase === 'poll');
    const lastPoll = pollOperations.at(-1);
    if (retainedReceipt !== undefined && (
      evidence.operations.at(-1)?.status !== retainedReceipt.status ||
      lastPoll?.status !== retainedReceipt.run.status ||
      !['completed', 'failed', 'canceled'].includes(lastPoll?.status ?? '')
    )) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'operations'], message: 'receipt operations must match receipt and terminal run status' });
    }
    if (pollOperations.slice(0, -1).some(
      (operation) => operation.status !== 'pending' && operation.status !== 'running',
    )) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'operations'], message: 'criterion collection cannot poll after terminal status' });
    }
    if (evidence.evalRunId !== undefined) {
      if (retainedEvalRunIds.has(evidence.evalRunId)) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'evalRunId'], message: 'criterion evalRunId values must be unique' });
      }
      retainedEvalRunIds.add(evidence.evalRunId);
    }
    if (retainedReceipt !== undefined) {
      if (retainedReceiptIds.has(retainedReceipt.receiptId)) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence', 'receipt', 'receiptId'], message: 'criterion receiptId values must be unique' });
      }
      retainedReceiptIds.add(retainedReceipt.receiptId);
      retainedDatasetDigests.add(retainedReceipt.datasetDigest);
      if (retainedReceipt.datasetDigest !== expectedDatasetDigest) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'retained receipt datasetDigest does not match the candidate dataset' });
      }
    }
    let verifiedComplete = false;
    if (evidence.receipt !== undefined) {
      if (evidence.evalRunId === undefined) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'receipt requires evalRunId' });
      } else {
        try {
          verifyReceiptManifestBinding(evidence.receipt, manifest, member);
          const verification = verifyCoevalReceipt(
            evidence.receipt,
            evidence.receipt,
            evidence.evalRunId,
            member.skillVersionId,
            succeeded.map((candidate) => ({
              id: candidate.id,
              input: candidate.input,
              output: candidate.candidate_output!,
            })),
          );
          verifiedComplete = verification.status === 'complete';
          if (verifiedComplete) {
            for (const item of result.items) {
              const label = verification.labels.get(item.id) ?? null;
              const candidate = candidates.find((entry) => entry.id === item.id)!;
              if (item.assessedLabel !== (candidate.status === 'success' ? label : null)) {
                throw new Error(`criterion label mismatch for ${item.id}`);
              }
            }
          } else if (result.items.some((item) => item.assessedLabel !== null)) {
            throw new Error('incomplete receipt cannot produce assessed labels');
          }
        } catch (error) {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria', index, 'evidence', 'receipt'],
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (evidence.rejectedReceipt !== undefined && evidence.evalRunId !== undefined) {
      try {
        verifyCoevalReceipt(
          evidence.rejectedReceipt,
          evidence.rejectedReceipt,
          evidence.evalRunId,
          member.skillVersionId,
          succeeded.map((candidate) => ({
            id: candidate.id,
            input: candidate.input,
            output: candidate.candidate_output!,
          })),
        );
        let bindingFailure: string | undefined;
        try {
          verifyReceiptManifestBinding(evidence.rejectedReceipt, manifest, member);
        } catch (error) {
          bindingFailure = error instanceof Error ? error.message : String(error);
        }
        if (bindingFailure === undefined) {
          throw new Error('rejected receipt satisfies the manifest binding');
        }
        if (evidence.rejection?.kind !== 'manifest_binding' ||
          evidence.rejection.reason !== bindingFailure) {
          throw new Error('rejected receipt reason does not reproduce its manifest-binding failure');
        }
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['criteria', index, 'evidence', 'rejectedReceipt'],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const trustAdmitted = report.trustPolicy.admissibleClasses.includes('verified');
    if (evidence.state === 'complete') {
      if (!verifiedComplete || result.trust.status !== 'complete' ||
        result.trust.class !== 'verified' || result.trust.admissible !== trustAdmitted) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'trust'], message: 'complete evidence trust mismatch' });
      }
    } else {
      if (verifiedComplete || result.trust.status !== 'unavailable' || result.trust.admissible !== false) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'trust'], message: 'incomplete evidence cannot claim trust' });
      }
      if (evidence.state === 'incomplete' && evidence.receipt !== undefined && evidence.receipt.status !== 'incomplete') {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'incomplete evidence receipt mismatch' });
      }
      if (evidence.state === 'integrity_failure' && evidence.receipt !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'integrity failures cannot retain unverified receipts' });
      }
      if (
        evidence.state === 'incomplete' &&
        evidence.receipt === undefined &&
        succeeded.length > 0
      ) {
        ctx.addIssue({ code: 'custom', path: ['criteria', index, 'evidence'], message: 'receipt-less provider failures are integrity failures' });
      }
    }
    const ledgerFullySuccessful = evidence.operations.length > 0 && evidence.operations.every(
      (operation) => operation.termination === undefined && operation.attempts.at(-1)?.outcome === 'success',
    );
    if (evidence.state === 'integrity_failure' && ledgerFullySuccessful &&
      evidence.rejectedReceipt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['criteria', index, 'evidence'],
        message: 'integrity failure with a successful ledger requires a reproducible rejected receipt',
      });
    }
    policyInputs.push({
      criterionVersionId: member.criterionVersionId,
      evidenceState: evidence.state,
      trustAdmissible: result.trust.status === 'complete' && result.trust.admissible,
      passed: totals.passed,
      total: totals.total,
      passRate: totals.passRate,
      regressions: totals.regressions,
    });
  }
  if (retainedDatasetDigests.size > 1) {
    ctx.addIssue({ code: 'custom', path: ['criteria'], message: 'all retained receipts must share one candidate datasetDigest' });
  }
  const expected = applyReleasePolicy(
    policy,
    policyInputs,
    report.candidateExecution.failed > 0,
    report.candidateExecution.items.some(
      (item) => item.status === 'error' && item.errorKind === 'protocol',
    ),
  );
  if (report.decision !== expected.decision || report.decisionPrecedence !== expected.precedence) {
    ctx.addIssue({ code: 'custom', path: ['decision'], message: 'decision or precedence mismatch' });
  }
  if (JSON.stringify(report.compensation) !== JSON.stringify(expected.compensation)) {
    ctx.addIssue({ code: 'custom', path: ['compensation'], message: 'compensation result mismatch' });
  }
  for (const [index, result] of report.criteria.entries()) {
    const expectedResult = expected.criteria[index]!;
    if (JSON.stringify(result.policyResult) !== JSON.stringify({
      evidenceRequirement: expectedResult.evidenceRequirement,
      consequence: expectedResult.consequence,
      rulePassed: expectedResult.rulePassed,
    })) {
      ctx.addIssue({ code: 'custom', path: ['criteria', index, 'policyResult'], message: 'criterion policy result mismatch' });
    }
  }
  const statement = buildSuiteDecisionStatement(
    expected.decision,
    policy.id,
    policy.version,
    report.policyDigest,
    manifest.manifestId,
    manifest.manifestDigest,
    report.scope.kind,
    report.scope.id,
    report.scope.inputArtifact.digest,
  );
  if (report.decisionStatement !== statement) {
    ctx.addIssue({ code: 'custom', path: ['decisionStatement'], message: 'decision statement mismatch' });
  }
});

export function renderSuiteMarkdown(report: SuiteReport): string {
  const lines = [
    `# Criterion release report: ${report.decision.toUpperCase()}`,
    '',
    `- Decision: **${report.decision}**`,
    `- Precedence: ${report.decisionPrecedence}`,
    `- Policy: ${report.policy.id}@${report.policy.version} (\`${report.policyDigest}\`)`,
    `- Suite: ${report.manifest.manifestId} (\`${report.manifest.manifestDigest}\`)`,
    `- Scope: **${report.scope.kind}** (${report.scope.id})`,
    `- Exact input: \`${report.scope.inputArtifact.digest}\``,
    `- Candidate dataset: ${report.candidateDatasetDigest === null ? 'none' : `\`${report.candidateDatasetDigest}\``}`,
    `- Candidate execution: ${report.candidateExecution.succeeded}/${report.candidateExecution.total} succeeded`,
    '',
    report.decisionStatement,
    '',
    '## Execution policy',
    '',
    `- Scheduling: ${report.executionPolicy.scheduling} (manifest order, bounded pool)`,
    `- Shared evidence deadline: ${report.executionPolicy.evidenceDeadlineMs} ms, starting ${report.executionPolicy.deadlineStartsAt.replaceAll('_', ' ')}`,
    `- Poll interval: ${report.executionPolicy.pollIntervalMs} ms`,
    `- Per-call timeout: ${report.executionPolicy.perCallTimeoutMs} ms`,
    `- Concurrency: ${report.executionPolicy.concurrency}`,
    `- Provider: ${report.executionPolicy.provider.type} at ${report.executionPolicy.provider.url}; headers [${report.executionPolicy.provider.headerNames.join(', ')}] (\`${report.executionPolicy.provider.identityDigest}\`)`,
    `- Candidate: ${report.executionPolicy.candidate.type === 'command'
      ? `command ${JSON.stringify(report.executionPolicy.candidate.template)}`
      : `http at ${report.executionPolicy.candidate.url}; headers [${report.executionPolicy.candidate.headerNames.join(', ')}]`} (\`${report.executionPolicy.candidate.identityDigest}\`)`,
    `- Execution policy digest: \`${report.executionPolicyDigest}\``,
    '',
    '## Criteria',
    '',
  ];
  for (const criterion of report.criteria) {
    lines.push(
      `### ${criterion.criterionId}`,
      '',
      `- Criterion version: ${criterion.criterionVersionId}`,
      `- Consequence: ${criterion.policyResult.consequence}`,
      `- Evidence: ${criterion.evidence.state}`,
      ...(criterion.evidence.error === undefined ? [] : [`- Evidence reason: ${criterion.evidence.error}`]),
      ...(criterion.evidence.zeroRequestTermination === undefined ? [] : [
        `- Zero-request termination: ${criterion.evidence.zeroRequestTermination.phase}/${criterion.evidence.zeroRequestTermination.reason}`,
      ]),
      ...(criterion.evidence.rejection === undefined ? [] : [
        `- Rejected artifact: ${criterion.evidence.rejection.kind} — ${criterion.evidence.rejection.reason}`,
      ]),
      `- Trust: ${criterion.trust.status === 'complete' ? `verified (${criterion.trust.admissible ? 'admissible' : 'not admissible'})` : `unavailable (${criterion.trust.reason})`}`,
      `- Pass rate: ${(criterion.totals.passRate * 100).toFixed(1)}% (${criterion.totals.passed}/${criterion.totals.total})`,
      `- Regressions: ${criterion.totals.regressions}`,
      `- Rule passed: ${criterion.policyResult.rulePassed === null ? 'not evaluated' : String(criterion.policyResult.rulePassed)}`,
      '',
    );
  }
  if (report.compensation.length > 0) {
    lines.push('## Compensation', '');
    for (const group of report.compensation) {
      const weighted = group.weightedPassRate === null
        ? 'not evaluated'
        : `${(group.weightedPassRate * 100).toFixed(4)}%`;
      const exact = group.exactComparison === null
        ? 'not available'
        : `${group.exactComparison.weightedNumerator}/${group.exactComparison.weightedDenominator} ` +
          `vs ${group.exactComparison.minimumNumerator}/${group.exactComparison.minimumDenominator}`;
      lines.push(
        `### ${group.id}`,
        '',
        `- Status: ${group.status}`,
        `- Weighted pass rate: ${weighted}`,
        `- Minimum pass rate: ${(group.minimumPassRate * 100).toFixed(4)}%`,
        `- Exact comparison: ${exact}`,
        `- Passed: ${group.passed === null ? 'not evaluated' : String(group.passed)}`,
        '',
      );
    }
  }
  return lines.join('\n');
}
