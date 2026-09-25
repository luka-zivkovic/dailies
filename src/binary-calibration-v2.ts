import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, sha256Digest } from './rubrist.js';
import { rubristEvaluatorIdentitySchema, rubristSkillDigestV2 } from './rubrist-v2.js';

// Rubrist binary calibration v2 (contracts/binary-calibration-v2.md), verified
// independently of Rubrist's runtime. It keeps every v1 rule except what
// Rubrist ADR-0014 changes: the evaluator is the v2 evaluator identity with
// skillDigest and requestedBindingDigest recomputed from it, errors use the
// shared failure taxonomy, never-attempted items are `notAttempted`, provider
// groups record the OpenRouter upstream, and a typed-question evaluator never
// abstains. Dailies ADR-0008: this module replaces binary-calibration.ts,
// with the same export names, when Rubrist emits v2.

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_PUBLIC_STRING_CODE_POINTS = 4_096;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_OBJECT_PROPERTIES = 100;
const MAX_JSON_ARRAY_ITEMS = 5_000;
const MAX_SAFE_COUNT = 5_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BINARY64_PATTERN = /^[a-f0-9]{16}$/;
const UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const WILSON_Z_BITS = '3fff5c0331eeff84';

export type BinaryCalibrationIntegrityCode =
  | 'invalid_bytes'
  | 'invalid_json'
  | 'invalid_structure'
  | 'noncanonical_bytes'
  | 'invalid_domain'
  | 'digest_mismatch'
  | 'identity_mismatch'
  | 'semantic_mismatch';

/** A malformed or unexpectedly bound artifact, distinct from operational absence. */
export class BinaryCalibrationIntegrityError extends Error {
  readonly code: BinaryCalibrationIntegrityCode;

  constructor(code: BinaryCalibrationIntegrityCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BinaryCalibrationIntegrityError';
    this.code = code;
  }
}

function hasUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function codePointLength(value: string): number {
  return [...value].length;
}

const publicStringSchema = z.string().superRefine((value, ctx) => {
  if (value.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'string must not be empty' });
  }
  if (!hasUnicodeScalarValues(value)) {
    ctx.addIssue({ code: 'custom', message: 'string contains a lone surrogate' });
  }
  if (codePointLength(value) > MAX_PUBLIC_STRING_CODE_POINTS) {
    ctx.addIssue({ code: 'custom', message: 'string exceeds 4096 Unicode code points' });
  }
});
const digestSchema = z.string().regex(DIGEST_PATTERN);
const binary64BitsSchema = z.string().regex(BINARY64_PATTERN);
const utcMillisecondsSchema = z.string().regex(UTC_MILLISECONDS_PATTERN);
const safeIntegerSchema = z.number().int().min(0).max(MAX_SAFE_INTEGER);
const countSchema = z.number().int().min(0).max(MAX_SAFE_COUNT);
const positiveCountSchema = z.number().int().min(1).max(MAX_SAFE_COUNT);
const metricComponentSchema = z.number().int().min(0).max(10_000);

const lineageSchema = z.object({
  artifactRevision: z.number().int().min(1).max(MAX_SAFE_INTEGER),
  predecessorArtifactId: publicStringSchema.nullable(),
  correctionReason: publicStringSchema.nullable(),
}).strict();

const criterionSchema = z.object({
  criterionId: publicStringSchema,
  criterionVersionId: publicStringSchema,
  criterionDigest: digestSchema,
}).strict();

const evaluatorSchema = z.object({
  skillId: publicStringSchema,
  skillVersionId: publicStringSchema,
  // The same object receipt v2 carries as `evaluator`: basis, definition digest, execution binding.
  identity: rubristEvaluatorIdentitySchema,
  skillDigest: digestSchema,
  outputContractDigest: digestSchema,
  requestedBindingDigest: digestSchema,
}).strict();

const suiteBindingSchema = z.object({
  manifestId: publicStringSchema,
  manifestDigest: digestSchema,
  memberPosition: z.number().int().min(0).max(99),
}).strict();

const truthOriginSchema = z.object({
  governedReviewBatchId: publicStringSchema,
  governedReviewBatchDigest: digestSchema,
  reviewInstructionVersionId: publicStringSchema,
  reviewInstructionDigest: digestSchema,
  populationId: publicStringSchema,
  populationDigest: digestSchema,
  drawDigest: digestSchema,
}).strict();

const representativeReasonSchema = z.enum([
  'selection_method_not_eligible',
  'population_frame_incomplete',
  'collection_provenance_unverified',
  'draw_not_server_executed',
  'draw_not_reproducible',
  'fixed_budget_mismatch',
  'strata_incomplete',
  'review_coverage_incomplete',
  'deferred_assignments',
  'cannot_determine_present',
  'unresolved_items',
]);

const truthSchema = z.object({
  datasetRevisionId: publicStringSchema,
  revisionDigest: digestSchema,
  contentDigest: digestSchema,
  itemCount: positiveCountSchema,
  role: z.literal('sealed_validation'),
  sourceKind: z.literal('sealed_intake'),
  provenanceLevel: z.literal('governed_blind'),
  semanticLeakageDetection: z.literal('unsupported'),
  representativeOfPopulationId: publicStringSchema.nullable(),
  representativeIneligibleReasons: z.array(representativeReasonSchema).max(11),
  selectionMethod: z.enum([
    'simple_random',
    'systematic',
    'stratified_random',
    'convenience',
    'uncertainty',
    'failure_hunting',
    'manual',
  ]),
  origin: truthOriginSchema,
}).strict();

