import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  binaryCalibrationArtifactByteDigest,
  expectedBinaryCalibrationIdentity,
  parseCanonicalBinaryCalibrationBytes,
  type BinaryCalibrationArtifact,
} from '../src/binary-calibration.js';
import {
  calibrationEvidenceSetDigest,
  collectCalibrationEvidence,
  evaluateCalibrationRequirement,
  type CalibrationCollectionResult,
  type CalibrationPolicyResult,
} from '../src/calibration-policy.js';
import type { CalibrationEvidenceFileSource } from '../src/config-v6.js';
import {
  applyReleasePolicyV2,
  binaryCalibrationRequirementV1Schema,
  releasePolicyV2CandidateProjection,
  releasePolicyV2Schema,
  type BinaryCalibrationRequirementV1,
  type ReleasePolicyV2,
} from '../src/policy-v2.js';
import type {
  EvaluatorSuiteManifest,
  EvaluatorSuiteManifestMember,
} from '../src/suite-manifest.js';

function fixtureBytes(name: 'complete' | 'repeated' | 'incomplete'): Uint8Array {
  return readFileSync(new URL(
    `../contracts/fixtures/binary-calibration-v1.${name}.json`,
    import.meta.url,
  ));
}

function artifact(name: 'complete' | 'repeated' | 'incomplete'): BinaryCalibrationArtifact {
  return parseCanonicalBinaryCalibrationBytes(fixtureBytes(name));
}

function manifestFor(value: BinaryCalibrationArtifact): {
  manifest: EvaluatorSuiteManifest;
  member: EvaluatorSuiteManifestMember;
} {
  const member: EvaluatorSuiteManifestMember = {
    position: 0,
    criterionId: value.criterion.criterionId,
    criterionVersionId: value.criterion.criterionVersionId,
    criterionName: 'Calibration test criterion',
    criterionDefinition: 'A criterion used to test release calibration policy.',
    criterionDigest: value.criterion.criterionDigest,
    skillId: value.evaluator.skillId,
    skillVersionId: value.evaluator.skillVersionId,
    skillDigest: value.evaluator.skillDigest,
    outputContractDigest: value.evaluator.outputContractDigest,
    applicability: { kind: 'all_items' },
  };
  return {
    member,
    manifest: {
      contract: 'coeval/evaluator-suite-manifest/v1',
      schemaVersion: 1,
      manifestId: value.suiteBinding?.manifestId ?? 'current-manifest',
      suiteId: 'suite-calibration-test',
      projectId: value.projectId,
      revision: 1,
      members: [member],
      trialPlan: null,
      manifestDigest: value.suiteBinding?.manifestDigest ?? `sha256:${'e'.repeat(64)}`,
    },
  };
}

function sourceFor(value: BinaryCalibrationArtifact, bytes: Uint8Array): CalibrationEvidenceFileSource {
  return {
    type: 'file',
    path: '/configured/calibration.json',
    artifactDigest: binaryCalibrationArtifactByteDigest(bytes),
    expectedIdentity: expectedBinaryCalibrationIdentity(value),
  };
}

function collect(name: 'complete' | 'repeated' | 'incomplete'): CalibrationCollectionResult {
  const bytes = fixtureBytes(name);
  const value = artifact(name);
  const { manifest, member } = manifestFor(value);
  return collectCalibrationEvidence({
    criterionVersionId: value.criterion.criterionVersionId,
    source: sourceFor(value, bytes),
    manifest,
    member,
    bytes,
  });
}

function requirement(
  value: BinaryCalibrationArtifact,
  overrides: Partial<BinaryCalibrationRequirementV1> = {},
): BinaryCalibrationRequirementV1 {
  return binaryCalibrationRequirementV1Schema.parse({
    contract: 'dailies/binary-calibration-requirement/v1',
    requiredTruthRole: 'sealed_validation',
    requiredTruthProvenanceLevel: 'governed_blind',
    requiredPositiveClass: value.positiveClass,
    requiredRepresentativeOfPopulationId: value.truth.representativeOfPopulationId,
    trialRule: { kind: 'all_trials_meet/v1', minimumTrials: value.trials.length },
    maximumAgeSeconds: 60,
    minimumProviderIdentityStrength: 'requested_only',
    minimumTruthSupport: { total: 2, pass: 1, fail: 1 },
    minimumClassifiedCoverage: { overall: '0', truthPass: '0', truthFail: '0' },
    metricChecks: [{
      metric: 'accuracy',
      minimumDenominator: 1,
      minimumPointEstimate: '0',
      minimumWilsonLowerBound: '0',
    }],
    ...overrides,
  });
}

