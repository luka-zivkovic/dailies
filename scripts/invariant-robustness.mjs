import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTHORED_INVARIANT_SCENARIO_CONTRACT,
  applyReleasePolicy,
  applyReleasePolicyV2,
  authoredInvariantEnvironment,
  authoredInvariantScenarioSchema,
  buildAuthoredInvariantRun,
  calibrationPolicyResultSchema,
  canonicalJson,
  classifyAuthoredInvariantThrownError,
  classifyV4InvariantReport,
  classifyV5InvariantDecision,
  classifyV6InvariantDecision,
  evaluateAuthoredInvariantOutcome,
  reportSchema,
  releasePolicyV1Schema,
  releasePolicyV2Schema,
  runShadow,
  verifyAuthoredInvariantRun,
} from '../dist/index.js';

const FIXED_TIME = '2026-08-23T12:00:00.000Z';
const REPEATS = 2;
const DIGEST = `sha256:${'1'.repeat(64)}`;
const FAULT_TIMEOUT_MS = 250;
const CLI_TIMEOUT_MS = 10_000;

const proxyEnvironmentNames = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);
let proxyVariablesRemoved = 0;
let credentialVariablesRemoved = 0;
for (const name of Object.keys(process.env)) {
  if (proxyEnvironmentNames.has(name)) {
    delete process.env[name];
    proxyVariablesRemoved += 1;
  } else if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(name)) {
    delete process.env[name];
    credentialVariablesRemoved += 1;
  }
}
const harnessCacheDirectory = await mkdtemp(join(tmpdir(), 'dailies-authored-cache-'));
process.env.XDG_CACHE_HOME = harnessCacheDirectory;
process.env.TZ = 'UTC';
process.env.LANG = 'C';
process.env.LC_ALL = 'C';
process.on('exit', () => rmSync(harnessCacheDirectory, { recursive: true, force: true }));
let validatedLoopbackEndpoints = 0;

function validatedLoopbackUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`authored invariant endpoint must be loopback HTTP(S): ${raw}`);
  }
  validatedLoopbackEndpoints += 1;
  return raw;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exitCode(decision) {
  return decision === 'promote' ? 0 : decision === 'block' ? 1 : 2;
}

function scenario({
  id,
  family,
  seam,
  description,
  expectation,
  rationale,
  terminal = 'report',
  decision,
  precedence = null,
  calls = { candidate: 0, evidenceProvider: 0 },
  evidenceState,
  observationClass,
  errorKind = null,
  repeatCount = REPEATS,
  expectedProcessSignal = null,
  minimumMaxInFlight = 0,
  requireDistinctCompletionOrders = false,
}) {
  const emitsFullReport = seam === 'v4_runner' || seam === 'v4_cli';
  return authoredInvariantScenarioSchema.parse({
    contract: AUTHORED_INVARIANT_SCENARIO_CONTRACT,
    schemaVersion: 1,
    evidenceClass: 'authored_correctness_only',
    comparativeClaim: 'forbidden',
    id,
    family,
    description,
    seam,
    repeatCount,
    safetyOracle: { expectation, rationale },
    dailiesOracle: {
      terminal,
      decision: terminal === 'report' ? decision : null,
      decisionPrecedence: terminal === 'report' ? precedence : null,
      exitCode: seam === 'v4_cli'
        ? terminal === 'report' ? exitCode(decision) : 2
        : null,
      expectedProcessSignal,
      expectedCalls: calls,
      expectedEvidenceState: evidenceState,
      expectedObservationClass: observationClass,
      expectedErrorKind: errorKind,
      reportMustValidate: terminal === 'report' && emitsFullReport,
    },
    executionOracle: { minimumMaxInFlight, requireDistinctCompletionOrders },
  });
}

function policyObservation(source, result) {
  const classification = source === 'v5_policy'
    ? classifyV5InvariantDecision(result)
    : classifyV6InvariantDecision(result);
  return {
    source,
    native: {
      terminal: 'report',
      decision: result.decision,
      decisionPrecedence: result.precedence ?? null,
    },
    exitCode: null,
    processSignal: null,
    calls: { candidate: 0, evidenceProvider: 0 },
    reportValidated: false,
    ...classification,
    executionEvidence: { maxInFlight: 0, completionOrderDigest: null },
  };
}

function v5Policy() {
  return releasePolicyV1Schema.parse({
    schemaVersion: 1,
    id: 'authored-v5-policy',
    version: '1',
    manifestId: 'authored-manifest',
    manifestDigest: DIGEST,
    criteria: [
      {
        criterionVersionId: 'criterion-a',
        evidenceRequirement: 'mandatory',
        consequence: 'advisory',
        rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
      },
      {
        criterionVersionId: 'criterion-b',
        evidenceRequirement: 'mandatory',
        consequence: 'blocking',
        rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
      },
    ],
    compensationGroups: [],
  });
}

function criterionEvidence(
  criterionVersionId,
  { evidenceState = 'complete', trustAdmissible = true, passRate = 1,
    passed = passRate === 1 ? 1 : 0, total = 1 } = {},
) {
  return {
    criterionVersionId,
    evidenceState,
    trustAdmissible,
    passed,
    total,
    passRate,
    regressions: passRate === 1 ? 0 : 1,
  };
}

