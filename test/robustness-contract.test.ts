import { describe, expect, it } from 'vitest';
import {
  AUTHORED_INVARIANT_SCENARIO_CONTRACT,
  authoredInvariantEnvironment,
  authoredInvariantOutcomeSchema,
  authoredInvariantRunSchema,
  authoredInvariantScenarioDigest,
  authoredInvariantScenarioSchema,
  buildAuthoredInvariantRun,
  classifyV4InvariantReport,
  classifyV5InvariantDecision,
  classifyV6InvariantDecision,
  evaluateAuthoredInvariantOutcome,
  type AuthoredInvariantEnvironment,
  type AuthoredInvariantObservation,
  type AuthoredInvariantScenario,
} from '../src/robustness.js';
import type { PolicyDecision } from '../src/policy.js';
import type { PolicyDecisionV2 } from '../src/policy-v2.js';
import type { Report } from '../src/report.js';

const isolation: AuthoredInvariantEnvironment['isolation'] = {
  network: 'configured_endpoints_validated_loopback',
  validatedLoopbackEndpoints: 0,
  caches: 'fresh_temporary_cache_directory',
  credentialVariablesRemoved: 0,
  proxyVariablesRemoved: 0,
  externalModels: 'none_configured',
};

function environment(sourceTree: 'clean' | 'dirty' = 'dirty'): AuthoredInvariantEnvironment {
  return authoredInvariantEnvironment('0.1.0', 'test-revision', sourceTree, isolation);
}

function promoteScenario(
  overrides: Partial<AuthoredInvariantScenario> = {},
): AuthoredInvariantScenario {
  return authoredInvariantScenarioSchema.parse({
    contract: AUTHORED_INVARIANT_SCENARIO_CONTRACT,
    schemaVersion: 1,
    evidenceClass: 'authored_correctness_only',
    comparativeClaim: 'forbidden',
    id: 'clean-promote',
    family: 'control',
    description: 'Complete admissible evidence satisfies policy.',
    seam: 'v4_policy',
    repeatCount: 2,
    safetyOracle: {
      expectation: 'release_allowed',
      rationale: 'The deterministic candidate and evidence are complete and passing.',
    },
    dailiesOracle: {
      terminal: 'report',
      decision: 'promote',
      decisionPrecedence: null,
      exitCode: null,
      expectedProcessSignal: null,
      expectedCalls: { candidate: 0, evidenceProvider: 0 },
      expectedEvidenceState: 'complete',
      expectedObservationClass: 'policy_result',
      expectedErrorKind: null,
      reportMustValidate: false,
    },
    executionOracle: {
      minimumMaxInFlight: 0,
      requireDistinctCompletionOrders: false,
    },
    ...overrides,
  });
}

function observation(
  overrides: Partial<AuthoredInvariantObservation> = {},
): AuthoredInvariantObservation {
  return {
    source: 'v4_policy',
    native: { terminal: 'report', decision: 'promote', decisionPrecedence: null },
    exitCode: null,
    processSignal: null,
    calls: { candidate: 0, evidenceProvider: 0 },
    reportValidated: false,
    evidenceState: 'complete',
    observationClass: 'policy_result',
    errorKind: null,
    executionEvidence: { maxInFlight: 0, completionOrderDigest: null },
    ...overrides,
  };
}

