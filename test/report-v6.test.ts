import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  binaryCalibrationArtifactByteDigest,
  binaryCalibrationEvidenceDigest,
  expectedBinaryCalibrationIdentity,
  verifyBinaryCalibrationArtifact,
  type BinaryCalibrationArtifact,
} from '../src/binary-calibration.js';
import {
  collectCalibrationEvidence,
  type CalibrationCollectionResult,
} from '../src/calibration-policy.js';
import { canonicalJson, sha256Digest } from '../src/rubrist.js';
import {
  releasePolicyV2CandidateProjection,
  releasePolicyV2Digest,
  verifyReleasePolicyV2,
  type ReleasePolicyV2,
} from '../src/policy-v2.js';
import { releasePolicyDigest } from '../src/policy.js';
import {
  buildCalibrationReportV6,
  parseCanonicalCalibrationReportV6Bytes,
  renderCalibrationReportMarkdown,
  reportV6Schema,
  serializeCalibrationReportV6,
  type CalibrationSuiteReport,
} from '../src/report-v6.js';
import {
  aggregateCriterionItems,
  buildSuiteDecisionStatement,
  candidateExecutionIdentity,
  providerExecutionIdentity,
  reportV5Schema,
  suiteExecutionPolicyDigest,
  type SuiteReport,
} from '../src/report-v5.js';
import { parseReportForInspection } from '../src/report.js';
import {
  evaluatorSuiteCriterionDigest,
  evaluatorSuiteManifestDigest,
  verifyEvaluatorSuiteManifest,
  type EvaluatorSuiteManifest,
} from '../src/suite-manifest.js';

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const STARTED_AT = '2026-08-23T13:00:00.000Z';
const FINISHED_AT = '2026-08-23T13:00:01.000Z';
const EVALUATED_AT = '2026-08-23T13:00:00.000Z';

function fixtureArtifact(name = 'binary-calibration-v1.complete.json'): BinaryCalibrationArtifact {
  return JSON.parse(readFileSync(
    new URL(`../contracts/fixtures/${name}`, import.meta.url),
    'utf8',
  )) as BinaryCalibrationArtifact;
}

function governedFixture(name = 'binary-calibration-v1.complete.json'): {
  artifact: BinaryCalibrationArtifact;
  bytes: Uint8Array;
  manifest: EvaluatorSuiteManifest;
} {
  const artifact = structuredClone(fixtureArtifact(name));
  const member = {
    position: 0,
    criterionId: artifact.criterion.criterionId,
    criterionVersionId: artifact.criterion.criterionVersionId,
    criterionName: 'Binary calibration test criterion',
    criterionDefinition: 'The output satisfies the frozen test criterion.',
    criterionDigest: ZERO_DIGEST,
    skillId: artifact.evaluator.skillId,
    skillVersionId: artifact.evaluator.skillVersionId,
    skillDigest: artifact.evaluator.skillDigest,
    outputContractDigest: artifact.evaluator.outputContractDigest,
    applicability: { kind: 'all_items' as const },
  };
  member.criterionDigest = evaluatorSuiteCriterionDigest(member);
  const manifest: EvaluatorSuiteManifest = {
    contract: 'rubrist/evaluator-suite-manifest/v1',
    schemaVersion: 1,
    manifestId: 'manifest-calibration-report-v6',
    suiteId: 'suite-calibration-report-v6',
    projectId: artifact.projectId,
    revision: 1,
    members: [member],
    trialPlan: null,
    manifestDigest: ZERO_DIGEST,
  };
  manifest.manifestDigest = evaluatorSuiteManifestDigest(manifest);
  verifyEvaluatorSuiteManifest(manifest);

  artifact.criterion.criterionDigest = member.criterionDigest;
  artifact.suiteBinding = {
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    memberPosition: 0,
  };
  artifact.evidenceDigest = binaryCalibrationEvidenceDigest(artifact);
  verifyBinaryCalibrationArtifact(artifact);
  const bytes = Buffer.from(canonicalJson(artifact), 'utf8');
  return { artifact, bytes, manifest };
}