function v5CompensationPolicy() {
  return releasePolicyV1Schema.parse({
    schemaVersion: 1,
    id: 'authored-v5-compensation-policy',
    version: '1',
    manifestId: 'authored-manifest',
    manifestDigest: DIGEST,
    criteria: ['criterion-a', 'criterion-b'].map((criterionVersionId) => ({
      criterionVersionId,
      evidenceRequirement: 'mandatory',
      consequence: 'compensatory',
      compensationGroupId: 'quality',
      rule: { kind: 'pass_rate_operand/v1', unit: 'pass_rate_ratio' },
    })),
    compensationGroups: [{
      id: 'quality',
      formula: {
        contract: 'dailies/weighted-pass-rate/v1',
        unit: 'pass_rate_ratio',
        minimumPassRate: 0.8,
        terms: ['criterion-a', 'criterion-b'].map((criterionVersionId) => ({
          criterionVersionId,
          weightBasisPoints: 5_000,
        })),
      },
    }],
  });
}

const calibrationRequirement = {
  contract: 'dailies/binary-calibration-requirement/v1',
  requiredTruthRole: 'sealed_validation',
  requiredTruthProvenanceLevel: 'governed_blind',
  requiredPositiveClass: 'pass',
  requiredRepresentativeOfPopulationId: null,
  trialRule: { kind: 'all_trials_meet/v1', minimumTrials: 1 },
  maximumAgeSeconds: 86_400,
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

function v6Policy() {
  return releasePolicyV2Schema.parse({
    schemaVersion: 2,
    id: 'authored-v6-policy',
    version: '1',
    manifestId: 'authored-manifest',
    manifestDigest: DIGEST,
    criteria: ['criterion-a', 'criterion-b'].map((criterionVersionId) => ({
      criterionVersionId,
      evidenceRequirement: 'mandatory',
      consequence: 'blocking',
      rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
      calibrationRequirement,
    })),
    compensationGroups: [],
  });
}

function calibrationResult(criterionVersionId, status) {
  const satisfied = status === 'satisfied';
  const integrity = status === 'integrity_failure';
  const reason = satisfied ? null : integrity ? 'artifact_digest_mismatch' : 'source_not_configured';
  return calibrationPolicyResultSchema.parse({
    criterionVersionId,
    status,
    admissible: satisfied,
    evaluatedAt: FIXED_TIME,
    requirement: calibrationRequirement,
    collectionState: satisfied ? 'verified' : integrity ? 'integrity_failure' : 'incomplete',
    calibrationEvidenceScope: null,
    reasons: reason === null ? [] : [reason],
    worstReason: reason,
    checks: [],
    trials: [],
  });
}

function pureExecutor(source, execute) {
  return async () => {
    const result = execute();
    return {
      observation: policyObservation(source, result),
      rawArtifact: canonicalJson(result),
    };
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server did not bind');
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  if (server === undefined) return;
  server.closeAllConnections();
  server.close();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let value = '';
    request.on('data', (chunk) => { value += chunk; });
    request.on('end', () => resolve(value));
    request.on('error', reject);
  });
}