describe('authored invariant contracts', () => {
  it('keeps an authored correctness corpus explicitly non-comparative', () => {
    const scenario = promoteScenario();
    expect(scenario).toMatchObject({
      evidenceClass: 'authored_correctness_only',
      comparativeClaim: 'forbidden',
    });
    expect(authoredInvariantScenarioDigest(scenario)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects contradictory safety and non-CLI exit-code oracles', () => {
    expect(() => promoteScenario({
      safetyOracle: {
        expectation: 'release_denied',
        rationale: 'A denied release cannot expect promotion.',
      },
    })).toThrow(/release_denied/);
    expect(() => promoteScenario({
      dailiesOracle: {
        ...promoteScenario().dailiesOracle,
        exitCode: 0,
      },
    })).toThrow(/only the CLI seam/);
  });

  it('retains abort separately from no_decision and tests CLI process state', () => {
    const abort = authoredInvariantScenarioSchema.parse({
      ...promoteScenario(),
      id: 'tampered-preflight',
      family: 'tamper',
      seam: 'v4_cli',
      repeatCount: 1,
      safetyOracle: {
        expectation: 'insufficient_evidence',
        rationale: 'A mismatched input digest prevents a release decision.',
      },
      dailiesOracle: {
        terminal: 'abort',
        decision: null,
        decisionPrecedence: null,
        exitCode: 2,
        expectedProcessSignal: null,
        expectedCalls: { candidate: 0, evidenceProvider: 0 },
        expectedEvidenceState: 'integrity_failure',
        expectedObservationClass: 'artifact_tamper',
        expectedErrorKind: 'protocol',
        reportMustValidate: false,
      },
    });
    const outcome = evaluateAuthoredInvariantOutcome({
      scenario: abort,
      observation: {
        source: 'v4_cli',
        native: { terminal: 'abort', decision: null, decisionPrecedence: null },
        exitCode: 2,
        processSignal: null,
        calls: { candidate: 0, evidenceProvider: 0 },
        reportValidated: false,
        evidenceState: 'integrity_failure',
        observationClass: 'artifact_tamper',
        errorKind: 'protocol',
        executionEvidence: { maxInFlight: 0, completionOrderDigest: null },
      },
      trialIndex: 0,
      seed: 7,
      durationNanoseconds: 1n,
      stderr: 'dailies error: input artifact digest mismatch',
    });
    expect(outcome.normalized.releaseSignal).toBe('aborted');
    expect(outcome.checks).toMatchObject({
      falsePromotion: false,
      exactCliExitCode: true,
      exactProcessSignal: true,
      passed: true,
    });
  });

  it('detects a false promotion independently of exact Dailies mismatches', () => {
    const scenario = authoredInvariantScenarioSchema.parse({
      ...promoteScenario(),
      id: 'judge-timeout',
      family: 'timeout',
      safetyOracle: {
        expectation: 'insufficient_evidence',
        rationale: 'A judge timeout leaves required evidence incomplete.',
      },
      dailiesOracle: {
        terminal: 'report',
        decision: 'inconclusive',
        decisionPrecedence: null,
        exitCode: null,
        expectedProcessSignal: null,
        expectedCalls: { candidate: 1, evidenceProvider: 2 },
        expectedEvidenceState: 'incomplete',
        expectedObservationClass: 'evidence_timeout',
        expectedErrorKind: 'timeout',
        reportMustValidate: false,
      },
    });
    const outcome = evaluateAuthoredInvariantOutcome({
      scenario,
      observation: observation({
        calls: { candidate: 1, evidenceProvider: 2 },
        evidenceState: 'incomplete',
        observationClass: 'evidence_timeout',
        errorKind: 'timeout',
      }),
      trialIndex: 0,
      seed: 1,
      durationNanoseconds: 3n,
      rawArtifact: '{}',
    });
    expect(outcome.checks).toMatchObject({
      falsePromotion: true,
      exactDecision: false,
      passed: false,
    });
  });

  it('hashes raw evidence but excludes timing, raw bytes, and completion order from semantics', () => {
    const scenario = promoteScenario();
    const first = evaluateAuthoredInvariantOutcome({
      scenario,
      observation: observation({
        executionEvidence: {
          maxInFlight: 4,
          completionOrderDigest: `sha256:${'1'.repeat(64)}`,
        },
      }),
      trialIndex: 0,
      seed: 10,
      durationNanoseconds: 1n,
      rawArtifact: '{"time":"first"}',
      stdout: 'first',
    });
    const second = evaluateAuthoredInvariantOutcome({
      scenario,
      observation: observation({
        executionEvidence: {
          maxInFlight: 2,
          completionOrderDigest: `sha256:${'2'.repeat(64)}`,
        },
      }),
      trialIndex: 1,
      seed: 11,
      durationNanoseconds: 99n,
      rawArtifact: '{"time":"second"}',
      stdout: 'second',
    });
    expect(first.rawEvidence.artifactDigest).not.toBe(second.rawEvidence.artifactDigest);
    expect(first.semanticDigest).toBe(second.semanticDigest);
    expect(authoredInvariantOutcomeSchema.parse(first)).toEqual(first);

    const run = buildAuthoredInvariantRun(
      'dailies-authored-invariants-v1',
      [scenario],
      [first, second],
      environment(),
    );
    expect(run.summary).toMatchObject({
      falsePromotions: 0,
      exactOracleMismatches: 0,
      nondeterministicScenarios: 0,
      completionOrderFailures: 0,
      executionEvidenceFailures: 0,
      passed: true,
    });
    expect(run.runtimeDistributions[0]).toMatchObject({
      samples: 2,
      minNanoseconds: '1',
      maxNanoseconds: '99',
    });
  });

  it('rejects missing, duplicate, unexpected, or identity-swapped outcome coverage', () => {
    const scenario = promoteScenario({ repeatCount: 1 });
    const result = evaluateAuthoredInvariantOutcome({
      scenario,
      observation: observation(),
      trialIndex: 0,
      seed: 1,
      durationNanoseconds: 1n,
    });
    expect(() => buildAuthoredInvariantRun('suite', [scenario], [], environment('clean')))
      .toThrow(/exactly 1/);
    expect(() => buildAuthoredInvariantRun(
      'suite', [scenario], [result, result], environment('clean'),
    )).toThrow(/unexpected scenario coverage|exactly 1/);
    const swapped = { ...result, scenarioDigest: `sha256:${'0'.repeat(64)}` };
    expect(() => buildAuthoredInvariantRun('suite', [scenario], [swapped], environment('clean')))
      .toThrow(/identity mismatch/);
  });

  it('rederives serialized runs and rejects every derived-field tamper', () => {
    const scenario = promoteScenario();
    const outcomes = [0, 1].map((trialIndex) => evaluateAuthoredInvariantOutcome({
      scenario,
      observation: observation(),
      trialIndex,
      seed: trialIndex + 1,
      durationNanoseconds: BigInt(trialIndex + 1),
      rawArtifact: '{}',
    }));
    const run = buildAuthoredInvariantRun('tamper-table', [scenario], outcomes, environment());
    const mutations: Array<(copy: Record<string, any>) => void> = [
      (copy) => { copy.scenarioSetDigest = `sha256:${'0'.repeat(64)}`; },
      (copy) => { copy.outcomes[0].checks.falsePromotion = true; },
      (copy) => { copy.outcomes[0].checks.exactEvidenceState = false; },
      (copy) => { copy.outcomes[0].normalized.evidenceState = 'incomplete'; },
      (copy) => { copy.outcomes[0].processSignal = 'SIGTERM'; },
      (copy) => { copy.outcomes[0].semanticDigest = `sha256:${'0'.repeat(64)}`; },
      (copy) => { copy.outcomes.reverse(); },
      (copy) => { copy.runtimeDistributions[0].p95Nanoseconds = '999'; },
      (copy) => { copy.summary.passed = false; },
      (copy) => { copy.summary.exactOracleMismatches = 1; },
      (copy) => { copy.summary.completionOrderFailures = 1; },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(run) as unknown as Record<string, any>;
      mutate(copy);
      expect(() => authoredInvariantRunSchema.parse(copy)).toThrow();
    }

    const absentArtifactWithBytes = structuredClone(outcomes[0]) as Record<string, any>;
    absentArtifactWithBytes.rawEvidence.artifactDigest = null;
    expect(() => authoredInvariantOutcomeSchema.parse(absentArtifactWithBytes))
      .toThrow(/absent raw artifact/);
  });
});

function v5Decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    decision: 'inconclusive',
    precedence: 'mandatory_evidence_incomplete',
    criteria: [{
      criterionVersionId: 'criterion',
      evidenceState: 'complete',
      trustAdmissible: true,
      passed: 1,
      total: 1,
      passRate: 1,
      regressions: 0,
      evidenceRequirement: 'mandatory',
      consequence: 'advisory',
      rulePassed: true,
    }],
    compensation: [],
    ...overrides,
  };
}

