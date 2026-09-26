import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  binaryCalibrationArtifactByteDigest,
  binaryCalibrationEvidenceDigest,
  expectedBinaryCalibrationIdentity,
  parseCanonicalBinaryCalibrationBytes,
  type BinaryCalibrationArtifact,
} from '../src/binary-calibration-v2.js';
import { canonicalJson, sha256Digest } from '../src/rubrist.js';
import { MAX_CALIBRATION_FILE_BYTES } from '../src/calibration-file.js';
import { parseSuiteConfigV6, type SuiteConfigV6 } from '../src/config-v6.js';
import type { BinaryCalibrationRequirementV1 } from '../src/policy-v2.js';
import { parseCanonicalCalibrationReportV6Bytes } from '../src/report-v6.js';
import { preflightCalibrationSuiteRelease } from '../src/suite-runner-v6.js';
import { runCalibrationSuiteRelease } from '../src/suite-runner-v6.js';
import {
  evaluatorSuiteManifestV2Digest,
  verifyEvaluatorSuiteManifestV2,
  type EvaluatorSuiteManifestV2,
  type EvaluatorSuiteManifestV2Member,
} from '../src/suite-manifest-v2.js';
import { evaluatorIdentityFor, knownEvaluatorIdentity, receiptV2 } from './rubrist-v2-support.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function bytesDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const calibrationRequirement: BinaryCalibrationRequirementV1 = {
  contract: 'dailies/binary-calibration-requirement/v1',
  requiredTruthRole: 'sealed_validation',
  requiredTruthProvenanceLevel: 'governed_blind',
  requiredPositiveClass: 'pass',
  requiredRepresentativeOfPopulationId: null,
  trialRule: { kind: 'all_trials_meet/v1', minimumTrials: 1 },
  maximumAgeSeconds: 31_557_600,
  minimumProviderIdentityStrength: 'requested_only',
  minimumTruthSupport: { total: 1, pass: 0, fail: 0 },
  minimumClassifiedCoverage: { overall: '0', truthPass: '0', truthFail: '0' },
  metricChecks: [{
    metric: 'accuracy',
    minimumDenominator: 1,
    minimumPointEstimate: '0',
    minimumWilsonLowerBound: null,
  }],
};

async function manifestFixture(): Promise<EvaluatorSuiteManifestV2> {
  const raw = JSON.parse(await readFile(
    new URL('../contracts/fixtures/evaluator-suite-manifest-v2.complete.json', import.meta.url),
    'utf8',
  )) as EvaluatorSuiteManifestV2;
  raw.trialPlan = null;
  // The second member's fixture evaluator is typed-question; these tests bind a prompted one.
  raw.members[1]!.skillDigest = sha256Digest(knownEvaluatorIdentity('repeated'));
  raw.manifestDigest = evaluatorSuiteManifestV2Digest(raw);
  return verifyEvaluatorSuiteManifestV2(raw);
}

