import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  compareExactRationals,
  parseCanonicalDecimalRational,
} from './binary-calibration-v2.js';
import { canonicalJson } from './rubrist-canonical.js';
import {
  applyReleasePolicy,
  binaryThresholdRuleSchema,
  compensationFormulaSchema,
  passRateOperandRuleSchema,
  verifyReleasePolicy,
  type CompensationResult,
  type CriterionPolicyInput,
  type CriterionPolicyResult,
  type DecisionPrecedence,
  type ReleasePolicyV1,
} from './policy.js';
import type {
  CalibrationPolicyResult,
} from './calibration-policy.js';
import type { EvaluatorSuiteManifestV2 } from './suite-manifest-v2.js';

const nonBlankStringSchema = z.string().min(1).refine((value) => value.trim().length > 0);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const canonicalDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const canonicalUnitIntervalDecimalSchema = z.string()
  .max(32)
  .regex(canonicalDecimalPattern)
  .superRefine((value, ctx) => {
    // Zod continues refinements after a preceding regex issue. Guard the exact
    // parser so malformed customer input remains a normal schema rejection.
    if (value.length > 32 || !canonicalDecimalPattern.test(value)) return;
    if (compareExactRationals(
      parseCanonicalDecimalRational(value),
      { numerator: 1n, denominator: 1n },
    ) > 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a canonical decimal in [0,1]' });
    }
  });

export const providerIdentityStrengthSchema = z.enum([
  'requested_only',
  'observed_model',
  'observed_fingerprint',
  'observed_version',
]);

export const calibrationMetricNameSchema = z.enum([
  'accuracy',
  'truth_pass_recall',
  'truth_fail_recall',
  'positive_class_precision',
  'positive_class_recall',
  'positive_class_f1',
]);

const calibrationMetricCheckSchema = z.object({
  metric: calibrationMetricNameSchema,
  minimumDenominator: z.number().int().min(1).max(10_000),
  minimumPointEstimate: canonicalUnitIntervalDecimalSchema.nullable(),
  minimumWilsonLowerBound: canonicalUnitIntervalDecimalSchema.nullable(),
}).strict().superRefine((check, ctx) => {
  if (check.minimumPointEstimate === null && check.minimumWilsonLowerBound === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'metric check requires a point-estimate or Wilson-lower threshold',
    });
  }
  if (check.metric === 'positive_class_f1' && check.minimumWilsonLowerBound !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['minimumWilsonLowerBound'],
      message: 'positive_class_f1 has no Wilson interval in binary calibration',
    });
  }
});

export const binaryCalibrationRequirementV1Schema = z.object({
  contract: z.literal('dailies/binary-calibration-requirement/v1'),
  requiredTruthRole: z.literal('sealed_validation'),
  requiredTruthProvenanceLevel: z.literal('governed_blind'),
  requiredPositiveClass: z.enum(['pass', 'fail']),
  /** Null means policy does not require a population-representativeness claim. */
  requiredRepresentativeOfPopulationId: nonBlankStringSchema.nullable(),
  trialRule: z.object({
    kind: z.literal('all_trials_meet/v1'),
    minimumTrials: z.number().int().min(1).max(10),
  }).strict(),
  maximumAgeSeconds: z.number().int().min(0).max(315_576_000),
  minimumProviderIdentityStrength: providerIdentityStrengthSchema,
  minimumTruthSupport: z.object({
    total: z.number().int().min(1).max(5_000),
    pass: z.number().int().min(0).max(5_000),
    fail: z.number().int().min(0).max(5_000),
  }).strict(),
  minimumClassifiedCoverage: z.object({
    overall: canonicalUnitIntervalDecimalSchema,
    truthPass: canonicalUnitIntervalDecimalSchema,
    truthFail: canonicalUnitIntervalDecimalSchema,
  }).strict(),
  metricChecks: z.array(calibrationMetricCheckSchema).min(1).max(6),
}).strict().superRefine((requirement, ctx) => {
  const metrics = requirement.metricChecks.map((check) => check.metric);
  if (new Set(metrics).size !== metrics.length) {
    ctx.addIssue({ code: 'custom', path: ['metricChecks'], message: 'metric checks must be unique' });
  }
});