function v4ClassificationReport({
  errors = [],
  total = 1,
  evaluated = 0,
  trustAdmissible = true,
}: {
  errors?: Array<{ errorStage: 'candidate' | 'judge'; errorKind: Report['items'][number]['errorKind'] }>;
  total?: number;
  evaluated?: number;
  trustAdmissible?: boolean;
} = {}): Report {
  return {
    items: errors,
    totals: {
      total,
      evaluated,
      evaluationCoverage: total === 0 ? 0 : evaluated / total,
    },
    trust: evaluated > 0
      ? {
          status: 'complete',
          class: 'deterministic',
          derivation: 'exact_match_v1',
          admissible: trustAdmissible,
        }
      : {
          status: 'unavailable',
          derivation: 'exact_match_v1',
          admissible: false,
          reason: 'no_completed_evidence',
        },
  } as unknown as Report;
}

function v6Decision(
  calibrationStatus: 'satisfied' | 'insufficient' | 'incomplete' | 'integrity_failure',
  overrides: Partial<PolicyDecisionV2> = {},
): PolicyDecisionV2 {
  const reason = calibrationStatus === 'integrity_failure'
    ? 'artifact_digest_mismatch'
    : calibrationStatus === 'insufficient'
      ? 'artifact_too_old'
      : calibrationStatus === 'incomplete'
        ? 'source_not_configured'
        : null;
  return {
    decision: calibrationStatus === 'satisfied' ? 'promote' : 'inconclusive',
    precedence: calibrationStatus === 'integrity_failure'
      ? 'required_integrity_failure'
      : calibrationStatus === 'satisfied'
        ? 'policy_satisfied'
        : 'mandatory_evidence_incomplete',
    criteria: [{
      criterionVersionId: 'criterion',
      evidenceState: 'complete',
      trustAdmissible: true,
      passed: 1,
      total: 1,
      passRate: 1,
      regressions: 0,
      evidenceRequirement: 'mandatory',
      consequence: 'blocking',
      rulePassed: calibrationStatus === 'satisfied' ? true : null,
      calibrationRequirement: {} as never,
      calibration: {
        criterionVersionId: 'criterion',
        status: calibrationStatus,
        admissible: calibrationStatus === 'satisfied',
        evaluatedAt: '2026-08-23T12:00:00.000Z',
        requirement: {} as never,
        collectionState: calibrationStatus === 'integrity_failure'
          ? 'integrity_failure'
          : calibrationStatus === 'incomplete'
            ? 'incomplete'
            : 'verified',
        calibrationEvidenceScope: null,
        reasons: reason === null ? [] : [reason],
        worstReason: reason,
        checks: [],
        trials: [],
      },
      releaseAdmissible: calibrationStatus === 'satisfied',
    }],
    compensation: [],
    ...overrides,
  } as PolicyDecisionV2;
}