async function calibrationForMember(
  manifest: EvaluatorSuiteManifestV2,
  member: EvaluatorSuiteManifestV2Member,
  fixtureName: 'complete' | 'repeated' | 'incomplete' = 'complete',
): Promise<{ bytes: Uint8Array; artifact: BinaryCalibrationArtifact }> {
  const fixtureBytes = await readFile(
    new URL(`../contracts/fixtures/binary-calibration-v2.${fixtureName}.json`, import.meta.url),
  );
  const artifact = structuredClone(
    parseCanonicalBinaryCalibrationBytes(fixtureBytes),
  ) as BinaryCalibrationArtifact;
  artifact.artifactId = `artifact-${member.position}`;
  artifact.calibrationRunId = `calibration-run-${member.position}`;
  artifact.projectId = manifest.projectId;
  artifact.exposure.authorization.recordedAt = '2026-08-22T12:00:00.000Z';
  artifact.startedAt = '2026-08-22T12:00:01.000Z';
  artifact.completedAt = '2026-08-22T12:00:02.000Z';
  artifact.exposure.completion.recordedAt = '2026-08-22T12:00:03.000Z';
  artifact.createdAt = '2026-08-22T12:00:04.000Z';
  artifact.criterion = {
    criterionId: member.criterionId,
    criterionVersionId: member.criterionVersionId,
    criterionDigest: member.criterionDigest,
  };
  const identity = evaluatorIdentityFor(member);
  artifact.evaluator = {
    identity,
    skillId: member.skillId,
    skillVersionId: member.skillVersionId,
    skillDigest: member.skillDigest,
    outputContractDigest: member.outputContractDigest,
    requestedBindingDigest: sha256Digest(identity.executionBinding),
  };
  // A reused fixture's provider groups name the member's provider.
  for (const trial of artifact.trials) {
    for (const group of trial.providerIdentityGroups) {
      group.provider = identity.executionBinding.provider;
      group.upstreamProvider = null;
    }
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

async function preflightFixture(): Promise<{
  dir: string;
  config: SuiteConfigV6;
  manifest: EvaluatorSuiteManifestV2;
  calibrationBytes: Map<string, Uint8Array>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-v6-preflight-'));
  tempDirs.push(dir);
  const manifest = await manifestFixture();
  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, canonicalJson(manifest));
  const inputBytes = Buffer.from('{"id":"one","input":"safe"}\n');
  const inputPath = join(dir, 'inputs.jsonl');
  await writeFile(inputPath, inputBytes);
  const calibrationBytes = new Map<string, Uint8Array>();
  const calibrationEvidence = [];
  for (const member of manifest.members) {
    const calibration = await calibrationForMember(manifest, member);
    const path = join(dir, `calibration-${member.position}.json`);
    calibrationBytes.set(path, calibration.bytes);
    calibrationEvidence.push({
      criterionVersionId: member.criterionVersionId,
      source: {
        type: 'file' as const,
        path,
        artifactDigest: binaryCalibrationArtifactByteDigest(calibration.bytes),
        expectedIdentity: expectedBinaryCalibrationIdentity(calibration.artifact),
      },
    });
  }
  const config = parseSuiteConfigV6({
    schemaVersion: 6,
    inputs: { type: 'jsonl', path: inputPath, digest: bytesDigest(inputBytes) },
    scope: {
      id: 'candidate-regression-scope',
      kind: 'regression_corpus',
      expectedItems: 1,
      collectionProcedure: 'Pinned candidate regression input.',
      population: 'The declared candidate regression corpus.',
      timeWindow: { kind: 'not_applicable', reason: 'Static fixture.' },
    },
    candidate: { type: 'command', template: 'printf %s {input}' },
    suite: {
      manifest: {
        type: 'file',
        path: manifestPath,
        manifestId: manifest.manifestId,
        manifestDigest: manifest.manifestDigest,
      },
      provider: {
        type: 'rubrist',
        url: 'http://127.0.0.1:1',
        pollIntervalMs: 1,
        evidenceDeadlineMs: 1_000,
      },
    },
    policy: {
      schemaVersion: 2,
      id: 'calibration-policy',
      version: '1',
      manifestId: manifest.manifestId,
      manifestDigest: manifest.manifestDigest,
      criteria: manifest.members.map((member) => ({
        criterionVersionId: member.criterionVersionId,
        evidenceRequirement: 'mandatory' as const,
        consequence: 'blocking' as const,
        rule: { kind: 'binary_threshold/v1' as const, minPassRate: 1, maxRegressions: 0 },
        calibrationRequirement,
      })),
      compensationGroups: [],
    },
    calibrationEvidence,
    concurrency: 2,
    timeoutMs: 1_000,
    output: { dir: join(dir, 'out') },
  });
  return { dir, config, manifest, calibrationBytes };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server did not bind');
      resolve(address.port);
    });
  });
}