const exposureSnapshotSchema = z.object({
  state: z.enum(['protected', 'exposed']),
  snapshotDigest: digestSchema,
  eventId: publicStringSchema,
  recordedAt: utcMillisecondsSchema,
}).strict();

const completionEligibilitySchema = z.object({
  result: z.enum(['eligible', 'ineligible']),
  reasons: z.array(z.enum([
    'authorization_snapshot_changed',
    'development_exposure_detected',
    'evaluator_reuse_ineligible',
    'exposure_state_unknown',
  ])).max(4),
}).strict();

const completionExposureSchema = exposureSnapshotSchema.extend({
  eligibility: completionEligibilitySchema,
}).strict();

const executionSchema = z.object({
  definitionVersion: z.literal('sealed-binary-calibration-execution/v1'),
  providerDataHandling: z.object({
    executionEnvironment: z.enum(['external_provider', 'self_hosted_provider', 'local_provider']),
    policyId: publicStringSchema,
    policyDigest: digestSchema,
    payloadTransmission: z.literal('sealed_payload_to_pinned_provider'),
  }).strict(),
}).strict();

const trialPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), trialsPerItem: z.literal(1) }).strict(),
  z.object({
    kind: z.literal('independent_repetitions'),
    trialsPerItem: z.number().int().min(2).max(10),
  }).strict(),
]);

const truthSupportSchema = z.object({
  total: positiveCountSchema,
  pass: countSchema,
  fail: countSchema,
}).strict();

const outcomeCountsSchema = z.object({
  classified: countSchema,
  abstained: countSchema,
  errored: countSchema,
  notAttempted: countSchema,
}).strict();

const errorCodeSchema = z.enum([
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
]);

const outcomesSchema = z.object({
  planned: positiveCountSchema,
  classified: countSchema,
  abstained: countSchema,
  errored: countSchema,
  notAttempted: countSchema,
  providerCalls: safeIntegerSchema,
  byTruth: z.object({ pass: outcomeCountsSchema, fail: outcomeCountsSchema }).strict(),
  errors: z.array(z.object({ code: errorCodeSchema, count: positiveCountSchema }).strict()).max(10),
}).strict();

const confusionMatrixSchema = z.object({
  truthPassEvaluatorPass: countSchema,
  truthPassEvaluatorFail: countSchema,
  truthFailEvaluatorPass: countSchema,
  truthFailEvaluatorFail: countSchema,
}).strict();

const definedWilsonRateSchema = z.object({
  state: z.literal('defined'),
  numerator: countSchema,
  denominator: positiveCountSchema,
  interval: z.object({
    method: z.literal('wilson-score/v1'),
    confidenceBasisPoints: z.literal(9500),
    lowerBinary64: binary64BitsSchema,
    upperBinary64: binary64BitsSchema,
  }).strict(),
}).strict();

const undefinedWilsonRateSchema = z.object({
  state: z.literal('undefined'),
  numerator: z.literal(0),
  denominator: z.literal(0),
  undefinedReason: z.literal('zero_denominator'),
  interval: z.null(),
}).strict();

const wilsonRateSchema = z.discriminatedUnion('state', [
  definedWilsonRateSchema,
  undefinedWilsonRateSchema,
]);

const exactRateSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('defined'),
    numerator: metricComponentSchema,
    denominator: z.number().int().min(1).max(10_000),
  }).strict(),
  z.object({
    state: z.literal('undefined'),
    numerator: metricComponentSchema,
    denominator: metricComponentSchema,
    undefinedReason: z.enum(['zero_denominator', 'no_positive_truth_support']),
  }).strict(),
]);

const metricsSchema = z.object({
  accuracy: wilsonRateSchema,
  truthPassRecall: wilsonRateSchema,
  truthFailRecall: wilsonRateSchema,
  positiveClassPrecision: wilsonRateSchema,
  positiveClassRecall: wilsonRateSchema,
  positiveClassF1: exactRateSchema,
  classifiedCoverage: z.object({
    overall: wilsonRateSchema,
    truthPass: wilsonRateSchema,
    truthFail: wilsonRateSchema,
  }).strict(),
}).strict();

const providerIdentityGroupSchema = z.object({
  provider: publicStringSchema,
  observedModel: publicStringSchema.nullable(),
  observedVersion: publicStringSchema.nullable(),
  systemFingerprint: publicStringSchema.nullable(),
  // The OpenRouter upstream that served the calls; null for every other provider.
  upstreamProvider: publicStringSchema.nullable(),
  identityStrength: z.enum([
    'observed_version',
    'observed_fingerprint',
    'observed_model',
    'requested_only',
  ]),
  observationCount: positiveCountSchema,
}).strict();

