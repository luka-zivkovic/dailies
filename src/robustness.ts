import { createHash } from 'node:crypto';
import { arch, cpus, platform } from 'node:os';
import { z } from 'zod';
import { canonicalJson } from './coeval.js';
import type { PolicyDecision } from './policy.js';
import type { PolicyDecisionV2 } from './policy-v2.js';
import type { Report } from './report.js';

export const AUTHORED_INVARIANT_SCENARIO_CONTRACT =
  'dailies/authored-release-invariant-scenario/v1' as const;
export const AUTHORED_INVARIANT_OUTCOME_CONTRACT =
  'dailies/authored-release-invariant-outcome/v1' as const;
export const AUTHORED_INVARIANT_RUN_CONTRACT =
  'dailies/authored-release-invariant-run/v1' as const;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nonBlankStringSchema = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must contain a non-whitespace character',
});
const decisionSchema = z.enum(['promote', 'block', 'inconclusive']);
const decisionPrecedenceSchema = z.enum([
  'required_integrity_failure',
  'candidate_execution_failure',
  'complete_blocking_failure',
  'mandatory_evidence_incomplete',
  'compensation_failure',
  'policy_satisfied',
]);
const evidenceStateSchema = z.enum([
  'complete',
  'incomplete',
  'integrity_failure',
  'unknown',
]);
const observationClassSchema = z.enum([
  'policy_result',
  'candidate_execution_failure',
  'evidence_timeout',
  'evidence_transport_failure',
  'protocol_integrity_failure',
  'partial_coverage',
  'trust_inadmissible',
  'scope_mismatch',
  'artifact_tamper',
  'preflight_failure',
]);
const observedErrorKindSchema = z.enum([
  'timeout',
  'transport',
  'http',
  'protocol',
  'incomplete',
  'execution',
  'unknown',
]).nullable();

export const authoredInvariantFamilySchema = z.enum([
  'control',
  'timeout',
  'transport',
  'protocol',
  'partial_coverage',
  'tamper',
  'mixed_trust',
  'scope_mismatch',
  'nondeterminism',
  'multi_criterion_conflict',
]);

export const authoredSafetyExpectationSchema = z.enum([
  'release_allowed',
  'release_denied',
  'insufficient_evidence',
]);

const expectedCallsSchema = z.object({
  candidate: z.number().int().nonnegative(),
  evidenceProvider: z.number().int().nonnegative(),
}).strict();

const reportOracleSchema = z.object({
  terminal: z.literal('report'),
  decision: decisionSchema,
  decisionPrecedence: decisionPrecedenceSchema.nullable(),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable(),
  expectedProcessSignal: nonBlankStringSchema.nullable(),
  expectedCalls: expectedCallsSchema,
  expectedEvidenceState: evidenceStateSchema,
  expectedObservationClass: observationClassSchema,
  expectedErrorKind: observedErrorKindSchema,
  reportMustValidate: z.boolean(),
}).strict();

const abortOracleSchema = z.object({
  terminal: z.literal('abort'),
  decision: z.null(),
  decisionPrecedence: z.null(),
  exitCode: z.literal(2).nullable(),
  expectedProcessSignal: nonBlankStringSchema.nullable(),
  expectedCalls: expectedCallsSchema,
  expectedEvidenceState: evidenceStateSchema,
  expectedObservationClass: observationClassSchema,
  expectedErrorKind: observedErrorKindSchema,
  reportMustValidate: z.literal(false),
}).strict();

export const authoredDailiesOracleSchema = z.discriminatedUnion('terminal', [
  reportOracleSchema,
  abortOracleSchema,
]);

