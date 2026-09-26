import { z } from 'zod';
import {
  binaryCalibrationArtifactByteDigest,
  binaryCalibrationArtifactSchema,
  compareBinary64ToCanonicalDecimal,
  compareExactRationals,
  parseCanonicalBinaryCalibrationBytes,
  parseCanonicalDecimalRational,
  BinaryCalibrationIntegrityError,
  type BinaryCalibrationArtifact,
  type BinaryCalibrationTrial,
} from './binary-calibration-v2.js';
import {
  calibrationEvidenceFileSourceSchema,
  type CalibrationEvidenceFileSource,
} from './config-v6.js';
import { canonicalJson, sha256Digest } from './rubrist-canonical.js';
import {
  binaryCalibrationRequirementV1Schema,
  calibrationMetricNameSchema,
  providerIdentityStrengthSchema,
  type BinaryCalibrationRequirementV1,
  type CalibrationMetricName,
  type ProviderIdentityStrength,
} from './policy-v2.js';
import type {
  EvaluatorSuiteManifestV2,
  EvaluatorSuiteManifestV2Member,
} from './suite-manifest-v2.js';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const exactUtcMillisecondsSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);

export const calibrationEvidenceScopeSchema = z.object({
  kind: z.literal('sealed_validation_calibration'),
  artifactId: z.string().min(1),
  calibrationRunId: z.string().min(1),
  datasetRevisionId: z.string().min(1),
  revisionDigest: digestSchema,
  contentDigest: digestSchema,
  itemCount: z.number().int().positive().max(5_000),
  selectionMethod: z.enum([
    'simple_random',
    'systematic',
    'stratified_random',
    'convenience',
    'uncertainty',
    'failure_hunting',
    'manual',
  ]),
  representativeOfPopulationId: z.string().min(1).nullable(),
  populationId: z.string().min(1),
  populationDigest: digestSchema,
  drawDigest: digestSchema,
  governedReviewBatchId: z.string().min(1),
  governedReviewBatchDigest: digestSchema,
  reviewInstructionVersionId: z.string().min(1),
  reviewInstructionDigest: digestSchema,
  authorizationExposureSnapshotDigest: digestSchema,
  authorizationExposureEventId: z.string().min(1),
  completionExposureSnapshotDigest: digestSchema,
  completionExposureEventId: z.string().min(1),
  completionExposureState: z.enum(['protected', 'exposed']),
  completionExposureEligibility: z.enum(['eligible', 'ineligible']),
  completedAt: exactUtcMillisecondsSchema,
}).strict();

export const calibrationCollectionIncompleteReasonSchema = z.enum([
  'source_not_configured',
  'artifact_incomplete',
]);

export const calibrationCollectionIntegrityReasonSchema = z.enum([
  'invalid_collection_input',
  'source_not_found',
  'source_read_failed',
  'manifest_binding_mismatch',
  'artifact_digest_mismatch',
  'artifact_identity_mismatch',
  'artifact_verification_failed',
]);

const verifiedCollectionSchema = z.object({
  criterionVersionId: z.string().min(1),
  state: z.literal('verified'),
  source: calibrationEvidenceFileSourceSchema,
  observedArtifactDigest: digestSchema,
  artifact: binaryCalibrationArtifactSchema,
  calibrationEvidenceScope: calibrationEvidenceScopeSchema,
}).strict();

const incompleteCollectionSchema = z.object({
  criterionVersionId: z.string().min(1),
  state: z.literal('incomplete'),
  source: calibrationEvidenceFileSourceSchema.nullable(),
  observedArtifactDigest: digestSchema.nullable(),
  artifact: binaryCalibrationArtifactSchema.nullable(),
  calibrationEvidenceScope: calibrationEvidenceScopeSchema.nullable(),
  reason: calibrationCollectionIncompleteReasonSchema,
  detail: z.string().min(1).nullable(),
}).strict();

const integrityFailureCollectionSchema = z.object({
  criterionVersionId: z.string().min(1),
  state: z.literal('integrity_failure'),
  source: calibrationEvidenceFileSourceSchema,
  observedArtifactDigest: digestSchema.nullable(),
  artifact: z.null(),
  calibrationEvidenceScope: z.null(),
  reason: calibrationCollectionIntegrityReasonSchema,
  detail: z.string().min(1),
}).strict();