const trialSchema = z.object({
  trialIndex: z.number().int().min(0).max(9),
  status: z.enum(['complete', 'incomplete']),
  outcomes: outcomesSchema,
  confusionMatrix: confusionMatrixSchema,
  errorDirections: z.object({ falsePass: countSchema, falseFail: countSchema }).strict(),
  metrics: metricsSchema,
  providerIdentityGroups: z.array(providerIdentityGroupSchema).min(1).max(5_000),
}).strict();

export const binaryCalibrationArtifactSchema = z.object({
  contract: z.literal('rubrist/binary-calibration/v2'),
  schemaVersion: z.literal(2),
  canonicalizationVersion: z.literal('rubrist-canonical-json/v1'),
  artifactId: publicStringSchema,
  calibrationRunId: publicStringSchema,
  projectId: publicStringSchema,
  lineage: lineageSchema,
  status: z.enum(['complete', 'incomplete']),
  incompleteReasons: z.array(z.enum([
    'trial_incomplete',
    'completion_exposure_exposed',
    'completion_exposure_ineligible',
  ])).max(3),
  createdAt: utcMillisecondsSchema,
  startedAt: utcMillisecondsSchema,
  completedAt: utcMillisecondsSchema,
  criterion: criterionSchema,
  evaluator: evaluatorSchema,
  suiteBinding: suiteBindingSchema.nullable(),
  truth: truthSchema,
  exposure: z.object({
    authorization: exposureSnapshotSchema.extend({ state: z.literal('protected') }).strict(),
    completion: completionExposureSchema,
  }).strict(),
  execution: executionSchema,
  positiveClass: z.enum(['pass', 'fail']),
  errorDirectionDefinitions: z.object({
    falsePass: z.literal('evaluator_pass_when_truth_fail'),
    falseFail: z.literal('evaluator_fail_when_truth_pass'),
  }).strict(),
  metricDefinitionVersion: z.literal('binary-classification/v1'),
  intervalDefinitionVersion: z.literal('wilson-score/v1'),
  trialPlan: trialPlanSchema,
  truthSupport: truthSupportSchema,
  privateLedger: z.object({
    contract: z.literal('rubrist/binary-calibration-private-ledger/v2'),
    commitmentDigest: digestSchema,
  }).strict(),
  trials: z.array(trialSchema).min(1).max(10),
  evidenceDigest: digestSchema,
}).strict();

export type BinaryCalibrationArtifact = z.infer<typeof binaryCalibrationArtifactSchema>;
export type BinaryCalibrationTrial = BinaryCalibrationArtifact['trials'][number];

export interface ExpectedBinaryCalibrationIdentity {
  artifactId: string;
  calibrationRunId: string;
  projectId: string;
  criterionId: string;
  criterionVersionId: string;
  criterionDigest: string;
  skillId: string;
  skillVersionId: string;
  skillDigest: string;
  outputContractDigest: string;
  requestedBindingDigest: string;
  datasetRevisionId: string;
  revisionDigest: string;
  contentDigest: string;
  itemCount: number;
  governedReviewBatchId: string;
  governedReviewBatchDigest: string;
  reviewInstructionVersionId: string;
  reviewInstructionDigest: string;
  populationId: string;
  populationDigest: string;
  drawDigest: string;
  representativeOfPopulationId: string | null;
  selectionMethod: BinaryCalibrationArtifact['truth']['selectionMethod'];
  exposureAuthorizationSnapshotDigest: string;
  exposureAuthorizationEventId: string;
  exposureCompletionSnapshotDigest: string;
  exposureCompletionEventId: string;
  exposureCompletionState: BinaryCalibrationArtifact['exposure']['completion']['state'];
  exposureCompletionEligibility: BinaryCalibrationArtifact['exposure']['completion']['eligibility']['result'];
  executionEnvironment: BinaryCalibrationArtifact['execution']['providerDataHandling']['executionEnvironment'];
  providerDataHandlingPolicyId: string;
  providerDataHandlingPolicyDigest: string;
  positiveClass: BinaryCalibrationArtifact['positiveClass'];
  trialPlanKind: BinaryCalibrationArtifact['trialPlan']['kind'];
  trialsPerItem: number;
  suiteManifestId: string | null;
  suiteManifestDigest: string | null;
  suiteMemberPosition: number | null;
}