export const authoredInvariantScenarioSchema = z.object({
  contract: z.literal(AUTHORED_INVARIANT_SCENARIO_CONTRACT),
  schemaVersion: z.literal(1),
  evidenceClass: z.literal('authored_correctness_only'),
  comparativeClaim: z.literal('forbidden'),
  id: nonBlankStringSchema,
  family: authoredInvariantFamilySchema,
  description: nonBlankStringSchema,
  seam: z.enum([
    'v4_policy',
    'v4_runner',
    'v4_cli',
    'v5_policy',
    'v6_policy',
    'report_parser',
  ]),
  repeatCount: z.number().int().min(1).max(100),
  safetyOracle: z.object({
    expectation: authoredSafetyExpectationSchema,
    rationale: nonBlankStringSchema,
  }).strict(),
  dailiesOracle: authoredDailiesOracleSchema,
  executionOracle: z.object({
    minimumMaxInFlight: z.number().int().nonnegative(),
    requireDistinctCompletionOrders: z.boolean(),
  }).strict(),
}).strict().superRefine((scenario, ctx) => {
  const expected = scenario.safetyOracle.expectation;
  const dailies = scenario.dailiesOracle;
  if (expected === 'release_allowed' &&
    (dailies.terminal !== 'report' || dailies.decision !== 'promote')) {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle'],
      message: 'release_allowed requires an exact Dailies promote report oracle',
    });
  }
  if (expected === 'release_denied' &&
    (dailies.terminal !== 'report' || dailies.decision !== 'block')) {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle'],
      message: 'release_denied requires an exact Dailies block report oracle',
    });
  }
  if (expected === 'insufficient_evidence' &&
    dailies.terminal === 'report' && dailies.decision !== 'inconclusive') {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle', 'decision'],
      message: 'insufficient_evidence requires inconclusive or a typed preflight abort',
    });
  }
  if (scenario.seam === 'v4_cli' && dailies.terminal === 'report') {
    const expectedExitCode = dailies.decision === 'promote' ? 0 :
      dailies.decision === 'block' ? 1 : 2;
    if (dailies.exitCode !== expectedExitCode) {
      ctx.addIssue({
        code: 'custom',
        path: ['dailiesOracle', 'exitCode'],
        message: `decision ${dailies.decision} requires exit code ${expectedExitCode}`,
      });
    }
  }
  if (scenario.seam === 'v4_cli' && dailies.terminal === 'abort' && dailies.exitCode !== 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle', 'exitCode'],
      message: 'v4_cli abort requires exit code 2',
    });
  }
  if (scenario.seam !== 'v4_cli' && dailies.exitCode !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle', 'exitCode'],
      message: 'only the CLI seam has an exit-code oracle',
    });
  }
  if (scenario.seam !== 'v4_cli' && dailies.expectedProcessSignal !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle', 'expectedProcessSignal'],
      message: 'only the CLI seam has a process-signal oracle',
    });
  }
  if ((scenario.seam === 'v5_policy' || scenario.seam === 'v6_policy') &&
    dailies.decisionPrecedence === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle', 'decisionPrecedence'],
      message: `${scenario.seam} requires an exact non-null decision precedence`,
    });
  }
  if ((scenario.seam === 'v4_policy' || scenario.seam === 'v4_runner' ||
    scenario.seam === 'v4_cli') && dailies.decisionPrecedence !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle', 'decisionPrecedence'],
      message: `${scenario.seam} does not emit a decision precedence`,
    });
  }
  const emitsFullReport = scenario.seam === 'v4_runner' || scenario.seam === 'v4_cli';
  if (dailies.terminal === 'report' && dailies.reportMustValidate !== emitsFullReport) {
    ctx.addIssue({
      code: 'custom',
      path: ['dailiesOracle', 'reportMustValidate'],
      message: emitsFullReport
        ? `${scenario.seam} report outcomes must validate`
        : `${scenario.seam} is a pure policy seam and does not emit a report`,
    });
  }
  if (scenario.executionOracle.requireDistinctCompletionOrders && scenario.repeatCount < 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['repeatCount'],
      message: 'distinct completion-order evidence requires at least two trials',
    });
  }
});

export type AuthoredInvariantFamily = z.infer<typeof authoredInvariantFamilySchema>;
export type AuthoredSafetyExpectation = z.infer<typeof authoredSafetyExpectationSchema>;
export type AuthoredDailiesOracle = z.infer<typeof authoredDailiesOracleSchema>;
export type AuthoredInvariantScenario = z.infer<typeof authoredInvariantScenarioSchema>;

const observedTerminalSchema = z.discriminatedUnion('terminal', [
  z.object({
    terminal: z.literal('report'),
    decision: decisionSchema,
    decisionPrecedence: decisionPrecedenceSchema.nullable(),
  }).strict(),
  z.object({
    terminal: z.literal('abort'),
    decision: z.null(),
    decisionPrecedence: z.null(),
  }).strict(),
]);

export const authoredInvariantObservationSchema = z.object({
  source: z.enum([
    'v4_policy',
    'v4_runner',
    'v4_cli',
    'v5_policy',
    'v6_policy',
    'report_parser',
  ]),
  native: observedTerminalSchema,
  exitCode: z.number().int().nullable(),
  processSignal: nonBlankStringSchema.nullable(),
  calls: z.object({
    candidate: z.number().int().nonnegative(),
    evidenceProvider: z.number().int().nonnegative(),
  }).strict(),
  reportValidated: z.boolean(),
  evidenceState: evidenceStateSchema,
  observationClass: observationClassSchema,
  errorKind: observedErrorKindSchema,
  executionEvidence: z.object({
    maxInFlight: z.number().int().nonnegative(),
    completionOrderDigest: digestSchema.nullable(),
  }).strict(),
}).strict();

