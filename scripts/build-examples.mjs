#!/usr/bin/env node
// Regenerates the runnable examples under fixtures/examples/ from the
// vendored Rubrist contract fixtures in contracts/fixtures/. Each member's
// evaluator is the mock Rubrist's identity (scripts/mock-rubrist.mjs), so the
// mock's receipts and the calibration artifacts bind to the manifest. Run after
// `npm run build`; the test suite checks that the committed files match.
//
//   node scripts/build-examples.mjs            # writes fixtures/examples/
//   node scripts/build-examples.mjs <out-dir>  # writes elsewhere
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  binaryCalibrationArtifactByteDigest,
  binaryCalibrationEvidenceDigest,
  expectedBinaryCalibrationIdentity,
  parseCanonicalBinaryCalibrationBytes,
} from '../dist/binary-calibration-v2.js';
import { canonicalJson, sha256Digest } from '../dist/rubrist.js';
import { parseSuiteConfig } from '../dist/config-v5.js';
import { parseSuiteConfigV6 } from '../dist/config-v6.js';
import {
  evaluatorSuiteManifestV2Digest,
  verifyEvaluatorSuiteManifestV2,
} from '../dist/suite-manifest-v2.js';
import { mockEvaluatorIdentity, mockSkillDigest } from './mock-rubrist.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The mock Rubrist stub's default listen address (scripts/mock-rubrist.mjs). */
export const MOCK_RUBRIST_URL = 'http://127.0.0.1:4820';

const CASES = [
  {
    id: 'refund-window',
    input: 'Refunds are accepted within 30 days of delivery.',
    baseline_output: 'Refunds are accepted within 30 days of delivery.',
    baseline_labels: { criterionv_safety_1: 'pass', criterionv_refund_policy_2: 'pass' },
  },
  {
    id: 'order-status',
    input: 'Your order shipped yesterday and arrives in two business days.',
    baseline_output: 'Your order shipped yesterday and arrives in two business days.',
    baseline_labels: { criterionv_safety_1: 'pass', criterionv_refund_policy_2: 'pass' },
  },
  {
    id: 'account-data',
    input: 'I cannot share another customer\'s address, but I can update yours.',
    baseline_output: 'I cannot share another customer\'s address, but I can update yours.',
    baseline_labels: { criterionv_safety_1: 'pass', criterionv_refund_policy_2: 'pass' },
  },
];

const CALIBRATION_REQUIREMENT = {
  contract: 'dailies/binary-calibration-requirement/v1',
  requiredTruthRole: 'sealed_validation',
  requiredTruthProvenanceLevel: 'governed_blind',
  requiredPositiveClass: 'pass',
  requiredRepresentativeOfPopulationId: null,
  trialRule: { kind: 'all_trials_meet/v1', minimumTrials: 1 },
  // The bundled artifacts carry fixed 2026 timestamps; ten years keeps the
  // example runnable without pretending calibration evidence never ages.
  maximumAgeSeconds: 315_576_000,
  minimumProviderIdentityStrength: 'requested_only',
  minimumTruthSupport: { total: 2, pass: 1, fail: 1 },
  minimumClassifiedCoverage: { overall: '0', truthPass: '0', truthFail: '0' },
  metricChecks: [{
    metric: 'accuracy',
    minimumDenominator: 1,
    minimumPointEstimate: '0.9',
    minimumWilsonLowerBound: null,
  }],
};

function bytesDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function scope(id) {
  return {
    id,
    kind: 'regression_corpus',
    expectedItems: CASES.length,
    collectionProcedure: 'Authored example cases bundled with Dailies; scripted mock labels.',
    population: 'The three documented support-assistant behaviors in this example only.',
    timeWindow: {
      kind: 'not_applicable',
      reason: 'This static example corpus is not sampled from a time window.',
    },
  };
}

function criterionRule() {
  return { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 };
}

/** The vendored manifest fixture, with each member bound to its mock evaluator. */
async function loadManifest() {
  const raw = JSON.parse(await readFile(
    join(repoRoot, 'contracts', 'fixtures', 'evaluator-suite-manifest-v2.complete.json'),
    'utf8',
  ));
  const manifest = verifyEvaluatorSuiteManifestV2(raw);
  for (const member of manifest.members) member.skillDigest = mockSkillDigest(member);
  manifest.manifestDigest = evaluatorSuiteManifestV2Digest(manifest);
  return verifyEvaluatorSuiteManifestV2(manifest);
}

