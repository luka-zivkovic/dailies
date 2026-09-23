import { z } from 'zod';
import {
  binaryCalibrationArtifactByteDigest,
  binaryCalibrationArtifactSchema,
  parseCanonicalBinaryCalibrationBytes,
  type BinaryCalibrationArtifact,
} from './binary-calibration.js';
import {
  calibrationCollectionIncompleteReasonSchema,
  calibrationCollectionIntegrityReasonSchema,
  calibrationEvidenceScopeSchema,
  calibrationEvidenceSetDigest,
  calibrationPolicyReasonSchema,
  calibrationPolicyResultSchema,
  calibrationReleaseAdmissibilityReason,
  collectCalibrationEvidence,
  criterionCalibrationAdmissible,
  deriveCalibrationEvidenceScope,
  evaluateCalibrationRequirement,
  type CalibrationCollectionResult,
  type CalibrationPolicyResult,
} from './calibration-policy.js';
import {
  expectedBinaryCalibrationIdentitySchema,
  type ExpectedBinaryCalibrationIdentityConfig,
} from './config-v6.js';
import {
  scopeConfigSchema,
  scopeKindSchema,
  timeWindowSchema,
  type ScopeConfig,
} from './config.js';
import { canonicalJson, sha256Digest } from './rubrist.js';
import {
  applyReleasePolicyV2,
  releasePolicyV2CandidateProjection,
  releasePolicyV2Digest,
  releasePolicyV2Schema,
  verifyReleasePolicyV2,
  type ReleasePolicyV2,
} from './policy-v2.js';
import type { CriterionPolicyInput } from './policy.js';
import { reportV5Schema, type SuiteReport } from './report-v5.js';
import {
  evaluatorSuiteManifestSchema,
  verifyEvaluatorSuiteManifest,
  type EvaluatorSuiteManifest,
} from './suite-manifest.js';

export const CALIBRATION_REPORT_SCHEMA_VERSION = 6;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const exactUtcMillisecondsSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);
const signedIntegerTextSchema = z.string().regex(/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/);
const decisionSchema = z.enum(['promote', 'block', 'inconclusive']);
const evidenceStateSchema = z.enum(['verified', 'incomplete', 'integrity_failure']);

const releaseScopeSchema = z.object({
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
}).strict();

const candidateAssessmentSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    reportDigest: digestSchema,
    report: reportV5Schema,
  }).strict(),
  z.object({
    status: z.literal('not_started'),
    reason: z.literal('required_calibration_integrity_failure'),
  }).strict(),
]);

const artifactEvidenceSchema = z.discriminatedUnion('disposition', [
  z.object({
    disposition: z.literal('accepted'),
    expectedArtifactDigest: digestSchema,
    observedArtifactDigest: digestSchema,
    artifact: binaryCalibrationArtifactSchema,
  }).strict(),
  z.object({
    disposition: z.literal('rejected'),
    expectedArtifactDigest: digestSchema,
    observedArtifactDigest: digestSchema.nullable(),
    reason: calibrationCollectionIntegrityReasonSchema,
  }).strict(),
  z.object({
    disposition: z.literal('unavailable'),
    expectedArtifactDigest: z.null(),
    observedArtifactDigest: z.null(),
    reason: z.literal('source_not_configured'),
  }).strict(),
]);

const calibrationTrustSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('verified'),
    derivation: z.literal('rubrist_binary_calibration_v1'),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    derivation: z.literal('rubrist_binary_calibration_v1'),
    reason: z.union([
      calibrationCollectionIncompleteReasonSchema,
      calibrationCollectionIntegrityReasonSchema,
    ]),
  }).strict(),
]);

const effectiveAssessmentSchema = z.object({
  candidateEvidenceState: z.enum(['complete', 'incomplete', 'integrity_failure']),
  candidateTrustAdmissible: z.boolean(),
  calibrationAdmissible: z.boolean(),
  calibrationReason: calibrationPolicyReasonSchema.nullable(),
  releaseAdmissible: z.boolean(),
}).strict();