function close(server: Server): void {
  server.closeAllConnections();
  server.close();
}

interface SubmittedItem {
  clientItemId: string;
  input: string;
  output: string;
}

function assessmentReceipt(
  manifest: EvaluatorSuiteManifestV2,
  skillVersionId: string,
  items: SubmittedItem[],
  failingPositions: Set<number>,
): Record<string, unknown> {
  const member = manifest.members.find((entry) => entry.skillVersionId === skillVersionId)!;
  return receiptV2({
    evalRunId: `run-${skillVersionId}`,
    projectId: manifest.projectId,
    skillId: member.skillId,
    skillVersionId,
    evaluator: evaluatorIdentityFor(member),
    items: items.map((item) => ({
      clientItemId: item.clientItemId,
      caseId: `case-${member.position}-${item.clientItemId}`,
      input: item.input,
      output: item.output,
      result: { state: 'outcome', outcome: failingPositions.has(member.position) ? 'fail' : 'pass' },
    })),
    runStatus: 'completed',
  });
}

async function executionServers(
  fixture: Awaited<ReturnType<typeof preflightFixture>>,
  failingPositions: number[] = [],
): Promise<{
  candidateServer: Server;
  rubristServer: Server;
  readonly candidateCalls: number;
  readonly providerSubmissions: number;
}> {
  let candidateCalls = 0;
  const candidateServer = createServer(async (req, res) => {
    candidateCalls += 1;
    const body = JSON.parse(await readBody(req)) as { input: string };
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ output: body.input }));
  });
  const candidatePort = await listen(candidateServer);
  fixture.config.candidate = {
    type: 'http',
    url: `http://127.0.0.1:${candidatePort}/candidate`,
    bodyTemplate: '{"input": {input}}',
  };

  const submissions = new Map<string, { skillVersionId: string; items: SubmittedItem[] }>();
  let providerSubmissions = 0;
  const rubristServer = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/judge/batch') {
      providerSubmissions += 1;
      const body = JSON.parse(await readBody(req)) as { skillVersionId: string; items: SubmittedItem[] };
      const runId = `run-${body.skillVersionId}`;
      submissions.set(runId, body);
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({
        evalRunId: runId,
        status: 'pending',
        totalItems: body.items.length,
        cachedItems: 0,
        skippedItems: 0,
        pollUrl: `/api/v1/eval-runs/${runId}`,
      }));
      return;
    }
    const poll = req.url?.match(/^\/api\/v1\/eval-runs\/(run-[^/]+)$/);
    if (req.method === 'GET' && poll) {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: poll[1], status: 'completed' }));
      return;
    }
    const receiptPath = req.url?.match(
      /^\/api\/v1\/eval-runs\/(run-[^/]+)\/assessment-receipt$/,
    );
    if (req.method === 'GET' && receiptPath) {
      const submission = submissions.get(receiptPath[1]!);
      if (submission === undefined) throw new Error('missing submission');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(
        assessmentReceipt(
          fixture.manifest,
          submission.skillVersionId,
          submission.items,
          new Set(failingPositions),
        ),
      ));
      return;
    }
    res.writeHead(404).end();
  });
  const rubristPort = await listen(rubristServer);
  fixture.config.suite.provider.url = `http://127.0.0.1:${rubristPort}`;
  return {
    candidateServer,
    rubristServer,
    get candidateCalls() { return candidateCalls; },
    get providerSubmissions() { return providerSubmissions; },
  };
}