export interface ExactRational {
  numerator: bigint;
  denominator: bigint;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function normalizeRational(value: ExactRational): ExactRational {
  if (value.denominator <= 0n) throw new Error('rational denominator must be positive');
  if (value.numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(value.numerator, value.denominator);
  return {
    numerator: value.numerator / divisor,
    denominator: value.denominator / divisor,
  };
}

export function parseCanonicalDecimalRational(value: string): ExactRational {
  if (value.length > 32 || !CANONICAL_DECIMAL_PATTERN.test(value)) {
    throw new BinaryCalibrationIntegrityError('invalid_domain', 'invalid canonical decimal string');
  }
  const [whole, fractional = ''] = value.split('.');
  return normalizeRational({
    numerator: BigInt(`${whole}${fractional}`),
    denominator: 10n ** BigInt(fractional.length),
  });
}

export function decodeNonnegativeBinary64Rational(bits: string): ExactRational {
  if (!BINARY64_PATTERN.test(bits)) {
    throw new BinaryCalibrationIntegrityError('invalid_domain', 'invalid binary64 bit string');
  }
  const raw = BigInt(`0x${bits}`);
  const sign = raw >> 63n;
  const exponent = Number((raw >> 52n) & 0x7ffn);
  const fraction = raw & ((1n << 52n) - 1n);
  if (sign !== 0n) {
    throw new BinaryCalibrationIntegrityError('invalid_domain', 'binary64 value has a sign bit or negative zero');
  }
  if (exponent === 0x7ff) {
    throw new BinaryCalibrationIntegrityError('invalid_domain', 'binary64 value is NaN or infinite');
  }
  if (exponent === 0 && fraction === 0n) return { numerator: 0n, denominator: 1n };
  const significand = exponent === 0 ? fraction : (1n << 52n) + fraction;
  const power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  const rational = power >= 0
    ? { numerator: significand << BigInt(power), denominator: 1n }
    : { numerator: significand, denominator: 1n << BigInt(-power) };
  const normalized = normalizeRational(rational);
  if (normalized.numerator > normalized.denominator) {
    throw new BinaryCalibrationIntegrityError('invalid_domain', 'binary64 value is outside [0,1]');
  }
  return normalized;
}

export function compareExactRationals(left: ExactRational, right: ExactRational): -1 | 0 | 1 {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** Compare an exact binary64 Wilson bound with a canonical decimal policy value. */
export function compareBinary64ToCanonicalDecimal(bits: string, decimal: string): -1 | 0 | 1 {
  return compareExactRationals(
    decodeNonnegativeBinary64Rational(bits),
    parseCanonicalDecimalRational(decimal),
  );
}

function numberToBinary64Bits(value: number): string {
  const bytes = new ArrayBuffer(8);
  new DataView(bytes).setFloat64(0, value, false);
  return Buffer.from(bytes).toString('hex');
}

function binary64BitsToNumber(bits: string): number {
  const bytes = Buffer.from(bits, 'hex');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, false);
}

export function wilsonScoreBinary64(x: number, n: number): {
  lowerBinary64: string;
  upperBinary64: string;
} {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(n) || n <= 0 || x < 0 || x > n) {
    throw new BinaryCalibrationIntegrityError('invalid_domain', 'Wilson inputs require 0 <= x <= n');
  }
  const z = binary64BitsToNumber(WILSON_Z_BITS);
  const zSquared = z * z;
  const adjustedDenominator = n + zSquared;
  const centerNumerator = x + (zSquared / 2);
  const remaining = n - x;
  const product = x * remaining;
  const scaledProduct = product / n;
  const correction = zSquared / 4;
  const radicand = scaledProduct + correction;
  const root = Math.sqrt(radicand);
  const marginNumerator = z * root;
  const lowerRaw = (centerNumerator - marginNumerator) / adjustedDenominator;
  const upperRaw = (centerNumerator + marginNumerator) / adjustedDenominator;
  const lower = x === 0 ? 0 : Math.max(0, lowerRaw);
  const upper = x === n ? 1 : Math.min(1, upperRaw);
  return {
    lowerBinary64: numberToBinary64Bits(lower),
    upperBinary64: numberToBinary64Bits(upper),
  };
}

function assertSortedUnique(values: string[], what: string): void {
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (new Set(values).size !== values.length) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      what === 'error breakdown' ? `${what} has duplicate codes` : `${what} has duplicate values`,
    );
  }
  if (values.some((value, index) => value !== sorted[index])) {
    throw new BinaryCalibrationIntegrityError('semantic_mismatch', `${what} is not ordered`);
  }
}

function assertExactCalendarTimestamp(value: string): void {
  if (!UTC_MILLISECONDS_PATTERN.test(value) || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      `${value} is not an exact calendar timestamp`,
    );
  }
}

// The only numbers that may be fractional: the execution binding's sampling
// settings, serialized as ECMAScript does, exactly as in receipt v2.
const SAMPLING_PATHS = new Set([
  'evaluator.identity.executionBinding.sampling.temperature',
  'evaluator.identity.executionBinding.sampling.topP',
]);

function validatePublicJsonDomain(value: unknown, depth = 0, path = ''): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new BinaryCalibrationIntegrityError('invalid_domain', 'artifact JSON exceeds depth 32');
  }
  if (typeof value === 'number') {
    const fractionAllowed = SAMPLING_PATHS.has(path);
    if (!Number.isFinite(value) || (!fractionAllowed && !Number.isSafeInteger(value)) || value < 0) {
      throw new BinaryCalibrationIntegrityError('invalid_domain', 'artifact numbers must be nonnegative safe integers');
    }
    if (Object.is(value, -0)) {
      throw new BinaryCalibrationIntegrityError('invalid_domain', 'artifact contains negative zero');
    }
    return;
  }
  if (typeof value === 'string') {
    if (!hasUnicodeScalarValues(value)) {
      throw new BinaryCalibrationIntegrityError('invalid_domain', 'artifact contains a lone surrogate');
    }
    if (codePointLength(value) > MAX_PUBLIC_STRING_CODE_POINTS) {
      throw new BinaryCalibrationIntegrityError('invalid_domain', 'artifact string exceeds 4096 Unicode code points');
    }
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      throw new BinaryCalibrationIntegrityError('invalid_domain', 'artifact array exceeds 5000 items');
    }
    for (const [index, entry] of value.entries()) validatePublicJsonDomain(entry, depth + 1, `${path}[${index}]`);
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_JSON_OBJECT_PROPERTIES) {
      throw new BinaryCalibrationIntegrityError('invalid_domain', 'artifact object exceeds 100 properties');
    }
    for (const [key, entry] of entries) {
      if (!hasUnicodeScalarValues(key) || codePointLength(key) > MAX_PUBLIC_STRING_CODE_POINTS) {
        throw new BinaryCalibrationIntegrityError('invalid_domain', 'artifact object key is not bounded Unicode scalar text');
      }
      validatePublicJsonDomain(entry, depth + 1, path === '' ? key : `${path}.${key}`);
    }
    return;
  }
  throw new BinaryCalibrationIntegrityError('invalid_domain', `artifact contains unsupported ${typeof value}`);
}

