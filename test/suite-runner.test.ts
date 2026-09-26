import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest } from '../src/rubrist.js';
import { parseSuiteConfig } from '../src/config-v5.js';
import {
  aggregateCriterionItems,
  candidateExecutionIdentity,
  providerExecutionIdentity,
  renderSuiteMarkdown,
  reportV5Schema,
} from '../src/report-v5.js';
import { parseReportForInspection } from '../src/report.js';
import { runSuiteRelease } from '../src/suite-runner.js';
import {
  evaluatorSuiteManifestV2Digest,
  verifyEvaluatorSuiteManifestV2,
  type EvaluatorSuiteManifestV2,
} from '../src/suite-manifest-v2.js';
import { evaluatorIdentityFor, otherEvaluatorIdentity, receiptV2, type ReceiptItemInput } from './rubrist-v2-support.js';
import { sha256Bytes } from './v4-fixture.js';

type MemberMode = 'complete' | 'incomplete' | 'binding-tamper' | 'pending' | 'abstain';

interface SubmittedItem {
  clientItemId: string;
  input: string;
  output: string;
}

interface Submission {
  skillVersionId: string;
  items: SubmittedItem[];
}

const tempDirs: string[] = [];
const cliPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'cli.js');

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

function receipt(
  manifest: EvaluatorSuiteManifestV2,
  submission: Submission,
  mode: MemberMode,
): Record<string, unknown> {
  const member = manifest.members.find((entry) => entry.skillVersionId === submission.skillVersionId)!;
  const sorted = [...submission.items].sort((a, b) =>
    a.clientItemId < b.clientItemId ? -1 : a.clientItemId > b.clientItemId ? 1 : 0);
  const items: ReceiptItemInput[] = sorted.map((item) => ({
    clientItemId: item.clientItemId,
    caseId: `case-${member.position}-${item.clientItemId}`,
    input: item.input,
    output: item.output,
    result: {
      state: 'outcome',
      outcome: mode === 'abstain'
        ? 'abstain'
        : member.position === 1 && item.clientItemId.includes('unsafe') ? 'fail' : 'pass',
    },
  }));
  if (mode === 'incomplete') {
    items[items.length - 1] = { ...items.at(-1)!, result: { state: 'failure', failureKind: 'provider_timeout' } };
  }
  const evaluator = evaluatorIdentityFor(member);
  return receiptV2({
    evalRunId: `run-${submission.skillVersionId}`,
    projectId: manifest.projectId,
    skillId: member.skillId,
    skillVersionId: member.skillVersionId,
    // A digest-valid receipt from another evaluator fails only the manifest binding.
    evaluator: mode === 'binding-tamper' ? otherEvaluatorIdentity(evaluator) : evaluator,
    items,
    runStatus: mode === 'incomplete' ? 'failed' : 'completed',
  });
}

async function mockRubrist(
  manifest: EvaluatorSuiteManifestV2,
  modes: Record<string, MemberMode> = {},
): Promise<{ server: Server; url: string; submissions: Submission[]; readonly maxSubmitInFlight: number }> {
  const submissions: Submission[] = [];
  const byRun = new Map<string, Submission>();
  let inFlightSubmits = 0;
  let maxSubmitInFlight = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/judge/batch') {
      inFlightSubmits += 1;
      maxSubmitInFlight = Math.max(maxSubmitInFlight, inFlightSubmits);
      const body = JSON.parse(await readBody(req)) as Submission & { purpose: string };
      submissions.push(body);
      const runId = `run-${body.skillVersionId}`;
      byRun.set(runId, body);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlightSubmits -= 1;
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
      const submission = byRun.get(poll[1]!);
      if (!submission) throw new Error('missing submission');
      const mode = modes[submission.skillVersionId] ?? 'complete';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: poll[1],
        status: mode === 'pending' ? 'running' : mode === 'incomplete' ? 'failed' : 'completed',
      }));
      return;
    }
    const receiptPath = req.url?.match(
      /^\/api\/v1\/eval-runs\/(run-[^/]+)\/assessment-receipt$/,
    );
    if (req.method === 'GET' && receiptPath) {
      const submission = byRun.get(receiptPath[1]!);
      if (!submission) throw new Error('missing submission');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(
        receipt(manifest, submission, modes[submission.skillVersionId] ?? 'complete'),
      ));
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    submissions,
    get maxSubmitInFlight() { return maxSubmitInFlight; },
  };
}