export type AuthoredInvariantObservation = z.infer<typeof authoredInvariantObservationSchema>;

export interface AuthoredInvariantClassification {
  evidenceState: z.infer<typeof evidenceStateSchema>;
  observationClass: z.infer<typeof observationClassSchema>;
  errorKind: z.infer<typeof observedErrorKindSchema>;
}

/** Derive the authored invariant classification from a validated v4 report. */
export function classifyV4InvariantReport(report: Report): AuthoredInvariantClassification {
  const protocolError = report.items.find((item) => item.errorKind === 'protocol');
  if (protocolError !== undefined) {
    return {
      evidenceState: 'integrity_failure',
      observationClass: 'protocol_integrity_failure',
      errorKind: 'protocol',
    };
  }
  const candidateError = report.items.find((item) => item.errorStage === 'candidate');
  if (candidateError !== undefined) {
    return {
      evidenceState: 'incomplete',
      observationClass: 'candidate_execution_failure',
      errorKind: candidateError.errorKind ?? 'unknown',
    };
  }
  const judgeError = report.items.find((item) => item.errorStage === 'judge');
  if (judgeError !== undefined) {
    const kind = judgeError.errorKind ?? 'unknown';
    let observationClass: AuthoredInvariantClassification['observationClass'];
    if (report.totals.evaluated > 0 && report.totals.evaluated < report.totals.total) {
      observationClass = 'partial_coverage';
    } else if (kind === 'timeout') {
      observationClass = 'evidence_timeout';
    } else if (kind === 'transport' || kind === 'http') {
      observationClass = 'evidence_transport_failure';
    } else {
      observationClass = 'partial_coverage';
    }
    return {
      evidenceState: 'incomplete',
      observationClass,
      errorKind: kind,
    };
  }
  if (report.totals.evaluated !== report.totals.total ||
    report.totals.evaluationCoverage !== 1) {
    return {
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    };
  }
  if (report.trust.status === 'complete' && !report.trust.admissible) {
    return {
      evidenceState: 'complete',
      observationClass: 'trust_inadmissible',
      errorKind: null,
    };
  }
  return { evidenceState: 'complete', observationClass: 'policy_result', errorKind: null };
}

/** Derive the authored invariant classification from a v5 policy decision. */
export function classifyV5InvariantDecision(
  result: PolicyDecision,
): AuthoredInvariantClassification {
  if (result.precedence === 'required_integrity_failure') {
    return {
      evidenceState: 'integrity_failure',
      observationClass: 'protocol_integrity_failure',
      errorKind: 'protocol',
    };
  }
  if (result.precedence === 'candidate_execution_failure') {
    return {
      evidenceState: 'incomplete',
      observationClass: 'candidate_execution_failure',
      errorKind: 'execution',
    };
  }
  if (result.criteria.some((entry) => entry.evidenceState !== 'complete')) {
    return {
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    };
  }
  if (result.criteria.some((entry) => !entry.trustAdmissible)) {
    return {
      evidenceState: 'complete',
      observationClass: 'trust_inadmissible',
      errorKind: null,
    };
  }
  if (result.compensation.some((entry) => entry.status !== 'complete')) {
    return {
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    };
  }
  return { evidenceState: 'complete', observationClass: 'policy_result', errorKind: null };
}

/** Derive the authored invariant classification from v6 candidate and calibration results. */
export function classifyV6InvariantDecision(
  result: PolicyDecisionV2,
): AuthoredInvariantClassification {
  if (result.precedence === 'required_integrity_failure') {
    const reasons = result.criteria.flatMap((entry) => entry.calibration.reasons);
    const artifactIntegrityFailure = reasons.some((reason) => [
      'manifest_binding_mismatch',
      'artifact_digest_mismatch',
      'artifact_identity_mismatch',
      'artifact_verification_failed',
    ].includes(reason));
    return {
      evidenceState: 'integrity_failure',
      observationClass: artifactIntegrityFailure ? 'artifact_tamper' : 'protocol_integrity_failure',
      errorKind: 'protocol',
    };
  }
  if (result.precedence === 'candidate_execution_failure') {
    return {
      evidenceState: 'incomplete',
      observationClass: 'candidate_execution_failure',
      errorKind: 'execution',
    };
  }
  if (result.criteria.some((entry) => entry.evidenceState !== 'complete' ||
    entry.calibration.status === 'incomplete')) {
    return {
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    };
  }
  if (result.criteria.some((entry) => !entry.trustAdmissible ||
    entry.calibration.status === 'insufficient' || !entry.releaseAdmissible)) {
    return {
      evidenceState: 'complete',
      observationClass: 'trust_inadmissible',
      errorKind: null,
    };
  }
  if (result.compensation.some((entry) => entry.status !== 'complete')) {
    return {
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    };
  }
  return { evidenceState: 'complete', observationClass: 'policy_result', errorKind: null };
}