describe('binary calibration collection boundary', () => {
  it('verifies exact bytes and all pinned identities while deriving a separate scope', () => {
    const result = collect('complete');
    expect(result).toMatchObject({
      state: 'verified',
      criterionVersionId: 'criterion-version-7',
      calibrationEvidenceScope: {
        kind: 'sealed_validation_calibration',
        datasetRevisionId: 'dataset-revision-sealed-4',
        completionExposureState: 'protected',
      },
    });
    expect(calibrationEvidenceSetDigest([result])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(calibrationEvidenceSetDigest([result])).toBe(calibrationEvidenceSetDigest([result]));
  });

  it('types absence separately from configured local read and integrity failures', () => {
    const value = artifact('complete');
    const bytes = fixtureBytes('complete');
    const source = sourceFor(value, bytes);
    const { manifest, member } = manifestFor(value);
    const base = { criterionVersionId: value.criterion.criterionVersionId, manifest, member };

    expect(collectCalibrationEvidence({ ...base, source: null })).toMatchObject({
      state: 'incomplete', reason: 'source_not_configured',
    });
    expect(collectCalibrationEvidence({ ...base, source, readFailure: 'not_found' })).toMatchObject({
      state: 'integrity_failure', reason: 'source_not_found',
    });
    expect(collectCalibrationEvidence({ ...base, source, readFailure: 'read_failed' })).toMatchObject({
      state: 'integrity_failure', reason: 'source_read_failed',
    });
    const tampered = Uint8Array.from(bytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! === 0x7d ? 0x20 : 0x7d;
    expect(collectCalibrationEvidence({ ...base, source, bytes: tampered })).toMatchObject({
      state: 'integrity_failure', reason: 'artifact_digest_mismatch',
    });

    const swapped = structuredClone(source);
    swapped.expectedIdentity.artifactId = 'another-artifact';
    expect(collectCalibrationEvidence({ ...base, source: swapped, bytes })).toMatchObject({
      state: 'integrity_failure', reason: 'artifact_identity_mismatch',
    });
    const swappedManifest = structuredClone(manifest);
    swappedManifest.manifestId = 'another-manifest';
    expect(collectCalibrationEvidence({
      ...base,
      manifest: swappedManifest,
      source,
      bytes,
    })).toMatchObject({
      state: 'integrity_failure', reason: 'manifest_binding_mismatch',
    });
    const substitutedMember = { ...member, skillVersionId: 'substituted-skill-version' };
    expect(collectCalibrationEvidence({
      ...base,
      member: substitutedMember,
      source: {
        ...source,
        expectedIdentity: {
          ...source.expectedIdentity,
          skillVersionId: substitutedMember.skillVersionId,
        },
      },
      bytes,
    })).toMatchObject({
      state: 'integrity_failure', reason: 'manifest_binding_mismatch',
    });
    expect(collect('incomplete')).toMatchObject({
      state: 'incomplete', reason: 'artifact_incomplete',
    });
  });

  it('accepts the frozen repeated artifact with an explicitly absent suite binding', () => {
    const result = collect('repeated');
    expect(result.state).toBe('verified');
    expect(result.source?.expectedIdentity).toMatchObject({
      suiteManifestId: null,
      suiteManifestDigest: null,
      suiteMemberPosition: null,
    });
  });
});

describe('binary calibration customer policy', () => {
  it('treats total and per-class support floors independently', () => {
    const value = artifact('complete');
    expect(() => requirement(value, {
      minimumTruthSupport: { total: 10, pass: 10, fail: 10 },
    })).not.toThrow();
  });

  it('rejects malformed canonical decimals as schema errors rather than throwing from refinements', () => {
    const value = artifact('complete');
    const raw = requirement(value) as unknown as Record<string, any>;
    raw.minimumClassifiedCoverage.overall = '0.0';
    expect(binaryCalibrationRequirementV1Schema.safeParse(raw).success).toBe(false);
  });

  it('uses exact decimal point and Wilson comparisons and never pools repeated trials', () => {
    const value = artifact('repeated');
    const strict = requirement(value, {
      metricChecks: [{
        metric: 'accuracy',
        minimumDenominator: 1,
        minimumPointEstimate: '0.5',
        minimumWilsonLowerBound: null,
      }],
    });
    const result = evaluateCalibrationRequirement(
      value.criterion.criterionVersionId,
      strict,
      collect('repeated'),
      '2026-08-23T12:00:10.000Z',
    );
    expect(result).toMatchObject({
      status: 'insufficient',
      admissible: false,
      trials: [
        { trialIndex: 0, passed: true },
        {
          trialIndex: 1,
          passed: false,
          reasons: ['metric_point_estimate_below_minimum'],
        },
      ],
    });

    const lowerBound = evaluateCalibrationRequirement(
      value.criterion.criterionVersionId,
      requirement(value, {
        metricChecks: [{
          metric: 'accuracy',
          minimumDenominator: 1,
          minimumPointEstimate: null,
          minimumWilsonLowerBound: '0.0000000000000000001',
        }],
      }),
      collect('repeated'),
      '2026-08-23T12:00:10.000Z',
    );
    expect(lowerBound.trials[1]).toMatchObject({
      passed: false,
      reasons: ['metric_wilson_lower_bound_below_minimum'],
    });
  });

  it('checks support, coverage, freshness, provider strength, class, and population independently', () => {
    const value = artifact('complete');
    const observed = collect('complete');
    const result = evaluateCalibrationRequirement(
      value.criterion.criterionVersionId,
      requirement(value, {
        requiredPositiveClass: 'fail',
        requiredRepresentativeOfPopulationId: 'another-population',
        maximumAgeSeconds: 1,
        minimumProviderIdentityStrength: 'observed_fingerprint',
        minimumTruthSupport: { total: 4, pass: 2, fail: 2 },
        minimumClassifiedCoverage: { overall: '0.6', truthPass: '1', truthFail: '0.1' },
      }),
      observed,
      '2026-08-23T12:00:10.000Z',
    );
    expect(result.status).toBe('insufficient');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'positive_class_mismatch',
      'representative_population_mismatch',
      'artifact_too_old',
      'truth_support_total_below_minimum',
      'provider_identity_strength_below_minimum',
      'classified_coverage_overall_below_minimum',
      'classified_coverage_truth_fail_below_minimum',
    ]));
  });

  it('classifies an artifact completed after evaluatedAt as integrity failure', () => {
    const value = artifact('complete');
    expect(evaluateCalibrationRequirement(
      value.criterion.criterionVersionId,
      requirement(value),
      collect('complete'),
      '2026-08-23T12:00:01.000Z',
    )).toMatchObject({
      status: 'integrity_failure',
      worstReason: 'artifact_completed_after_evaluated_at',
    });
  });

  it('classifies a retained incomplete artifact from the future as integrity failure', () => {
    const value = artifact('incomplete');
    const collection = collect('incomplete');
    expect(collection).toMatchObject({
      state: 'incomplete',
      reason: 'artifact_incomplete',
      artifact: { status: 'incomplete' },
    });
    expect(evaluateCalibrationRequirement(
      value.criterion.criterionVersionId,
      requirement(value),
      collection,
      '2026-08-23T12:00:01.000Z',
    )).toMatchObject({
      status: 'integrity_failure',
      collectionState: 'incomplete',
      reasons: ['artifact_completed_after_evaluated_at'],
      worstReason: 'artifact_completed_after_evaluated_at',
      checks: [{ check: 'freshness', passed: false }],
    });
  });
});