export function binaryCalibrationEvidenceDigest(
  artifact: BinaryCalibrationArtifact | Record<string, unknown>,
): string {
  const { evidenceDigest: _excluded, ...unsigned } = artifact;
  return sha256Digest(unsigned);
}

function expectedWilsonRate(numerator: number, denominator: number): unknown {
  if (denominator === 0) {
    return {
      state: 'undefined',
      numerator: 0,
      denominator: 0,
      undefinedReason: 'zero_denominator',
      interval: null,
    };
  }
  return {
    state: 'defined',
    numerator,
    denominator,
    interval: {
      method: 'wilson-score/v1',
      confidenceBasisPoints: 9500,
      ...wilsonScoreBinary64(numerator, denominator),
    },
  };
}

function expectedExactRate(
  numerator: number,
  denominator: number,
  noPositiveTruthSupport: boolean,
): unknown {
  if (noPositiveTruthSupport) {
    return { state: 'undefined', numerator, denominator, undefinedReason: 'no_positive_truth_support' };
  }
  if (denominator === 0) {
    return { state: 'undefined', numerator, denominator, undefinedReason: 'zero_denominator' };
  }
  return { state: 'defined', numerator, denominator };
}

function expectedMetrics(
  trial: BinaryCalibrationTrial,
  artifact: BinaryCalibrationArtifact,
): unknown {
  const matrix = trial.confusionMatrix;
  const passPass = matrix.truthPassEvaluatorPass;
  const passFail = matrix.truthPassEvaluatorFail;
  const failPass = matrix.truthFailEvaluatorPass;
  const failFail = matrix.truthFailEvaluatorFail;
  const truePositive = artifact.positiveClass === 'pass' ? passPass : failFail;
  const falsePositive = artifact.positiveClass === 'pass' ? failPass : passFail;
  const falseNegative = artifact.positiveClass === 'pass' ? passFail : failPass;
  const positiveTruthSupport = artifact.positiveClass === 'pass'
    ? artifact.truthSupport.pass
    : artifact.truthSupport.fail;
  return {
    accuracy: expectedWilsonRate(passPass + failFail, trial.outcomes.classified),
    truthPassRecall: expectedWilsonRate(passPass, trial.outcomes.byTruth.pass.classified),
    truthFailRecall: expectedWilsonRate(failFail, trial.outcomes.byTruth.fail.classified),
    positiveClassPrecision: expectedWilsonRate(truePositive, truePositive + falsePositive),
    positiveClassRecall: expectedWilsonRate(truePositive, truePositive + falseNegative),
    positiveClassF1: expectedExactRate(
      2 * truePositive,
      2 * truePositive + falsePositive + falseNegative,
      positiveTruthSupport === 0,
    ),
    classifiedCoverage: {
      overall: expectedWilsonRate(trial.outcomes.classified, trial.outcomes.planned),
      truthPass: expectedWilsonRate(
        trial.outcomes.byTruth.pass.classified,
        artifact.truthSupport.pass,
      ),
      truthFail: expectedWilsonRate(
        trial.outcomes.byTruth.fail.classified,
        artifact.truthSupport.fail,
      ),
    },
  };
}

function identityStrength(group: BinaryCalibrationTrial['providerIdentityGroups'][number]):
  BinaryCalibrationTrial['providerIdentityGroups'][number]['identityStrength'] {
  if (group.observedVersion !== null) {
    if (group.observedModel === null) {
      throw new BinaryCalibrationIntegrityError(
        'semantic_mismatch',
        'observed provider version requires an observed model',
      );
    }
    return 'observed_version';
  }
  if (group.systemFingerprint !== null) {
    if (group.observedModel === null) {
      throw new BinaryCalibrationIntegrityError(
        'semantic_mismatch',
        'observed provider fingerprint requires an observed model',
      );
    }
    return 'observed_fingerprint';
  }
  if (group.observedModel !== null) return 'observed_model';
  return 'requested_only';
}

