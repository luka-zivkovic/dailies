import { z } from 'zod';
import {
  candidateConfigSchema,
  DEFAULT_TIMEOUT_MS,
  inputsConfigSchema,
  scopeConfigSchema,
  trustPolicySchema,
} from './config.js';
import { suiteProviderConfigSchema } from './config-v5.js';
import { releasePolicyV2Schema } from './policy-v2.js';

export const SUITE_CONFIG_V6_SCHEMA_VERSION = 6;

const nonBlankStringSchema = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must contain a non-whitespace character',
});
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * The complete identity Dailies expects the Coeval artifact to prove. Keeping
 * this explicit prevents a digest-valid artifact for another evaluator,
 * sealed revision, exposure snapshot, provider policy, or suite position from
 * becoming admissible release evidence.
 */
export const expectedBinaryCalibrationIdentitySchema = z.object({
  artifactId: nonBlankStringSchema,
  calibrationRunId: nonBlankStringSchema,
  projectId: nonBlankStringSchema,
  criterionId: nonBlankStringSchema,
  criterionVersionId: nonBlankStringSchema,
  criterionDigest: digestSchema,
  skillId: nonBlankStringSchema,
  skillVersionId: nonBlankStringSchema,
  skillDigest: digestSchema,
  outputContractDigest: digestSchema,
  requestedBindingDigest: digestSchema,
  datasetRevisionId: nonBlankStringSchema,
  revisionDigest: digestSchema,
  contentDigest: digestSchema,
  itemCount: z.number().int().positive().max(5_000),
  governedReviewBatchId: nonBlankStringSchema,
  governedReviewBatchDigest: digestSchema,
  reviewInstructionVersionId: nonBlankStringSchema,
  reviewInstructionDigest: digestSchema,
  populationId: nonBlankStringSchema,
  populationDigest: digestSchema,
  drawDigest: digestSchema,
  representativeOfPopulationId: nonBlankStringSchema.nullable(),
  selectionMethod: z.enum([
    'simple_random',
    'systematic',
    'stratified_random',
    'convenience',
    'uncertainty',
    'failure_hunting',
    'manual',
  ]),
  exposureAuthorizationSnapshotDigest: digestSchema,
  exposureAuthorizationEventId: nonBlankStringSchema,
  exposureCompletionSnapshotDigest: digestSchema,
  exposureCompletionEventId: nonBlankStringSchema,
  exposureCompletionState: z.enum(['protected', 'exposed']),
  exposureCompletionEligibility: z.enum(['eligible', 'ineligible']),
  executionEnvironment: z.enum(['external_provider', 'self_hosted_provider', 'local_provider']),
  providerDataHandlingPolicyId: nonBlankStringSchema,
  providerDataHandlingPolicyDigest: digestSchema,
  positiveClass: z.enum(['pass', 'fail']),
  trialPlanKind: z.enum(['single', 'independent_repetitions']),
  trialsPerItem: z.number().int().min(1).max(10),
  suiteManifestId: nonBlankStringSchema.nullable(),
  suiteManifestDigest: digestSchema.nullable(),
  suiteMemberPosition: z.number().int().min(0).max(99).nullable(),
}).strict().superRefine((identity, ctx) => {
  if (identity.trialPlanKind === 'single' && identity.trialsPerItem !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['trialsPerItem'],
      message: 'single trial identity requires trialsPerItem 1',
    });
  }
  if (identity.trialPlanKind === 'independent_repetitions' && identity.trialsPerItem < 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['trialsPerItem'],
      message: 'independent repetitions require at least two trials',
    });
  }
  const suiteValues = [
    identity.suiteManifestId,
    identity.suiteManifestDigest,
    identity.suiteMemberPosition,
  ];
  const present = suiteValues.filter((value) => value !== null).length;
  if (present !== 0 && present !== suiteValues.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['suiteManifestId'],
      message: 'suite identity fields must be all null or all present',
    });
  }
});

export const calibrationEvidenceFileSourceSchema = z.object({
  type: z.literal('file'),
  path: z.string().min(1),
  /** SHA-256 of the exact canonical artifact bytes read by Dailies. */
  artifactDigest: digestSchema,
  expectedIdentity: expectedBinaryCalibrationIdentitySchema,
}).strict();

export const calibrationEvidenceBindingSchema = z.object({
  criterionVersionId: nonBlankStringSchema,
  source: calibrationEvidenceFileSourceSchema.nullable(),
}).strict();

/** Additive suite configuration; schema v5 remains unchanged and supported. */
export const suiteConfigV6Schema = z.object({
  schemaVersion: z.literal(SUITE_CONFIG_V6_SCHEMA_VERSION),
  inputs: inputsConfigSchema,
  scope: scopeConfigSchema,
  candidate: candidateConfigSchema,
  suite: z.object({
    manifest: z.object({
      type: z.literal('file'),
      path: z.string().min(1),
      manifestId: nonBlankStringSchema,
      manifestDigest: digestSchema,
    }).strict(),
    provider: suiteProviderConfigSchema,
  }).strict(),
  policy: releasePolicyV2Schema,
  calibrationEvidence: z.array(calibrationEvidenceBindingSchema).min(1),
  trustPolicy: trustPolicySchema.default({
    admissibleClasses: ['verified', 'deterministic'],
  }),
  concurrency: z.number().int().min(1).default(4),
  timeoutMs: z.number().int().min(1).default(DEFAULT_TIMEOUT_MS),
  output: z.object({ dir: z.string().min(1) }).strict(),
}).strict().superRefine((config, ctx) => {
  const criterionIds = config.policy.criteria.map((entry) => entry.criterionVersionId);
  if (config.calibrationEvidence.length !== criterionIds.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['calibrationEvidence'],
      message: 'calibrationEvidence must have exact policy criterion coverage',
    });
    return;
  }
  for (const [index, criterionVersionId] of criterionIds.entries()) {
    const binding = config.calibrationEvidence[index];
    if (binding?.criterionVersionId !== criterionVersionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['calibrationEvidence', index, 'criterionVersionId'],
        message: 'calibrationEvidence must follow policy criterion order',
      });
    }
    if (binding?.source !== null &&
      binding?.source.expectedIdentity.criterionVersionId !== criterionVersionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['calibrationEvidence', index, 'source', 'expectedIdentity', 'criterionVersionId'],
        message: 'calibration source identity must match its criterion binding',
      });
    }
    // A null source is deliberately valid even when policy requires
    // calibration. Runtime retains that explicit absence as typed incomplete
    // evidence rather than turning it into a configuration integrity error.
  }
});

export type ExpectedBinaryCalibrationIdentityConfig = z.infer<
  typeof expectedBinaryCalibrationIdentitySchema
>;
export type CalibrationEvidenceFileSource = z.infer<typeof calibrationEvidenceFileSourceSchema>;
export type CalibrationEvidenceBinding = z.infer<typeof calibrationEvidenceBindingSchema>;
export type SuiteConfigV6 = z.infer<typeof suiteConfigV6Schema>;

export function parseSuiteConfigV6(raw: unknown): SuiteConfigV6 {
  const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== SUITE_CONFIG_V6_SCHEMA_VERSION) {
    throw new Error(
      `unsupported suite config schema version: ${version === undefined ? 'missing' : String(version)}; ` +
      `calibration-aware criterion release execution requires schemaVersion ${SUITE_CONFIG_V6_SCHEMA_VERSION}`,
    );
  }
  return suiteConfigV6Schema.parse(raw);
}