function policyFor(
  value: BinaryCalibrationArtifact,
  calibrationRequirement: BinaryCalibrationRequirementV1 | null,
): ReleasePolicyV2 {
  const { manifest } = manifestFor(value);
  return {
    schemaVersion: 2,
    id: 'release-policy-v2-test',
    version: '1',
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    criteria: [{
      criterionVersionId: value.criterion.criterionVersionId,
      evidenceRequirement: 'mandatory',
      consequence: 'blocking',
      rule: { kind: 'binary_threshold/v1', minPassRate: 0.9, maxRegressions: 0 },
      calibrationRequirement,
    }],
    compensationGroups: [],
  };
}

function notRequiredCalibration(criterionVersionId: string): CalibrationPolicyResult {
  return {
    criterionVersionId,
    status: 'not_required',
    admissible: true,
    evaluatedAt: '2026-08-23T12:00:10.000Z',
    requirement: null,
    collectionState: 'incomplete',
    calibrationEvidenceScope: null,
    reasons: [],
    worstReason: null,
    checks: [],
    trials: [],
  };
}

function requiredCalibrationResult(
  criterionVersionId: string,
  calibrationRequirement: BinaryCalibrationRequirementV1,
  status: 'satisfied' | 'insufficient' | 'incomplete' | 'integrity_failure',
): CalibrationPolicyResult {
  const reason = status === 'satisfied'
    ? null
    : status === 'incomplete'
      ? 'source_not_configured' as const
      : status === 'integrity_failure'
        ? 'source_not_found' as const
        : 'metric_point_estimate_below_minimum' as const;
  return {
    criterionVersionId,
    status,
    admissible: status === 'satisfied',
    evaluatedAt: '2026-08-23T12:00:10.000Z',
    requirement: calibrationRequirement,
    collectionState: status === 'integrity_failure'
      ? 'integrity_failure'
      : status === 'incomplete'
        ? 'incomplete'
        : 'verified',
    calibrationEvidenceScope: null,
    reasons: reason === null ? [] : [reason],
    worstReason: reason,
    checks: [],
    trials: [],
  };
}