export const calibrationCollectionResultSchema = z.discriminatedUnion('state', [
  verifiedCollectionSchema,
  incompleteCollectionSchema,
  integrityFailureCollectionSchema,
]);

export type CalibrationEvidenceScope = z.infer<typeof calibrationEvidenceScopeSchema>;
export type CalibrationCollectionIncompleteReason = z.infer<
  typeof calibrationCollectionIncompleteReasonSchema
>;
export type CalibrationCollectionIntegrityReason = z.infer<
  typeof calibrationCollectionIntegrityReasonSchema
>;
export type CalibrationCollectionResult = z.infer<typeof calibrationCollectionResultSchema>;

export interface CollectCalibrationEvidenceInput {
  criterionVersionId: string;
  source: CalibrationEvidenceFileSource | null;
  manifest: EvaluatorSuiteManifestV2;
  member: EvaluatorSuiteManifestV2Member;
  /** Exact bytes from the configured file; filesystem I/O remains in the runner. */
  bytes?: Uint8Array;
  /** A closed local read failure. Never combine this with bytes. */
  readFailure?: 'not_found' | 'read_failed';
}

export function deriveCalibrationEvidenceScope(
  artifact: BinaryCalibrationArtifact,
): CalibrationEvidenceScope {
  return {
    kind: 'sealed_validation_calibration',
    artifactId: artifact.artifactId,
    calibrationRunId: artifact.calibrationRunId,
    datasetRevisionId: artifact.truth.datasetRevisionId,
    revisionDigest: artifact.truth.revisionDigest,
    contentDigest: artifact.truth.contentDigest,
    itemCount: artifact.truth.itemCount,
    selectionMethod: artifact.truth.selectionMethod,
    representativeOfPopulationId: artifact.truth.representativeOfPopulationId,
    populationId: artifact.truth.origin.populationId,
    populationDigest: artifact.truth.origin.populationDigest,
    drawDigest: artifact.truth.origin.drawDigest,
    governedReviewBatchId: artifact.truth.origin.governedReviewBatchId,
    governedReviewBatchDigest: artifact.truth.origin.governedReviewBatchDigest,
    reviewInstructionVersionId: artifact.truth.origin.reviewInstructionVersionId,
    reviewInstructionDigest: artifact.truth.origin.reviewInstructionDigest,
    authorizationExposureSnapshotDigest: artifact.exposure.authorization.snapshotDigest,
    authorizationExposureEventId: artifact.exposure.authorization.eventId,
    completionExposureSnapshotDigest: artifact.exposure.completion.snapshotDigest,
    completionExposureEventId: artifact.exposure.completion.eventId,
    completionExposureState: artifact.exposure.completion.state,
    completionExposureEligibility: artifact.exposure.completion.eligibility.result,
    completedAt: artifact.completedAt,
  };
}

function manifestBindingFailure(
  criterionVersionId: string,
  source: CalibrationEvidenceFileSource,
  manifest: EvaluatorSuiteManifestV2,
  member: EvaluatorSuiteManifestV2Member,
): string | null {
  if (criterionVersionId !== member.criterionVersionId) return 'criterion binding does not match member';
  const manifestMember = manifest.members[member.position];
  if (manifestMember === undefined || canonicalJson(manifestMember) !== canonicalJson(member)) {
    return 'member is not at its declared manifest position';
  }
  const expected = source.expectedIdentity;
  const mismatches: string[] = [];
  const compare = (field: string, actual: unknown, wanted: unknown) => {
    if (actual !== wanted) mismatches.push(field);
  };
  compare('projectId', expected.projectId, manifest.projectId);
  compare('criterionId', expected.criterionId, member.criterionId);
  compare('criterionVersionId', expected.criterionVersionId, member.criterionVersionId);
  compare('criterionDigest', expected.criterionDigest, member.criterionDigest);
  compare('skillId', expected.skillId, member.skillId);
  compare('skillVersionId', expected.skillVersionId, member.skillVersionId);
  compare('skillDigest', expected.skillDigest, member.skillDigest);
  compare('outputContractDigest', expected.outputContractDigest, member.outputContractDigest);
  if (expected.suiteManifestId !== null) {
    compare('suiteManifestId', expected.suiteManifestId, manifest.manifestId);
    compare('suiteManifestDigest', expected.suiteManifestDigest, manifest.manifestDigest);
    compare('suiteMemberPosition', expected.suiteMemberPosition, member.position);
  }
  return mismatches.length === 0 ? null : `expected identity mismatches manifest: ${mismatches.join(', ')}`;
}