const blockingCriterionPolicyV2Schema = z.object({
  criterionVersionId: nonBlankStringSchema,
  evidenceRequirement: z.literal('mandatory'),
  consequence: z.literal('blocking'),
  rule: binaryThresholdRuleSchema,
  calibrationRequirement: binaryCalibrationRequirementV1Schema.nullable(),
}).strict();

const advisoryCriterionPolicyV2Schema = z.object({
  criterionVersionId: nonBlankStringSchema,
  evidenceRequirement: z.enum(['mandatory', 'optional']),
  consequence: z.literal('advisory'),
  rule: binaryThresholdRuleSchema,
  calibrationRequirement: binaryCalibrationRequirementV1Schema.nullable(),
}).strict();

const compensatoryCriterionPolicyV2Schema = z.object({
  criterionVersionId: nonBlankStringSchema,
  evidenceRequirement: z.literal('mandatory'),
  consequence: z.literal('compensatory'),
  compensationGroupId: nonBlankStringSchema,
  rule: passRateOperandRuleSchema,
  calibrationRequirement: binaryCalibrationRequirementV1Schema.nullable(),
}).strict();

export const criterionPolicyV2Schema = z.discriminatedUnion('consequence', [
  blockingCriterionPolicyV2Schema,
  advisoryCriterionPolicyV2Schema,
  compensatoryCriterionPolicyV2Schema,
]);

export const releasePolicyV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: nonBlankStringSchema,
  version: nonBlankStringSchema,
  manifestId: nonBlankStringSchema,
  manifestDigest: digestSchema,
  criteria: z.array(criterionPolicyV2Schema).min(1),
  compensationGroups: z.array(z.object({
    id: nonBlankStringSchema,
    formula: compensationFormulaSchema,
  }).strict()).default([]),
}).strict();

export type ProviderIdentityStrength = z.infer<typeof providerIdentityStrengthSchema>;
export type CalibrationMetricName = z.infer<typeof calibrationMetricNameSchema>;
export type BinaryCalibrationRequirementV1 = z.infer<typeof binaryCalibrationRequirementV1Schema>;
export type CriterionPolicyV2 = z.infer<typeof criterionPolicyV2Schema>;
export type ReleasePolicyV2 = z.infer<typeof releasePolicyV2Schema>;

export function releasePolicyV2CandidateProjection(policy: ReleasePolicyV2): ReleasePolicyV1 {
  return {
    schemaVersion: 1,
    id: policy.id,
    version: policy.version,
    manifestId: policy.manifestId,
    manifestDigest: policy.manifestDigest,
    criteria: policy.criteria.map(({ calibrationRequirement: _excluded, ...criterion }) => criterion),
    compensationGroups: policy.compensationGroups,
  };
}

export function verifyReleasePolicyV2(
  raw: unknown,
  manifest: EvaluatorSuiteManifestV2,
): ReleasePolicyV2 {
  const policy = releasePolicyV2Schema.parse(raw);
  verifyReleasePolicy(releasePolicyV2CandidateProjection(policy), manifest);
  return policy;
}

export function releasePolicyV2Digest(policy: ReleasePolicyV2): string {
  return `sha256:${createHash('sha256').update(canonicalJson(policy)).digest('hex')}`;
}

export interface CriterionPolicyResultV2 extends CriterionPolicyResult {
  calibrationRequirement: BinaryCalibrationRequirementV1 | null;
  calibration: CalibrationPolicyResult;
  /** Candidate trust and calibration are separate inputs to this combined value. */
  releaseAdmissible: boolean;
}

export interface PolicyDecisionV2 {
  decision: 'promote' | 'block' | 'inconclusive';
  precedence: DecisionPrecedence;
  criteria: CriterionPolicyResultV2[];
  compensation: CompensationResult[];
}