describe('combined release policy v2 precedence', () => {
  it('accepts a blocking criterion that does not opt into calibration', () => {
    expect(releasePolicyV2Schema.parse(policyFor(artifact('complete'), null))
      .criteria[0]?.calibrationRequirement).toBeNull();
  });

  it('projects v2 to unchanged v1 candidate policy without calibration fields', () => {
    const value = artifact('complete');
    const projected = releasePolicyV2CandidateProjection(policyFor(value, requirement(value)));
    expect(projected.schemaVersion).toBe(1);
    expect(projected.criteria[0]).not.toHaveProperty('calibrationRequirement');
  });

  it('requires a blocking criterion own opted-in calibration before it can block', () => {
    const value = artifact('complete');
    const required = requirement(value);
    const policy = policyFor(value, required);
    const criterionVersionId = value.criterion.criterionVersionId;
    const evidence = [{
      criterionVersionId,
      evidenceState: 'complete' as const,
      trustAdmissible: true,
      passed: 0,
      total: 2,
      passRate: 0,
      regressions: 1,
    }];
    const satisfied = evaluateCalibrationRequirement(
      criterionVersionId,
      required,
      collect('complete'),
      '2026-08-23T12:00:10.000Z',
    );
    expect(applyReleasePolicyV2(policy, evidence, [satisfied], false)).toMatchObject({
      decision: 'block', precedence: 'complete_blocking_failure',
    });

    const missingCollection = collectCalibrationEvidence({
      criterionVersionId,
      source: null,
      ...manifestFor(value),
    });
    const missing = evaluateCalibrationRequirement(
      criterionVersionId,
      required,
      missingCollection,
      '2026-08-23T12:00:10.000Z',
    );
    expect(applyReleasePolicyV2(policy, evidence, [missing], false)).toMatchObject({
      decision: 'inconclusive', precedence: 'mandatory_evidence_incomplete',
    });

    const future = evaluateCalibrationRequirement(
      criterionVersionId,
      required,
      collect('complete'),
      '2026-08-23T12:00:01.000Z',
    );
    expect(applyReleasePolicyV2(policy, evidence, [future], true)).toMatchObject({
      decision: 'inconclusive', precedence: 'required_integrity_failure',
    });
  });

  it('keeps calibration opt-in and rejects a result evaluated under another requirement', () => {
    const value = artifact('complete');
    const criterionVersionId = value.criterion.criterionVersionId;
    const noCalibration = policyFor(value, null);
    const evidence = [{
      criterionVersionId,
      evidenceState: 'complete' as const,
      trustAdmissible: true,
      passed: 0,
      total: 1,
      passRate: 0,
      regressions: 1,
    }];
    expect(applyReleasePolicyV2(
      noCalibration,
      evidence,
      [notRequiredCalibration(criterionVersionId)],
      false,
    )).toMatchObject({ decision: 'block', precedence: 'complete_blocking_failure' });

    const evaluated = evaluateCalibrationRequirement(
      criterionVersionId,
      requirement(value),
      collect('complete'),
      '2026-08-23T12:00:10.000Z',
    );
    expect(() => applyReleasePolicyV2(noCalibration, evidence, [evaluated], false))
      .toThrow(/calibration requirement mismatch/);
  });

  it('implements the multi-criterion ADR-0005 calibration truth table', () => {
    const calibrationRequirement = requirement(artifact('complete'));
    const twoCriteria: ReleasePolicyV2 = {
      schemaVersion: 2,
      id: 'two-criterion-policy',
      version: '1',
      manifestId: 'manifest',
      manifestDigest: `sha256:${'1'.repeat(64)}`,
      criteria: [
        {
          criterionVersionId: 'blocking',
          evidenceRequirement: 'mandatory',
          consequence: 'blocking',
          rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
          calibrationRequirement,
        },
        {
          criterionVersionId: 'mandatory',
          evidenceRequirement: 'mandatory',
          consequence: 'advisory',
          rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
          calibrationRequirement,
        },
      ],
      compensationGroups: [],
    };
    const evidence = [
      {
        criterionVersionId: 'blocking',
        evidenceState: 'complete' as const,
        trustAdmissible: true,
        passed: 0,
        total: 1,
        passRate: 0,
        regressions: 1,
      },
      {
        criterionVersionId: 'mandatory',
        evidenceState: 'complete' as const,
        trustAdmissible: true,
        passed: 1,
        total: 1,
        passRate: 1,
        regressions: 0,
      },
    ];
    const satisfiedBlock = requiredCalibrationResult('blocking', calibrationRequirement, 'satisfied');

    expect(applyReleasePolicyV2(twoCriteria, evidence, [
      satisfiedBlock,
      requiredCalibrationResult('mandatory', calibrationRequirement, 'incomplete'),
    ], false)).toMatchObject({
      decision: 'block',
      precedence: 'complete_blocking_failure',
    });
    expect(applyReleasePolicyV2(twoCriteria, evidence, [
      requiredCalibrationResult('blocking', calibrationRequirement, 'incomplete'),
      requiredCalibrationResult('mandatory', calibrationRequirement, 'satisfied'),
    ], false)).toMatchObject({
      decision: 'inconclusive',
      precedence: 'mandatory_evidence_incomplete',
    });
    expect(applyReleasePolicyV2(twoCriteria, evidence, [
      satisfiedBlock,
      requiredCalibrationResult('mandatory', calibrationRequirement, 'integrity_failure'),
    ], false)).toMatchObject({
      decision: 'inconclusive',
      precedence: 'required_integrity_failure',
    });
  });

  it('never promotes after required calibration is weakened or removed', () => {
    const value = artifact('complete');
    const calibrationRequirement = requirement(value);
    const policy = policyFor(value, calibrationRequirement);
    const evidence = [{
      criterionVersionId: value.criterion.criterionVersionId,
      evidenceState: 'complete' as const,
      trustAdmissible: true,
      passed: 1,
      total: 1,
      passRate: 1,
      regressions: 0,
    }];
    expect(applyReleasePolicyV2(policy, evidence, [
      requiredCalibrationResult(value.criterion.criterionVersionId, calibrationRequirement, 'satisfied'),
    ], false).decision).toBe('promote');
    for (const status of ['insufficient', 'incomplete', 'integrity_failure'] as const) {
      expect(applyReleasePolicyV2(policy, evidence, [
        requiredCalibrationResult(value.criterion.criterionVersionId, calibrationRequirement, status),
      ], false).decision).not.toBe('promote');
    }
  });
});