export type AuthoredInvariantFailureContext =
  | 'input_tamper'
  | 'scope_binding'
  | 'report_validation';

/** Normalize a caught failure without changing the product's thrown-error contract. */
export function classifyAuthoredInvariantThrownError(
  error: unknown,
  context: AuthoredInvariantFailureContext,
): AuthoredInvariantClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (/input artifact digest mismatch/i.test(message)) {
    return {
      evidenceState: 'integrity_failure',
      observationClass: context === 'scope_binding' ? 'scope_mismatch' : 'artifact_tamper',
      errorKind: 'protocol',
    };
  }
  if (context === 'report_validation') {
    return {
      evidenceState: 'integrity_failure',
      observationClass: 'artifact_tamper',
      errorKind: 'protocol',
    };
  }
  return {
    evidenceState: 'unknown',
    observationClass: 'preflight_failure',
    errorKind: 'unknown',
  };
}

const rawEvidenceSchema = z.object({
  artifactDigest: digestSchema.nullable(),
  artifactByteLength: z.number().int().nonnegative(),
  stdoutDigest: digestSchema,
  stdoutByteLength: z.number().int().nonnegative(),
  stderrDigest: digestSchema,
  stderrByteLength: z.number().int().nonnegative(),
}).strict();

const outcomeChecksSchema = z.object({
  falsePromotion: z.boolean(),
  falseBlock: z.boolean(),
  exactTerminal: z.boolean(),
  exactDecision: z.boolean(),
  exactPrecedence: z.boolean(),
  exactCliExitCode: z.boolean(),
  exactProcessSignal: z.boolean(),
  exactCallCounts: z.boolean(),
  exactEvidenceState: z.boolean(),
  exactObservationClass: z.boolean(),
  exactErrorKind: z.boolean(),
  sufficientObservedConcurrency: z.boolean(),
  reportValidation: z.boolean(),
  passed: z.boolean(),
}).strict();

const authoredInvariantOutcomeShapeSchema = z.object({
  contract: z.literal(AUTHORED_INVARIANT_OUTCOME_CONTRACT),
  schemaVersion: z.literal(1),
  evidenceClass: z.literal('authored_correctness_only'),
  comparativeClaim: z.literal('forbidden'),
  scenarioId: nonBlankStringSchema,
  scenarioDigest: digestSchema,
  family: authoredInvariantFamilySchema,
  trialIndex: z.number().int().nonnegative(),
  seed: z.number().int().nonnegative(),
  source: authoredInvariantObservationSchema.shape.source,
  native: observedTerminalSchema,
  exitCode: z.number().int().nullable(),
  processSignal: nonBlankStringSchema.nullable(),
  calls: expectedCallsSchema,
  reportValidated: z.boolean(),
  normalized: z.object({
    releaseSignal: z.enum(['proceed', 'do_not_proceed', 'no_decision', 'aborted']),
    evidenceState: evidenceStateSchema,
    observationClass: observationClassSchema,
    errorKind: observedErrorKindSchema,
  }).strict(),
  executionEvidence: z.object({
    maxInFlight: z.number().int().nonnegative(),
    completionOrderDigest: digestSchema.nullable(),
  }).strict(),
  rawEvidence: rawEvidenceSchema,
  durationNanoseconds: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  checks: outcomeChecksSchema,
  semanticDigest: digestSchema,
}).strict();

export const authoredInvariantOutcomeSchema = authoredInvariantOutcomeShapeSchema.superRefine(
  (outcome, ctx) => {
    if (outcome.rawEvidence.artifactDigest === null &&
      outcome.rawEvidence.artifactByteLength !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rawEvidence', 'artifactByteLength'],
        message: 'an absent raw artifact must have byte length 0',
      });
    }
    if (outcome.rawEvidence.artifactDigest !== null &&
      outcome.rawEvidence.artifactByteLength === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rawEvidence', 'artifactByteLength'],
        message: 'a retained raw artifact must not be empty',
      });
    }
  },
);