function requirement(artifact: BinaryCalibrationArtifact) {
  return {
    contract: 'dailies/binary-calibration-requirement/v1' as const,
    requiredTruthRole: 'sealed_validation' as const,
    requiredTruthProvenanceLevel: 'governed_blind' as const,
    requiredPositiveClass: artifact.positiveClass,
    requiredRepresentativeOfPopulationId: artifact.truth.representativeOfPopulationId,
    trialRule: { kind: 'all_trials_meet/v1' as const, minimumTrials: 1 },
    maximumAgeSeconds: 7_200,
    minimumProviderIdentityStrength: 'requested_only' as const,
    minimumTruthSupport: { total: 1, pass: 0, fail: 0 },
    minimumClassifiedCoverage: { overall: '0', truthPass: '0', truthFail: '0' },
    metricChecks: [{
      metric: 'accuracy' as const,
      minimumDenominator: 1,
      minimumPointEstimate: '0',
      minimumWilsonLowerBound: null,
    }],
  };
}

function policy(manifest: EvaluatorSuiteManifest, artifact: BinaryCalibrationArtifact): ReleasePolicyV2 {
  return verifyReleasePolicyV2({
    schemaVersion: 2,
    id: 'release-policy-v6',
    version: '1',
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    criteria: [{
      criterionVersionId: manifest.members[0]!.criterionVersionId,
      evidenceRequirement: 'mandatory',
      consequence: 'blocking',
      rule: { kind: 'binary_threshold/v1', minPassRate: 0.9, maxRegressions: 0 },
      calibrationRequirement: requirement(artifact),
    }],
    compensationGroups: [],
  }, manifest);
}

function releaseScope() {
  return {
    id: 'candidate-regression-scope',
    kind: 'regression_corpus' as const,
    collectionProcedure: 'Pinned local JSONL regression fixture.',
    population: 'The exact checked-in candidate regression cases.',
    timeWindow: {
      kind: 'not_applicable' as const,
      reason: 'Static regression evidence has no sampling time window.',
    },
    inputArtifact: {
      type: 'jsonl' as const,
      digest: `sha256:${'1'.repeat(64)}`,
      declaredDigest: `sha256:${'1'.repeat(64)}`,
      byteLength: 42,
      itemCount: 1,
    },
    coverage: { expectedItems: 1, observedItems: 1 },
    producerProvenance: {
      datasetRevision: 'not_provided' as const,
      exposure: 'not_provided' as const,
      review: 'not_provided' as const,
    },
  };
}