async function runV4Fixture(mode, seed) {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-authored-invariant-'));
  let candidateServer;
  let judgeServer;
  let candidateCalls = 0;
  let judgeCalls = 0;
  let candidateInFlight = 0;
  let candidateMaxInFlight = 0;
  const completionOrder = [];
  try {
    const itemCount = mode === 'completion_order' ? 4 : mode === 'partial_coverage' ? 2 : 1;
    const rows = Array.from({ length: itemCount }, (_, index) => ({
      id: `item-${index}`,
      input: `value-${index}`,
      baseline_label: 'pass',
      baseline_output: `value-${index}`,
    }));
    const inputBytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const inputPath = join(dir, 'inputs.jsonl');
    await writeFile(inputPath, inputBytes);

    let candidateUrl;
    if (mode !== 'candidate_transport') {
      candidateServer = createServer(async (request, response) => {
        candidateCalls += 1;
        candidateInFlight += 1;
        candidateMaxInFlight = Math.max(candidateMaxInFlight, candidateInFlight);
        try {
          const body = JSON.parse(await readBody(request));
          if (mode === 'candidate_timeout') return;
          if (mode === 'completion_order') {
            const index = Number(body.prompt.slice('value-'.length));
            const delay = (index + seed) % 2 === 0 ? 30 : 1;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            output: mode === 'candidate_protocol' ? null : body.prompt,
          }));
          completionOrder.push(body.prompt);
        } finally {
          candidateInFlight -= 1;
        }
      });
      candidateUrl = validatedLoopbackUrl(
        `http://127.0.0.1:${await listen(candidateServer)}/candidate`,
      );
    } else {
      candidateUrl = validatedLoopbackUrl('http://127.0.0.1:1/candidate');
    }

    let judge;
    if (['judge_timeout', 'judge_protocol', 'partial_coverage', 'judge_http_503',
      'judge_clean_admitted', 'judge_clean_unadmitted'].includes(mode)) {
      judgeServer = createServer(async (request, response) => {
        judgeCalls += 1;
        const body = JSON.parse(await readBody(request));
        if (mode === 'judge_timeout' ||
          (mode === 'partial_coverage' && body.input === 'value-1')) return;
        if (mode === 'judge_http_503') {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'authored unavailable' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(mode === 'judge_protocol'
          ? { pass: true }
          : { score: 1, pass: true }));
      });
      judge = {
        type: 'http',
        url: validatedLoopbackUrl(`http://127.0.0.1:${await listen(judgeServer)}/judge`),
      };
    } else if (mode === 'judge_transport') {
      judge = { type: 'http', url: validatedLoopbackUrl('http://127.0.0.1:1/judge') };
    } else {
      judge = { type: 'exact-match' };
    }

    const config = {
      schemaVersion: 4,
      inputs: { type: 'jsonl', path: inputPath, digest: sha256Bytes(inputBytes) },
      scope: {
        id: `authored-${mode}`,
        kind: 'regression_corpus',
        expectedItems: itemCount,
        collectionProcedure: 'Authored deterministic local robustness fixture.',
        population: 'Only the authored fixture cases in this run.',
        timeWindow: { kind: 'not_applicable', reason: 'Static authored fixture.' },
      },
      candidate: {
        type: 'http',
        url: candidateUrl,
        bodyTemplate: '{"prompt": {input}}',
      },
      judge,
      thresholds: mode === 'partial_coverage'
        ? { minPassRate: 0.5, maxRegressions: 1 }
        : { minPassRate: 1, maxRegressions: 0 },
      trustPolicy: mode === 'judge_clean_unadmitted'
        ? { admissibleClasses: ['verified'] }
        : judge.type === 'http'
        ? {
            admissibleClasses: ['self_reported'],
            selfReportedOverride: { reason: 'Authored local fault fixture only.' },
          }
        : { admissibleClasses: ['deterministic'] },
      concurrency: 4,
      timeoutMs: mode === 'judge_timeout' || mode === 'candidate_timeout' ||
        mode === 'partial_coverage' ? FAULT_TIMEOUT_MS : 1_000,
      output: { dir: join(dir, 'unused') },
    };
    const report = reportSchema.parse(await runShadow(config, {
      now: () => new Date(FIXED_TIME),
    }));
    const observedCandidateCalls = report.items.reduce(
      (sum, item) => sum + item.attempts.candidate.length,
      0,
    );
    const observedJudgeCalls = report.judgeType === 'exact-match' ? 0 : report.items.reduce(
      (sum, item) => sum + (item.attempts.judge?.length ?? 0),
      0,
    );
    if (candidateServer !== undefined && candidateCalls !== observedCandidateCalls) {
      throw new Error('candidate server call count disagrees with attempt ledger');
    }
    if (judgeServer !== undefined && judgeCalls !== observedJudgeCalls) {
      throw new Error('judge server call count disagrees with attempt ledger');
    }
    return {
      report,
      calls: { candidate: observedCandidateCalls, evidenceProvider: observedJudgeCalls },
      executionEvidence: {
        maxInFlight: candidateMaxInFlight,
        completionOrderDigest: completionOrder.length === 0
          ? null
          : sha256Bytes(Buffer.from(canonicalJson(completionOrder))),
      },
      rawArtifact: JSON.stringify(report),
    };
  } finally {
    closeServer(candidateServer);
    closeServer(judgeServer);
    await rm(dir, { recursive: true, force: true });
  }
}

function runnerExecutor(mode) {
  return async (seed) => {
    const result = await runV4Fixture(mode, seed);
    const classification = classifyV4InvariantReport(result.report);
    return {
      observation: {
        source: 'v4_runner',
        native: {
          terminal: 'report',
          decision: result.report.decision,
          decisionPrecedence: null,
        },
        exitCode: null,
        processSignal: null,
        calls: result.calls,
        reportValidated: true,
        ...classification,
        executionEvidence: result.executionEvidence,
      },
      rawArtifact: result.rawArtifact,
    };
  };
}