async function fixture(
  consequences: ['blocking' | 'advisory', 'blocking' | 'advisory'] = ['blocking', 'blocking'],
  modes: Record<string, MemberMode> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-suite-'));
  tempDirs.push(dir);
  const manifest = verifyEvaluatorSuiteManifestV2(JSON.parse(await readFile(
    new URL('../contracts/fixtures/evaluator-suite-manifest-v2.complete.json', import.meta.url),
    'utf8',
  )) as EvaluatorSuiteManifestV2);
  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, canonicalJson(manifest), 'utf8');
  const inputBytes = [
    JSON.stringify({
      id: 'safe',
      input: 'safe',
      baseline_labels: Object.fromEntries(manifest.members.map((member) => [member.criterionVersionId, 'pass'])),
    }),
    JSON.stringify({
      id: 'unsafe',
      input: 'unsafe',
      baseline_labels: Object.fromEntries(manifest.members.map((member) => [member.criterionVersionId, 'pass'])),
    }),
  ].join('\n') + '\n';
  const inputPath = join(dir, 'inputs.jsonl');
  await writeFile(inputPath, inputBytes, 'utf8');
  let candidateCalls = 0;
  const candidateServer = createServer(async (req, res) => {
    candidateCalls += 1;
    const body = JSON.parse(await readBody(req)) as { input: string };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      output: body.input,
    }));
  });
  const candidatePort = await listen(candidateServer);
  const rubrist = await mockRubrist(manifest, modes);
  const config = parseSuiteConfig({
    schemaVersion: 5,
    inputs: { type: 'jsonl', path: inputPath, digest: sha256Bytes(inputBytes) },
    scope: {
      id: 'support-suite',
      kind: 'regression_corpus',
      expectedItems: 2,
      collectionProcedure: 'Pinned suite test inputs.',
      population: 'The suite integration fixture.',
      timeWindow: { kind: 'not_applicable', reason: 'Static fixture.' },
    },
    candidate: {
      type: 'http',
      url: `http://127.0.0.1:${candidatePort}/candidate`,
      bodyTemplate: '{"input": {input}}',
    },
    suite: {
      manifest: {
        type: 'file',
        path: manifestPath,
        manifestId: manifest.manifestId,
        manifestDigest: manifest.manifestDigest,
      },
      provider: {
        type: 'rubrist',
        url: rubrist.url,
        pollIntervalMs: 1,
        evidenceDeadlineMs: 1_000,
      },
    },
    policy: {
      schemaVersion: 1,
      id: 'suite-policy',
      version: '1',
      manifestId: manifest.manifestId,
      manifestDigest: manifest.manifestDigest,
      criteria: manifest.members.map((member, index) => ({
        criterionVersionId: member.criterionVersionId,
        evidenceRequirement: 'mandatory',
        consequence: consequences[index],
        rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
      })),
      compensationGroups: [],
    },
    concurrency: 2,
    timeoutMs: 1_000,
    output: { dir: join(dir, 'out') },
  });
  return {
    config,
    manifest,
    rubrist,
    candidateServer,
    get candidateCalls() { return candidateCalls; },
  };
}

function close(server: Server): void {
  server.closeAllConnections();
  server.close();
}

function runCli(configPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, '--config', configPath], { timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
      });
  });
}