function isRequiredCriterion(entry: CriterionPolicyV2): boolean {
  // V2 preserves v1's closed roles: blocking and compensatory entries are
  // structurally mandatory, while only advisory entries can be optional.
  return entry.evidenceRequirement === 'mandatory';
}

function calibrationSatisfied(result: CalibrationPolicyResult): boolean {
  return result.status === 'not_required' || result.status === 'satisfied';
}

/**
 * Apply v1 candidate policy with calibration as a separate admissibility
 * condition. In particular, an otherwise blocking assessment can block only
 * when that criterion's own calibration requirement is satisfied.
 */
export function applyReleasePolicyV2(
  policy: ReleasePolicyV2,
  evidence: CriterionPolicyInput[],
  calibration: CalibrationPolicyResult[],
  candidateExecutionFailed: boolean,
  candidateIntegrityFailure = false,
): PolicyDecisionV2 {
  const calibrationById = new Map(calibration.map((entry) => [entry.criterionVersionId, entry]));
  if (calibrationById.size !== calibration.length || calibration.length !== policy.criteria.length) {
    throw new Error('policy v2 evaluation requires exact unique calibration-result coverage');
  }
  const evidenceById = new Map(evidence.map((entry) => [entry.criterionVersionId, entry]));
  if (evidenceById.size !== evidence.length || evidence.length !== policy.criteria.length) {
    throw new Error('policy v2 evaluation requires exact unique criterion-evidence coverage');
  }

  const effectiveEvidence = policy.criteria.map((entry): CriterionPolicyInput => {
    const input = evidenceById.get(entry.criterionVersionId);
    const calibrationResult = calibrationById.get(entry.criterionVersionId);
    if (input === undefined) throw new Error(`missing criterion evidence ${entry.criterionVersionId}`);
    if (calibrationResult === undefined) {
      throw new Error(`missing calibration result ${entry.criterionVersionId}`);
    }
    if (canonicalJson(calibrationResult.requirement) !== canonicalJson(entry.calibrationRequirement)) {
      throw new Error(`calibration requirement mismatch for ${entry.criterionVersionId}`);
    }
    if (entry.calibrationRequirement === null && calibrationResult.status !== 'not_required') {
      throw new Error(`unexpected calibration evaluation for ${entry.criterionVersionId}`);
    }
    if (entry.calibrationRequirement !== null && calibrationResult.status === 'not_required') {
      throw new Error(`required calibration was not evaluated for ${entry.criterionVersionId}`);
    }
    if (calibrationResult.admissible !== calibrationSatisfied(calibrationResult)) {
      throw new Error(`calibration admissibility mismatch for ${entry.criterionVersionId}`);
    }
    return {
      ...input,
      trustAdmissible: input.trustAdmissible && calibrationSatisfied(calibrationResult),
    };
  });

  const requiredCalibrationIntegrityFailure = policy.criteria.some((entry) =>
    isRequiredCriterion(entry) &&
    calibrationById.get(entry.criterionVersionId)?.status === 'integrity_failure');
  const base = applyReleasePolicy(
    releasePolicyV2CandidateProjection(policy),
    effectiveEvidence,
    candidateExecutionFailed,
    candidateIntegrityFailure || requiredCalibrationIntegrityFailure,
  );
  const baseById = new Map(base.criteria.map((entry) => [entry.criterionVersionId, entry]));
  const criteria = policy.criteria.map((entry): CriterionPolicyResultV2 => {
    const input = evidenceById.get(entry.criterionVersionId)!;
    const calibrationResult = calibrationById.get(entry.criterionVersionId)!;
    const evaluated = baseById.get(entry.criterionVersionId)!;
    return {
      ...input,
      evidenceRequirement: entry.evidenceRequirement,
      consequence: entry.consequence,
      rulePassed: evaluated.rulePassed,
      calibrationRequirement: entry.calibrationRequirement,
      calibration: calibrationResult,
      releaseAdmissible: input.trustAdmissible && calibrationSatisfied(calibrationResult),
    };
  });
  return {
    decision: base.decision,
    precedence: base.precedence,
    criteria,
    compensation: base.compensation,
  };
}