/**
 * Pure collection boundary. Explicitly unconfigured evidence and a valid
 * incomplete artifact are incomplete. A configured local read failure and
 * pinned-byte, canonical-contract, identity, or manifest failure are integrity
 * failures. No candidate execution is required to classify either.
 */
export function collectCalibrationEvidence(
  input: CollectCalibrationEvidenceInput,
): CalibrationCollectionResult {
  if (input.source === null) {
    return {
      criterionVersionId: input.criterionVersionId,
      state: 'incomplete',
      source: null,
      observedArtifactDigest: null,
      artifact: null,
      calibrationEvidenceScope: null,
      reason: 'source_not_configured',
      detail: null,
    };
  }
  if (input.bytes !== undefined && input.readFailure !== undefined) {
    return {
      criterionVersionId: input.criterionVersionId,
      state: 'integrity_failure',
      source: input.source,
      observedArtifactDigest: binaryCalibrationArtifactByteDigest(input.bytes),
      artifact: null,
      calibrationEvidenceScope: null,
      reason: 'invalid_collection_input',
      detail: 'calibration collection cannot contain both bytes and a read failure',
    };
  }
  if (input.bytes === undefined) {
    return {
      criterionVersionId: input.criterionVersionId,
      state: 'integrity_failure',
      source: input.source,
      observedArtifactDigest: null,
      artifact: null,
      calibrationEvidenceScope: null,
      reason: input.readFailure === 'not_found' ? 'source_not_found' : 'source_read_failed',
      detail: input.readFailure === 'not_found'
        ? 'configured calibration source was not found'
        : 'configured calibration source could not be read',
    };
  }

  const bindingFailure = manifestBindingFailure(
    input.criterionVersionId,
    input.source,
    input.manifest,
    input.member,
  );
  if (bindingFailure !== null) {
    return {
      criterionVersionId: input.criterionVersionId,
      state: 'integrity_failure',
      source: input.source,
      observedArtifactDigest: binaryCalibrationArtifactByteDigest(input.bytes),
      artifact: null,
      calibrationEvidenceScope: null,
      reason: 'manifest_binding_mismatch',
      detail: bindingFailure,
    };
  }

  const observedArtifactDigest = binaryCalibrationArtifactByteDigest(input.bytes);
  if (observedArtifactDigest !== input.source.artifactDigest) {
    return {
      criterionVersionId: input.criterionVersionId,
      state: 'integrity_failure',
      source: input.source,
      observedArtifactDigest,
      artifact: null,
      calibrationEvidenceScope: null,
      reason: 'artifact_digest_mismatch',
      detail: `artifact digest mismatch: expected ${input.source.artifactDigest}`,
    };
  }

  let artifact: BinaryCalibrationArtifact;
  try {
    artifact = parseCanonicalBinaryCalibrationBytes(input.bytes, input.source.expectedIdentity);
  } catch (error) {
    const identityMismatch = error instanceof BinaryCalibrationIntegrityError &&
      error.code === 'identity_mismatch';
    return {
      criterionVersionId: input.criterionVersionId,
      state: 'integrity_failure',
      source: input.source,
      observedArtifactDigest,
      artifact: null,
      calibrationEvidenceScope: null,
      reason: identityMismatch ? 'artifact_identity_mismatch' : 'artifact_verification_failed',
      detail: error instanceof Error ? error.message : 'binary calibration verification failed',
    };
  }
  const calibrationEvidenceScope = deriveCalibrationEvidenceScope(artifact);
  if (artifact.status === 'incomplete') {
    return {
      criterionVersionId: input.criterionVersionId,
      state: 'incomplete',
      source: input.source,
      observedArtifactDigest,
      artifact,
      calibrationEvidenceScope,
      reason: 'artifact_incomplete',
      detail: artifact.incompleteReasons.join(', '),
    };
  }
  return {
    criterionVersionId: input.criterionVersionId,
    state: 'verified',
    source: input.source,
    observedArtifactDigest,
    artifact,
    calibrationEvidenceScope,
  };
}