const calibrationCriterionSchema = z.object({
  position: z.number().int().nonnegative(),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  expectedIdentity: expectedBinaryCalibrationIdentitySchema.nullable(),
  evidenceState: evidenceStateSchema,
  artifactEvidence: artifactEvidenceSchema,
  calibrationTruthScope: calibrationEvidenceScopeSchema.nullable(),
  trust: calibrationTrustSchema,
  ageMilliseconds: signedIntegerTextSchema.nullable(),
  calibrationPolicy: calibrationPolicyResultSchema,
  effectiveAssessment: effectiveAssessmentSchema,
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
    weightedDenominator: z.string().regex(/^[1-9][0-9]*$/),
    minimumNumerator: z.string().regex(/^[0-9]+$/),
    minimumDenominator: z.string().regex(/^[1-9][0-9]*$/),
  }).strict().nullable(),
}).strict();

const reportV6ShapeSchema = z.object({
  schemaVersion: z.literal(CALIBRATION_REPORT_SCHEMA_VERSION),
  startedAt: exactUtcMillisecondsSchema,
  finishedAt: exactUtcMillisecondsSchema,
  evaluatedAt: exactUtcMillisecondsSchema,
  releaseScope: releaseScopeSchema,
  manifest: evaluatorSuiteManifestSchema,
  policy: releasePolicyV2Schema,
  policyDigest: digestSchema,
  candidateAssessment: candidateAssessmentSchema,
  candidateAssessmentDigest: digestSchema,
  calibrationEvidenceSetDigest: digestSchema,
  criteria: z.array(calibrationCriterionSchema).min(1),
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

export type CalibrationSuiteReport = z.infer<typeof reportV6ShapeSchema>;
export type CalibrationReportCriterion = CalibrationSuiteReport['criteria'][number];
export type CalibrationCandidateAssessment = CalibrationSuiteReport['candidateAssessment'];

export interface BuildCalibrationReportV6Input {
  startedAt: string;
  finishedAt: string;
  evaluatedAt: string;
  releaseScope: CalibrationSuiteReport['releaseScope'];
  manifest: EvaluatorSuiteManifest;
  policy: ReleasePolicyV2;
  candidateAssessment:
    | { status: 'completed'; report: SuiteReport }
    | { status: 'not_started'; reason: 'required_calibration_integrity_failure' };
  calibrationCollections: CalibrationCollectionResult[];
}

function assertExactTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an exact UTC timestamp with milliseconds`);
  }
}

function calibrationAgeMilliseconds(
  scope: CalibrationCollectionResult['calibrationEvidenceScope'],
  evaluatedAt: string,
): string | null {
  if (scope === null) return null;
  return (BigInt(Date.parse(evaluatedAt)) - BigInt(Date.parse(scope.completedAt))).toString();
}

function reportSource(
  expectedIdentity: ExpectedBinaryCalibrationIdentityConfig,
  artifactDigest: string,
) {
  return {
    type: 'file' as const,
    path: '<report-path-redacted>',
    artifactDigest,
    expectedIdentity,
  };
}

function projectArtifactEvidence(
  collection: CalibrationCollectionResult,
): CalibrationReportCriterion['artifactEvidence'] {
  if (collection.artifact !== null) {
    if (collection.source === null || collection.observedArtifactDigest === null) {
      throw new Error('retained calibration artifact requires configured source and observed digest');
    }
    return {
      disposition: 'accepted',
      expectedArtifactDigest: collection.source.artifactDigest,
      observedArtifactDigest: collection.observedArtifactDigest,
      artifact: collection.artifact,
    };
  }
  if (collection.state === 'integrity_failure') {
    return {
      disposition: 'rejected',
      expectedArtifactDigest: collection.source.artifactDigest,
      observedArtifactDigest: collection.observedArtifactDigest,
      reason: collection.reason,
    };
  }
  if (collection.source !== null || collection.reason !== 'source_not_configured') {
    throw new Error('artifact-less incomplete calibration must be unconfigured evidence');
  }
  return {
    disposition: 'unavailable',
    expectedArtifactDigest: null,
    observedArtifactDigest: null,
    reason: 'source_not_configured',
  };
}

function reconstructCollection(
  criterion: CalibrationReportCriterion,
  manifest: EvaluatorSuiteManifest,
): CalibrationCollectionResult {
  const member = manifest.members[criterion.position];
  if (member === undefined) throw new Error('calibration criterion has no manifest member');
  const evidence = criterion.artifactEvidence;
  if (evidence.disposition === 'unavailable') {
    return collectCalibrationEvidence({
      criterionVersionId: criterion.criterionVersionId,
      source: null,
      manifest,
      member,
    });
  }
  if (criterion.expectedIdentity === null) {
    throw new Error('configured calibration evidence requires expectedIdentity');
  }
  const source = reportSource(criterion.expectedIdentity, evidence.expectedArtifactDigest);
  if (evidence.disposition === 'accepted') {
    const bytes = Buffer.from(canonicalJson(evidence.artifact), 'utf8');
    if (binaryCalibrationArtifactByteDigest(bytes) !== evidence.observedArtifactDigest) {
      throw new Error('accepted calibration artifact observed digest mismatch');
    }
    // Independently execute the frozen byte/parser/identity verifier before
    // replaying the collection boundary and policy derivation.
    parseCanonicalBinaryCalibrationBytes(bytes, criterion.expectedIdentity);
    return collectCalibrationEvidence({
      criterionVersionId: criterion.criterionVersionId,
      source,
      manifest,
      member,
      bytes,
    });
  }
  if (evidence.reason === 'invalid_collection_input') {
    throw new Error('invalid_collection_input cannot be serialized by the report v6 runner');
  }
  if (evidence.reason === 'source_not_found' || evidence.reason === 'source_read_failed') {
    if (evidence.observedArtifactDigest !== null) {
      throw new Error(`${evidence.reason} rejected evidence cannot have an observed digest`);
    }
  } else if (evidence.observedArtifactDigest === null) {
    throw new Error(`${evidence.reason} rejected evidence requires an observed digest`);
  }
  if (evidence.reason === 'artifact_digest_mismatch' &&
    evidence.observedArtifactDigest === evidence.expectedArtifactDigest) {
    throw new Error('artifact_digest_mismatch requires distinct expected and observed digests');
  }
  if ((evidence.reason === 'artifact_identity_mismatch' ||
    evidence.reason === 'artifact_verification_failed') &&
    evidence.observedArtifactDigest !== evidence.expectedArtifactDigest) {
    throw new Error(`${evidence.reason} requires bytes matching the configured artifact digest`);
  }
  if (evidence.reason === 'manifest_binding_mismatch') {
    const replay = collectCalibrationEvidence({
      criterionVersionId: criterion.criterionVersionId,
      source,
      manifest,
      member,
      // The manifest binding is checked before byte digest/parsing, so empty
      // bytes safely reproduce only that public expected-identity failure.
      bytes: new Uint8Array(),
    });
    if (replay.state !== 'integrity_failure' || replay.reason !== 'manifest_binding_mismatch') {
      throw new Error('manifest_binding_mismatch is not reproducible from expected identity');
    }
  }
  return {
    criterionVersionId: criterion.criterionVersionId,
    state: 'integrity_failure',
    source,
    observedArtifactDigest: evidence.observedArtifactDigest,
    artifact: null,
    calibrationEvidenceScope: null,
    reason: evidence.reason,
    detail: 'rejected evidence detail intentionally omitted from report v6',
  };
}

function candidatePolicyInputs(
  candidateAssessment: CalibrationCandidateAssessment,
  manifest: EvaluatorSuiteManifest,
): {
  evidence: CriterionPolicyInput[];
  executionFailed: boolean;
  integrityFailure: boolean;
} {
  if (candidateAssessment.status === 'not_started') {
    return {
      evidence: manifest.members.map((member) => ({
        criterionVersionId: member.criterionVersionId,
        evidenceState: 'incomplete',
        trustAdmissible: false,
        passed: 0,
        total: 0,
        passRate: 0,
        regressions: 0,
      })),
      executionFailed: false,
      integrityFailure: false,
    };
  }
  return {
    evidence: candidateAssessment.report.criteria.map((criterion) => ({
      criterionVersionId: criterion.criterionVersionId,
      evidenceState: criterion.evidence.state,
      trustAdmissible: criterion.trust.status === 'complete' && criterion.trust.admissible,
      passed: criterion.totals.passed,
      total: criterion.totals.total,
      passRate: criterion.totals.passRate,
      regressions: criterion.totals.regressions,
    })),
    executionFailed: candidateAssessment.report.candidateExecution.failed > 0,
    integrityFailure: candidateAssessment.report.candidateExecution.items.some(
      (item) => item.status === 'error' && item.errorKind === 'protocol',
    ),
  };
}

function candidateEvidenceForCriterion(
  assessment: CalibrationCandidateAssessment,
  criterionVersionId: string,
): Pick<CalibrationReportCriterion['effectiveAssessment'],
  'candidateEvidenceState' | 'candidateTrustAdmissible'> {
  if (assessment.status === 'not_started') {
    return { candidateEvidenceState: 'incomplete', candidateTrustAdmissible: false };
  }
  const criterion = assessment.report.criteria.find(
    (entry) => entry.criterionVersionId === criterionVersionId,
  );
  if (criterion === undefined) throw new Error(`missing candidate criterion ${criterionVersionId}`);
  return {
    candidateEvidenceState: criterion.evidence.state,
    candidateTrustAdmissible: criterion.trust.status === 'complete' && criterion.trust.admissible,
  };
}

function calibrationTrust(
  collection: CalibrationCollectionResult,
): CalibrationReportCriterion['trust'] {
  if (collection.state === 'verified') {
    return { status: 'verified', derivation: 'rubrist_binary_calibration_v1' };
  }
  return {
    status: 'unavailable',
    derivation: 'rubrist_binary_calibration_v1',
    reason: collection.reason,
  };
}

export function buildCalibrationDecisionStatement(
  report: Pick<CalibrationSuiteReport,
    'decision' | 'policy' | 'policyDigest' | 'manifest' | 'releaseScope' |
    'candidateAssessmentDigest' | 'calibrationEvidenceSetDigest'>,
): string {
  return `Decision ${report.decision} under calibration-aware policy ` +
    `${JSON.stringify(`${report.policy.id}@${report.policy.version}`)} (${report.policyDigest}) ` +
    `for evaluator suite ${JSON.stringify(report.manifest.manifestId)} ` +
    `(${report.manifest.manifestDigest}) on ${report.releaseScope.kind} release scope ` +
    `${JSON.stringify(report.releaseScope.id)} over exact JSONL input ` +
    `${report.releaseScope.inputArtifact.digest}, candidate assessment ` +
    `${report.candidateAssessmentDigest}, and calibration evidence set ` +
    `${report.calibrationEvidenceSetDigest}.`;
}

function exactEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function verifyReleaseScope(scope: CalibrationSuiteReport['releaseScope']): void {
  const parsed: ScopeConfig = {
    id: scope.id,
    kind: scope.kind,
    expectedItems: scope.coverage.expectedItems,
    collectionProcedure: scope.collectionProcedure,
    population: scope.population,
    timeWindow: scope.timeWindow,
  };
  scopeConfigSchema.parse(parsed);
  if (scope.inputArtifact.digest !== scope.inputArtifact.declaredDigest ||
    scope.inputArtifact.itemCount !== scope.coverage.expectedItems ||
    scope.coverage.observedItems !== scope.coverage.expectedItems) {
    throw new Error('release scope coverage or exact input identity mismatch');
  }
}

function verifyReportV6(report: CalibrationSuiteReport): void {
  for (const [field, value] of [
    ['startedAt', report.startedAt],
    ['finishedAt', report.finishedAt],
    ['evaluatedAt', report.evaluatedAt],
  ] as const) assertExactTimestamp(value, field);
  if (report.evaluatedAt > report.startedAt || report.startedAt > report.finishedAt) {
    throw new Error('report v6 timestamps are not in lifecycle order');
  }
  verifyReleaseScope(report.releaseScope);

  const manifest = verifyEvaluatorSuiteManifest(report.manifest, {
    manifestId: report.manifest.manifestId,
    manifestDigest: report.manifest.manifestDigest,
  });
  const policy = verifyReleasePolicyV2(report.policy, manifest);
  if (report.policyDigest !== releasePolicyV2Digest(policy)) {
    throw new Error('report v6 policyDigest mismatch');
  }
  if (report.candidateAssessmentDigest !== sha256Digest(report.candidateAssessment)) {
    throw new Error('candidateAssessmentDigest mismatch');
  }

  if (report.candidateAssessment.status === 'completed') {
    const candidateReport = reportV5Schema.parse(report.candidateAssessment.report);
    if (report.candidateAssessment.reportDigest !== sha256Digest(candidateReport)) {
      throw new Error('embedded candidate report digest mismatch');
    }
    if (!exactEqual(candidateReport.manifest, manifest) ||
      !exactEqual(candidateReport.policy, releasePolicyV2CandidateProjection(policy)) ||
      !exactEqual(candidateReport.scope, report.releaseScope)) {
      throw new Error('embedded candidate report identity does not match report v6');
    }
    if (candidateReport.startedAt !== report.startedAt || candidateReport.finishedAt !== report.finishedAt) {
      throw new Error('embedded candidate report lifecycle does not match report v6');
    }
  }

  if (report.criteria.length !== manifest.members.length) {
    throw new Error('report v6 criterion coverage mismatch');
  }
  const collections: CalibrationCollectionResult[] = [];
  const calibrationResults: CalibrationPolicyResult[] = [];
  for (const [index, criterion] of report.criteria.entries()) {
    const member = manifest.members[index]!;
    const requirement = policy.criteria[index]!.calibrationRequirement;
    if (criterion.position !== index ||
      criterion.criterionId !== member.criterionId ||
      criterion.criterionVersionId !== member.criterionVersionId) {
      throw new Error(`report v6 criterion identity mismatch at position ${index}`);
    }
    const collection = reconstructCollection(criterion, manifest);
    collections.push(collection);
    if (criterion.expectedIdentity === null !== (collection.source === null)) {
      throw new Error(`expected calibration identity presence mismatch at position ${index}`);
    }
    if (collection.source !== null &&
      !exactEqual(criterion.expectedIdentity, collection.source.expectedIdentity)) {
      throw new Error(`expected calibration identity mismatch at position ${index}`);
    }
    if (criterion.evidenceState !== collection.state ||
      !exactEqual(criterion.calibrationTruthScope, collection.calibrationEvidenceScope) ||
      !exactEqual(criterion.trust, calibrationTrust(collection)) ||
      criterion.ageMilliseconds !== calibrationAgeMilliseconds(
        collection.calibrationEvidenceScope,
        report.evaluatedAt,
      )) {
      throw new Error(`calibration evidence projection mismatch at position ${index}`);
    }
    if (collection.artifact !== null &&
      !exactEqual(criterion.calibrationTruthScope, deriveCalibrationEvidenceScope(collection.artifact))) {
      throw new Error(`calibration truth scope mismatch at position ${index}`);
    }
    const calibration = evaluateCalibrationRequirement(
      member.criterionVersionId,
      requirement,
      collection,
      report.evaluatedAt,
    );
    calibrationResults.push(calibration);
    if (!exactEqual(criterion.calibrationPolicy, calibration)) {
      throw new Error(`calibration policy derivation mismatch at position ${index}`);
    }
  }
  if (report.calibrationEvidenceSetDigest !== calibrationEvidenceSetDigest(collections)) {
    throw new Error('calibrationEvidenceSetDigest mismatch');
  }

  const requiredCalibrationIntegrityFailure = policy.criteria.some((entry, index) =>
    entry.evidenceRequirement === 'mandatory' &&
    calibrationResults[index]?.status === 'integrity_failure');
  if ((report.candidateAssessment.status === 'not_started') !== requiredCalibrationIntegrityFailure) {
    throw new Error('candidate preflight state does not match required calibration integrity');
  }

  const candidate = candidatePolicyInputs(report.candidateAssessment, manifest);
  const decision = applyReleasePolicyV2(
    policy,
    candidate.evidence,
    calibrationResults,
    candidate.executionFailed,
    candidate.integrityFailure,
  );
  if (report.decision !== decision.decision || report.decisionPrecedence !== decision.precedence ||
    !exactEqual(report.compensation, decision.compensation)) {
    throw new Error('report v6 decision, precedence, or compensation mismatch');
  }
  for (const [index, criterion] of report.criteria.entries()) {
    const expected = decision.criteria[index]!;
    const candidateProjection = candidateEvidenceForCriterion(
      report.candidateAssessment,
      criterion.criterionVersionId,
    );
    const effective = {
      ...candidateProjection,
      calibrationAdmissible: criterionCalibrationAdmissible(expected.calibration),
      calibrationReason: calibrationReleaseAdmissibilityReason(expected.calibration),
      releaseAdmissible: expected.releaseAdmissible,
    };
    if (!exactEqual(criterion.effectiveAssessment, effective) ||
      !exactEqual(criterion.policyResult, {
        evidenceRequirement: expected.evidenceRequirement,
        consequence: expected.consequence,
        rulePassed: expected.rulePassed,
      })) {
      throw new Error(`effective assessment or policy result mismatch at position ${index}`);
    }
  }
  if (report.decisionStatement !== buildCalibrationDecisionStatement(report)) {
    throw new Error('report v6 decision statement mismatch');
  }
}

export const reportV6Schema = z.unknown().transform((raw, ctx): CalibrationSuiteReport => {
  const parsed = reportV6ShapeSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }
  try {
    if (canonicalJson(raw) !== canonicalJson(parsed.data)) {
      ctx.addIssue({
        code: 'custom',
        message: 'report v6 must contain every explicit field; schema normalization is forbidden',
      });
      return z.NEVER;
    }
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: `report v6 cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
    });
    return z.NEVER;
  }
  return parsed.data;
}).superRefine((report, ctx) => {
  try {
    verifyReportV6(report);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export function buildCalibrationReportV6(
  input: BuildCalibrationReportV6Input,
): CalibrationSuiteReport {
  const manifest = verifyEvaluatorSuiteManifest(input.manifest, {
    manifestId: input.manifest.manifestId,
    manifestDigest: input.manifest.manifestDigest,
  });
  const policy = verifyReleasePolicyV2(input.policy, manifest);
  if (input.calibrationCollections.length !== manifest.members.length) {
    throw new Error('calibration report builder requires exact collection coverage');
  }
  const candidateAssessment: CalibrationCandidateAssessment =
    input.candidateAssessment.status === 'completed'
      ? {
          status: 'completed',
          reportDigest: sha256Digest(input.candidateAssessment.report),
          report: input.candidateAssessment.report,
        }
      : input.candidateAssessment;
  const calibrationResults = input.calibrationCollections.map((collection, index) =>
    evaluateCalibrationRequirement(
      manifest.members[index]!.criterionVersionId,
      policy.criteria[index]!.calibrationRequirement,
      collection,
      input.evaluatedAt,
    ));
  const candidate = candidatePolicyInputs(candidateAssessment, manifest);
  const decision = applyReleasePolicyV2(
    policy,
    candidate.evidence,
    calibrationResults,
    candidate.executionFailed,
    candidate.integrityFailure,
  );
  const criteria = manifest.members.map((member, index): CalibrationReportCriterion => {
    const collection = input.calibrationCollections[index]!;
    const calibration = calibrationResults[index]!;
    const effective = decision.criteria[index]!;
    return {
      position: index,
      criterionId: member.criterionId,
      criterionVersionId: member.criterionVersionId,
      expectedIdentity: collection.source?.expectedIdentity ?? null,
      evidenceState: collection.state,
      artifactEvidence: projectArtifactEvidence(collection),
      calibrationTruthScope: collection.calibrationEvidenceScope,
      trust: calibrationTrust(collection),
      ageMilliseconds: calibrationAgeMilliseconds(
        collection.calibrationEvidenceScope,
        input.evaluatedAt,
      ),
      calibrationPolicy: calibration,
      effectiveAssessment: {
        ...candidateEvidenceForCriterion(candidateAssessment, member.criterionVersionId),
        calibrationAdmissible: criterionCalibrationAdmissible(calibration),
        calibrationReason: calibrationReleaseAdmissibilityReason(calibration),
        releaseAdmissible: effective.releaseAdmissible,
      },
      policyResult: {
        evidenceRequirement: effective.evidenceRequirement,
        consequence: effective.consequence,
        rulePassed: effective.rulePassed,
      },
    };
  });
  const basis = {
    schemaVersion: CALIBRATION_REPORT_SCHEMA_VERSION,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    evaluatedAt: input.evaluatedAt,
    releaseScope: input.releaseScope,
    manifest,
    policy,
    policyDigest: releasePolicyV2Digest(policy),
    candidateAssessment,
    candidateAssessmentDigest: sha256Digest(candidateAssessment),
    calibrationEvidenceSetDigest: calibrationEvidenceSetDigest(input.calibrationCollections),
    criteria,
    compensation: decision.compensation,
    decision: decision.decision,
    decisionPrecedence: decision.precedence,
  } satisfies Omit<CalibrationSuiteReport, 'decisionStatement'>;
  return reportV6Schema.parse({
    ...basis,
    decisionStatement: buildCalibrationDecisionStatement(basis),
  });
}

/** Deterministic canonical transport bytes for report archival and digesting. */
export function serializeCalibrationReportV6(report: CalibrationSuiteReport): Uint8Array {
  return Buffer.from(canonicalJson(reportV6Schema.parse(report)), 'utf8');
}

export function parseCanonicalCalibrationReportV6Bytes(bytes: Uint8Array): CalibrationSuiteReport {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error('report v6 has a UTF-8 BOM');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const raw = JSON.parse(text) as unknown;
  if (canonicalJson(raw) !== text) throw new Error('report v6 is not exact canonical JSON');
  return reportV6Schema.parse(raw);
}

export function renderCalibrationReportMarkdown(report: CalibrationSuiteReport): string {
  const verified = report.criteria.filter((criterion) => criterion.evidenceState === 'verified').length;
  const renderCheck = (check: CalibrationPolicyResult['checks'][number]) =>
    `- ${check.passed ? 'PASS' : 'FAIL'} ${check.check}` +
    `${check.metric === null ? '' : `/${check.metric}`}` +
    `${check.trialIndex === null ? '' : ` trial=${check.trialIndex}`}: ` +
    `actual=${check.actual}; required=${check.required}` +
    `${check.reason === null ? '' : `; reason=${check.reason}`}`;
  const lines = [
    `# Calibration-aware criterion release report: ${report.decision.toUpperCase()}`,
    '',
    `- Decision: **${report.decision}**`,
    `- Precedence: ${report.decisionPrecedence}`,
    `- Policy: ${report.policy.id}@${report.policy.version} (\`${report.policyDigest}\`)`,
    `- Suite: ${report.manifest.manifestId} (\`${report.manifest.manifestDigest}\`)`,
    `- Release scope: **${report.releaseScope.kind}** (${report.releaseScope.id})`,
    `- Exact candidate input: \`${report.releaseScope.inputArtifact.digest}\``,
    `- Candidate assessment: ${report.candidateAssessment.status} (\`${report.candidateAssessmentDigest}\`)`,
    `- Calibration evidence: ${verified}/${report.criteria.length} verified (\`${report.calibrationEvidenceSetDigest}\`)`,
    `- Calibration evaluated: ${report.evaluatedAt}`,
    '',
    report.decisionStatement,
    '',
    '## Criteria',
    '',
  ];
  for (const criterion of report.criteria) {
    const calibration = criterion.calibrationPolicy;
    lines.push(
      `### ${criterion.criterionId}`,
      '',
      `- Criterion version: ${criterion.criterionVersionId}`,
      `- Calibration evidence: ${criterion.evidenceState} (${criterion.artifactEvidence.disposition})`,
      `- Expected artifact digest: ${criterion.artifactEvidence.expectedArtifactDigest ?? 'unavailable'}`,
      `- Observed artifact digest: ${criterion.artifactEvidence.observedArtifactDigest ?? 'unavailable'}`,
      `- Calibration trust: ${criterion.trust.status === 'verified'
        ? 'verified/rubrist_binary_calibration_v1'
        : `unavailable/${criterion.trust.reason}`}`,
      `- Separate calibration truth scope: ${criterion.calibrationTruthScope === null
        ? 'unavailable'
        : `${criterion.calibrationTruthScope.kind}/${criterion.calibrationTruthScope.datasetRevisionId}`}`,
      `- Artifact age: ${criterion.ageMilliseconds === null ? 'unavailable' : `${criterion.ageMilliseconds} ms`}`,
      `- Calibration policy: ${calibration.status}; admissible=${calibration.admissible}`,
      `- Worst calibration reason: ${calibration.worstReason ?? 'none'}`,
      `- Requirement checks: ${calibration.checks.filter((check) => check.passed).length}/${calibration.checks.length} passed`,
      `- Trials: ${calibration.trials.length}; failures: ${calibration.trials.filter((trial) => !trial.passed).length}`,
      `- Candidate trust admissible: ${criterion.effectiveAssessment.candidateTrustAdmissible}`,
      `- Effective assessment admissible: ${criterion.effectiveAssessment.releaseAdmissible}`,
      `- Release admissibility reason: ${criterion.effectiveAssessment.calibrationReason ?? 'none'}`,
      `- Consequence: ${criterion.policyResult.consequence}`,
      `- Rule passed: ${criterion.policyResult.rulePassed === null ? 'not evaluated' : String(criterion.policyResult.rulePassed)}`,
      '',
    );
    if (calibration.checks.length > 0) {
      lines.push(
        '#### Artifact-level calibration checks',
        '',
        ...calibration.checks.map(renderCheck),
        '',
      );
    }
    for (const trial of calibration.trials) {
      lines.push(
        `#### Trial ${trial.trialIndex} calibration ${trial.passed ? 'checks' : 'failure'}`,
        '',
        `- Passed: ${trial.passed}`,
        `- Worst reason: ${trial.worstReason ?? 'none'}`,
        `- Reasons: ${trial.reasons.join(', ') || 'none'}`,
        ...trial.checks.map(renderCheck),
        '',
      );
    }
  }
  return lines.join('\n');
}