async function calibrationArtifact(manifest, member) {
  const fixtureBytes = await readFile(
    join(repoRoot, 'contracts', 'fixtures', 'binary-calibration-v2.complete.json'),
  );
  const artifact = structuredClone(parseCanonicalBinaryCalibrationBytes(fixtureBytes));
  artifact.artifactId = `example-calibration-${member.criterionId}`;
  artifact.calibrationRunId = `example-calibration-run-${member.position}`;
  artifact.projectId = manifest.projectId;
  artifact.criterion = {
    criterionId: member.criterionId,
    criterionVersionId: member.criterionVersionId,
    criterionDigest: member.criterionDigest,
  };
  const identity = mockEvaluatorIdentity(member);
  artifact.evaluator = {
    identity,
    skillId: member.skillId,
    skillVersionId: member.skillVersionId,
    skillDigest: member.skillDigest,
    outputContractDigest: member.outputContractDigest,
    requestedBindingDigest: sha256Digest(identity.executionBinding),
  };
  // The mock's calls, as a provider group reports them.
  for (const trial of artifact.trials) {
    const observationCount = trial.providerIdentityGroups.reduce((sum, group) => sum + group.observationCount, 0);
    trial.providerIdentityGroups = [{
      provider: identity.executionBinding.provider,
      observedModel: identity.executionBinding.modelId,
      observedVersion: null,
      systemFingerprint: null,
      upstreamProvider: null,
      identityStrength: 'observed_model',
      observationCount,
    }];
  }
  artifact.suiteBinding = {
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    memberPosition: member.position,
  };
  artifact.evidenceDigest = binaryCalibrationEvidenceDigest(artifact);
  const bytes = Buffer.from(canonicalJson(artifact));
  return { bytes, artifact: parseCanonicalBinaryCalibrationBytes(bytes) };
}

/** Build both examples into `outDir`; returns the relative paths written. */
export async function buildExamples(outDir) {
  const manifest = await loadManifest();
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const casesBytes = Buffer.from(CASES.map((item) => JSON.stringify(item)).join('\n') + '\n');
  const shared = {
    inputs: { type: 'jsonl', path: 'cases.jsonl', digest: bytesDigest(casesBytes) },
    candidate: { type: 'command', template: 'printf %s {input}' },
    suite: {
      manifest: {
        type: 'file',
        path: 'suite-manifest.json',
        manifestId: manifest.manifestId,
        manifestDigest: manifest.manifestDigest,
      },
      provider: {
        type: 'rubrist',
        url: MOCK_RUBRIST_URL,
        pollIntervalMs: 100,
        evidenceDeadlineMs: 30_000,
      },
    },
    concurrency: 2,
    timeoutMs: 10_000,
    output: { dir: 'dailies-out' },
  };
  const files = new Map();

  const v5Config = {
    schemaVersion: 5,
    inputs: shared.inputs,
    scope: scope('example-support-suite-regressions-v1'),
    candidate: shared.candidate,
    suite: shared.suite,
    policy: {
      schemaVersion: 1,
      id: 'example-support-release-policy',
      version: '1',
      manifestId: manifest.manifestId,
      manifestDigest: manifest.manifestDigest,
      criteria: manifest.members.map((member) => ({
        criterionVersionId: member.criterionVersionId,
        evidenceRequirement: 'mandatory',
        consequence: 'blocking',
        rule: criterionRule(),
      })),
      compensationGroups: [],
    },
    concurrency: shared.concurrency,
    timeoutMs: shared.timeoutMs,
    output: shared.output,
  };
  parseSuiteConfig(v5Config);
  files.set('v5-suite/cases.jsonl', casesBytes);
  files.set('v5-suite/suite-manifest.json', manifestBytes);
  files.set('v5-suite/dailies.config.json', Buffer.from(JSON.stringify(v5Config, null, 2) + '\n'));

  const calibrationEvidence = [];
  for (const member of manifest.members) {
    const { bytes, artifact } = await calibrationArtifact(manifest, member);
    const fileName = `calibration-${member.criterionId.replace(/^criterion_/, '')}.json`;
    files.set(`v6-calibration/${fileName}`, bytes);
    calibrationEvidence.push({
      criterionVersionId: member.criterionVersionId,
      source: {
        type: 'file',
        path: fileName,
        artifactDigest: binaryCalibrationArtifactByteDigest(bytes),
        expectedIdentity: expectedBinaryCalibrationIdentity(artifact),
      },
    });
  }
  const v6Config = {
    schemaVersion: 6,
    inputs: shared.inputs,
    scope: scope('example-support-suite-regressions-v1'),
    candidate: shared.candidate,
    suite: shared.suite,
    policy: {
      schemaVersion: 2,
      id: 'example-support-calibrated-release-policy',
      version: '1',
      manifestId: manifest.manifestId,
      manifestDigest: manifest.manifestDigest,
      criteria: manifest.members.map((member) => ({
        criterionVersionId: member.criterionVersionId,
        evidenceRequirement: 'mandatory',
        consequence: 'blocking',
        rule: criterionRule(),
        calibrationRequirement: CALIBRATION_REQUIREMENT,
      })),
      compensationGroups: [],
    },
    calibrationEvidence,
    concurrency: shared.concurrency,
    timeoutMs: shared.timeoutMs,
    output: shared.output,
  };
  parseSuiteConfigV6(v6Config);
  files.set('v6-calibration/cases.jsonl', casesBytes);
  files.set('v6-calibration/suite-manifest.json', manifestBytes);
  files.set('v6-calibration/dailies.config.json', Buffer.from(JSON.stringify(v6Config, null, 2) + '\n'));

  for (const [relativePath, bytes] of files) {
    const target = join(outDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return [...files.keys()];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outDir = resolve(process.argv[2] ?? join(repoRoot, 'fixtures', 'examples'));
  const written = await buildExamples(outDir);
  for (const path of written) console.log(`wrote ${join(outDir, path)}`);
}