export const calibrationPolicyReasonSchema = z.enum([
  'invalid_collection_input',
  'source_not_found',
  'source_read_failed',
  'manifest_binding_mismatch',
  'artifact_digest_mismatch',
  'artifact_identity_mismatch',
  'artifact_verification_failed',
  'source_not_configured',
  'artifact_incomplete',
  'truth_role_mismatch',
  'truth_provenance_mismatch',
  'positive_class_mismatch',
  'representative_population_mismatch',
  'artifact_completed_after_evaluated_at',
  'artifact_too_old',
  'truth_support_total_below_minimum',
  'truth_support_pass_below_minimum',
  'truth_support_fail_below_minimum',
  'trial_count_below_minimum',
  'provider_identity_strength_below_minimum',
  'classified_coverage_overall_below_minimum',
  'classified_coverage_truth_pass_below_minimum',
  'classified_coverage_truth_fail_below_minimum',
  'metric_undefined',
  'metric_denominator_below_minimum',
  'metric_point_estimate_below_minimum',
  'metric_wilson_lower_bound_below_minimum',
]);

export type CalibrationPolicyReason = z.infer<typeof calibrationPolicyReasonSchema>;

export const CALIBRATION_POLICY_REASON_ORDER: readonly CalibrationPolicyReason[] = [
  'invalid_collection_input',
  'source_not_found',
  'source_read_failed',
  'manifest_binding_mismatch',
  'artifact_digest_mismatch',
  'artifact_identity_mismatch',
  'artifact_verification_failed',
  'source_not_configured',
  'artifact_incomplete',
  'truth_role_mismatch',
  'truth_provenance_mismatch',
  'positive_class_mismatch',
  'representative_population_mismatch',
  'artifact_completed_after_evaluated_at',
  'artifact_too_old',
  'truth_support_total_below_minimum',
  'truth_support_pass_below_minimum',
  'truth_support_fail_below_minimum',
  'trial_count_below_minimum',
  'provider_identity_strength_below_minimum',
  'classified_coverage_overall_below_minimum',
  'classified_coverage_truth_pass_below_minimum',
  'classified_coverage_truth_fail_below_minimum',
  'metric_undefined',
  'metric_denominator_below_minimum',
  'metric_point_estimate_below_minimum',
  'metric_wilson_lower_bound_below_minimum',
] as const;

export function worstCalibrationReason(
  reasons: readonly CalibrationPolicyReason[],
): CalibrationPolicyReason | null {
  const set = new Set(reasons);
  return CALIBRATION_POLICY_REASON_ORDER.find((reason) => set.has(reason)) ?? null;
}

export const calibrationRequirementCheckSchema = z.object({
  check: z.enum([
    'truth_role',
    'truth_provenance',
    'positive_class',
    'representative_population',
    'freshness',
    'truth_support_total',
    'truth_support_pass',
    'truth_support_fail',
    'trial_count',
    'provider_identity_strength',
    'classified_coverage_overall',
    'classified_coverage_truth_pass',
    'classified_coverage_truth_fail',
    'metric_defined',
    'metric_denominator',
    'metric_point_estimate',
    'metric_wilson_lower_bound',
  ]),
  trialIndex: z.number().int().min(0).max(9).nullable(),
  metric: calibrationMetricNameSchema.nullable(),
  passed: z.boolean(),
  actual: z.string(),
  required: z.string(),
  reason: calibrationPolicyReasonSchema.nullable(),
}).strict();