function candidateReport(
  manifest: EvaluatorSuiteManifest,
  policyV2: ReleasePolicyV2,
): SuiteReport {
  const scope = releaseScope();
  const policyV1 = releasePolicyV2CandidateProjection(policyV2);
  const provider = providerExecutionIdentity({ type: 'rubrist', url: 'https://rubrist.example' });
  const candidate = candidateExecutionIdentity({ type: 'command', template: 'candidate {input}' });
  const executionPolicy = {
    scheduling: 'manifest_order_bounded_pool/v1' as const,
    deadlineStartsAt: 'after_candidate_execution' as const,
    evidenceDeadlineMs: 5_000,
    pollIntervalMs: 100,
    perCallTimeoutMs: 1_000,
    concurrency: 1,
    provider,
    candidate,
  };
  const criterionItems = [{
    id: 'case-1',
    assessedLabel: null,
    comparison: 'unpaired' as const,
    regression: false,
  }];
  const totals = aggregateCriterionItems(criterionItems);
  const report: SuiteReport = {
    schemaVersion: 5,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    scope,
    trustPolicy: { admissibleClasses: ['verified', 'deterministic'] },
    manifest,
    policy: policyV1,
    policyDigest: releasePolicyDigest(policyV1),
    executionPolicy,
    executionPolicyDigest: suiteExecutionPolicyDigest(executionPolicy),
    candidateExecution: {
      total: 1,
      succeeded: 0,
      failed: 1,
      items: [{
        id: 'case-1',
        input: 'candidate input',
        status: 'error',
        error: 'candidate configuration failed',
        errorKind: 'execution',
        attempts: [{
          attempt: 1,
          outcome: 'error',
          errorKind: 'execution',
          retryable: false,
        }],
      }],
    },
    candidateDatasetDigest: null,
    criteria: [{
      position: 0,
      criterionId: manifest.members[0]!.criterionId,
      criterionVersionId: manifest.members[0]!.criterionVersionId,
      criterionName: manifest.members[0]!.criterionName,
      criterionDefinition: manifest.members[0]!.criterionDefinition,
      criterionDigest: manifest.members[0]!.criterionDigest,
      skillId: manifest.members[0]!.skillId,
      skillVersionId: manifest.members[0]!.skillVersionId,
      skillDigest: manifest.members[0]!.skillDigest,
      outputContractDigest: manifest.members[0]!.outputContractDigest,
      suite: { manifestId: manifest.manifestId, manifestDigest: manifest.manifestDigest },
      scope: { id: scope.id, kind: scope.kind, inputDigest: scope.inputArtifact.digest },
      trust: {
        status: 'unavailable',
        derivation: 'rubrist_receipt_v1',
        admissible: false,
        reason: 'no_candidate_outputs',
      },
      evidence: {
        state: 'incomplete',
        operations: [],
        zeroRequestTermination: {
          phase: 'candidate_filter',
          reason: 'no_candidate_outputs',
        },
        error: 'no candidate outputs were available for evidence submission',
      },
      totals,
      items: criterionItems,
      policyResult: {
        evidenceRequirement: 'mandatory',
        consequence: 'blocking',
        rulePassed: null,
      },
    }],
    compensation: [],
    decision: 'block',
    decisionPrecedence: 'candidate_execution_failure',
    decisionStatement: buildSuiteDecisionStatement(
      'block',
      policyV1.id,
      policyV1.version,
      releasePolicyDigest(policyV1),
      manifest.manifestId,
      manifest.manifestDigest,
      scope.kind,
      scope.id,
      scope.inputArtifact.digest,
    ),
  };
  return reportV5Schema.parse(report);
}

function sourceFor(fixture: ReturnType<typeof governedFixture>) {
  return {
    type: 'file' as const,
    path: '/sealed/calibration.json',
    artifactDigest: binaryCalibrationArtifactByteDigest(fixture.bytes),
    expectedIdentity: expectedBinaryCalibrationIdentity(fixture.artifact),
  };
}

function collectionFor(fixture: ReturnType<typeof governedFixture>): CalibrationCollectionResult {
  return collectCalibrationEvidence({
    criterionVersionId: fixture.manifest.members[0]!.criterionVersionId,
    source: sourceFor(fixture),
    manifest: fixture.manifest,
    member: fixture.manifest.members[0]!,
    bytes: fixture.bytes,
  });
}

function completedReport(
  fixture = governedFixture(),
  collection = collectionFor(fixture),
): CalibrationSuiteReport {
  const acceptedPolicy = policy(fixture.manifest, fixture.artifact);
  return buildCalibrationReportV6({
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    evaluatedAt: EVALUATED_AT,
    releaseScope: releaseScope(),
    manifest: fixture.manifest,
    policy: acceptedPolicy,
    candidateAssessment: {
      status: 'completed',
      report: candidateReport(fixture.manifest, acceptedPolicy),
    },
    calibrationCollections: [collection],
  });
}

function preflightReport(
  fixture: ReturnType<typeof governedFixture>,
  collection: CalibrationCollectionResult,
): CalibrationSuiteReport {
  return buildCalibrationReportV6({
    startedAt: STARTED_AT,
    finishedAt: STARTED_AT,
    evaluatedAt: EVALUATED_AT,
    releaseScope: releaseScope(),
    manifest: fixture.manifest,
    policy: policy(fixture.manifest, fixture.artifact),
    candidateAssessment: {
      status: 'not_started',
      reason: 'required_calibration_integrity_failure',
    },
    calibrationCollections: [collection],
  });
}

function tamper(report: CalibrationSuiteReport, mutate: (copy: any) => void): unknown {
  const copy = structuredClone(report);
  mutate(copy);
  return copy;
}