export type AuthoredInvariantOutcome = z.infer<typeof authoredInvariantOutcomeSchema>;

export interface EvaluateAuthoredInvariantOutcomeInput {
  scenario: AuthoredInvariantScenario;
  observation: AuthoredInvariantObservation;
  trialIndex: number;
  seed: number;
  durationNanoseconds: bigint;
  rawArtifact?: string | Uint8Array;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
}

function rawBytes(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array();
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

function byteDigest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function authoredInvariantScenarioDigest(scenario: AuthoredInvariantScenario): string {
  const parsed = authoredInvariantScenarioSchema.parse(scenario);
  return byteDigest(Buffer.from(canonicalJson(parsed), 'utf8'));
}

function releaseSignal(
  native: AuthoredInvariantObservation['native'],
): AuthoredInvariantOutcome['normalized']['releaseSignal'] {
  if (native.terminal === 'abort') return 'aborted';
  if (native.decision === 'promote') return 'proceed';
  if (native.decision === 'block') return 'do_not_proceed';
  return 'no_decision';
}

function deriveOutcomeSemantics(
  scenario: AuthoredInvariantScenario,
  observation: AuthoredInvariantObservation,
) {
  const signal = releaseSignal(observation.native);
  const oracle = scenario.dailiesOracle;
  const exactTerminal = observation.native.terminal === oracle.terminal;
  const exactDecision = observation.native.decision === oracle.decision;
  const exactPrecedence = observation.native.decisionPrecedence === oracle.decisionPrecedence;
  const exactCliExitCode = observation.exitCode === oracle.exitCode;
  const exactProcessSignal = observation.processSignal === oracle.expectedProcessSignal;
  const exactCallCounts = observation.calls.candidate === oracle.expectedCalls.candidate &&
    observation.calls.evidenceProvider === oracle.expectedCalls.evidenceProvider;
  const exactEvidenceState = observation.evidenceState === oracle.expectedEvidenceState;
  const exactObservationClass = observation.observationClass === oracle.expectedObservationClass;
  const exactErrorKind = observation.errorKind === oracle.expectedErrorKind;
  const reportValidation = observation.reportValidated === oracle.reportMustValidate;
  const sufficientObservedConcurrency = observation.executionEvidence.maxInFlight >=
    scenario.executionOracle.minimumMaxInFlight;
  const falsePromotion = signal === 'proceed' &&
    scenario.safetyOracle.expectation !== 'release_allowed';
  const falseBlock = signal === 'do_not_proceed' &&
    scenario.safetyOracle.expectation === 'release_allowed';
  const checks = {
    falsePromotion,
    falseBlock,
    exactTerminal,
    exactDecision,
    exactPrecedence,
    exactCliExitCode,
    exactProcessSignal,
    exactCallCounts,
    exactEvidenceState,
    exactObservationClass,
    exactErrorKind,
    sufficientObservedConcurrency,
    reportValidation,
    passed: !falsePromotion && !falseBlock && exactTerminal && exactDecision && exactPrecedence &&
      exactCliExitCode && exactProcessSignal && exactCallCounts && exactEvidenceState &&
      exactObservationClass && exactErrorKind && sufficientObservedConcurrency && reportValidation,
  };
  const normalized = {
    releaseSignal: signal,
    evidenceState: observation.evidenceState,
    observationClass: observation.observationClass,
    errorKind: observation.errorKind,
  };
  const semanticDigest = byteDigest(Buffer.from(canonicalJson({
    source: observation.source,
    native: observation.native,
    exitCode: observation.exitCode,
    processSignal: observation.processSignal,
    calls: observation.calls,
    reportValidated: observation.reportValidated,
    normalized,
    checks,
  }), 'utf8'));
  return { normalized, checks, semanticDigest };
}

export function evaluateAuthoredInvariantOutcome(
  input: EvaluateAuthoredInvariantOutcomeInput,
): AuthoredInvariantOutcome {
  const scenario = authoredInvariantScenarioSchema.parse(input.scenario);
  const observation = authoredInvariantObservationSchema.parse(input.observation);
  if (observation.source !== scenario.seam) {
    throw new Error(`scenario ${scenario.id} requires seam ${scenario.seam}`);
  }
  if (!Number.isInteger(input.trialIndex) || input.trialIndex < 0 ||
    input.trialIndex >= scenario.repeatCount) {
    throw new Error(`scenario ${scenario.id} trial index is outside its repeatCount`);
  }
  if (!Number.isInteger(input.seed) || input.seed < 0) {
    throw new Error('invariant outcome seed must be a nonnegative integer');
  }
  if (input.durationNanoseconds < 0n) {
    throw new Error('invariant outcome duration cannot be negative');
  }

  const { normalized, checks, semanticDigest } = deriveOutcomeSemantics(scenario, observation);
  const artifactBytes = rawBytes(input.rawArtifact);
  const stdoutBytes = rawBytes(input.stdout);
  const stderrBytes = rawBytes(input.stderr);
  return authoredInvariantOutcomeSchema.parse({
    contract: AUTHORED_INVARIANT_OUTCOME_CONTRACT,
    schemaVersion: 1,
    evidenceClass: 'authored_correctness_only',
    comparativeClaim: 'forbidden',
    scenarioId: scenario.id,
    scenarioDigest: authoredInvariantScenarioDigest(scenario),
    family: scenario.family,
    trialIndex: input.trialIndex,
    seed: input.seed,
    source: observation.source,
    native: observation.native,
    exitCode: observation.exitCode,
    processSignal: observation.processSignal,
    calls: observation.calls,
    reportValidated: observation.reportValidated,
    normalized,
    executionEvidence: observation.executionEvidence,
    rawEvidence: {
      artifactDigest: input.rawArtifact === undefined ? null : byteDigest(artifactBytes),
      artifactByteLength: artifactBytes.byteLength,
      stdoutDigest: byteDigest(stdoutBytes),
      stdoutByteLength: stdoutBytes.byteLength,
      stderrDigest: byteDigest(stderrBytes),
      stderrByteLength: stderrBytes.byteLength,
    },
    durationNanoseconds: input.durationNanoseconds.toString(),
    checks,
    semanticDigest,
  });
}

export const authoredInvariantEnvironmentSchema = z.object({
  tool: z.object({
    name: z.literal('dailies'),
    version: nonBlankStringSchema,
    sourceRevision: nonBlankStringSchema,
    sourceTree: z.enum(['clean', 'dirty', 'unknown']),
  }).strict(),
  runtime: z.object({
    nodeVersion: nonBlankStringSchema,
    platform: nonBlankStringSchema,
    architecture: nonBlankStringSchema,
    cpuModel: nonBlankStringSchema,
    logicalCpuCount: z.number().int().positive(),
  }).strict(),
  isolation: z.object({
    network: z.literal('configured_endpoints_validated_loopback'),
    validatedLoopbackEndpoints: z.number().int().nonnegative(),
    caches: z.literal('fresh_temporary_cache_directory'),
    credentialVariablesRemoved: z.number().int().nonnegative(),
    proxyVariablesRemoved: z.number().int().nonnegative(),
    externalModels: z.literal('none_configured'),
  }).strict(),
}).strict();

export type AuthoredInvariantEnvironment = z.infer<typeof authoredInvariantEnvironmentSchema>;

export function authoredInvariantEnvironment(
  version: string,
  sourceRevision: string,
  sourceTree: 'clean' | 'dirty' | 'unknown',
  isolation: AuthoredInvariantEnvironment['isolation'],
): AuthoredInvariantEnvironment {
  const processors = cpus();
  return authoredInvariantEnvironmentSchema.parse({
    tool: { name: 'dailies', version, sourceRevision, sourceTree },
    runtime: {
      nodeVersion: process.version,
      platform: platform(),
      architecture: arch(),
      cpuModel: processors[0]?.model ?? 'unknown',
      logicalCpuCount: Math.max(1, processors.length),
    },
    isolation,
  });
}

const runtimeDistributionSchema = z.object({
  scenarioId: nonBlankStringSchema,
  samples: z.number().int().positive(),
  minNanoseconds: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  p50Nanoseconds: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  p95Nanoseconds: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  maxNanoseconds: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
}).strict();

const authoredInvariantRunShapeSchema = z.object({
  contract: z.literal(AUTHORED_INVARIANT_RUN_CONTRACT),
  schemaVersion: z.literal(1),
  evidenceClass: z.literal('authored_correctness_only'),
  comparativeClaim: z.literal('forbidden'),
  suiteId: nonBlankStringSchema,
  scenarioSetDigest: digestSchema,
  environment: authoredInvariantEnvironmentSchema,
  scenarios: z.array(authoredInvariantScenarioSchema).min(1),
  outcomes: z.array(authoredInvariantOutcomeSchema).min(1),
  runtimeDistributions: z.array(runtimeDistributionSchema).min(1),
  summary: z.object({
    scenarios: z.number().int().positive(),
    trials: z.number().int().positive(),
    falsePromotions: z.number().int().nonnegative(),
    falseBlocks: z.number().int().nonnegative(),
    exactOracleMismatches: z.number().int().nonnegative(),
    callCountMismatches: z.number().int().nonnegative(),
    reportValidationFailures: z.number().int().nonnegative(),
    nondeterministicScenarios: z.number().int().nonnegative(),
    completionOrderFailures: z.number().int().nonnegative(),
    executionEvidenceFailures: z.number().int().nonnegative(),
    passed: z.boolean(),
  }).strict(),
}).strict();

export const authoredInvariantRunSchema = authoredInvariantRunShapeSchema.superRefine(
  (run, ctx) => {
    try {
      assertAuthoredInvariantRun(run);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'authored invariant run verification failed',
      });
    }
  },
);