function verifyTrial(trial: BinaryCalibrationTrial, artifact: BinaryCalibrationArtifact): void {
  const outcomes = trial.outcomes;
  // A typed-question threshold maps every probability to pass or fail (Rubrist ADR-0014 section 5).
  if (artifact.evaluator.identity.executionBinding.verdictProtocol === 'typed-question/v1' && outcomes.abstained !== 0) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      `trial ${trial.trialIndex} records abstentions, but typed-question evaluators never abstain`,
    );
  }
  const sum = (counts: typeof outcomes.byTruth.pass) =>
    counts.classified + counts.abstained + counts.errored + counts.notAttempted;
  if (outcomes.planned !== artifact.truth.itemCount ||
    outcomes.classified + outcomes.abstained + outcomes.errored + outcomes.notAttempted !== outcomes.planned ||
    sum(outcomes.byTruth.pass) !== artifact.truthSupport.pass ||
    sum(outcomes.byTruth.fail) !== artifact.truthSupport.fail ||
    outcomes.byTruth.pass.classified + outcomes.byTruth.fail.classified !== outcomes.classified ||
    outcomes.byTruth.pass.abstained + outcomes.byTruth.fail.abstained !== outcomes.abstained ||
    outcomes.byTruth.pass.errored + outcomes.byTruth.fail.errored !== outcomes.errored ||
    outcomes.byTruth.pass.notAttempted + outcomes.byTruth.fail.notAttempted !== outcomes.notAttempted) {
    throw new BinaryCalibrationIntegrityError('semantic_mismatch', 'trial outcomes do not conserve truth support');
  }

  const matrix = trial.confusionMatrix;
  if (matrix.truthPassEvaluatorPass + matrix.truthPassEvaluatorFail !== outcomes.byTruth.pass.classified ||
    matrix.truthFailEvaluatorPass + matrix.truthFailEvaluatorFail !== outcomes.byTruth.fail.classified) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'classified count does not match matrix row',
    );
  }
  if (trial.errorDirections.falsePass !== matrix.truthFailEvaluatorPass ||
    trial.errorDirections.falseFail !== matrix.truthPassEvaluatorFail) {
    throw new BinaryCalibrationIntegrityError('semantic_mismatch', 'error direction counts do not match matrix');
  }

  assertSortedUnique(outcomes.errors.map((entry) => entry.code), 'error breakdown');
  if (outcomes.errors.reduce((sumValue, entry) => sumValue + entry.count, 0) !== outcomes.errored) {
    throw new BinaryCalibrationIntegrityError('semantic_mismatch', 'error breakdown does not conserve errored outcomes');
  }
  const outcomeUnknown = outcomes.errors.find((entry) => entry.code === 'outcome_unknown')?.count ?? 0;
  if (outcomes.providerCalls < outcomes.classified + outcomes.abstained + outcomeUnknown) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'providerCalls is below classified + abstained + outcome_unknown',
    );
  }

  const groupKeys = trial.providerIdentityGroups.map((group) => canonicalJson({
    provider: group.provider,
    observedModel: group.observedModel,
    observedVersion: group.observedVersion,
    systemFingerprint: group.systemFingerprint,
    upstreamProvider: group.upstreamProvider,
    identityStrength: group.identityStrength,
  }));
  if (new Set(groupKeys).size !== groupKeys.length) {
    throw new BinaryCalibrationIntegrityError('semantic_mismatch', 'provider identity groups have duplicate identity');
  }
  const sortedGroupKeys = [...groupKeys].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (groupKeys.some((key, index) => key !== sortedGroupKeys[index])) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'provider identity groups are not in canonical order',
    );
  }
  if (trial.providerIdentityGroups.reduce((sumValue, group) => sumValue + group.observationCount, 0) !==
    outcomes.planned) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'provider identity groups do not conserve planned observations',
    );
  }
  for (const group of trial.providerIdentityGroups) {
    if (group.provider !== artifact.evaluator.identity.executionBinding.provider) {
      throw new BinaryCalibrationIntegrityError(
        'semantic_mismatch',
        'provider identity group does not match the requested provider',
      );
    }
    if (group.upstreamProvider !== null && group.provider !== 'openrouter') {
      throw new BinaryCalibrationIntegrityError(
        'semantic_mismatch',
        'provider identity group records an upstream for a provider other than OpenRouter',
      );
    }
    const derived = identityStrength(group);
    if (group.identityStrength !== derived) {
      throw new BinaryCalibrationIntegrityError(
        'semantic_mismatch',
        `provider identity strength must be ${derived}`,
      );
    }
  }

  const expected = expectedMetrics(trial, artifact);
  try {
    for (const rate of [
      trial.metrics.accuracy,
      trial.metrics.truthPassRecall,
      trial.metrics.truthFailRecall,
      trial.metrics.positiveClassPrecision,
      trial.metrics.positiveClassRecall,
      trial.metrics.classifiedCoverage.overall,
      trial.metrics.classifiedCoverage.truthPass,
      trial.metrics.classifiedCoverage.truthFail,
    ]) {
      if (rate.state === 'defined') {
        decodeNonnegativeBinary64Rational(rate.interval.lowerBinary64);
        decodeNonnegativeBinary64Rational(rate.interval.upperBinary64);
      }
    }
  } catch (error) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'metrics or Wilson intervals do not match recomputation',
      { cause: error },
    );
  }
  if (canonicalJson(trial.metrics) !== canonicalJson(expected)) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'metrics or Wilson intervals do not match recomputation',
    );
  }

  const expectedStatus = outcomes.classified + outcomes.abstained === outcomes.planned &&
    outcomes.errored === 0 && outcomes.notAttempted === 0
    ? 'complete'
    : 'incomplete';
  if (trial.status !== expectedStatus) {
    throw new BinaryCalibrationIntegrityError('semantic_mismatch', 'trial status does not match outcome accounting');
  }
}