describe('criterion suite runner', () => {
  it('rejects a valid repeated-trial manifest before candidate or provider calls', async () => {
    const test = await fixture();
    const repeated = structuredClone(test.manifest);
    repeated.trialPlan = { kind: 'independent_repetitions', trialsPerItem: 3 };
    repeated.manifestDigest = evaluatorSuiteManifestV2Digest(repeated);
    await writeFile(test.config.suite.manifest.path, canonicalJson(repeated), 'utf8');
    test.config.suite.manifest.manifestDigest = repeated.manifestDigest;
    test.config.policy.manifestDigest = repeated.manifestDigest;
    try {
      await expect(runSuiteRelease(test.config)).rejects.toThrow(/unsupported by Dailies v5/);
      expect(test.candidateCalls).toBe(0);
      expect(test.rubrist.submissions).toHaveLength(0);
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('dispatches v5 through the CLI and keeps report/exit-code agreement', async () => {
    const test = await fixture(['blocking', 'advisory']);
    const configPath = join(dirname(test.config.inputs.path), 'dailies-v5.json');
    await writeFile(configPath, JSON.stringify(test.config), 'utf8');
    try {
      const cli = await runCli(configPath);
      const report = reportV5Schema.parse(JSON.parse(await readFile(
        join(test.config.output.dir, 'report.json'),
        'utf8',
      )));
      expect(cli.code).toBe(0);
      expect(cli.stdout).toContain('decision: promote | criteria 2');
      expect(report.decision).toBe('promote');
      expect(await readFile(join(test.config.output.dir, 'report.md'), 'utf8'))
        .toContain('# Criterion release report: PROMOTE');
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it.each([
    ['block', 1, ['blocking', 'blocking'] as const, {}],
    [
      'inconclusive',
      2,
      ['advisory', 'blocking'] as const,
      { skillv_safety_1: 'binding-tamper' as const },
    ],
  ] as const)('keeps CLI %s report and exit code aligned', async (
    expectedDecision,
    expectedCode,
    consequences,
    modes,
  ) => {
    const test = await fixture([...consequences], modes);
    const configPath = join(dirname(test.config.inputs.path), `dailies-v5-${expectedDecision}.json`);
    await writeFile(configPath, JSON.stringify(test.config), 'utf8');
    try {
      const cli = await runCli(configPath);
      const report = reportV5Schema.parse(JSON.parse(await readFile(
        join(test.config.output.dir, 'report.json'),
        'utf8',
      )));
      expect(cli.code).toBe(expectedCode);
      expect(report.decision).toBe(expectedDecision);
      expect(cli.stdout).toContain(`decision: ${expectedDecision}`);
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('counts an abstaining criterion as not passing and binds every abstention to its receipt (ADR-0009)', async () => {
    const test = await fixture(['blocking', 'advisory'], { skillv_safety_1: 'abstain' });
    try {
      const report = await runSuiteRelease(test.config, {
        now: () => new Date('2026-08-22T12:00:00.000Z'),
      });
      const criterion = report.criteria[0]!;
      expect(criterion.items.map((item) => [item.assessedLabel, item.comparison])).toEqual([
        ['abstain', 'regression'],
        ['abstain', 'regression'],
      ]);
      expect(criterion.totals).toMatchObject({ evaluated: 2, passed: 0, failed: 2, abstained: 2, passRate: 0, regressions: 2 });
      expect(report.decision).toBe('block');
      expect(reportV5Schema.safeParse(report).success).toBe(true);
      expect(renderSuiteMarkdown(report)).toContain('Abstained (counted as not passing): 2');

      const relabel = (label: 'pass' | 'fail') => (candidate: Record<string, any>) => {
        const tampered = candidate.criteria[0];
        tampered.items = tampered.items.map((item: Record<string, any>) => ({
          ...item,
          assessedLabel: label,
          comparison: label === 'pass' ? 'stable_pass' : 'regression',
          regression: label !== 'pass',
        }));
        tampered.totals = aggregateCriterionItems(tampered.items);
      };
      const mutations: Array<[string, (candidate: Record<string, any>) => void]> = [
        ['abstentions relabeled as fails', relabel('fail')],
        ['abstentions relabeled as passes', relabel('pass')],
        ['abstained count zeroed', (candidate) => { candidate.criteria[0].totals.abstained = 0; }],
        ['abstention left unpaired', (candidate) => {
          candidate.criteria[0].items[0].comparison = 'unpaired';
          candidate.criteria[0].items[0].regression = false;
          candidate.criteria[0].totals = aggregateCriterionItems(candidate.criteria[0].items);
        }],
      ];
      for (const [name, mutate] of mutations) {
        const candidate = structuredClone(report) as Record<string, any>;
        mutate(candidate);
        expect(reportV5Schema.safeParse(candidate).success, name).toBe(false);
      }
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('executes each candidate once and verifies separate receipts in manifest order', async () => {
    const test = await fixture(['blocking', 'advisory']);
    try {
      const report = await runSuiteRelease(test.config, {
        now: () => new Date('2026-08-22T12:00:00.000Z'),
      });
      expect(test.candidateCalls).toBe(2);
      expect(test.rubrist.submissions).toHaveLength(2);
      expect(test.rubrist.maxSubmitInFlight).toBeGreaterThan(1);
      expect(new Set(test.rubrist.submissions.map((entry) => entry.skillVersionId))).toEqual(
        new Set(test.manifest.members.map((member) => member.skillVersionId)),
      );
      expect(report).toMatchObject({
        schemaVersion: 5,
        decision: 'promote',
        decisionPrecedence: 'policy_satisfied',
        candidateExecution: { total: 2, succeeded: 2, failed: 0 },
        executionPolicy: {
          scheduling: 'manifest_order_bounded_pool/v1',
          deadlineStartsAt: 'after_candidate_execution',
          evidenceDeadlineMs: 1_000,
          pollIntervalMs: 1,
          perCallTimeoutMs: 1_000,
          concurrency: 2,
        },
      });
      expect(report.criteria.map((entry) => entry.criterionVersionId)).toEqual(
        test.manifest.members.map((member) => member.criterionVersionId),
      );
      expect(report.criteria[1]).toMatchObject({
        totals: { passed: 1, failed: 1, regressions: 1 },
        policyResult: { consequence: 'advisory', rulePassed: false },
      });
      expect(reportV5Schema.safeParse(report).success).toBe(true);
      expect(parseReportForInspection(report)).toMatchObject({
        schemaVersion: 5,
      });

      const mutations: Array<[string, (candidate: Record<string, any>) => void]> = [
        ['manifest digest', (candidate) => { candidate.manifest.manifestDigest = `sha256:${'0'.repeat(64)}`; }],
        ['policy digest', (candidate) => { candidate.policyDigest = `sha256:${'0'.repeat(64)}`; }],
        ['execution policy', (candidate) => { candidate.executionPolicy.concurrency = 1; }],
        ['candidate dataset', (candidate) => { candidate.candidateDatasetDigest = `sha256:${'0'.repeat(64)}`; }],
        ['scope identity', (candidate) => { candidate.criteria[0].scope.id = 'other-scope'; }],
        ['unknown baseline label', (candidate) => { candidate.candidateExecution.items[0].baseline_labels.unknown = 'pass'; }],
        ['trust', (candidate) => { candidate.criteria[0].trust.admissible = false; }],
        ['criterion totals', (candidate) => { candidate.criteria[0].totals.passed = 0; }],
        ['receipt skill digest', (candidate) => { candidate.criteria[0].evidence.receipt.skillDigest = `sha256:${'1'.repeat(64)}`; }],
        ['policy result', (candidate) => { candidate.criteria[1].policyResult.rulePassed = true; }],
        ['decision', (candidate) => { candidate.decision = 'block'; }],
        ['decision statement', (candidate) => { candidate.decisionStatement = 'unscoped promote'; }],
        ['receipt reuse', (candidate) => { candidate.criteria[1].evidence.receipt.receiptId = candidate.criteria[0].evidence.receipt.receiptId; }],
      ];
      for (const [name, mutate] of mutations) {
        const tampered = structuredClone(report) as unknown as Record<string, any>;
        mutate(tampered);
        expect(reportV5Schema.safeParse(tampered).success, name).toBe(false);
      }
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('lets a complete blocking failure outrank a different digest-valid incomplete receipt', async () => {
    const base = await fixture();
    close(base.candidateServer);
    close(base.rubrist.server);
    const incompleteSkill = base.manifest.members[0]!.skillVersionId;
    const test = await fixture(['advisory', 'blocking'], { [incompleteSkill]: 'incomplete' });
    try {
      const report = await runSuiteRelease(test.config);
      expect(report).toMatchObject({
        decision: 'block',
        decisionPrecedence: 'complete_blocking_failure',
      });
      expect(report.criteria[0]?.evidence.state).toBe('incomplete');
      expect(report.criteria[1]?.policyResult.rulePassed).toBe(false);
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('makes required receipt-binding corruption inconclusive even alongside a block', async () => {
    const base = await fixture();
    close(base.candidateServer);
    close(base.rubrist.server);
    const tamperedSkill = base.manifest.members[0]!.skillVersionId;
    const test = await fixture(['advisory', 'blocking'], { [tamperedSkill]: 'binding-tamper' });
    try {
      const report = await runSuiteRelease(test.config);
      expect(report).toMatchObject({
        decision: 'inconclusive',
        decisionPrecedence: 'required_integrity_failure',
      });
      expect(report.criteria[0]).toMatchObject({
        evidence: {
          state: 'integrity_failure',
          rejection: { kind: 'manifest_binding' },
        },
        trust: { status: 'unavailable', admissible: false },
      });
      expect(report.criteria[0]?.evidence.rejectedReceipt).toBeDefined();
      expect(renderSuiteMarkdown(report)).toContain('Rejected artifact: manifest_binding');

      const missingArtifact = structuredClone(report) as unknown as Record<string, any>;
      delete missingArtifact.criteria[0].evidence.rejectedReceipt;
      delete missingArtifact.criteria[0].evidence.rejection;
      expect(reportV5Schema.safeParse(missingArtifact).success).toBe(false);

      const zeroRequest = structuredClone(report) as unknown as Record<string, any>;
      zeroRequest.criteria[0].evidence.operations = [];
      delete zeroRequest.criteria[0].evidence.evalRunId;
      delete zeroRequest.criteria[0].evidence.rejectedReceipt;
      delete zeroRequest.criteria[0].evidence.rejection;
      zeroRequest.criteria[0].evidence.zeroRequestTermination = {
        phase: 'evidence_submission',
        reason: 'shared_evidence_deadline_elapsed',
      };
      expect(reportV5Schema.safeParse(zeroRequest).success).toBe(true);
      delete zeroRequest.criteria[0].evidence.zeroRequestTermination;
      expect(reportV5Schema.safeParse(zeroRequest).success).toBe(false);
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('records row-2 candidate failure once and applies candidate-failure precedence', async () => {
    const test = await fixture(['blocking', 'advisory']);
    test.config.candidate = {
      type: 'command',
      template: 'if [ {input} = unsafe ]; then exit 3; else printf %s {input}; fi',
    };
    try {
      const report = await runSuiteRelease(test.config);
      expect(report).toMatchObject({
        decision: 'block',
        decisionPrecedence: 'candidate_execution_failure',
        candidateExecution: { total: 2, succeeded: 1, failed: 1 },
      });
      expect(report.candidateExecution.items[1]).toMatchObject({
        id: 'unsafe',
        status: 'error',
        errorKind: 'execution',
      });
      expect(test.rubrist.submissions.every((submission) => submission.items.length === 1)).toBe(true);
      expect(reportV5Schema.safeParse(report).success).toBe(true);
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('makes a shared-deadline poll timeout a reproducible integrity failure', async () => {
    const base = await fixture();
    close(base.candidateServer);
    close(base.rubrist.server);
    const pendingSkill = base.manifest.members[0]!.skillVersionId;
    const test = await fixture(['advisory', 'advisory'], { [pendingSkill]: 'pending' });
    test.config.suite.provider.evidenceDeadlineMs = 200;
    test.config.suite.provider.pollIntervalMs = 5;
    try {
      const report = await runSuiteRelease(test.config);
      expect(report).toMatchObject({
        decision: 'inconclusive',
        decisionPrecedence: 'required_integrity_failure',
      });
      expect(report.criteria[0]?.evidence).toMatchObject({
        state: 'integrity_failure',
      });
      expect(report.criteria[0]?.evidence.error).toMatch(/timed out|timeout|deadline/i);
      expect(report.criteria[0]?.evidence.operations.some((operation) =>
        operation.termination !== undefined || operation.attempts.at(-1)?.outcome === 'error')).toBe(true);
      expect(reportV5Schema.safeParse(report).success).toBe(true);
      expect(renderSuiteMarkdown(report)).toContain('Evidence reason:');
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('treats verified-but-excluded trust as mandatory evidence incompleteness', async () => {
    const test = await fixture(['advisory', 'advisory']);
    test.config.trustPolicy = { admissibleClasses: ['deterministic'] };
    try {
      const report = await runSuiteRelease(test.config);
      expect(report).toMatchObject({
        decision: 'inconclusive',
        decisionPrecedence: 'mandatory_evidence_incomplete',
      });
      expect(report.criteria.every((criterion) =>
        criterion.trust.status === 'complete' && !criterion.trust.admissible)).toBe(true);
      expect(renderSuiteMarkdown(report)).toContain('verified (not admissible)');
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('allows optional advisory incompleteness without changing a satisfied decision', async () => {
    const base = await fixture();
    close(base.candidateServer);
    close(base.rubrist.server);
    const incompleteSkill = base.manifest.members[0]!.skillVersionId;
    const test = await fixture(['advisory', 'advisory'], { [incompleteSkill]: 'incomplete' });
    test.config.policy.criteria[0]!.evidenceRequirement = 'optional';
    try {
      const report = await runSuiteRelease(test.config);
      expect(report).toMatchObject({ decision: 'promote', decisionPrecedence: 'policy_satisfied' });
      expect(report.criteria[0]).toMatchObject({
        evidence: { state: 'incomplete' },
        policyResult: { evidenceRequirement: 'optional', consequence: 'advisory' },
      });
      expect(renderSuiteMarkdown(report)).toContain('unavailable (incomplete_evidence)');
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('executes compensatory policy end to end with no dead per-criterion threshold', async () => {
    const test = await fixture(['advisory', 'advisory']);
    test.config.policy.criteria = test.manifest.members.map((member) => ({
      criterionVersionId: member.criterionVersionId,
      evidenceRequirement: 'mandatory' as const,
      consequence: 'compensatory' as const,
      compensationGroupId: 'quality',
      rule: { kind: 'pass_rate_operand/v1' as const, unit: 'pass_rate_ratio' as const },
    }));
    test.config.policy.compensationGroups = [{
      id: 'quality',
      formula: {
        contract: 'dailies/weighted-pass-rate/v1',
        unit: 'pass_rate_ratio',
        minimumPassRate: 0.8,
        terms: test.manifest.members.map((member, index) => ({
          criterionVersionId: member.criterionVersionId,
          weightBasisPoints: index === 0 ? 6_000 : 4_000,
        })),
      },
    }];
    try {
      const promoted = await runSuiteRelease(test.config);
      expect(promoted).toMatchObject({
        decision: 'promote',
        compensation: [{
          weightedPassRate: 0.8,
          passed: true,
          exactComparison: {
            weightedNumerator: '4',
            weightedDenominator: '5',
            minimumNumerator: '4',
            minimumDenominator: '5',
          },
        }],
      });
      expect(promoted.criteria.every((criterion) => criterion.policyResult.rulePassed === null)).toBe(true);
      expect(renderSuiteMarkdown(promoted)).toContain('Exact comparison: 4/5 vs 4/5');
      const hiddenThreshold = structuredClone(promoted) as unknown as Record<string, any>;
      hiddenThreshold.policy.criteria[0].rule.minPassRate = 0.5;
      expect(reportV5Schema.safeParse(hiddenThreshold).success).toBe(false);
      const roundedDecision = structuredClone(promoted) as unknown as Record<string, any>;
      roundedDecision.compensation[0].exactComparison.weightedNumerator = '7999';
      expect(reportV5Schema.safeParse(roundedDecision).success).toBe(false);
      test.config.policy.compensationGroups[0]!.formula.minimumPassRate = 0.81;
      const blocked = await runSuiteRelease(test.config);
      expect(blocked).toMatchObject({ decision: 'block', decisionPrecedence: 'compensation_failure' });
      expect(reportV5Schema.safeParse(blocked).success).toBe(true);
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('keeps semantic report bytes deterministic across concurrency while auditing the configured value', async () => {
    const test = await fixture(['blocking', 'advisory']);
    const fixed = { now: () => new Date('2026-08-22T12:00:00.000Z') };
    try {
      test.config.concurrency = 1;
      const serial = await runSuiteRelease(test.config, fixed);
      test.config.concurrency = 2;
      const parallel = await runSuiteRelease(test.config, fixed);
      expect(serial.executionPolicy.concurrency).toBe(1);
      expect(parallel.executionPolicy.concurrency).toBe(2);
      expect(canonicalJson(serial)).not.toBe(canonicalJson(parallel));
      const serialSemantics = structuredClone(serial) as unknown as Record<string, unknown>;
      const parallelSemantics = structuredClone(parallel) as unknown as Record<string, unknown>;
      delete serialSemantics.executionPolicy;
      delete serialSemantics.executionPolicyDigest;
      delete parallelSemantics.executionPolicy;
      delete parallelSemantics.executionPolicyDigest;
      expect(canonicalJson(serialSemantics)).toBe(canonicalJson(parallelSemantics));
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });

  it('redacts credential values from execution identity while retaining operational identity changes', async () => {
    const test = await fixture(['blocking', 'advisory']);
    test.config.suite.provider.headers = {
      Authorization: 'provider-secret-one',
      'X-Tenant': 'tenant-secret-one',
    };
    if (test.config.candidate.type !== 'http') throw new Error('wrong fixture');
    test.config.candidate.headers = {
      Authorization: 'candidate-secret-one',
      'X-Candidate': 'candidate-tenant-one',
    };
    try {
      const first = await runSuiteRelease(test.config);
      const serialized = canonicalJson(first);
      expect(serialized).not.toContain('provider-secret-one');
      expect(serialized).not.toContain('tenant-secret-one');
      expect(serialized).not.toContain('candidate-secret-one');
      expect(serialized).not.toContain('candidate-tenant-one');
      expect(first.executionPolicy.provider.headerNames).toEqual(['authorization', 'x-tenant']);
      expect(first.executionPolicy.candidate).toMatchObject({
        type: 'http',
        headerNames: ['authorization', 'x-candidate'],
      });

      test.config.suite.provider.headers.Authorization = 'provider-secret-two';
      test.config.suite.provider.headers['X-Tenant'] = 'tenant-secret-two';
      test.config.candidate.headers.Authorization = 'candidate-secret-two';
      test.config.candidate.headers['X-Candidate'] = 'candidate-tenant-two';
      const second = await runSuiteRelease(test.config);
      expect(second.executionPolicy.provider.identityDigest)
        .toBe(first.executionPolicy.provider.identityDigest);
      expect(second.executionPolicy.candidate.identityDigest)
        .toBe(first.executionPolicy.candidate.identityDigest);
      expect(second.executionPolicyDigest).toBe(first.executionPolicyDigest);

      expect(providerExecutionIdentity({
        type: 'rubrist',
        url: test.config.suite.provider.url,
        headers: { 'X-Other': 'irrelevant' },
      }).identityDigest).not.toBe(first.executionPolicy.provider.identityDigest);
      expect(providerExecutionIdentity({
        type: 'rubrist',
        url: `${test.config.suite.provider.url}/other`,
        headers: test.config.suite.provider.headers,
      }).identityDigest).not.toBe(first.executionPolicy.provider.identityDigest);

      const command = candidateExecutionIdentity({
        type: 'command',
        template: 'candidate-a {input}',
      });
      expect(candidateExecutionIdentity({
        type: 'command',
        template: 'candidate-b {input}',
      }).identityDigest).not.toBe(command.identityDigest);
      expect(candidateExecutionIdentity({
        type: 'http',
        url: `${test.config.candidate.url}/other`,
        headers: test.config.candidate.headers,
      }).identityDigest).not.toBe(first.executionPolicy.candidate.identityDigest);
      expect(candidateExecutionIdentity({
        type: 'http',
        url: test.config.candidate.url,
        headers: { 'X-Other': 'irrelevant' },
      }).identityDigest).not.toBe(first.executionPolicy.candidate.identityDigest);
    } finally {
      close(test.candidateServer);
      close(test.rubrist.server);
    }
  });
});