describe('authored invariant classifier truth tables', () => {
  it('derives v4 protocol, execution, evidence, coverage, and trust precedence', () => {
    expect(classifyV4InvariantReport(v4ClassificationReport({
      errors: [
        { errorStage: 'candidate', errorKind: 'transport' },
        { errorStage: 'judge', errorKind: 'protocol' },
      ],
      total: 2,
    }))).toEqual({
      evidenceState: 'integrity_failure',
      observationClass: 'protocol_integrity_failure',
      errorKind: 'protocol',
    });

    expect(classifyV4InvariantReport(v4ClassificationReport({
      errors: [
        { errorStage: 'candidate', errorKind: 'transport' },
        { errorStage: 'judge', errorKind: 'timeout' },
      ],
      total: 2,
    }))).toEqual({
      evidenceState: 'incomplete',
      observationClass: 'candidate_execution_failure',
      errorKind: 'transport',
    });

    expect(classifyV4InvariantReport(v4ClassificationReport({
      errors: [{ errorStage: 'judge', errorKind: 'timeout' }],
    }))).toEqual({
      evidenceState: 'incomplete',
      observationClass: 'evidence_timeout',
      errorKind: 'timeout',
    });
    expect(classifyV4InvariantReport(v4ClassificationReport({
      errors: [{ errorStage: 'judge', errorKind: 'transport' }],
    }))).toEqual({
      evidenceState: 'incomplete',
      observationClass: 'evidence_transport_failure',
      errorKind: 'transport',
    });

    expect(classifyV4InvariantReport(v4ClassificationReport({
      errors: [{ errorStage: 'judge', errorKind: 'timeout' }],
      total: 2,
      evaluated: 1,
    }))).toEqual({
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'timeout',
    });
    expect(classifyV4InvariantReport(v4ClassificationReport({
      evaluated: 1,
      trustAdmissible: false,
    }))).toEqual({
      evidenceState: 'complete',
      observationClass: 'trust_inadmissible',
      errorKind: null,
    });
    expect(classifyV4InvariantReport(v4ClassificationReport({ evaluated: 1 }))).toEqual({
      evidenceState: 'complete',
      observationClass: 'policy_result',
      errorKind: null,
    });
  });

  it('keeps complete evidence separate from v5 trust admission and compensation policy', () => {
    const trustDenied = v5Decision({
      criteria: [{ ...v5Decision().criteria[0]!, trustAdmissible: false }],
    });
    expect(classifyV5InvariantDecision(trustDenied)).toEqual({
      evidenceState: 'complete',
      observationClass: 'trust_inadmissible',
      errorKind: null,
    });

    const compensationFailure = v5Decision({
      decision: 'block',
      precedence: 'compensation_failure',
      compensation: [{
        id: 'quality',
        status: 'complete',
        weightedPassRate: 0.5,
        minimumPassRate: 0.8,
        passed: false,
        exactComparison: {
          weightedNumerator: '1', weightedDenominator: '2',
          minimumNumerator: '4', minimumDenominator: '5',
        },
      }],
    });
    expect(classifyV5InvariantDecision(compensationFailure)).toEqual({
      evidenceState: 'complete',
      observationClass: 'policy_result',
      errorKind: null,
    });

    const integrity = v5Decision({ precedence: 'required_integrity_failure' });
    expect(classifyV5InvariantDecision(integrity)).toMatchObject({
      evidenceState: 'integrity_failure', errorKind: 'protocol',
    });
  });

  it('distinguishes v6 calibration insufficiency, missing evidence, and integrity', () => {
    expect(classifyV6InvariantDecision(v6Decision('insufficient'))).toEqual({
      evidenceState: 'complete',
      observationClass: 'trust_inadmissible',
      errorKind: null,
    });
    expect(classifyV6InvariantDecision(v6Decision('incomplete'))).toEqual({
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    });
    expect(classifyV6InvariantDecision(v6Decision('integrity_failure'))).toEqual({
      evidenceState: 'integrity_failure',
      observationClass: 'artifact_tamper',
      errorKind: 'protocol',
    });
  });
});