export type AuthoredInvariantRun = z.infer<typeof authoredInvariantRunSchema>;

function percentile(values: bigint[], quantile: number): bigint {
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type AuthoredInvariantRunShape = z.infer<typeof authoredInvariantRunShapeSchema>;

function deriveRunParts(
  scenarios: AuthoredInvariantScenario[],
  outcomes: AuthoredInvariantOutcome[],
) {
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) {
    throw new Error('authored invariant scenario ids must be unique');
  }
  const expectedScenarioOrder = [...scenarios].sort((left, right) =>
    codeUnitCompare(left.id, right.id));
  if (canonicalJson(scenarios) !== canonicalJson(expectedScenarioOrder)) {
    throw new Error('authored invariant scenarios must use canonical id order');
  }
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const byScenario = new Map<string, AuthoredInvariantOutcome[]>();
  for (const outcome of outcomes) {
    const scenario = scenarioById.get(outcome.scenarioId);
    if (scenario === undefined) {
      throw new Error(`unexpected authored invariant outcome scenario ${outcome.scenarioId}`);
    }
    if (outcome.source !== scenario.seam || outcome.family !== scenario.family ||
      outcome.scenarioDigest !== authoredInvariantScenarioDigest(scenario)) {
      throw new Error(`scenario ${scenario.id} outcome identity mismatch`);
    }
    const observation = authoredInvariantObservationSchema.parse({
      source: outcome.source,
      native: outcome.native,
      exitCode: outcome.exitCode,
      processSignal: outcome.processSignal,
      calls: outcome.calls,
      reportValidated: outcome.reportValidated,
      evidenceState: outcome.normalized.evidenceState,
      observationClass: outcome.normalized.observationClass,
      errorKind: outcome.normalized.errorKind,
      executionEvidence: outcome.executionEvidence,
    });
    const expected = deriveOutcomeSemantics(scenario, observation);
    if (canonicalJson(outcome.normalized) !== canonicalJson(expected.normalized) ||
      canonicalJson(outcome.checks) !== canonicalJson(expected.checks) ||
      outcome.semanticDigest !== expected.semanticDigest) {
      throw new Error(`scenario ${scenario.id} outcome derivation mismatch`);
    }
    const values = byScenario.get(outcome.scenarioId) ?? [];
    values.push(outcome);
    byScenario.set(outcome.scenarioId, values);
  }

  const canonicalOutcomes: AuthoredInvariantOutcome[] = [];
  for (const scenario of scenarios) {
    const values = byScenario.get(scenario.id) ?? [];
    values.sort((left, right) => left.trialIndex - right.trialIndex);
    if (values.length !== scenario.repeatCount) {
      throw new Error(`scenario ${scenario.id} requires exactly ${scenario.repeatCount} outcomes`);
    }
    values.forEach((outcome, index) => {
      if (outcome.trialIndex !== index) {
        throw new Error(`scenario ${scenario.id} trial coverage must be contiguous and zero-based`);
      }
    });
    canonicalOutcomes.push(...values);
  }
  if (canonicalJson(outcomes) !== canonicalJson(canonicalOutcomes)) {
    throw new Error('authored invariant outcomes must use canonical scenario/trial order');
  }
  if (outcomes.length !== scenarios.reduce((sum, scenario) => sum + scenario.repeatCount, 0)) {
    throw new Error('authored invariant outcomes contain unexpected scenario coverage');
  }

  const runtimeDistributions = scenarios.map((scenario) => {
    const values = byScenario.get(scenario.id)!;
    const durations = values.map((outcome) => BigInt(outcome.durationNanoseconds));
    return {
      scenarioId: scenario.id,
      samples: durations.length,
      minNanoseconds: percentile(durations, 0).toString(),
      p50Nanoseconds: percentile(durations, 0.5).toString(),
      p95Nanoseconds: percentile(durations, 0.95).toString(),
      maxNanoseconds: percentile(durations, 1).toString(),
    };
  });
  const exactOracleMismatches = outcomes.filter((outcome) =>
    !outcome.checks.exactTerminal || !outcome.checks.exactDecision ||
    !outcome.checks.exactPrecedence || !outcome.checks.exactCliExitCode ||
    !outcome.checks.exactProcessSignal ||
    !outcome.checks.exactEvidenceState || !outcome.checks.exactObservationClass ||
    !outcome.checks.exactErrorKind).length;
  const nondeterministicScenarios = scenarios.filter((scenario) =>
    new Set(byScenario.get(scenario.id)!.map((outcome) => outcome.semanticDigest)).size !== 1).length;
  const completionOrderFailures = scenarios.filter((scenario) => {
    if (!scenario.executionOracle.requireDistinctCompletionOrders) return false;
    const digests = byScenario.get(scenario.id)!
      .map((outcome) => outcome.executionEvidence.completionOrderDigest);
    return digests.some((digest) => digest === null) || new Set(digests).size < 2;
  }).length;
  const summary = {
    scenarios: scenarios.length,
    trials: outcomes.length,
    falsePromotions: outcomes.filter((outcome) => outcome.checks.falsePromotion).length,
    falseBlocks: outcomes.filter((outcome) => outcome.checks.falseBlock).length,
    exactOracleMismatches,
    callCountMismatches: outcomes.filter((outcome) => !outcome.checks.exactCallCounts).length,
    reportValidationFailures: outcomes.filter((outcome) => !outcome.checks.reportValidation).length,
    nondeterministicScenarios,
    completionOrderFailures,
    executionEvidenceFailures: outcomes.filter(
      (outcome) => !outcome.checks.sufficientObservedConcurrency,
    ).length,
    passed: false,
  };
  summary.passed = outcomes.every((outcome) => outcome.checks.passed) &&
    summary.nondeterministicScenarios === 0 && summary.completionOrderFailures === 0;
  return {
    scenarioSetDigest: byteDigest(Buffer.from(canonicalJson(scenarios), 'utf8')),
    runtimeDistributions,
    summary,
  };
}