export const calibrationTrialPolicyResultSchema = z.object({
  trialIndex: z.number().int().min(0).max(9),
  passed: z.boolean(),
  reasons: z.array(calibrationPolicyReasonSchema),
  worstReason: calibrationPolicyReasonSchema.nullable(),
  checks: z.array(calibrationRequirementCheckSchema),
}).strict();

export const calibrationPolicyResultSchema = z.object({
  criterionVersionId: z.string().min(1),
  status: z.enum(['not_required', 'satisfied', 'insufficient', 'incomplete', 'integrity_failure']),
  admissible: z.boolean(),
  evaluatedAt: exactUtcMillisecondsSchema,
  requirement: binaryCalibrationRequirementV1Schema.nullable(),
  collectionState: z.enum(['verified', 'incomplete', 'integrity_failure']),
  calibrationEvidenceScope: calibrationEvidenceScopeSchema.nullable(),
  reasons: z.array(calibrationPolicyReasonSchema),
  worstReason: calibrationPolicyReasonSchema.nullable(),
  checks: z.array(calibrationRequirementCheckSchema),
  trials: z.array(calibrationTrialPolicyResultSchema),
}).strict();

export type CalibrationRequirementCheck = z.infer<typeof calibrationRequirementCheckSchema>;
export type CalibrationTrialPolicyResult = z.infer<typeof calibrationTrialPolicyResultSchema>;
export type CalibrationPolicyResult = z.infer<typeof calibrationPolicyResultSchema>;

function exactTimestampMilliseconds(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('evaluatedAt must be an exact UTC timestamp with milliseconds');
  }
  return Date.parse(value);
}

function check(
  name: CalibrationRequirementCheck['check'],
  passed: boolean,
  actual: string,
  required: string,
  reason: CalibrationPolicyReason,
  trialIndex: number | null = null,
  metric: CalibrationMetricName | null = null,
): CalibrationRequirementCheck {
  return { check: name, trialIndex, metric, passed, actual, required, reason: passed ? null : reason };
}

function compareRate(
  numerator: number,
  denominator: number,
  minimum: string,
): boolean {
  if (denominator === 0) return false;
  return compareExactRationals(
    { numerator: BigInt(numerator), denominator: BigInt(denominator) },
    parseCanonicalDecimalRational(minimum),
  ) >= 0;
}

type WilsonMetric = Exclude<BinaryCalibrationTrial['metrics']['accuracy'], { state: 'undefined' }> |
  Extract<BinaryCalibrationTrial['metrics']['accuracy'], { state: 'undefined' }>;
type ExactMetric = BinaryCalibrationTrial['metrics']['positiveClassF1'];
type CalibrationMetric = WilsonMetric | ExactMetric;

function metricForTrial(
  trial: BinaryCalibrationTrial,
  metric: CalibrationMetricName,
): CalibrationMetric {
  switch (metric) {
    case 'accuracy': return trial.metrics.accuracy;
    case 'truth_pass_recall': return trial.metrics.truthPassRecall;
    case 'truth_fail_recall': return trial.metrics.truthFailRecall;
    case 'positive_class_precision': return trial.metrics.positiveClassPrecision;
    case 'positive_class_recall': return trial.metrics.positiveClassRecall;
    case 'positive_class_f1': return trial.metrics.positiveClassF1;
  }
}

const providerStrengthRank: Record<ProviderIdentityStrength, number> = {
  requested_only: 0,
  observed_model: 1,
  observed_fingerprint: 2,
  observed_version: 3,
};

function uniqueReasons(checks: CalibrationRequirementCheck[]): CalibrationPolicyReason[] {
  const present = new Set(checks.flatMap((entry) => entry.reason === null ? [] : [entry.reason]));
  return CALIBRATION_POLICY_REASON_ORDER.filter((reason) => present.has(reason));
}