export function expectedBinaryCalibrationIdentity(
  artifact: BinaryCalibrationArtifact,
): ExpectedBinaryCalibrationIdentity {
  const suite = artifact.suiteBinding;
  return {
    artifactId: artifact.artifactId,
    calibrationRunId: artifact.calibrationRunId,
    projectId: artifact.projectId,
    criterionId: artifact.criterion.criterionId,
    criterionVersionId: artifact.criterion.criterionVersionId,
    criterionDigest: artifact.criterion.criterionDigest,
    skillId: artifact.evaluator.skillId,
    skillVersionId: artifact.evaluator.skillVersionId,
    skillDigest: artifact.evaluator.skillDigest,
    outputContractDigest: artifact.evaluator.outputContractDigest,
    requestedBindingDigest: artifact.evaluator.requestedBindingDigest,
    datasetRevisionId: artifact.truth.datasetRevisionId,
    revisionDigest: artifact.truth.revisionDigest,
    contentDigest: artifact.truth.contentDigest,
    itemCount: artifact.truth.itemCount,
    governedReviewBatchId: artifact.truth.origin.governedReviewBatchId,
    governedReviewBatchDigest: artifact.truth.origin.governedReviewBatchDigest,
    reviewInstructionVersionId: artifact.truth.origin.reviewInstructionVersionId,
    reviewInstructionDigest: artifact.truth.origin.reviewInstructionDigest,
    populationId: artifact.truth.origin.populationId,
    populationDigest: artifact.truth.origin.populationDigest,
    drawDigest: artifact.truth.origin.drawDigest,
    representativeOfPopulationId: artifact.truth.representativeOfPopulationId,
    selectionMethod: artifact.truth.selectionMethod,
    exposureAuthorizationSnapshotDigest: artifact.exposure.authorization.snapshotDigest,
    exposureAuthorizationEventId: artifact.exposure.authorization.eventId,
    exposureCompletionSnapshotDigest: artifact.exposure.completion.snapshotDigest,
    exposureCompletionEventId: artifact.exposure.completion.eventId,
    exposureCompletionState: artifact.exposure.completion.state,
    exposureCompletionEligibility: artifact.exposure.completion.eligibility.result,
    executionEnvironment: artifact.execution.providerDataHandling.executionEnvironment,
    providerDataHandlingPolicyId: artifact.execution.providerDataHandling.policyId,
    providerDataHandlingPolicyDigest: artifact.execution.providerDataHandling.policyDigest,
    positiveClass: artifact.positiveClass,
    trialPlanKind: artifact.trialPlan.kind,
    trialsPerItem: artifact.trialPlan.trialsPerItem,
    suiteManifestId: suite?.manifestId ?? null,
    suiteManifestDigest: suite?.manifestDigest ?? null,
    suiteMemberPosition: suite?.memberPosition ?? null,
  };
}

function verifyExpectedIdentity(
  artifact: BinaryCalibrationArtifact,
  expected: ExpectedBinaryCalibrationIdentity,
): void {
  const actual = expectedBinaryCalibrationIdentity(artifact) as unknown as Record<string, unknown>;
  const expectation = expected as unknown as Record<string, unknown>;
  const actualKeys = Object.keys(actual);
  const unexpectedKeys = Object.keys(expectation).filter((key) => !Object.hasOwn(actual, key));
  if (unexpectedKeys.length > 0) {
    throw new BinaryCalibrationIntegrityError(
      'identity_mismatch',
      `expected identity has unknown fields: ${unexpectedKeys.sort().join(', ')}`,
    );
  }
  for (const key of actualKeys) {
    const expectedValue = expectation[key];
    if (actual[key] !== expectedValue) {
      throw new BinaryCalibrationIntegrityError(
        'identity_mismatch',
        `${key} mismatch: expected ${JSON.stringify(expectedValue)}`,
      );
    }
  }
}

