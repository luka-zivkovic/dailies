import {
  collectCalibrationEvidence,
  evaluateCalibrationRequirement,
  type CalibrationCollectionResult,
  type CalibrationPolicyResult,
} from './calibration-policy.js';
import {
  CalibrationFileReadError,
  readCalibrationFileOnce,
} from './calibration-file.js';
import {
  suiteConfigSchema,
  type SuiteConfig,
  type SuiteConfigInput,
} from './suite-config.js';
import type { CandidateAssessmentConfig } from './candidate-assessment-config.js';
import {
  releasePolicyCandidateProjection,
  verifyReleasePolicy,
  type ReleasePolicy,
} from './release-policy.js';
import {
  buildSuiteReport,
  type SuiteReport,
} from './suite-report.js';
import {
  preflightCandidateAssessment,
  runPreflightedCandidateAssessment,
  suiteReleaseScope,
  type PreflightedCandidateAssessment,
} from './candidate-assessment-runner.js';

export interface PreflightSuiteReleaseOptions {
  now?: () => Date;
  /** Failure-injection seam; each configured source is invoked exactly once. */
  readCalibrationBytes?: (path: string) => Promise<Uint8Array>;
}

export type RunSuiteReleaseOptions = PreflightSuiteReleaseOptions;

export interface PreflightedSuiteRelease {
  config: SuiteConfig;
  candidateAssessmentConfig: CandidateAssessmentConfig;
  candidateAssessmentPreflight: PreflightedCandidateAssessment;
  policy: ReleasePolicy;
  evaluatedAt: string;
  calibrationCollections: CalibrationCollectionResult[];
  calibrationPolicyResults: CalibrationPolicyResult[];
  requiredCalibrationIntegrityFailure: boolean;
}

function candidateAssessmentConfigProjection(config: SuiteConfig): CandidateAssessmentConfig {
  return {
    inputs: config.inputs,
    scope: config.scope,
    candidate: config.candidate,
    suite: config.suite,
    policy: releasePolicyCandidateProjection(config.policy),
    trustPolicy: config.trustPolicy,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    output: config.output,
  };
}

function exactNow(now: () => Date): string {
  const value = now().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error('suite runner clock must produce exact UTC milliseconds');
  }
  return value;
}

/**
 * Freeze every local input before candidate or provider execution. Calibration
 * files are read sequentially in manifest order, exactly once each, without
 * retry or a network/status fallback.
 */
export async function preflightSuiteRelease(
  inputConfig: SuiteConfigInput,
  options: PreflightSuiteReleaseOptions = {},
): Promise<PreflightedSuiteRelease> {
  const now = options.now ?? (() => new Date());
  const evaluatedAt = exactNow(now);
  const config = suiteConfigSchema.parse(inputConfig);
  const candidateAssessmentConfig = candidateAssessmentConfigProjection(config);
  const candidateAssessmentPreflight = await preflightCandidateAssessment(candidateAssessmentConfig);
  const policy = verifyReleasePolicy(config.policy, candidateAssessmentPreflight.manifest);

  const calibrationCollections: CalibrationCollectionResult[] = [];
  for (const [index, member] of candidateAssessmentPreflight.manifest.members.entries()) {
    const binding = config.calibrationEvidence[index];
    if (binding === undefined || binding.criterionVersionId !== member.criterionVersionId) {
      throw new Error('calibrationEvidence must exactly follow manifest order');
    }
    if (binding.source === null) {
      calibrationCollections.push(collectCalibrationEvidence({
        criterionVersionId: member.criterionVersionId,
        source: null,
        manifest: candidateAssessmentPreflight.manifest,
        member,
      }));
      continue;
    }

    try {
      const bytes = await readCalibrationFileOnce(binding.source.path, {
        readBytes: options.readCalibrationBytes,
      });
      calibrationCollections.push(collectCalibrationEvidence({
        criterionVersionId: member.criterionVersionId,
        source: binding.source,
        manifest: candidateAssessmentPreflight.manifest,
        member,
        bytes,
      }));
    } catch (error) {
      if (!(error instanceof CalibrationFileReadError)) throw error;
      calibrationCollections.push(collectCalibrationEvidence({
        criterionVersionId: member.criterionVersionId,
        source: binding.source,
        manifest: candidateAssessmentPreflight.manifest,
        member,
        readFailure: error.code === 'source_not_found' ? 'not_found' : 'read_failed',
      }));
    }
  }

  const calibrationPolicyResults = policy.criteria.map((entry, index) =>
    evaluateCalibrationRequirement(
      entry.criterionVersionId,
      entry.calibrationRequirement,
      calibrationCollections[index]!,
      evaluatedAt,
    ));
  const requiredCalibrationIntegrityFailure = policy.criteria.some((entry, index) =>
    entry.evidenceRequirement === 'mandatory' &&
      calibrationPolicyResults[index]?.status === 'integrity_failure');

  return {
    config,
    candidateAssessmentConfig,
    candidateAssessmentPreflight,
    policy,
    evaluatedAt,
    calibrationCollections,
    calibrationPolicyResults,
    requiredCalibrationIntegrityFailure,
  };
}

/**
 * Run the unchanged candidate assessment (the candidate/receipt flow) once after calibration
 * preflight, or emit a typed no-execution report for required integrity
 * failure. Calibration truth scope is never copied into the candidate scope.
 */
export async function runSuiteRelease(
  config: SuiteConfigInput,
  options: RunSuiteReleaseOptions = {},
): Promise<SuiteReport> {
  const now = options.now ?? (() => new Date());
  const preflight = await preflightSuiteRelease(config, {
    ...options,
    now,
  });
  const releaseScope = suiteReleaseScope(preflight.candidateAssessmentConfig, preflight.candidateAssessmentPreflight.inputArtifact);

  if (preflight.requiredCalibrationIntegrityFailure) {
    const finishedAt = exactNow(now);
    return buildSuiteReport({
      startedAt: preflight.evaluatedAt,
      finishedAt,
      evaluatedAt: preflight.evaluatedAt,
      releaseScope,
      manifest: preflight.candidateAssessmentPreflight.manifest,
      policy: preflight.policy,
      candidateAssessment: {
        status: 'not_started',
        reason: 'required_calibration_integrity_failure',
      },
      calibrationCollections: preflight.calibrationCollections,
    });
  }

  const candidateReport = await runPreflightedCandidateAssessment(
    preflight.candidateAssessmentConfig,
    preflight.candidateAssessmentPreflight,
    { now },
  );
  return buildSuiteReport({
    startedAt: candidateReport.startedAt,
    finishedAt: candidateReport.finishedAt,
    evaluatedAt: preflight.evaluatedAt,
    releaseScope,
    manifest: preflight.candidateAssessmentPreflight.manifest,
    policy: preflight.policy,
    candidateAssessment: { status: 'completed', report: candidateReport },
    calibrationCollections: preflight.calibrationCollections,
  });
}