function trialChecks(
  trial: BinaryCalibrationTrial,
  requirement: BinaryCalibrationRequirementV1,
): CalibrationRequirementCheck[] {
  const checks: CalibrationRequirementCheck[] = [];
  const requiredStrength = requirement.minimumProviderIdentityStrength;
  const weakestStrength = trial.providerIdentityGroups.reduce<ProviderIdentityStrength>(
    (weakest, group) => providerStrengthRank[group.identityStrength] < providerStrengthRank[weakest]
      ? group.identityStrength
      : weakest,
    'observed_version',
  );
  checks.push(check(
    'provider_identity_strength',
    providerStrengthRank[weakestStrength] >= providerStrengthRank[requiredStrength],
    weakestStrength,
    requiredStrength,
    'provider_identity_strength_below_minimum',
    trial.trialIndex,
  ));

  const coverage = [
    ['classified_coverage_overall', trial.metrics.classifiedCoverage.overall,
      requirement.minimumClassifiedCoverage.overall,
      'classified_coverage_overall_below_minimum'],
    ['classified_coverage_truth_pass', trial.metrics.classifiedCoverage.truthPass,
      requirement.minimumClassifiedCoverage.truthPass,
      'classified_coverage_truth_pass_below_minimum'],
    ['classified_coverage_truth_fail', trial.metrics.classifiedCoverage.truthFail,
      requirement.minimumClassifiedCoverage.truthFail,
      'classified_coverage_truth_fail_below_minimum'],
  ] as const;
  for (const [name, rate, minimum, reason] of coverage) {
    const passed = rate.state === 'defined' && compareRate(rate.numerator, rate.denominator, minimum);
    checks.push(check(
      name,
      passed,
      rate.state === 'defined' ? `${rate.numerator}/${rate.denominator}` : 'undefined',
      minimum,
      reason,
      trial.trialIndex,
    ));
  }

  for (const metricCheck of requirement.metricChecks) {
    const metric = metricForTrial(trial, metricCheck.metric);
    const defined = metric.state === 'defined';
    checks.push(check(
      'metric_defined',
      defined,
      defined ? 'defined' : 'undefined',
      'defined',
      'metric_undefined',
      trial.trialIndex,
      metricCheck.metric,
    ));
    const denominator = metric.denominator;
    checks.push(check(
      'metric_denominator',
      defined && denominator >= metricCheck.minimumDenominator,
      String(denominator),
      String(metricCheck.minimumDenominator),
      'metric_denominator_below_minimum',
      trial.trialIndex,
      metricCheck.metric,
    ));
    if (metricCheck.minimumPointEstimate !== null) {
      checks.push(check(
        'metric_point_estimate',
        defined && compareRate(metric.numerator, denominator, metricCheck.minimumPointEstimate),
        defined ? `${metric.numerator}/${denominator}` : 'undefined',
        metricCheck.minimumPointEstimate,
        defined ? 'metric_point_estimate_below_minimum' : 'metric_undefined',
        trial.trialIndex,
        metricCheck.metric,
      ));
    }
    if (metricCheck.minimumWilsonLowerBound !== null) {
      const interval = 'interval' in metric ? metric.interval : null;
      const lower = defined && interval !== null ? interval.lowerBinary64 : null;
      checks.push(check(
        'metric_wilson_lower_bound',
        lower !== null && compareBinary64ToCanonicalDecimal(
          lower,
          metricCheck.minimumWilsonLowerBound,
        ) >= 0,
        lower ?? 'undefined',
        metricCheck.minimumWilsonLowerBound,
        lower === null ? 'metric_undefined' : 'metric_wilson_lower_bound_below_minimum',
        trial.trialIndex,
        metricCheck.metric,
      ));
    }
  }
  return checks;
}

/**
 * Evaluate one artifact against customer policy. Repeated trials are never
 * pooled: every observed trial must satisfy every per-trial requirement.
 */