export function verifyBinaryCalibrationArtifact(
  raw: unknown,
  expected?: ExpectedBinaryCalibrationIdentity,
): BinaryCalibrationArtifact {
  validatePublicJsonDomain(raw);
  const parsed = binaryCalibrationArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BinaryCalibrationIntegrityError(
      'invalid_structure',
      `binary calibration artifact does not match v2 contract: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const artifact = parsed.data;
  if (artifact.evidenceDigest !== binaryCalibrationEvidenceDigest(artifact)) {
    throw new BinaryCalibrationIntegrityError('digest_mismatch', 'evidenceDigest mismatch');
  }

  if (artifact.lineage.artifactRevision === 1) {
    if (artifact.lineage.predecessorArtifactId !== null || artifact.lineage.correctionReason !== null) {
      throw new BinaryCalibrationIntegrityError(
        'semantic_mismatch',
        'root binary calibration artifact cannot name correction lineage',
      );
    }
  } else if (artifact.lineage.predecessorArtifactId === null || artifact.lineage.correctionReason === null) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'corrected binary calibration artifact must name predecessor and correction reason',
    );
  }

  if (artifact.evaluator.skillDigest !== rubristSkillDigestV2(artifact.evaluator.identity)) {
    throw new BinaryCalibrationIntegrityError('digest_mismatch', 'skillDigest does not match its evaluator identity');
  }
  if (artifact.evaluator.requestedBindingDigest !== sha256Digest(artifact.evaluator.identity.executionBinding)) {
    throw new BinaryCalibrationIntegrityError(
      'digest_mismatch',
      'requestedBindingDigest does not match its execution binding',
    );
  }

  for (const timestamp of [
    artifact.exposure.authorization.recordedAt,
    artifact.startedAt,
    artifact.completedAt,
    artifact.exposure.completion.recordedAt,
    artifact.createdAt,
  ]) assertExactCalendarTimestamp(timestamp);
  const lifecycle = [
    artifact.exposure.authorization.recordedAt,
    artifact.startedAt,
    artifact.completedAt,
    artifact.exposure.completion.recordedAt,
    artifact.createdAt,
  ];
  if (lifecycle.some((value, index) => index > 0 && value < lifecycle[index - 1]!)) {
    throw new BinaryCalibrationIntegrityError('semantic_mismatch', 'timestamps are not in lifecycle order');
  }

  assertSortedUnique(artifact.truth.representativeIneligibleReasons, 'representative ineligible reasons');
  if (artifact.truth.representativeOfPopulationId !== null &&
    artifact.truth.representativeIneligibleReasons.length > 0) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'representative truth cannot name ineligible reasons',
    );
  }
  if (artifact.truth.representativeOfPopulationId === null &&
    artifact.truth.representativeIneligibleReasons.length === 0) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'nonrepresentative truth must name at least one ineligible reason',
    );
  }
  assertSortedUnique(artifact.exposure.completion.eligibility.reasons, 'completion eligibility reasons');
  if ((artifact.exposure.completion.eligibility.result === 'eligible') !==
    (artifact.exposure.completion.eligibility.reasons.length === 0)) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'completion eligibility result does not match its reasons',
    );
  }
  if (artifact.exposure.completion.eligibility.result === 'eligible' &&
    artifact.exposure.completion.state !== 'protected') {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'eligible completion exposure must be protected',
    );
  }

  if (artifact.truthSupport.total !== artifact.truth.itemCount ||
    artifact.truthSupport.pass + artifact.truthSupport.fail !== artifact.truthSupport.total) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'truth support must equal the frozen truth itemCount',
    );
  }
  if (artifact.trials.length !== artifact.trialPlan.trialsPerItem) {
    throw new BinaryCalibrationIntegrityError(
      'semantic_mismatch',
      'trial coverage does not match the declared trial plan',
    );
  }
  for (const [index, trial] of artifact.trials.entries()) {
    if (trial.trialIndex !== index) {
      throw new BinaryCalibrationIntegrityError(
        'semantic_mismatch',
        'trials are not ordered by contiguous trialIndex',
      );
    }
    verifyTrial(trial, artifact);
  }

  const derivedIncompleteReasons = [
    ...(artifact.trials.some((trial) => trial.status === 'incomplete') ? ['trial_incomplete'] as const : []),
    ...(artifact.exposure.completion.state === 'exposed' ? ['completion_exposure_exposed'] as const : []),
    ...(artifact.exposure.completion.eligibility.result === 'ineligible'
      ? ['completion_exposure_ineligible'] as const
      : []),
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const expectedStatus = derivedIncompleteReasons.length === 0 ? 'complete' : 'incomplete';
  if (artifact.status !== expectedStatus ||
    canonicalJson(artifact.incompleteReasons) !== canonicalJson(derivedIncompleteReasons)) {
    throw new BinaryCalibrationIntegrityError('semantic_mismatch', 'incompleteReasons mismatch');
  }

  if (expected !== undefined) verifyExpectedIdentity(artifact, expected);
  return artifact;
}

export function parseCanonicalBinaryCalibrationBytes(
  bytes: Uint8Array,
  expected?: ExpectedBinaryCalibrationIdentity,
): BinaryCalibrationArtifact {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new BinaryCalibrationIntegrityError('invalid_bytes', 'binary calibration artifact exceeds 16 MiB');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new BinaryCalibrationIntegrityError('invalid_bytes', 'binary calibration artifact has a UTF-8 BOM');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BinaryCalibrationIntegrityError(
      'invalid_bytes',
      'binary calibration artifact is not valid UTF-8',
      { cause: error },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BinaryCalibrationIntegrityError(
      'invalid_json',
      'binary calibration artifact is not valid JSON',
      { cause: error },
    );
  }
  validatePublicJsonDomain(raw);
  if (canonicalJson(raw) !== text) {
    throw new BinaryCalibrationIntegrityError(
      'noncanonical_bytes',
      'binary calibration artifact is not exact canonical JSON',
    );
  }
  return verifyBinaryCalibrationArtifact(raw, expected);
}

export function binaryCalibrationArtifactByteDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