function assertAuthoredInvariantRun(run: AuthoredInvariantRunShape): void {
  const derived = deriveRunParts(run.scenarios, run.outcomes);
  if (run.scenarioSetDigest !== derived.scenarioSetDigest) {
    throw new Error('authored invariant scenarioSetDigest mismatch');
  }
  if (canonicalJson(run.runtimeDistributions) !== canonicalJson(derived.runtimeDistributions)) {
    throw new Error('authored invariant runtime distributions mismatch');
  }
  if (canonicalJson(run.summary) !== canonicalJson(derived.summary)) {
    throw new Error('authored invariant summary mismatch');
  }
}

/** Parse and independently rederive every authored invariant run field. */
export function verifyAuthoredInvariantRun(raw: unknown): AuthoredInvariantRun {
  return authoredInvariantRunSchema.parse(raw);
}

export function buildAuthoredInvariantRun(
  suiteId: string,
  rawScenarios: AuthoredInvariantScenario[],
  rawOutcomes: AuthoredInvariantOutcome[],
  rawEnvironment: AuthoredInvariantEnvironment,
): AuthoredInvariantRun {
  const scenarios = rawScenarios.map((scenario) => authoredInvariantScenarioSchema.parse(scenario))
    .sort((left, right) => codeUnitCompare(left.id, right.id));
  const scenarioOrder = new Map(scenarios.map((scenario, index) => [scenario.id, index]));
  const outcomes = rawOutcomes.map((outcome) => authoredInvariantOutcomeSchema.parse(outcome))
    .sort((left, right) => {
      const scenarioDifference = scenarioOrder.get(left.scenarioId)! -
        scenarioOrder.get(right.scenarioId)!;
      return scenarioDifference === 0 ? left.trialIndex - right.trialIndex : scenarioDifference;
    });
  const environment = authoredInvariantEnvironmentSchema.parse(rawEnvironment);
  const derived = deriveRunParts(scenarios, outcomes);
  return authoredInvariantRunSchema.parse({
    contract: AUTHORED_INVARIANT_RUN_CONTRACT,
    schemaVersion: 1,
    evidenceClass: 'authored_correctness_only',
    comparativeClaim: 'forbidden',
    suiteId,
    scenarioSetDigest: derived.scenarioSetDigest,
    environment,
    scenarios,
    outcomes,
    runtimeDistributions: derived.runtimeDistributions,
    summary: derived.summary,
  });
}