export function evaluateCalibrationRequirement(
  criterionVersionId: string,
  requirement: BinaryCalibrationRequirementV1 | null,
  collection: CalibrationCollectionResult,
  evaluatedAt: string,
): CalibrationPolicyResult {
  const evaluatedAtMs = exactTimestampMilliseconds(evaluatedAt);
  if (collection.criterionVersionId !== criterionVersionId) {
    throw new Error(`calibration collection criterion mismatch for ${criterionVersionId}`);
  }
  if (requirement === null) {
    return {
      criterionVersionId,
      status: 'not_required',
      admissible: true,
      evaluatedAt,
      requirement: null,
      collectionState: collection.state,
      calibrationEvidenceScope: collection.calibrationEvidenceScope,
      reasons: [],
      worstReason: null,
      checks: [],
      trials: [],
    };
  }
  const parsedRequirement = binaryCalibrationRequirementV1Schema.parse(requirement);
  if (collection.state === 'integrity_failure') {
    return {
      criterionVersionId,
      status: 'integrity_failure',
      admissible: false,
      evaluatedAt,
      requirement: parsedRequirement,
      collectionState: collection.state,
      calibrationEvidenceScope: null,
      reasons: [collection.reason],
      worstReason: collection.reason,
      checks: [],
      trials: [],
    };
  }
  const retainedCompletedAt = collection.artifact?.completedAt ??
    collection.calibrationEvidenceScope?.completedAt;
  if (retainedCompletedAt !== undefined &&
    evaluatedAtMs < exactTimestampMilliseconds(retainedCompletedAt)) {
    const ageMilliseconds = evaluatedAtMs - exactTimestampMilliseconds(retainedCompletedAt);
    const freshnessCheck = check(
      'freshness',
      false,
      String(ageMilliseconds),
      `0..${parsedRequirement.maximumAgeSeconds * 1_000}`,
      'artifact_completed_after_evaluated_at',
    );
    return {
      criterionVersionId,
      status: 'integrity_failure',
      admissible: false,
      evaluatedAt,
      requirement: parsedRequirement,
      collectionState: collection.state,
      calibrationEvidenceScope: collection.calibrationEvidenceScope,
      reasons: ['artifact_completed_after_evaluated_at'],
      worstReason: 'artifact_completed_after_evaluated_at',
      checks: [freshnessCheck],
      trials: [],
    };
  }
  if (collection.state === 'incomplete') {
    return {
      criterionVersionId,
      status: 'incomplete',
      admissible: false,
      evaluatedAt,
      requirement: parsedRequirement,
      collectionState: collection.state,
      calibrationEvidenceScope: collection.calibrationEvidenceScope,
      reasons: [collection.reason],
      worstReason: collection.reason,
      checks: [],
      trials: [],
    };
  }

  const artifact = collection.artifact;
  const checks: CalibrationRequirementCheck[] = [];
  checks.push(check(
    'truth_role',
    artifact.truth.role === parsedRequirement.requiredTruthRole,
    artifact.truth.role,
    parsedRequirement.requiredTruthRole,
    'truth_role_mismatch',
  ));
  checks.push(check(
    'truth_provenance',
    artifact.truth.provenanceLevel === parsedRequirement.requiredTruthProvenanceLevel,
    artifact.truth.provenanceLevel,
    parsedRequirement.requiredTruthProvenanceLevel,
    'truth_provenance_mismatch',
  ));
  checks.push(check(
    'positive_class',
    artifact.positiveClass === parsedRequirement.requiredPositiveClass,
    artifact.positiveClass,
    parsedRequirement.requiredPositiveClass,
    'positive_class_mismatch',
  ));
  const requiredPopulation = parsedRequirement.requiredRepresentativeOfPopulationId;
  checks.push(check(
    'representative_population',
    requiredPopulation === null || artifact.truth.representativeOfPopulationId === requiredPopulation,
    artifact.truth.representativeOfPopulationId ?? 'null',
    requiredPopulation ?? 'not_required',
    'representative_population_mismatch',
  ));

  const completedAtMs = exactTimestampMilliseconds(artifact.completedAt);
  const ageMilliseconds = evaluatedAtMs - completedAtMs;
  checks.push(check(
    'freshness',
    ageMilliseconds >= 0 &&
      ageMilliseconds <= parsedRequirement.maximumAgeSeconds * 1_000,
    String(ageMilliseconds),
    `0..${parsedRequirement.maximumAgeSeconds * 1_000}`,
    ageMilliseconds < 0 ? 'artifact_completed_after_evaluated_at' : 'artifact_too_old',
  ));
  if (ageMilliseconds < 0) {
    return {
      criterionVersionId,
      status: 'integrity_failure',
      admissible: false,
      evaluatedAt,
      requirement: parsedRequirement,
      collectionState: collection.state,
      calibrationEvidenceScope: collection.calibrationEvidenceScope,
      reasons: ['artifact_completed_after_evaluated_at'],
      worstReason: 'artifact_completed_after_evaluated_at',
      checks,
      trials: [],
    };
  }
  checks.push(check(
    'truth_support_total',
    artifact.truthSupport.total >= parsedRequirement.minimumTruthSupport.total,
    String(artifact.truthSupport.total),
    String(parsedRequirement.minimumTruthSupport.total),
    'truth_support_total_below_minimum',
  ));
  checks.push(check(
    'truth_support_pass',
    artifact.truthSupport.pass >= parsedRequirement.minimumTruthSupport.pass,
    String(artifact.truthSupport.pass),
    String(parsedRequirement.minimumTruthSupport.pass),
    'truth_support_pass_below_minimum',
  ));
  checks.push(check(
    'truth_support_fail',
    artifact.truthSupport.fail >= parsedRequirement.minimumTruthSupport.fail,
    String(artifact.truthSupport.fail),
    String(parsedRequirement.minimumTruthSupport.fail),
    'truth_support_fail_below_minimum',
  ));
  checks.push(check(
    'trial_count',
    artifact.trials.length >= parsedRequirement.trialRule.minimumTrials,
    String(artifact.trials.length),
    String(parsedRequirement.trialRule.minimumTrials),
    'trial_count_below_minimum',
  ));

  const trials = artifact.trials.map((trial): CalibrationTrialPolicyResult => {
    const trialResultChecks = trialChecks(trial, parsedRequirement);
    const reasons = uniqueReasons(trialResultChecks);
    return {
      trialIndex: trial.trialIndex,
      passed: reasons.length === 0,
      reasons,
      worstReason: worstCalibrationReason(reasons),
      checks: trialResultChecks,
    };
  });
  const reasons = uniqueReasons([
    ...checks,
    ...trials.flatMap((trial) => trial.checks),
  ]);
  const satisfied = reasons.length === 0 && trials.every((trial) => trial.passed);
  return {
    criterionVersionId,
    status: satisfied ? 'satisfied' : 'insufficient',
    admissible: satisfied,
    evaluatedAt,
    requirement: parsedRequirement,
    collectionState: collection.state,
    calibrationEvidenceScope: collection.calibrationEvidenceScope,
    reasons,
    worstReason: worstCalibrationReason(reasons),
    checks,
    trials,
  };
}

