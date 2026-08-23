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
  suiteConfigV6Schema,
  type SuiteConfigV6,
} from './config-v6.js';
import type { SuiteConfig } from './config-v5.js';
import {
  releasePolicyV2CandidateProjection,
  verifyReleasePolicyV2,
  type ReleasePolicyV2,
} from './policy-v2.js';
import {
  buildCalibrationReportV6,
  type CalibrationSuiteReport,
} from './report-v6.js';
import {
  preflightSuiteRelease,
  runPreflightedSuiteRelease,
  suiteReleaseScope,
  type PreflightedSuiteRelease,
} from './suite-runner.js';

export interface PreflightCalibrationSuiteOptions {
  now?: () => Date;
  /** Failure-injection seam; each configured source is invoked exactly once. */
  readCalibrationBytes?: (path: string) => Promise<Uint8Array>;
}

export type RunCalibrationSuiteOptions = PreflightCalibrationSuiteOptions;

export interface PreflightedCalibrationSuiteRelease {
  config: SuiteConfigV6;
  v5Config: SuiteConfig;
  v5: PreflightedSuiteRelease;
  policy: ReleasePolicyV2;
  evaluatedAt: string;
  calibrationCollections: CalibrationCollectionResult[];
  calibrationPolicyResults: CalibrationPolicyResult[];
  requiredCalibrationIntegrityFailure: boolean;
}

function candidateConfigProjection(config: SuiteConfigV6): SuiteConfig {
  return {
    schemaVersion: 5,
    inputs: config.inputs,
    scope: config.scope,
    candidate: config.candidate,
    suite: config.suite,
    policy: releasePolicyV2CandidateProjection(config.policy),
    trustPolicy: config.trustPolicy,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    output: config.output,
  };
}

function exactNow(now: () => Date): string {
  const value = now().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error('v6 runner clock must produce exact UTC milliseconds');
  }
  return value;
}

/**
 * Freeze every local input before candidate or provider execution. Calibration
 * files are read sequentially in manifest order, exactly once each, without
 * retry or a network/status fallback.
 */
export async function preflightCalibrationSuiteRelease(
  inputConfig: SuiteConfigV6,
  options: PreflightCalibrationSuiteOptions = {},
): Promise<PreflightedCalibrationSuiteRelease> {
  const now = options.now ?? (() => new Date());
  const evaluatedAt = exactNow(now);
  const config = suiteConfigV6Schema.parse(inputConfig);
  const v5Config = candidateConfigProjection(config);
  const v5 = await preflightSuiteRelease(v5Config);
  const policy = verifyReleasePolicyV2(config.policy, v5.manifest);

  const calibrationCollections: CalibrationCollectionResult[] = [];
  for (const [index, member] of v5.manifest.members.entries()) {
    const binding = config.calibrationEvidence[index];
    if (binding === undefined || binding.criterionVersionId !== member.criterionVersionId) {
      throw new Error('calibrationEvidence must exactly follow manifest order');
    }
    if (binding.source === null) {
      calibrationCollections.push(collectCalibrationEvidence({
        criterionVersionId: member.criterionVersionId,
        source: null,
        manifest: v5.manifest,
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
        manifest: v5.manifest,
        member,
        bytes,
      }));
    } catch (error) {
      if (!(error instanceof CalibrationFileReadError)) throw error;
      calibrationCollections.push(collectCalibrationEvidence({
        criterionVersionId: member.criterionVersionId,
        source: binding.source,
        manifest: v5.manifest,
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
    v5Config,
    v5,
    policy,
    evaluatedAt,
    calibrationCollections,
    calibrationPolicyResults,
    requiredCalibrationIntegrityFailure,
  };
}

/**
 * Run the unchanged v5 candidate/receipt flow once after calibration
 * preflight, or emit a typed no-execution report for required integrity
 * failure. Calibration truth scope is never copied into the candidate scope.
 */
export async function runCalibrationSuiteRelease(
  config: SuiteConfigV6,
  options: RunCalibrationSuiteOptions = {},
): Promise<CalibrationSuiteReport> {
  const now = options.now ?? (() => new Date());
  const preflight = await preflightCalibrationSuiteRelease(config, {
    ...options,
    now,
  });
  const releaseScope = suiteReleaseScope(preflight.v5Config, preflight.v5.inputArtifact);

  if (preflight.requiredCalibrationIntegrityFailure) {
    const finishedAt = exactNow(now);
    return buildCalibrationReportV6({
      startedAt: preflight.evaluatedAt,
      finishedAt,
      evaluatedAt: preflight.evaluatedAt,
      releaseScope,
      manifest: preflight.v5.manifest,
      policy: preflight.policy,
      candidateAssessment: {
        status: 'not_started',
        reason: 'required_calibration_integrity_failure',
      },
      calibrationCollections: preflight.calibrationCollections,
    });
  }

  const candidateReport = await runPreflightedSuiteRelease(
    preflight.v5Config,
    preflight.v5,
    { now },
  );
  return buildCalibrationReportV6({
    startedAt: candidateReport.startedAt,
    finishedAt: candidateReport.finishedAt,
    evaluatedAt: preflight.evaluatedAt,
    releaseScope,
    manifest: preflight.v5.manifest,
    policy: preflight.policy,
    candidateAssessment: { status: 'completed', report: candidateReport },
    calibrationCollections: preflight.calibrationCollections,
  });
}