function spawnCli(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CLI_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function countLogLines(path) {
  if (!(await fileExists(path))) return 0;
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0).length;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runV4CliFixture(tampered) {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-authored-cli-'));
  try {
    const inputBytes = Buffer.from(JSON.stringify({
      id: 'cli-item',
      input: 'value',
      baseline_label: 'pass',
      baseline_output: 'value',
    }) + '\n');
    await writeFile(join(dir, 'inputs.jsonl'), inputBytes);
    const callLogPath = join(dir, 'candidate-calls.log');
    const candidateScriptPath = join(dir, 'candidate.mjs');
    await writeFile(candidateScriptPath,
      "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(process.argv[2], 'call\\n');\n" +
      "process.stdout.write(process.argv[3]);\n");
    const outputDir = join(dir, 'out');
    const config = {
      schemaVersion: 4,
      inputs: {
        type: 'jsonl',
        path: 'inputs.jsonl',
        digest: tampered ? `sha256:${'0'.repeat(64)}` : sha256Bytes(inputBytes),
      },
      scope: {
        id: tampered ? 'tampered-cli' : 'clean-cli',
        kind: 'regression_corpus',
        expectedItems: 1,
        collectionProcedure: 'Authored deterministic CLI fixture.',
        population: 'One authored CLI case.',
        timeWindow: { kind: 'not_applicable', reason: 'Static authored fixture.' },
      },
      candidate: {
        type: 'command',
        template: `${shellQuote(process.execPath)} ${shellQuote(candidateScriptPath)} ` +
          `${shellQuote(callLogPath)} {input}`,
      },
      judge: { type: 'exact-match' },
      thresholds: { minPassRate: 1, maxRegressions: 0 },
      trustPolicy: { admissibleClasses: ['deterministic'] },
      concurrency: 1,
      timeoutMs: 1_000,
      output: { dir: outputDir },
    };
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    await mkdir(join(dir, 'cache'));
    const cli = await spawnCli([join(process.cwd(), 'dist/cli.js'), '--config', configPath], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
        XDG_CACHE_HOME: join(dir, 'cache'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (cli.timedOut) throw new Error(`packaged CLI exceeded ${CLI_TIMEOUT_MS}ms`);
    if (cli.signal !== null) throw new Error(`packaged CLI terminated with signal ${cli.signal}`);
    if (cli.code === null) throw new Error('packaged CLI closed without an exit code');
    const measuredCandidateCalls = await countLogLines(callLogPath);
    if (tampered) {
      const exactStderr = `dailies error: input artifact digest mismatch: expected ` +
        `${config.inputs.digest}, observed ${sha256Bytes(inputBytes)}\n`;
      if (cli.stderr !== exactStderr) {
        throw new Error(`packaged CLI digest-mismatch stderr changed: ${JSON.stringify(cli.stderr)}`);
      }
      if (measuredCandidateCalls !== 0) {
        throw new Error('tampered CLI fixture executed the candidate');
      }
    }
    const reportPath = join(outputDir, 'report.json');
    if (!(await fileExists(reportPath))) {
      return {
        cli,
        report: null,
        rawArtifact: undefined,
        calls: { candidate: measuredCandidateCalls, evidenceProvider: 0 },
      };
    }
    const rawArtifact = await readFile(reportPath);
    const report = reportSchema.parse(JSON.parse(rawArtifact.toString('utf8')));
    const reportCandidateCalls = report.items.reduce(
      (sum, item) => sum + item.attempts.candidate.length,
      0,
    );
    if (reportCandidateCalls !== measuredCandidateCalls) {
      throw new Error('CLI candidate call log disagrees with retained attempt ledger');
    }
    return {
      cli,
      report,
      rawArtifact,
      calls: {
        candidate: measuredCandidateCalls,
        evidenceProvider: report.judgeType === 'exact-match' ? 0 : report.items.reduce(
          (sum, item) => sum + (item.attempts.judge?.length ?? 0),
          0,
        ),
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cliExecutor(tampered) {
  return async () => {
    const result = await runV4CliFixture(tampered);
    if (result.report === null) {
      const classification = classifyAuthoredInvariantThrownError(
        result.cli.stderr,
        'input_tamper',
      );
      return {
        observation: {
          source: 'v4_cli',
          native: { terminal: 'abort', decision: null, decisionPrecedence: null },
          exitCode: result.cli.code,
          processSignal: result.cli.signal,
          calls: result.calls,
          reportValidated: false,
          ...classification,
          executionEvidence: { maxInFlight: 0, completionOrderDigest: null },
        },
        stdout: result.cli.stdout,
        stderr: result.cli.stderr,
      };
    }
    const classification = classifyV4InvariantReport(result.report);
    return {
      observation: {
        source: 'v4_cli',
        native: {
          terminal: 'report',
          decision: result.report.decision,
          decisionPrecedence: null,
        },
        exitCode: result.cli.code,
        processSignal: result.cli.signal,
        calls: result.calls,
        reportValidated: true,
        ...classification,
        executionEvidence: { maxInFlight: 0, completionOrderDigest: null },
      },
      rawArtifact: result.rawArtifact,
      stdout: result.cli.stdout,
      stderr: result.cli.stderr,
    };
  };
}

async function scopeMismatchExecutor() {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-authored-scope-'));
  try {
    const inputBytes = Buffer.from(JSON.stringify({
      id: 'scope-item', input: 'value', baseline_output: 'value',
    }) + '\n');
    const inputPath = join(dir, 'inputs.jsonl');
    await writeFile(inputPath, inputBytes);
    const callLogPath = join(dir, 'candidate-calls.log');
    const candidateScriptPath = join(dir, 'candidate.mjs');
    await writeFile(candidateScriptPath,
      "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(process.argv[2], 'call\\n');\n" +
      "process.stdout.write(process.argv[3]);\n");
    const config = {
      schemaVersion: 4,
      inputs: { type: 'jsonl', path: inputPath, digest: `sha256:${'0'.repeat(64)}` },
      scope: {
        id: 'mismatched-scope',
        kind: 'regression_corpus',
        expectedItems: 1,
        collectionProcedure: 'Authored scope mismatch.',
        population: 'One authored case.',
        timeWindow: { kind: 'not_applicable', reason: 'Static authored fixture.' },
      },
      candidate: {
        type: 'command',
        template: `${shellQuote(process.execPath)} ${shellQuote(candidateScriptPath)} ` +
          `${shellQuote(callLogPath)} {input}`,
      },
      judge: { type: 'exact-match' },
      thresholds: { minPassRate: 1, maxRegressions: 0 },
      trustPolicy: { admissibleClasses: ['deterministic'] },
      concurrency: 1,
      timeoutMs: 1_000,
      output: { dir: join(dir, 'unused') },
    };
    try {
      await runShadow(config, { now: () => new Date(FIXED_TIME) });
      throw new Error('scope mismatch unexpectedly produced a report');
    } catch (error) {
      if (!String(error).includes('input artifact digest mismatch')) throw error;
      const candidateCalls = await countLogLines(callLogPath);
      if (candidateCalls !== 0) {
        throw new Error('scope mismatch executed the candidate before preflight abort');
      }
      const classification = classifyAuthoredInvariantThrownError(error, 'scope_binding');
      return {
        observation: {
          source: 'v4_runner',
          native: { terminal: 'abort', decision: null, decisionPrecedence: null },
          exitCode: null,
          processSignal: null,
          calls: { candidate: candidateCalls, evidenceProvider: 0 },
          reportValidated: false,
          ...classification,
          executionEvidence: { maxInFlight: 0, completionOrderDigest: null },
        },
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function reportTamperExecutor(seed) {
  const result = await runV4Fixture('clean', seed);
  const tampered = structuredClone(result.report);
  tampered.decision = tampered.decision === 'promote' ? 'block' : 'promote';
  let rejection = '';
  try {
    reportSchema.parse(tampered);
    throw new Error('tampered report unexpectedly validated');
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
    if (rejection.includes('unexpectedly validated')) throw error;
  }
  const classification = classifyAuthoredInvariantThrownError(rejection, 'report_validation');
  return {
    observation: {
      source: 'report_parser',
      native: { terminal: 'abort', decision: null, decisionPrecedence: null },
      exitCode: null,
      processSignal: null,
      calls: result.calls,
      reportValidated: false,
      ...classification,
      executionEvidence: result.executionEvidence,
    },
    rawArtifact: JSON.stringify(tampered),
    stderr: rejection,
  };
}

const registered = [
  {
    scenario: scenario({
      id: 'control-cli-promote',
      family: 'control',
      seam: 'v4_cli',
      description: 'The packaged CLI promotes complete deterministic passing evidence.',
      expectation: 'release_allowed',
      rationale: 'All required deterministic evidence is complete and passing.',
      decision: 'promote',
      calls: { candidate: 1, evidenceProvider: 0 },
      evidenceState: 'complete',
      observationClass: 'policy_result',
    }),
    execute: cliExecutor(false),
  },
  {
    scenario: scenario({
      id: 'timeout-judge-remains-inconclusive',
      family: 'timeout',
      seam: 'v4_runner',
      description: 'A permanently hung judge is retried within bounds and cannot promote.',
      expectation: 'insufficient_evidence',
      rationale: 'The candidate ran but required judge evidence never completed.',
      decision: 'inconclusive',
      calls: { candidate: 1, evidenceProvider: 2 },
      evidenceState: 'incomplete',
      observationClass: 'evidence_timeout',
      errorKind: 'timeout',
    }),
    execute: runnerExecutor('judge_timeout'),
  },
  {
    scenario: scenario({
      id: 'transport-candidate-failure-blocks',
      family: 'transport',
      seam: 'v4_runner',
      description: 'A required candidate transport failure is never skipped.',
      expectation: 'release_denied',
      rationale: 'The required candidate could not execute after bounded attempts.',
      decision: 'block',
      calls: { candidate: 2, evidenceProvider: 0 },
      evidenceState: 'incomplete',
      observationClass: 'candidate_execution_failure',
      errorKind: 'transport',
    }),
    execute: runnerExecutor('candidate_transport'),
  },
  {
    scenario: scenario({
      id: 'timeout-candidate-failure-blocks',
      family: 'timeout',
      seam: 'v4_runner',
      description: 'A required candidate timeout is never skipped or mistaken for judge failure.',
      expectation: 'release_denied',
      rationale: 'The required candidate could not execute after bounded timeout attempts.',
      decision: 'block',
      calls: { candidate: 2, evidenceProvider: 0 },
      evidenceState: 'incomplete',
      observationClass: 'candidate_execution_failure',
      errorKind: 'timeout',
    }),
    execute: runnerExecutor('candidate_timeout'),
  },
  {
    scenario: scenario({
      id: 'transport-judge-failure-inconclusive',
      family: 'transport',
      seam: 'v4_runner',
      description: 'A permanent judge transport failure cannot become candidate evidence.',
      expectation: 'insufficient_evidence',
      rationale: 'The candidate ran but required judge evidence never completed.',
      decision: 'inconclusive',
      calls: { candidate: 1, evidenceProvider: 2 },
      evidenceState: 'incomplete',
      observationClass: 'evidence_transport_failure',
      errorKind: 'transport',
    }),
    execute: runnerExecutor('judge_transport'),
  },
  {
    scenario: scenario({
      id: 'protocol-malformed-judge-inconclusive',
      family: 'protocol',
      seam: 'v4_runner',
      description: 'A malformed successful judge payload cannot become release evidence.',
      expectation: 'insufficient_evidence',
      rationale: 'The evidence protocol did not produce a valid required result.',
      decision: 'inconclusive',
      calls: { candidate: 1, evidenceProvider: 1 },
      evidenceState: 'integrity_failure',
      observationClass: 'protocol_integrity_failure',
      errorKind: 'protocol',
    }),
    execute: runnerExecutor('judge_protocol'),
  },
  {
    scenario: scenario({
      id: 'protocol-malformed-candidate-inconclusive',
      family: 'protocol',
      seam: 'v4_runner',
      description: 'A malformed successful candidate payload is a protocol-integrity failure.',
      expectation: 'insufficient_evidence',
      rationale: 'The candidate channel returned an invalid output contract.',
      decision: 'inconclusive',
      calls: { candidate: 1, evidenceProvider: 0 },
      evidenceState: 'integrity_failure',
      observationClass: 'protocol_integrity_failure',
      errorKind: 'protocol',
    }),
    execute: runnerExecutor('candidate_protocol'),
  },
  {
    scenario: scenario({
      id: 'partial-coverage-never-promotes',
      family: 'partial_coverage',
      seam: 'v4_runner',
      description: 'Threshold slack cannot promote a partially judged required scope.',
      expectation: 'insufficient_evidence',
      rationale: 'Only one of two required items has completed judge evidence.',
      decision: 'inconclusive',
      calls: { candidate: 2, evidenceProvider: 3 },
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'timeout',
    }),
    execute: runnerExecutor('partial_coverage'),
  },
  {
    scenario: scenario({
      id: 'tamper-input-digest-aborts-cli',
      family: 'tamper',
      seam: 'v4_cli',
      description: 'The packaged CLI rejects changed input bytes before candidate execution.',
      expectation: 'insufficient_evidence',
      rationale: 'The configured exact-byte input identity does not match the file.',
      terminal: 'abort',
      calls: { candidate: 0, evidenceProvider: 0 },
      evidenceState: 'integrity_failure',
      observationClass: 'artifact_tamper',
      errorKind: 'protocol',
    }),
    execute: cliExecutor(true),
  },
  {
    scenario: scenario({
      id: 'mixed-trust-self-report-not-admitted',
      family: 'mixed_trust',
      seam: 'v4_runner',
      description: 'Complete self-reported evidence cannot promote without admission.',
      expectation: 'insufficient_evidence',
      rationale: 'The trust policy does not admit the evidence source.',
      decision: 'inconclusive',
      calls: { candidate: 1, evidenceProvider: 1 },
      evidenceState: 'complete',
      observationClass: 'trust_inadmissible',
    }),
    execute: runnerExecutor('judge_clean_unadmitted'),
  },
  {
    scenario: scenario({
      id: 'mixed-trust-self-report-explicitly-admitted',
      family: 'mixed_trust',
      seam: 'v4_runner',
      description: 'The same complete self-reported evidence promotes under an explicit admission.',
      expectation: 'release_allowed',
      rationale: 'The authored trust policy explicitly admits this local self-reported source.',
      decision: 'promote',
      calls: { candidate: 1, evidenceProvider: 1 },
      evidenceState: 'complete',
      observationClass: 'policy_result',
    }),
    execute: runnerExecutor('judge_clean_admitted'),
  },
  {
    scenario: scenario({
      id: 'transport-judge-http-503-inconclusive',
      family: 'transport',
      seam: 'v4_runner',
      description: 'A retryable HTTP 503 from the judge remains typed incomplete evidence.',
      expectation: 'insufficient_evidence',
      rationale: 'The candidate ran, but the required judge returned no usable evidence.',
      decision: 'inconclusive',
      calls: { candidate: 1, evidenceProvider: 2 },
      evidenceState: 'incomplete',
      observationClass: 'evidence_transport_failure',
      errorKind: 'http',
    }),
    execute: runnerExecutor('judge_http_503'),
  },
  {
    scenario: scenario({
      id: 'report-parser-rejects-decision-tamper',
      family: 'tamper',
      seam: 'report_parser',
      description: 'The strict report parser rejects a changed derived release decision.',
      expectation: 'insufficient_evidence',
      rationale: 'A mutated report is not trustworthy release evidence.',
      terminal: 'abort',
      calls: { candidate: 1, evidenceProvider: 0 },
      evidenceState: 'integrity_failure',
      observationClass: 'artifact_tamper',
      errorKind: 'protocol',
    }),
    execute: reportTamperExecutor,
  },
  {
    scenario: scenario({
      id: 'scope-input-identity-mismatch-aborts',
      family: 'scope_mismatch',
      seam: 'v4_runner',
      description: 'A release scope cannot execute against different input bytes.',
      expectation: 'insufficient_evidence',
      rationale: 'The declared evidence scope is not bound to the observed input artifact.',
      terminal: 'abort',
      calls: { candidate: 0, evidenceProvider: 0 },
      evidenceState: 'integrity_failure',
      observationClass: 'scope_mismatch',
      errorKind: 'protocol',
    }),
    execute: scopeMismatchExecutor,
  },
  {
    scenario: scenario({
      id: 'nondeterminism-completion-order-stable',
      family: 'nondeterminism',
      seam: 'v4_runner',
      description: 'Different concurrent completion orders retain one semantic outcome.',
      expectation: 'release_allowed',
      rationale: 'The candidate and exact judge are deterministic and all evidence is complete.',
      decision: 'promote',
      calls: { candidate: 4, evidenceProvider: 0 },
      evidenceState: 'complete',
      observationClass: 'policy_result',
      minimumMaxInFlight: 2,
      requireDistinctCompletionOrders: true,
    }),
    execute: runnerExecutor('completion_order'),
  },
  {
    scenario: scenario({
      id: 'multi-v5-integrity-outranks-block',
      family: 'multi_criterion_conflict',
      seam: 'v5_policy',
      description: 'Required integrity failure outranks a different blocking result.',
      expectation: 'insufficient_evidence',
      rationale: 'An unverifiable required channel prevents a trustworthy release decision.',
      decision: 'inconclusive',
      precedence: 'required_integrity_failure',
      evidenceState: 'integrity_failure',
      observationClass: 'protocol_integrity_failure',
      errorKind: 'protocol',
    }),
    execute: pureExecutor('v5_policy', () => applyReleasePolicy(v5Policy(), [
      criterionEvidence('criterion-a', { evidenceState: 'integrity_failure' }),
      criterionEvidence('criterion-b', { passRate: 0 }),
    ], false)),
  },
  {
    scenario: scenario({
      id: 'multi-v5-block-outranks-unrelated-missing',
      family: 'multi_criterion_conflict',
      seam: 'v5_policy',
      description: 'A complete blocking failure outranks unrelated mandatory incompleteness.',
      expectation: 'release_denied',
      rationale: 'Missing unrelated evidence cannot rescue a known policy violation.',
      decision: 'block',
      precedence: 'complete_blocking_failure',
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    }),
    execute: pureExecutor('v5_policy', () => applyReleasePolicy(v5Policy(), [
      criterionEvidence('criterion-a', { evidenceState: 'incomplete' }),
      criterionEvidence('criterion-b', { passRate: 0 }),
    ], false)),
  },
  {
    scenario: scenario({
      id: 'multi-v5-candidate-failure-blocks',
      family: 'multi_criterion_conflict',
      seam: 'v5_policy',
      description: 'A required candidate execution failure precedes completed assessment policy.',
      expectation: 'release_denied',
      rationale: 'The required release candidate did not execute successfully.',
      decision: 'block',
      precedence: 'candidate_execution_failure',
      evidenceState: 'incomplete',
      observationClass: 'candidate_execution_failure',
      errorKind: 'execution',
    }),
    execute: pureExecutor('v5_policy', () => applyReleasePolicy(v5Policy(), [
      criterionEvidence('criterion-a'),
      criterionEvidence('criterion-b'),
    ], true)),
  },
  {
    scenario: scenario({
      id: 'multi-v5-mandatory-incomplete',
      family: 'multi_criterion_conflict',
      seam: 'v5_policy',
      description: 'Mandatory incompleteness is inconclusive when no blocking result exists.',
      expectation: 'insufficient_evidence',
      rationale: 'Required criterion evidence is missing and no independent block is known.',
      decision: 'inconclusive',
      precedence: 'mandatory_evidence_incomplete',
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    }),
    execute: pureExecutor('v5_policy', () => applyReleasePolicy(v5Policy(), [
      criterionEvidence('criterion-a', { evidenceState: 'incomplete' }),
      criterionEvidence('criterion-b'),
    ], false)),
  },
  {
    scenario: scenario({
      id: 'multi-v5-policy-satisfied',
      family: 'multi_criterion_conflict',
      seam: 'v5_policy',
      description: 'Complete admissible multi-criterion evidence can promote.',
      expectation: 'release_allowed',
      rationale: 'Every required criterion is complete, admissible, and policy-passing.',
      decision: 'promote',
      precedence: 'policy_satisfied',
      evidenceState: 'complete',
      observationClass: 'policy_result',
    }),
    execute: pureExecutor('v5_policy', () => applyReleasePolicy(v5Policy(), [
      criterionEvidence('criterion-a'),
      criterionEvidence('criterion-b'),
    ], false)),
  },
  {
    scenario: scenario({
      id: 'multi-v5-compensation-failure',
      family: 'multi_criterion_conflict',
      seam: 'v5_policy',
      description: 'Complete compensatory evidence below its exact weighted threshold blocks.',
      expectation: 'release_denied',
      rationale: 'Both operands are complete, but the authored weighted policy is not satisfied.',
      decision: 'block',
      precedence: 'compensation_failure',
      evidenceState: 'complete',
      observationClass: 'policy_result',
    }),
    execute: pureExecutor('v5_policy', () => applyReleasePolicy(v5CompensationPolicy(), [
      criterionEvidence('criterion-a', { passRate: 0.5, passed: 1, total: 2 }),
      criterionEvidence('criterion-b', { passRate: 0.5, passed: 1, total: 2 }),
    ], false)),
  },
  {
    scenario: scenario({
      id: 'multi-v6-own-calibration-missing',
      family: 'multi_criterion_conflict',
      seam: 'v6_policy',
      description: 'A failing assessment cannot block without its own required calibration.',
      expectation: 'insufficient_evidence',
      rationale: 'The criterion needed to establish the block is not release-admissible.',
      decision: 'inconclusive',
      precedence: 'mandatory_evidence_incomplete',
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    }),
    execute: pureExecutor('v6_policy', () => applyReleasePolicyV2(v6Policy(), [
      criterionEvidence('criterion-a', { passRate: 0 }),
      criterionEvidence('criterion-b'),
    ], [
      calibrationResult('criterion-a', 'incomplete'),
      calibrationResult('criterion-b', 'satisfied'),
    ], false)),
  },
  {
    scenario: scenario({
      id: 'multi-v6-valid-block-outranks-other-missing',
      family: 'multi_criterion_conflict',
      seam: 'v6_policy',
      description: 'An independently calibrated block outranks unrelated missing calibration.',
      expectation: 'release_denied',
      rationale: 'The blocking criterion has complete admissible assessment and calibration.',
      decision: 'block',
      precedence: 'complete_blocking_failure',
      evidenceState: 'incomplete',
      observationClass: 'partial_coverage',
      errorKind: 'incomplete',
    }),
    execute: pureExecutor('v6_policy', () => applyReleasePolicyV2(v6Policy(), [
      criterionEvidence('criterion-a'),
      criterionEvidence('criterion-b', { passRate: 0 }),
    ], [
      calibrationResult('criterion-a', 'incomplete'),
      calibrationResult('criterion-b', 'satisfied'),
    ], false)),
  },
  {
    scenario: scenario({
      id: 'multi-v6-own-calibration-integrity-outranks-valid-block',
      family: 'multi_criterion_conflict',
      seam: 'v6_policy',
      description: 'A required calibration integrity failure outranks another valid block.',
      expectation: 'insufficient_evidence',
      rationale: 'A required calibration artifact failed exact integrity verification.',
      decision: 'inconclusive',
      precedence: 'required_integrity_failure',
      evidenceState: 'integrity_failure',
      observationClass: 'artifact_tamper',
      errorKind: 'protocol',
    }),
    execute: pureExecutor('v6_policy', () => applyReleasePolicyV2(v6Policy(), [
      criterionEvidence('criterion-a'),
      criterionEvidence('criterion-b', { passRate: 0 }),
    ], [
      calibrationResult('criterion-a', 'integrity_failure'),
      calibrationResult('criterion-b', 'satisfied'),
    ], false)),
  },
];

const scenarios = registered.map((entry) => entry.scenario);
const outcomes = [];
for (const entry of registered) {
  for (let trialIndex = 0; trialIndex < entry.scenario.repeatCount; trialIndex += 1) {
    const seed = 10_000 + trialIndex;
    const started = process.hrtime.bigint();
    const observed = await entry.execute(seed);
    const durationNanoseconds = process.hrtime.bigint() - started;
    outcomes.push(evaluateAuthoredInvariantOutcome({
      scenario: entry.scenario,
      observation: observed.observation,
      trialIndex,
      seed,
      durationNanoseconds,
      rawArtifact: observed.rawArtifact,
      stdout: observed.stdout,
      stderr: observed.stderr,
    }));
  }
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
let sourceRevision = 'unavailable';
let sourceTree = 'unknown';
try {
  sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() || 'unavailable';
  sourceTree = execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() ? 'dirty' : 'clean';
} catch {
  // Source identity is explicit rather than guessed when the package is not in Git.
}
const run = buildAuthoredInvariantRun(
  'dailies-batch6-authored-invariants-v1',
  scenarios,
  outcomes,
  authoredInvariantEnvironment(packageJson.version, sourceRevision, sourceTree, {
    network: 'configured_endpoints_validated_loopback',
    validatedLoopbackEndpoints,
    caches: 'fresh_temporary_cache_directory',
    credentialVariablesRemoved,
    proxyVariablesRemoved,
    externalModels: 'none_configured',
  }),
);
verifyAuthoredInvariantRun(JSON.parse(JSON.stringify(run)));

console.error('Dailies authored invariant robustness gate (not competitor evidence)');
console.error(
  `${run.summary.scenarios} scenarios, ${run.summary.trials} trials, ` +
  `${run.summary.falsePromotions} false promotions, ` +
  `${run.summary.nondeterministicScenarios} nondeterministic scenarios`,
);
console.log(JSON.stringify(run, null, 2));
if (!run.summary.passed) process.exitCode = 1;
await rm(harnessCacheDirectory, { recursive: true, force: true });