export function criterionCalibrationAdmissible(result: CalibrationPolicyResult): boolean {
  return result.status === 'not_required' || result.status === 'satisfied';
}

/** A closed reason for release admissibility; this never changes evidence trust class. */
export function calibrationReleaseAdmissibilityReason(
  result: CalibrationPolicyResult,
): CalibrationPolicyReason | null {
  return criterionCalibrationAdmissible(result) ? null : result.worstReason;
}

/** Digest the ordered, public collection projections without binding local paths. */
export function calibrationEvidenceSetDigest(
  entries: readonly CalibrationCollectionResult[],
): string {
  return sha256Digest(entries.map((entry) => ({
    criterionVersionId: entry.criterionVersionId,
    state: entry.state,
    source: entry.source === null ? null : {
      artifactDigest: entry.source.artifactDigest,
      expectedIdentity: entry.source.expectedIdentity,
    },
    observedArtifactDigest: entry.observedArtifactDigest,
    artifact: entry.artifact === null ? null : {
      artifactId: entry.artifact.artifactId,
      evidenceDigest: entry.artifact.evidenceDigest,
      status: entry.artifact.status,
    },
    calibrationEvidenceScope: entry.calibrationEvidenceScope,
    reason: entry.state === 'verified' ? null : entry.reason,
  })));
}

/** Stable JSON projection available to report parsers that cannot retain class instances. */
export function canonicalCalibrationCollectionResult(
  result: CalibrationCollectionResult,
): string {
  return canonicalJson(result);
}