async function runCli(configPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), '--config', configPath], {
      timeout: 10_000,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

function retimeCalibrationFilesForCli(
  fixture: Awaited<ReturnType<typeof preflightFixture>>,
): void {
  const createdAtMs = Date.now() - 60_000;
  for (const binding of fixture.config.calibrationEvidence) {
    if (binding.source === null) continue;
    const artifact = structuredClone(parseCanonicalBinaryCalibrationBytes(
      fixture.calibrationBytes.get(binding.source.path)!,
    ));
    artifact.exposure.authorization.recordedAt = new Date(createdAtMs - 4_000).toISOString();
    artifact.startedAt = new Date(createdAtMs - 3_000).toISOString();
    artifact.completedAt = new Date(createdAtMs - 2_000).toISOString();
    artifact.exposure.completion.recordedAt = new Date(createdAtMs - 1_000).toISOString();
    artifact.createdAt = new Date(createdAtMs).toISOString();
    artifact.evidenceDigest = binaryCalibrationEvidenceDigest(artifact);
    const bytes = Buffer.from(canonicalJson(artifact));
    const verified = parseCanonicalBinaryCalibrationBytes(bytes);
    fixture.calibrationBytes.set(binding.source.path, bytes);
    binding.source.artifactDigest = binaryCalibrationArtifactByteDigest(bytes);
    binding.source.expectedIdentity = expectedBinaryCalibrationIdentity(verified);
  }
}

describe('calibration-aware suite preflight', () => {
  it('reads one raw snapshot per source sequentially in manifest order', async () => {
    const fixture = await preflightFixture();
    const reads: string[] = [];
    const preflight = await preflightCalibrationSuiteRelease(fixture.config, {
      now: () => new Date('2026-08-23T12:01:00.000Z'),
      readCalibrationBytes: async (path) => {
        reads.push(path);
        return fixture.calibrationBytes.get(path)!;
      },
    });

    expect(reads).toEqual(fixture.config.calibrationEvidence.map((entry) => entry.source!.path));
    expect(preflight.calibrationCollections.map((entry) => entry.state))
      .toEqual(['verified', 'verified']);
    expect(preflight.calibrationPolicyResults.map((entry) => entry.status))
      .toEqual(['satisfied', 'satisfied']);
    expect(preflight.requiredCalibrationIntegrityFailure).toBe(false);
  });

  it('distinguishes explicit absence, configured not-found, and configured read failure', async () => {
    const absent = await preflightFixture();
    absent.config.calibrationEvidence[0]!.source = null;
    const absentResult = await preflightCalibrationSuiteRelease(absent.config, {
      now: () => new Date('2026-08-23T12:01:00.000Z'),
      readCalibrationBytes: async (path) => absent.calibrationBytes.get(path)!,
    });
    expect(absentResult.calibrationCollections[0]).toMatchObject({
      state: 'incomplete',
      reason: 'source_not_configured',
    });
    expect(absentResult.requiredCalibrationIntegrityFailure).toBe(false);

    const failed = await preflightFixture();
    const failures = ['ENOENT', 'EACCES'] as const;
    const failedResult = await preflightCalibrationSuiteRelease(failed.config, {
      now: () => new Date('2026-08-23T12:01:00.000Z'),
      readCalibrationBytes: async (_path) => {
        const code = failures.shift()!;
        throw Object.assign(new Error(code), { code });
      },
    });
    expect(failedResult.calibrationCollections.map((entry) =>
      entry.state === 'integrity_failure' ? entry.reason : entry.state))
      .toEqual(['source_not_found', 'source_read_failed']);
    expect(failedResult.requiredCalibrationIntegrityFailure).toBe(true);
  });

  it('finishes input and manifest integrity checks before opening calibration files', async () => {
    const fixture = await preflightFixture();
    fixture.config.inputs.digest = `sha256:${'0'.repeat(64)}`;
    let calibrationReads = 0;
    await expect(preflightCalibrationSuiteRelease(fixture.config, {
      readCalibrationBytes: async () => {
        calibrationReads += 1;
        throw new Error('must not read');
      },
    })).rejects.toThrow(/input artifact digest mismatch/);
    expect(calibrationReads).toBe(0);
  });

  it('retains optional-advisory integrity failure without stopping candidate execution', async () => {
    const fixture = await preflightFixture();
    fixture.config.policy.criteria[0] = {
      ...fixture.config.policy.criteria[0]!,
      evidenceRequirement: 'optional',
      consequence: 'advisory',
    };
    const firstPath = fixture.config.calibrationEvidence[0]!.source!.path;
    const result = await preflightCalibrationSuiteRelease(fixture.config, {
      now: () => new Date('2026-08-23T12:01:00.000Z'),
      readCalibrationBytes: async (path) => {
        if (path === firstPath) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return fixture.calibrationBytes.get(path)!;
      },
    });

    expect(result.calibrationPolicyResults[0]).toMatchObject({
      status: 'integrity_failure',
      worstReason: 'source_not_found',
    });
    expect(result.requiredCalibrationIntegrityFailure).toBe(false);
  });

  it('applies strict and permissive policies differently to the same artifact bytes', async () => {
    const permissive = await preflightFixture();
    const permissiveServers = await executionServers(permissive);
    try {
      const report = await runCalibrationSuiteRelease(permissive.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => permissive.calibrationBytes.get(path)!,
      });
      expect(report).toMatchObject({
        schemaVersion: 6,
        decision: 'promote',
        decisionPrecedence: 'policy_satisfied',
        candidateAssessment: { status: 'completed' },
      });
    } finally {
      close(permissiveServers.candidateServer);
      close(permissiveServers.rubristServer);
    }

    const strict = await preflightFixture();
    strict.config.policy.criteria[0]!.calibrationRequirement!.minimumClassifiedCoverage.overall = '1';
    const strictServers = await executionServers(strict);
    try {
      const report = await runCalibrationSuiteRelease(strict.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => strict.calibrationBytes.get(path)!,
      });
      expect(report).toMatchObject({
        decision: 'inconclusive',
        decisionPrecedence: 'mandatory_evidence_incomplete',
        candidateAssessment: { status: 'completed' },
      });
      expect(report.criteria[0]?.calibrationPolicy.worstReason)
        .toBe('classified_coverage_overall_below_minimum');
    } finally {
      close(strictServers.candidateServer);
      close(strictServers.rubristServer);
    }
  });

  it('does not admit a block whose own required calibration is missing', async () => {
    const fixture = await preflightFixture();
    fixture.config.calibrationEvidence[0]!.source = null;
    const servers = await executionServers(fixture, [0]);
    try {
      const report = await runCalibrationSuiteRelease(fixture.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => fixture.calibrationBytes.get(path)!,
      });
      expect(report).toMatchObject({
        decision: 'inconclusive',
        decisionPrecedence: 'mandatory_evidence_incomplete',
      });
      expect(report.criteria[0]).toMatchObject({
        calibrationPolicy: { status: 'incomplete', worstReason: 'source_not_configured' },
        effectiveAssessment: { releaseAdmissible: false },
        policyResult: { rulePassed: null },
      });
    } finally {
      close(servers.candidateServer);
      close(servers.rubristServer);
    }
  });

  it('lets a valid calibrated block outrank unrelated missing calibration', async () => {
    const fixture = await preflightFixture();
    fixture.config.calibrationEvidence[0]!.source = null;
    const servers = await executionServers(fixture, [1]);
    try {
      const report = await runCalibrationSuiteRelease(fixture.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => fixture.calibrationBytes.get(path)!,
      });
      expect(report).toMatchObject({
        decision: 'block',
        decisionPrecedence: 'complete_blocking_failure',
      });
      expect(report.criteria[1]).toMatchObject({
        calibrationPolicy: { status: 'satisfied' },
        effectiveAssessment: { releaseAdmissible: true },
        policyResult: { rulePassed: false },
      });
    } finally {
      close(servers.candidateServer);
      close(servers.rubristServer);
    }
  });

  it('makes required calibration integrity terminal before candidate or provider calls', async () => {
    const fixture = await preflightFixture();
    const firstPath = fixture.config.calibrationEvidence[0]!.source!.path;
    fixture.calibrationBytes.set(
      firstPath,
      Buffer.concat([fixture.calibrationBytes.get(firstPath)!, Buffer.from('\n')]),
    );
    const servers = await executionServers(fixture, [1]);
    try {
      const report = await runCalibrationSuiteRelease(fixture.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => fixture.calibrationBytes.get(path)!,
      });
      expect(report).toMatchObject({
        decision: 'inconclusive',
        decisionPrecedence: 'required_integrity_failure',
        candidateAssessment: {
          status: 'not_started',
          reason: 'required_calibration_integrity_failure',
        },
      });
      expect(report.criteria[0]?.artifactEvidence).toMatchObject({
        disposition: 'rejected',
        reason: 'artifact_digest_mismatch',
      });
      expect(servers.candidateCalls).toBe(0);
      expect(servers.providerSubmissions).toBe(0);
    } finally {
      close(servers.candidateServer);
      close(servers.rubristServer);
    }
  });

  it('classifies an injected oversize snapshot before candidate or provider calls', async () => {
    const fixture = await preflightFixture();
    const firstPath = fixture.config.calibrationEvidence[0]!.source!.path;
    const servers = await executionServers(fixture);
    let firstReads = 0;
    try {
      const report = await runCalibrationSuiteRelease(fixture.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => {
          if (path === firstPath) {
            firstReads += 1;
            return new Uint8Array(MAX_CALIBRATION_FILE_BYTES + 1);
          }
          return fixture.calibrationBytes.get(path)!;
        },
      });
      expect(firstReads).toBe(1);
      expect(report).toMatchObject({
        decision: 'inconclusive',
        decisionPrecedence: 'required_integrity_failure',
        candidateAssessment: { status: 'not_started' },
      });
      expect(report.criteria[0]?.artifactEvidence).toMatchObject({
        disposition: 'rejected',
        reason: 'artifact_digest_mismatch',
      });
      expect(servers.candidateCalls).toBe(0);
      expect(servers.providerSubmissions).toBe(0);
    } finally {
      close(servers.candidateServer);
      close(servers.rubristServer);
    }
  });

  it('bounds a default-path oversize file and emits closed integrity evidence', async () => {
    const fixture = await preflightFixture();
    const firstPath = fixture.config.calibrationEvidence[0]!.source!.path;
    for (const [path, bytes] of fixture.calibrationBytes) await writeFile(path, bytes);
    await writeFile(firstPath, Buffer.alloc(MAX_CALIBRATION_FILE_BYTES + 64, 0x20));
    const servers = await executionServers(fixture);
    try {
      const report = await runCalibrationSuiteRelease(fixture.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
      });
      expect(report).toMatchObject({
        decisionPrecedence: 'required_integrity_failure',
        candidateAssessment: { status: 'not_started' },
      });
      expect(report.criteria[0]?.artifactEvidence).toMatchObject({
        disposition: 'rejected',
        reason: 'artifact_digest_mismatch',
      });
      expect(servers.candidateCalls).toBe(0);
      expect(servers.providerSubmissions).toBe(0);
    } finally {
      close(servers.candidateServer);
      close(servers.rubristServer);
    }
  });

  it('stops on future incomplete evidence but proceeds for nonfuture incomplete evidence', async () => {
    const nonfuture = await preflightFixture();
    const nonfutureMember = nonfuture.manifest.members[0]!;
    const incomplete = await calibrationForMember(
      nonfuture.manifest,
      nonfutureMember,
      'incomplete',
    );
    const nonfutureSource = nonfuture.config.calibrationEvidence[0]!.source!;
    nonfutureSource.artifactDigest = binaryCalibrationArtifactByteDigest(incomplete.bytes);
    nonfutureSource.expectedIdentity = expectedBinaryCalibrationIdentity(incomplete.artifact);
    nonfuture.calibrationBytes.set(nonfutureSource.path, incomplete.bytes);
    const nonfutureServers = await executionServers(nonfuture);
    try {
      const report = await runCalibrationSuiteRelease(nonfuture.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => nonfuture.calibrationBytes.get(path)!,
      });
      expect(report.criteria[0]?.calibrationPolicy).toMatchObject({
        status: 'incomplete',
        worstReason: 'artifact_incomplete',
      });
      expect(report.candidateAssessment.status).toBe('completed');
      expect(nonfutureServers.candidateCalls).toBe(1);
      expect(nonfutureServers.providerSubmissions).toBe(2);
    } finally {
      close(nonfutureServers.candidateServer);
      close(nonfutureServers.rubristServer);
    }

    const future = await preflightFixture();
    const futureMember = future.manifest.members[0]!;
    const futureCalibration = await calibrationForMember(
      future.manifest,
      futureMember,
      'incomplete',
    );
    const futureArtifact = structuredClone(futureCalibration.artifact);
    futureArtifact.exposure.authorization.recordedAt = '2026-08-24T12:00:00.000Z';
    futureArtifact.startedAt = '2026-08-24T12:00:01.000Z';
    futureArtifact.completedAt = '2026-08-24T12:00:02.000Z';
    futureArtifact.exposure.completion.recordedAt = '2026-08-24T12:00:03.000Z';
    futureArtifact.createdAt = '2026-08-24T12:00:04.000Z';
    futureArtifact.evidenceDigest = binaryCalibrationEvidenceDigest(futureArtifact);
    const futureBytes = Buffer.from(canonicalJson(futureArtifact));
    const verifiedFutureArtifact = parseCanonicalBinaryCalibrationBytes(futureBytes);
    const futureSource = future.config.calibrationEvidence[0]!.source!;
    futureSource.artifactDigest = binaryCalibrationArtifactByteDigest(futureBytes);
    futureSource.expectedIdentity = expectedBinaryCalibrationIdentity(verifiedFutureArtifact);
    future.calibrationBytes.set(futureSource.path, futureBytes);
    const futureServers = await executionServers(future);
    try {
      const report = await runCalibrationSuiteRelease(future.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => future.calibrationBytes.get(path)!,
      });
      expect(report).toMatchObject({
        decision: 'inconclusive',
        decisionPrecedence: 'required_integrity_failure',
        candidateAssessment: { status: 'not_started' },
      });
      expect(report.criteria[0]?.calibrationPolicy).toMatchObject({
        status: 'integrity_failure',
        worstReason: 'artifact_completed_after_evaluated_at',
      });
      expect(futureServers.candidateCalls).toBe(0);
      expect(futureServers.providerSubmissions).toBe(0);
    } finally {
      close(futureServers.candidateServer);
      close(futureServers.rubristServer);
    }
  });

  it('evaluates every repeated trial without pooling', async () => {
    const fixture = await preflightFixture();
    const member = fixture.manifest.members[0]!;
    const repeated = await calibrationForMember(fixture.manifest, member, 'repeated');
    const source = fixture.config.calibrationEvidence[0]!.source!;
    source.artifactDigest = binaryCalibrationArtifactByteDigest(repeated.bytes);
    source.expectedIdentity = expectedBinaryCalibrationIdentity(repeated.artifact);
    fixture.calibrationBytes.set(source.path, repeated.bytes);
    fixture.config.policy.criteria[0]!.calibrationRequirement!.trialRule.minimumTrials = 2;
    fixture.config.policy.criteria[0]!.calibrationRequirement!.metricChecks[0] = {
      metric: 'accuracy',
      minimumDenominator: 1,
      minimumPointEstimate: '0.5',
      minimumWilsonLowerBound: null,
    };
    const servers = await executionServers(fixture);
    try {
      const report = await runCalibrationSuiteRelease(fixture.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => fixture.calibrationBytes.get(path)!,
      });
      expect(report.criteria[0]?.calibrationPolicy.trials.map((trial) => ({
        trialIndex: trial.trialIndex,
        passed: trial.passed,
      }))).toEqual([
        { trialIndex: 0, passed: true },
        { trialIndex: 1, passed: false },
      ]);
      expect(report.decision).toBe('inconclusive');
    } finally {
      close(servers.candidateServer);
      close(servers.rubristServer);
    }
  });

  it('stops on future evidence but runs with stale evidence as typed insufficiency', async () => {
    const future = await preflightFixture();
    const futureServers = await executionServers(future);
    try {
      const report = await runCalibrationSuiteRelease(future.config, {
        now: () => new Date('2026-08-22T11:59:00.000Z'),
        readCalibrationBytes: async (path) => future.calibrationBytes.get(path)!,
      });
      expect(report.candidateAssessment.status).toBe('not_started');
      expect(report.criteria[0]?.calibrationPolicy).toMatchObject({
        status: 'integrity_failure',
        worstReason: 'artifact_completed_after_evaluated_at',
      });
      expect(futureServers.candidateCalls).toBe(0);
      expect(futureServers.providerSubmissions).toBe(0);
    } finally {
      close(futureServers.candidateServer);
      close(futureServers.rubristServer);
    }

    const stale = await preflightFixture();
    stale.config.policy.criteria.forEach((entry) => {
      entry.calibrationRequirement!.maximumAgeSeconds = 1;
    });
    const staleServers = await executionServers(stale);
    try {
      const report = await runCalibrationSuiteRelease(stale.config, {
        now: () => new Date('2026-08-23T12:01:00.000Z'),
        readCalibrationBytes: async (path) => stale.calibrationBytes.get(path)!,
      });
      expect(report.candidateAssessment.status).toBe('completed');
      expect(report.criteria[0]?.calibrationPolicy).toMatchObject({
        status: 'insufficient',
        worstReason: 'artifact_too_old',
      });
      expect(staleServers.candidateCalls).toBe(1);
      expect(staleServers.providerSubmissions).toBe(2);
    } finally {
      close(staleServers.candidateServer);
      close(staleServers.rubristServer);
    }
  });

  it.each([
    ['promote', 0, [] as number[], false],
    ['block', 1, [1], true],
    ['inconclusive', 2, [] as number[], true],
  ] as const)('dispatches v6 CLI %s with aligned report and exit code', async (
    decision,
    code,
    failingPositions,
    omitFirstCalibration,
  ) => {
    const fixture = await preflightFixture();
    if (omitFirstCalibration) fixture.config.calibrationEvidence[0]!.source = null;
    if (decision === 'inconclusive') {
      fixture.config.policy.criteria[1]!.calibrationRequirement!.minimumClassifiedCoverage.overall = '1';
    }
    retimeCalibrationFilesForCli(fixture);
    for (const [path, bytes] of fixture.calibrationBytes) await writeFile(path, bytes);
    const servers = await executionServers(fixture, [...failingPositions]);
    const configPath = join(fixture.dir, `dailies-v6-${decision}.json`);
    await writeFile(configPath, JSON.stringify(fixture.config));
    try {
      const cli = await runCli(configPath);
      const report = parseCanonicalCalibrationReportV6Bytes(await readFile(
        join(fixture.config.output.dir, 'report.json'),
      ));
      expect(cli.code, cli.stderr).toBe(code);
      expect(cli.stdout).toContain(`decision: ${decision}`);
      expect(report.decision).toBe(decision);
      if (decision === 'inconclusive') {
        expect(cli.stderr).toContain('mandatory_evidence_incomplete');
      } else {
        expect(cli.stderr).not.toContain('dailies inconclusive:');
      }
      expect(await readFile(join(fixture.config.output.dir, 'report.md'), 'utf8'))
        .toContain(`# Calibration-aware criterion release report: ${decision.toUpperCase()}`);
    } finally {
      close(servers.candidateServer);
      close(servers.rubristServer);
    }
  });
});