describe('calibration-aware report v6', () => {
  it('retains separate release/calibration scopes and independently verifies deterministic bytes', () => {
    const report = completedReport();
    expect(report.schemaVersion).toBe(6);
    expect(report.releaseScope.kind).toBe('regression_corpus');
    expect(report.criteria[0]!.calibrationTruthScope?.kind).toBe('sealed_validation_calibration');
    expect(report.criteria[0]!.evidenceState).toBe('verified');
    expect(report.criteria[0]!.trust).toEqual({
      status: 'verified',
      derivation: 'rubrist_binary_calibration_v1',
    });
    expect(report.criteria[0]!.calibrationPolicy.status).toBe('satisfied');
    expect(report.criteria[0]!.ageMilliseconds).toBe('3598000');
    expect(report.criteria[0]!.effectiveAssessment).toMatchObject({
      calibrationAdmissible: true,
      releaseAdmissible: false,
    });
    expect(report.decision).toBe('block');
    expect(report.decisionStatement).toContain(report.calibrationEvidenceSetDigest);
    expect(report.decisionStatement).toContain(report.candidateAssessmentDigest);

    const first = serializeCalibrationReportV6(report);
    const second = serializeCalibrationReportV6(structuredClone(report));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(parseCanonicalCalibrationReportV6Bytes(first)).toEqual(report);
    const raw = structuredClone(report);
    const inspection = parseReportForInspection(raw);
    expect(inspection).toMatchObject({ schemaVersion: 6, readOnly: false });
    expect(inspection.report).toEqual(report);
    expect(inspection.report).not.toBe(raw);
  });

  it('renders trust, age, requirement checks, effective admissibility, and trial failures', () => {
    const fixture = governedFixture();
    const strictPolicy = structuredClone(policy(fixture.manifest, fixture.artifact));
    strictPolicy.criteria[0]!.calibrationRequirement.metricChecks[0]!.minimumWilsonLowerBound = '1';
    const acceptedPolicy = verifyReleasePolicyV2(strictPolicy, fixture.manifest);
    const report = buildCalibrationReportV6({
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      evaluatedAt: EVALUATED_AT,
      releaseScope: releaseScope(),
      manifest: fixture.manifest,
      policy: acceptedPolicy,
      candidateAssessment: {
        status: 'completed',
        report: candidateReport(fixture.manifest, acceptedPolicy),
      },
      calibrationCollections: [collectionFor(fixture)],
    });
    const markdown = renderCalibrationReportMarkdown(report);
    expect(markdown).toContain('# Calibration-aware criterion release report: BLOCK');
    expect(markdown).toContain('verified/rubrist_binary_calibration_v1');
    expect(markdown).toContain('Separate calibration truth scope: sealed_validation_calibration/');
    expect(markdown).toContain('Artifact age: 3598000 ms');
    expect(markdown).toContain('Requirement checks:');
    expect(markdown).toContain('Effective assessment admissible: false');
    expect(markdown).toContain('#### Trial 0 calibration failure');
    expect(markdown).toContain('metric_wilson_lower_bound_below_minimum');
  });

  it('retains an incomplete but canonical public artifact as accepted and unavailable trust', () => {
    const fixture = governedFixture('binary-calibration-v1.incomplete.json');
    const collection = collectionFor(fixture);
    expect(collection.state).toBe('incomplete');
    const acceptedPolicy = policy(fixture.manifest, fixture.artifact);
    const report = buildCalibrationReportV6({
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      evaluatedAt: EVALUATED_AT,
      releaseScope: releaseScope(),
      manifest: fixture.manifest,
      policy: acceptedPolicy,
      candidateAssessment: {
        status: 'completed',
        report: candidateReport(fixture.manifest, acceptedPolicy),
      },
      calibrationCollections: [collection],
    });
    expect(report.criteria[0]!.artifactEvidence.disposition).toBe('accepted');
    expect(report.criteria[0]!.evidenceState).toBe('incomplete');
    expect(report.criteria[0]!.trust).toMatchObject({
      status: 'unavailable',
      reason: 'artifact_incomplete',
    });
    expect(reportV6Schema.parse(structuredClone(report))).toEqual(report);
  });

  it('retains rejected evidence only as bounded digests and a typed reason', () => {
    const fixture = governedFixture();
    const source = { ...sourceFor(fixture), artifactDigest: ZERO_DIGEST };
    const collection = collectCalibrationEvidence({
      criterionVersionId: fixture.manifest.members[0]!.criterionVersionId,
      source,
      manifest: fixture.manifest,
      member: fixture.manifest.members[0]!,
      bytes: fixture.bytes,
    });
    expect(collection).toMatchObject({ state: 'integrity_failure', reason: 'artifact_digest_mismatch' });
    const report = preflightReport(fixture, collection);
    const evidence = report.criteria[0]!.artifactEvidence;
    expect(evidence).toMatchObject({
      disposition: 'rejected',
      expectedArtifactDigest: ZERO_DIGEST,
      reason: 'artifact_digest_mismatch',
    });
    expect(evidence).not.toHaveProperty('artifact');
    expect(canonicalJson(report)).not.toContain('/sealed/calibration.json');
    expect(report.decisionPrecedence).toBe('required_integrity_failure');
    expect(reportV6Schema.parse(structuredClone(report))).toEqual(report);
  });

  it.each([
    ['policy digest', (r: any) => { r.policyDigest = ZERO_DIGEST; }],
    ['candidate assessment digest', (r: any) => { r.candidateAssessmentDigest = ZERO_DIGEST; }],
    ['calibration set digest', (r: any) => { r.calibrationEvidenceSetDigest = ZERO_DIGEST; }],
    ['expected identity', (r: any) => { r.criteria[0].expectedIdentity.projectId = 'swapped'; }],
    ['artifact metrics', (r: any) => { r.criteria[0].artifactEvidence.artifact.trials[0].confusionMatrix.truthPassEvaluatorPass = 0; }],
    ['calibration truth scope', (r: any) => { r.criteria[0].calibrationTruthScope.revisionDigest = ZERO_DIGEST; }],
    ['evidence state', (r: any) => { r.criteria[0].evidenceState = 'incomplete'; }],
    ['trust', (r: any) => { r.criteria[0].trust = { status: 'unavailable', derivation: 'rubrist_binary_calibration_v1', reason: 'artifact_incomplete' }; }],
    ['age', (r: any) => { r.criteria[0].ageMilliseconds = '0'; }],
    ['requirement checks', (r: any) => { r.criteria[0].calibrationPolicy.checks[0].passed = false; }],
    ['per trial result', (r: any) => { r.criteria[0].calibrationPolicy.trials[0].passed = false; }],
    ['worst reason', (r: any) => { r.criteria[0].calibrationPolicy.worstReason = 'artifact_too_old'; }],
    ['effective admissibility', (r: any) => { r.criteria[0].effectiveAssessment.releaseAdmissible = true; }],
    ['decision', (r: any) => { r.decision = 'promote'; }],
    ['decision statement', (r: any) => { r.decisionStatement += ' tampered'; }],
  ])('rejects %s tampering', (_name, mutateReport) => {
    expect(() => reportV6Schema.parse(tamper(completedReport(), mutateReport))).toThrow();
  });

  it('enforces evaluatedAt <= startedAt and candidate preflight termination', () => {
    expect(() => reportV6Schema.parse(tamper(completedReport(), (report) => {
      report.evaluatedAt = '2026-08-23T13:00:00.001Z';
    }))).toThrow(/lifecycle/);
    expect(() => reportV6Schema.parse(tamper(completedReport(), (report) => {
      report.candidateAssessment = {
        status: 'not_started',
        reason: 'required_calibration_integrity_failure',
      };
      report.candidateAssessmentDigest = sha256Digest(report.candidateAssessment);
    }))).toThrow(/preflight/);
  });

  it('rejects impossible rejected-reason and digest combinations', () => {
    const fixture = governedFixture();
    const digestMismatch = collectCalibrationEvidence({
      criterionVersionId: fixture.manifest.members[0]!.criterionVersionId,
      source: { ...sourceFor(fixture), artifactDigest: ZERO_DIGEST },
      manifest: fixture.manifest,
      member: fixture.manifest.members[0]!,
      bytes: fixture.bytes,
    });
    const digestReport = preflightReport(fixture, digestMismatch);
    expect(() => reportV6Schema.parse(tamper(digestReport, (report) => {
      report.criteria[0].artifactEvidence.observedArtifactDigest = ZERO_DIGEST;
    }))).toThrow(/distinct/);

    const notFound = collectCalibrationEvidence({
      criterionVersionId: fixture.manifest.members[0]!.criterionVersionId,
      source: sourceFor(fixture),
      manifest: fixture.manifest,
      member: fixture.manifest.members[0]!,
      readFailure: 'not_found',
    });
    const notFoundReport = preflightReport(fixture, notFound);
    expect(() => reportV6Schema.parse(tamper(notFoundReport, (report) => {
      report.criteria[0].artifactEvidence.observedArtifactDigest = ZERO_DIGEST;
    }))).toThrow(/cannot have an observed digest/);

    const mismatchedIdentity = structuredClone(sourceFor(fixture));
    mismatchedIdentity.expectedIdentity.projectId = 'another-project';
    const binding = collectCalibrationEvidence({
      criterionVersionId: fixture.manifest.members[0]!.criterionVersionId,
      source: mismatchedIdentity,
      manifest: fixture.manifest,
      member: fixture.manifest.members[0]!,
      bytes: fixture.bytes,
    });
    const bindingReport = preflightReport(fixture, binding);
    expect(() => reportV6Schema.parse(tamper(bindingReport, (report) => {
      report.criteria[0].expectedIdentity.projectId = fixture.manifest.projectId;
    }))).toThrow(/manifest_binding_mismatch/);
  });

  it('rejects noncanonical transport, BOM, unknown fields, and unsupported legacy shapes', () => {
    const report = completedReport();
    expect(() => parseCanonicalCalibrationReportV6Bytes(
      Buffer.from(`${canonicalJson(report)}\n`, 'utf8'),
    )).toThrow(/canonical/);
    expect(() => parseCanonicalCalibrationReportV6Bytes(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      serializeCalibrationReportV6(report),
    ]))).toThrow(/BOM/);
    expect(() => reportV6Schema.parse(tamper(report, (copy) => {
      copy.criteria[0].sealedCases = ['must-not-appear'];
    }))).toThrow();
    expect(() => parseReportForInspection({ ...report, schemaVersion: 5 })).toThrow();
  });

  it.each([
    ['outer policy default', (report: any) => { delete report.policy.compensationGroups; }],
    ['embedded v5 policy default', (report: any) => {
      delete report.candidateAssessment.report.policy.compensationGroups;
    }],
  ])('rejects omitted %s without normalizing object or canonical bytes', (_name, omitDefault) => {
    const alternate = structuredClone(completedReport());
    omitDefault(alternate);
    expect(() => reportV6Schema.parse(alternate)).toThrow(/normalization is forbidden/);
    expect(() => parseCanonicalCalibrationReportV6Bytes(
      Buffer.from(canonicalJson(alternate), 'utf8'),
    )).toThrow(/normalization is forbidden/);
  });

  it('binds the v2 policy digest and never substitutes the v5 candidate projection', () => {
    const report = completedReport();
    expect(report.policyDigest).toBe(releasePolicyV2Digest(report.policy));
    expect(() => reportV6Schema.parse(tamper(report, (copy) => {
      copy.candidateAssessment.report.policy.criteria[0].rule.minPassRate = 0;
      copy.candidateAssessment.report.policyDigest = releasePolicyDigest(
        copy.candidateAssessment.report.policy,
      );
      copy.candidateAssessment.report.decisionStatement = buildSuiteDecisionStatement(
        copy.candidateAssessment.report.decision,
        copy.candidateAssessment.report.policy.id,
        copy.candidateAssessment.report.policy.version,
        copy.candidateAssessment.report.policyDigest,
        copy.manifest.manifestId,
        copy.manifest.manifestDigest,
        copy.releaseScope.kind,
        copy.releaseScope.id,
        copy.releaseScope.inputArtifact.digest,
      );
      copy.candidateAssessment.reportDigest = sha256Digest(copy.candidateAssessment.report);
      copy.candidateAssessmentDigest = sha256Digest(copy.candidateAssessment);
    }))).toThrow(/identity/);
  });
});
