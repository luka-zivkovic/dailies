import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  rubristEvidenceOperationSchema,
  sha256Digest,
} from '../src/rubrist.js';
import { parseConfig, type Config } from '../src/config.js';
import { decideExitCode, renderMarkdown, reportSchema, type Report } from '../src/report.js';
import { runShadow } from '../src/runner.js';
import { v4ContractForPath } from './v4-fixture.js';

type MockMode =
  | 'valid'
  | 'tampered-evidence'
  | 'extra-field'
  | 'future-schema'
  | 'content-mismatch'
  | 'dataset-mismatch'
  | 'skill-mismatch'
  | 'ambiguous-label'
  | 'incomplete'
  | 'missing-item'
  | 'duplicate-item'
  | 'unordered'
  | 'provider-error'
  | 'submit-transient'
  | 'poll-transient'
  | 'receipt-transient'
  | 'cross-origin-poll'
  | 'pending';

interface SubmittedItem {
  clientItemId: string;
  input: string;
  output: string;
}

interface BatchRequest {
  purpose: string;
  skillVersionId: string;
  items: SubmittedItem[];
}

interface MockRubrist {
  server: Server;
  url: string;
  requests: BatchRequest[];
  receiptBodies: string[];
  authorizationHeaders: Array<string | undefined>;
  callCounts: { submit: number; poll: number; receipt: number };
}

const tempDirs: string[] = [];
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, 'dist', 'cli.js');

function independentCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? 'null' : independentCanonical(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${independentCanonical(record[key])}`).join(',')}}`;
  }
  throw new Error(`unsupported fixture value: ${typeof value}`);
}

function independentDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(independentCanonical(value)).digest('hex')}`;
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

function buildReceipt(submitted: SubmittedItem[], mode: MockMode): Record<string, unknown> {
  const codeUnitOrder = (a: SubmittedItem, b: SubmittedItem) =>
    a.clientItemId < b.clientItemId ? -1 : a.clientItemId > b.clientItemId ? 1 : 0;
  let items = [...submitted].sort(codeUnitOrder).map((item) => ({
    clientItemId: item.clientItemId,
    caseId: `case-${item.clientItemId}`,
    status: 'completed',
    judgedLabel: item.clientItemId.includes('fail') ? 'fail' : 'pass',
    verdictId: `verdict-${item.clientItemId}`,
    error: null,
    contentDigest: independentDigest({ input: item.input, output: item.output }),
    providerMetadata: {
      model: 'mock-v1',
      requestId: `request-${item.clientItemId}`,
      responseId: `response-${item.clientItemId}`,
      systemFingerprint: null,
    },
  }));

  if (mode === 'missing-item') items = items.slice(0, -1);
  if (mode === 'duplicate-item' && items.length > 1 && items[0]) {
    items[1] = { ...items[1]!, clientItemId: items[0].clientItemId };
  }
  if (mode === 'unordered') items.reverse();
  if (mode === 'content-mismatch' && items[0]) {
    items[0] = { ...items[0], contentDigest: `sha256:${'0'.repeat(64)}` };
  }
  if (mode === 'ambiguous-label' && items[0]) {
    items[0] = { ...items[0], judgedLabel: 'ambiguous' };
  }
  if (mode === 'incomplete' && items.at(-1)) {
    items[items.length - 1] = {
      ...items.at(-1)!,
      status: 'failed',
      judgedLabel: null,
      verdictId: null,
      error: 'provider failed',
    };
  }

  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    receiptId: 'receipt-run-1',
    evalRunId: 'run-1',
    projectId: 'project-1',
    skillId: 'skill-1',
    skillVersionId: mode === 'skill-mismatch' ? 'skill-version-other' : 'skill-version-1',
    status: mode === 'incomplete' ? 'incomplete' : 'complete',
    run: {
      status: mode === 'incomplete' ? 'failed' : 'completed',
      totalItems: submitted.length,
      completedItems: mode === 'incomplete' ? Math.max(0, submitted.length - 1) : submitted.length,
      failedItems: mode === 'incomplete' ? 1 : 0,
      agreedItems: 0,
    },
    requestedModelBinding: {
      provider: 'mock',
      modelId: 'mock-v1',
      modelVersion: '1',
      temperature: 0,
    },
    skillDigest: independentDigest({ immutableSkill: 'skill-version-1' }),
    datasetDigest: independentDigest(
      items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })),
    ),
    items,
  };

  if (mode === 'extra-field') receipt.calibrationRef = 'not-part-of-v1';
  if (mode === 'future-schema') receipt.schemaVersion = 2;
  if (mode === 'dataset-mismatch') receipt.datasetDigest = `sha256:${'1'.repeat(64)}`;
  receipt.evidenceDigest = independentDigest(receipt);
  if (mode === 'tampered-evidence') receipt.evidenceDigest = `sha256:${'2'.repeat(64)}`;
  return receipt;
}

interface MockRubristHooks {
  /** Runs on every poll GET before the mock answers; lets a test move a fake clock. */
  onPoll?: (pollCall: number) => void;
}

async function startMockRubrist(
  mode: MockMode = 'valid',
  hooks: MockRubristHooks = {},
): Promise<MockRubrist> {
  const requests: BatchRequest[] = [];
  const receiptBodies: string[] = [];
  const authorizationHeaders: Array<string | undefined> = [];
  let pollCalls = 0;
  let successfulPolls = 0;
  let submitCalls = 0;
  let receiptCalls = 0;
  const server = createServer(async (req, res) => {
    authorizationHeaders.push(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    );
    if (req.method === 'POST' && req.url === '/api/v1/judge/batch') {
      submitCalls += 1;
      const body = JSON.parse(await readBody(req)) as BatchRequest;
      requests.push(body);
      if (mode === 'submit-transient') {
        res
          .writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' })
          .end('{"error":"uncertain submit"}');
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({
        evalRunId: 'run-1',
        status: 'pending',
        totalItems: body.items.length,
        cachedItems: 0,
        skippedItems: 0,
        pollUrl: mode === 'cross-origin-poll'
          ? 'https://untrusted.example/eval-runs/run-1'
          : '/api/v1/eval-runs/run-1',
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/eval-runs/run-1') {
      pollCalls += 1;
      hooks.onPoll?.(pollCalls);
      if (mode === 'poll-transient' && pollCalls === 1) {
        res
          .writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' })
          .end('{"error":"temporary poll"}');
        return;
      }
      successfulPolls += 1;
      const status = mode === 'pending' || successfulPolls === 1
        ? 'running'
        : mode === 'incomplete'
          ? 'failed'
          : 'completed';
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ id: 'run-1', status }),
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/eval-runs/run-1/assessment-receipt') {
      receiptCalls += 1;
      if (mode === 'provider-error') {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
        return;
      }
      if (mode === 'receipt-transient' && receiptCalls === 1) {
        res
          .writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' })
          .end('{"error":"temporary receipt"}');
        return;
      }
      const latest = requests.at(-1);
      if (!latest) throw new Error('receipt requested before batch submission');
      const body = JSON.stringify(buildReceipt(latest.items, mode));
      receiptBodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    requests,
    receiptBodies,
    authorizationHeaders,
    callCounts: {
      get submit() { return submitCalls; },
      get poll() { return pollCalls; },
      get receipt() { return receiptCalls; },
    },
  };
}

async function writeInputs(lines: object[]): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-rubrist-'));
  tempDirs.push(dir);
  const path = join(dir, 'inputs.jsonl');
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return { dir, path };
}

function makeConfig(
  inputsPath: string,
  judgeUrl: string,
  thresholds = { minPassRate: 1, maxRegressions: 0 },
  pollTimeoutMs = 500,
): Config {
  return parseConfig({
    ...v4ContractForPath(inputsPath),
    candidate: { type: 'command', template: 'printf %s {input}' },
    judge: {
      type: 'rubrist',
      url: judgeUrl,
      headers: { authorization: 'Bearer test-key' },
      skillVersionId: 'skill-version-1',
      pollIntervalMs: 5,
      pollTimeoutMs,
    },
    thresholds,
    concurrency: 3,
    timeoutMs: 1_000,
    output: { dir: 'unused' },
  });
}

function closeServer(server: Server): void {
  server.closeAllConnections();
  server.close();
}

function runCli(configPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, '--config', configPath],
      { cwd: dirname(configPath), timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Rubrist canonical receipt primitives', () => {
  it('uses recursive code-unit key ordering and array order/undefined semantics', () => {
    const value = { z: [undefined, { é: 3, Z: 1, a: 2 }], a: 'first' };
    const expected = '{"a":"first","z":[null,{"Z":1,"a":2,"é":3}]}';
    expect(canonicalJson(value)).toBe(expected);
    expect(sha256Digest(value)).toBe(independentDigest(value));
  });

  it('keeps numeric-looking keys in lexical rather than JS integer-index order', () => {
    const value = { outer: { '2': 'two', '10': 'ten', nested: { '20': 20, '3': 3 } } };
    expect(canonicalJson(value)).toBe(
      '{"outer":{"10":"ten","2":"two","nested":{"20":20,"3":3}}}',
    );
    expect(sha256Digest(value)).toBe(independentDigest(value));
  });

  it.each([
    [{ phase: 'submit', policy: 'retry_transient', attempts: [{ attempt: 1, outcome: 'success' }], status: 'pending' }, 'submit retry policy'],
    [{ phase: 'poll', policy: 'single_non_idempotent', attempts: [{ attempt: 1, outcome: 'success' }], status: 'running' }, 'poll submit policy'],
    [{ phase: 'receipt', policy: 'retry_transient', attempts: [{ attempt: 1, outcome: 'success' }] }, 'success without status'],
    [{ phase: 'receipt', policy: 'retry_transient', attempts: [{ attempt: 1, outcome: 'error', errorKind: 'protocol', retryable: false }], status: 'complete' }, 'failure with status'],
    [{ phase: 'receipt', policy: 'retry_transient', attempts: [{ attempt: 1, outcome: 'success' }], status: 'completed' }, 'receipt with run status'],
    [{ phase: 'poll', policy: 'retry_transient', attempts: [{ attempt: 1, outcome: 'success' }], status: 'complete' }, 'poll with receipt status'],
    [{ phase: 'submit', policy: 'single_non_idempotent', attempts: [{ attempt: 1, outcome: 'success' }], status: 'pending', extra: true }, 'unknown field'],
    [{ phase: 'poll', policy: 'retry_transient', attempts: [] }, 'zero requests without termination'],
    [{ phase: 'poll', policy: 'retry_transient', attempts: [{ attempt: 1, outcome: 'success' }], termination: { kind: 'deadline', errorKind: 'timeout' }, status: 'running' }, 'attempt plus termination'],
  ] as const)('rejects incoherent evidence operation: %s', (operation) => {
    expect(rubristEvidenceOperationSchema.safeParse(operation).success).toBe(false);
  });

  it.each([
    { phase: 'submit', policy: 'single_non_idempotent', attempts: [{ attempt: 1, outcome: 'success' }], status: 'pending' },
    { phase: 'poll', policy: 'retry_transient', attempts: [{ attempt: 1, outcome: 'success' }], status: 'completed' },
    { phase: 'receipt', policy: 'retry_transient', attempts: [{ attempt: 1, outcome: 'success' }], status: 'incomplete' },
    { phase: 'submit', policy: 'single_non_idempotent', attempts: [{ attempt: 1, outcome: 'error', errorKind: 'http', httpStatus: 503, retryable: true }] },
    { phase: 'poll', policy: 'retry_transient', attempts: [], termination: { kind: 'preflight', errorKind: 'protocol' } },
    { phase: 'receipt', policy: 'retry_transient', attempts: [], termination: { kind: 'deadline', errorKind: 'timeout' } },
  ] as const)('accepts coherent evidence operation %#', (operation) => {
    expect(rubristEvidenceOperationSchema.safeParse(operation).success).toBe(true);
  });
});

describe('Rubrist release-evidence boundary', () => {
  it('submits one batch, verifies the receipt, and leaves promotion policy in Dailies', async () => {
    const mock = await startMockRubrist();
    const { path } = await writeInputs([
      { id: 'pass-a', input: 'alpha', baseline_label: 'pass', baseline_output: 'alpha' },
      { id: 'fail-b', input: 'beta', baseline_label: 'pass', baseline_output: 'old-beta' },
    ]);
    try {
      const strict = await runShadow(
        makeConfig(path, mock.url, { minPassRate: 0.5, maxRegressions: 0 }),
      );
      const permissive = await runShadow(
        makeConfig(path, mock.url, { minPassRate: 0.5, maxRegressions: 1 }),
      );

      expect(mock.requests).toHaveLength(2);
      expect(mock.requests[0]).toMatchObject({
        purpose: 'release_evidence',
        skillVersionId: 'skill-version-1',
        items: [
          { clientItemId: 'pass-a', input: 'alpha', output: 'alpha' },
          { clientItemId: 'fail-b', input: 'beta', output: 'beta' },
        ],
      });
      expect(mock.receiptBodies).toHaveLength(2);
      expect(mock.receiptBodies[0]).toBe(mock.receiptBodies[1]);
      const receipt = JSON.parse(mock.receiptBodies[0]!) as Record<string, unknown>;
      expect(receipt).not.toHaveProperty('thresholds');
      expect(receipt).not.toHaveProperty('verdict');
      expect(receipt).not.toHaveProperty('deployDecision');
      expect(strict.decision).toBe('block');
      expect(decideExitCode(strict)).toBe(1);
      expect(permissive.decision).toBe('promote');
      expect(decideExitCode(permissive)).toBe(0);
      expect(strict.trust).toEqual({
        status: 'complete',
        class: 'verified',
        derivation: 'rubrist_receipt_v1',
        admissible: true,
      });
      expect(strict.items.every((item) => item.trustClass === 'verified')).toBe(true);
      expect(strict.scope.producerProvenance).toEqual({
        datasetRevision: 'not_provided',
        exposure: 'not_provided',
        review: 'not_provided',
      });
      expect(strict.evidence?.receipt.evidenceDigest).toBe(
        permissive.evidence?.receipt.evidenceDigest,
      );
      expect(strict.items.map((item) => item.outcome)).toEqual(['pass', 'fail']);
      expect(strict.totals).toMatchObject({ evaluated: 2, regressions: 1 });
      expect(mock.authorizationHeaders.every((header) => header === 'Bearer test-key')).toBe(true);
    } finally {
      closeServer(mock.server);
    }
  });

  it('rejects internally inconsistent or receipt-unlinked serialized reports', async () => {
    const mock = await startMockRubrist();
    const { path } = await writeInputs([
      { id: 'pass-a', input: 'alpha', baseline_label: 'pass', baseline_output: 'alpha' },
      { id: 'fail-b', input: 'beta', baseline_label: 'pass', baseline_output: 'old-beta' },
    ]);
    try {
      const valid = await runShadow(
        makeConfig(path, mock.url, { minPassRate: 0.5, maxRegressions: 0 }),
      );
      expect(reportSchema.safeParse(valid).success).toBe(true);

      const wrongTotals = structuredClone(valid);
      wrongTotals.totals.passed += 1;

      const outOfRangeRate = structuredClone(valid);
      outOfRangeRate.totals.passRate = 1.01;

      const negativeCounter = structuredClone(valid);
      negativeCounter.totals.comparisonCounts.regression = -1;

      const invalidThreshold = structuredClone(valid);
      invalidThreshold.thresholds.minPassRate = -0.01;

      const wrongDecision = structuredClone(valid);
      wrongDecision.decision = 'promote';

      const missingEvidence = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
      delete missingEvidence.evidence;

      const wrongJudgeIdentity = structuredClone(valid);
      wrongJudgeIdentity.judgeType = 'exact-match';

      const wrongPinnedSkill = structuredClone(valid);
      if (wrongPinnedSkill.evidence === undefined) throw new Error('expected evidence');
      wrongPinnedSkill.evidence.skillVersionId = 'skill-version-other';

      const missingSubmittedRun = structuredClone(valid);
      if (missingSubmittedRun.evidence === undefined) throw new Error('expected evidence');
      delete missingSubmittedRun.evidence.evalRunId;

      const swappedRunReceipt = structuredClone(valid);
      const swappedReceipt = swappedRunReceipt.evidence?.receipt;
      if (swappedReceipt === undefined) throw new Error('expected retained receipt');
      swappedReceipt.receiptId = 'receipt-run-2';
      swappedReceipt.evalRunId = 'run-2';
      const { evidenceDigest: _swappedDigest, ...unsignedSwappedReceipt } = swappedReceipt;
      swappedReceipt.evidenceDigest = independentDigest(unsignedSwappedReceipt);

      const contentUnlinked = structuredClone(valid);
      contentUnlinked.items[0]!.candidate_output = 'tampered-after-collection';

      const labelUnlinked = structuredClone(valid);
      const labelReceipt = labelUnlinked.evidence?.receipt;
      if (labelReceipt === undefined) throw new Error('expected retained receipt');
      labelReceipt.items[0]!.judgedLabel =
        labelReceipt.items[0]!.judgedLabel === 'pass' ? 'fail' : 'pass';
      const { evidenceDigest: _oldDigest, ...unsignedReceipt } = labelReceipt;
      labelReceipt.evidenceDigest = independentDigest(unsignedReceipt);

      const pollRemoved = structuredClone(valid);
      if (pollRemoved.evidence === undefined) throw new Error('expected evidence');
      pollRemoved.evidence.operations = pollRemoved.evidence.operations.filter(
        (operation) => operation.phase !== 'poll',
      );

      const pollStatusUnlinked = structuredClone(valid);
      const retainedOperations = pollStatusUnlinked.evidence?.operations;
      const lastPoll = [...(retainedOperations ?? [])]
        .reverse()
        .find((operation) => operation.phase === 'poll');
      if (lastPoll === undefined) throw new Error('expected poll operation');
      lastPoll.status = 'failed';

      const receiptRemovedAfterSuccess = structuredClone(valid);
      if (receiptRemovedAfterSuccess.evidence === undefined) throw new Error('expected evidence');
      receiptRemovedAfterSuccess.evidence.status = 'failed';
      delete receiptRemovedAfterSuccess.evidence.receipt;

      const syntheticPerItemJudge = structuredClone(valid);
      syntheticPerItemJudge.items[0]!.attempts.judge = [{ attempt: 1, outcome: 'success' }];

      for (const [name, tampered] of [
        ['totals', wrongTotals],
        ['rate bound', outOfRangeRate],
        ['counter bound', negativeCounter],
        ['threshold bound', invalidThreshold],
        ['decision', wrongDecision],
        ['missing evidence', missingEvidence],
        ['judge identity', wrongJudgeIdentity],
        ['pinned skill identity', wrongPinnedSkill],
        ['missing submitted eval-run identity', missingSubmittedRun],
        ['submitted eval-run identity', swappedRunReceipt],
        ['content linkage', contentUnlinked],
        ['label linkage', labelUnlinked],
        ['poll sequence', pollRemoved],
        ['poll/receipt status linkage', pollStatusUnlinked],
        ['receipt removal', receiptRemovedAfterSuccess],
        ['synthetic per-item Rubrist judge attempt', syntheticPerItemJudge],
      ] as const) {
        expect(reportSchema.safeParse(tampered).success, name).toBe(false);
      }
    } finally {
      closeServer(mock.server);
    }
  });

  it('accepts receipt order defined by JS code units for mixed-case and non-ASCII IDs', async () => {
    const mock = await startMockRubrist();
    const { path } = await writeInputs([
      { id: 'é', input: 'accent' },
      { id: 'a', input: 'lower' },
      { id: 'Z', input: 'upper' },
      { id: ' a ', input: 'whitespace-is-identity' },
    ]);
    try {
      const report = await runShadow(makeConfig(path, mock.url));
      expect(report.decision).toBe('promote');
      expect(report.evidence?.receipt.items.map((item) => item.clientItemId)).toEqual([
        ' a ',
        'Z',
        'a',
        'é',
      ]);
    } finally {
      closeServer(mock.server);
    }
  });

  it('retains distinct client IDs even when submitted input and output bytes are identical', async () => {
    const mock = await startMockRubrist();
    const { path } = await writeInputs([
      { id: 'duplicate-content-a', input: 'same' },
      { id: 'duplicate-content-b', input: 'same' },
    ]);
    try {
      const report = await runShadow(makeConfig(path, mock.url));
      expect(report.decision).toBe('promote');
      expect(mock.requests[0]?.items).toHaveLength(2);
      expect(report.evidence?.receipt.items).toHaveLength(2);
      expect(report.evidence?.receipt.items[0]?.contentDigest).toBe(
        report.evidence?.receipt.items[1]?.contentDigest,
      );
    } finally {
      closeServer(mock.server);
    }
  });

  it('submits only successful candidates and still blocks a required candidate failure', async () => {
    const mock = await startMockRubrist();
    const { path } = await writeInputs([
      { id: 'required-fails', input: 'bad' },
      { id: 'pass-good', input: 'good' },
    ]);
    const config = makeConfig(path, mock.url, { minPassRate: 0, maxRegressions: 99 });
    config.candidate = {
      type: 'command',
      template: 'if [ {input} = bad ]; then exit 3; else printf %s {input}; fi',
    };
    try {
      const report = await runShadow(config);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.items).toEqual([
        { clientItemId: 'pass-good', input: 'good', output: 'good' },
      ]);
      expect(report.decision).toBe('block');
      expect(report.totals).toMatchObject({
        candidateErrored: 1,
        judgeErrored: 0,
        evaluated: 1,
      });
      expect(report.items[0]).toMatchObject({
        outcome: 'error',
        errorStage: 'candidate',
      });
      expect(report.items[1]).toMatchObject({ outcome: 'pass', pass: true });
    } finally {
      closeServer(mock.server);
    }
  });

  it('does not invent provider operations when every required candidate fails', async () => {
    const mock = await startMockRubrist();
    const { path } = await writeInputs([{ id: 'required-fails', input: 'bad' }]);
    const config = makeConfig(path, mock.url, { minPassRate: 0, maxRegressions: 99 });
    config.candidate = { type: 'command', template: 'exit 3' };
    try {
      const report = await runShadow(config);
      expect(report).toMatchObject({ judgeType: 'rubrist', decision: 'block' });
      expect(report.evidence).toBeUndefined();
      expect(report.trust).toEqual({
        status: 'unavailable',
        derivation: 'rubrist_receipt_v1',
        admissible: false,
        reason: 'no_completed_evidence',
      });
      expect(mock.callCounts.submit).toBe(0);
      expect(report.items[0]).toMatchObject({
        outcome: 'error',
        errorStage: 'candidate',
        errorKind: 'execution',
      });
      expect(reportSchema.safeParse(report).success).toBe(true);
    } finally {
      closeServer(mock.server);
    }
  });

  for (const [mode, message] of [
    ['tampered-evidence', 'evidenceDigest mismatch'],
    ['extra-field', 'does not match receipt v1 contract'],
    ['future-schema', 'does not match receipt v1 contract'],
    ['content-mismatch', 'contentDigest mismatch'],
    ['dataset-mismatch', 'datasetDigest mismatch'],
    ['skill-mismatch', 'skillVersionId mismatch'],
    ['ambiguous-label', 'claims complete with incomplete'],
    ['missing-item', 'exact clientItemId coverage'],
    ['duplicate-item', 'clientItemId values must be unique'],
    ['unordered', 'not ordered by clientItemId'],
  ] as const) {
    it(`is inconclusive for ${mode} evidence`, async () => {
      const mock = await startMockRubrist(mode);
      const { path } = await writeInputs([
        { id: 'pass-a', input: 'alpha', baseline_output: 'alpha' },
        { id: 'pass-b', input: 'beta', baseline_output: 'beta' },
      ]);
      try {
        const report = await runShadow(
          makeConfig(path, mock.url, { minPassRate: 0, maxRegressions: 99 }),
        );
        expect(report.decision).toBe('inconclusive');
        expect(decideExitCode(report)).toBe(2);
        expect(report.evidence).toMatchObject({ provider: 'rubrist', status: 'failed' });
        expect(report.evidence?.receipt).toBeUndefined();
        expect(report.evidence?.operations.at(-1)).toMatchObject({
          phase: 'receipt',
          attempts: [{ outcome: 'error', errorKind: 'protocol', retryable: false }],
        });
        expect(report.totals).toMatchObject({
          passed: 0,
          errored: 2,
          judgeErrored: 2,
          protocolErrored: 2,
          evaluated: 0,
        });
        expect(report.items[0]).toMatchObject({
          outcome: 'error',
          errorStage: 'judge',
          errorKind: 'protocol',
          regression: false,
        });
        expect(report.items[0]?.error).toContain(message);
      } finally {
        closeServer(mock.server);
      }
    });
  }

  it('preserves a digest-valid incomplete receipt without calling it a protocol error', async () => {
    const mock = await startMockRubrist('incomplete');
    const { path } = await writeInputs([
      { id: 'pass-a', input: 'alpha', baseline_label: 'pass' },
      { id: 'pass-b', input: 'beta', baseline_label: 'pass' },
    ]);
    try {
      const report = await runShadow(
        makeConfig(path, mock.url, { minPassRate: 0, maxRegressions: 99 }),
      );
      expect(report.decision).toBe('inconclusive');
      expect(report.evidence).toMatchObject({
        status: 'incomplete',
        receipt: { status: 'incomplete', run: { failedItems: 1 } },
      });
      expect(report.evidence?.operations.at(-1)).toMatchObject({
        phase: 'receipt',
        status: 'incomplete',
        attempts: [{ outcome: 'success' }],
      });
      expect(report.totals).toMatchObject({
        judgeErrored: 2,
        protocolErrored: 0,
        evaluated: 0,
      });
      expect(report.items.every(
        (item) =>
          item.errorKind === 'incomplete' &&
          item.comparison === 'unpaired' &&
          item.trustClass === undefined,
      )).toBe(true);
      expect(report.trust).toEqual({
        status: 'unavailable',
        derivation: 'rubrist_receipt_v1',
        admissible: false,
        reason: 'no_completed_evidence',
      });
      expect(renderMarkdown(report)).toContain('Trust: **unavailable**');
      const forgedVerifiedTrust = structuredClone(report) as Record<string, any>;
      forgedVerifiedTrust.trust = {
        status: 'complete',
        class: 'verified',
        derivation: 'rubrist_receipt_v1',
        admissible: true,
      };
      expect(reportSchema.safeParse(forgedVerifiedTrust).success).toBe(false);

      const nonterminalReceipt = structuredClone(report);
      const retainedReceipt = nonterminalReceipt.evidence?.receipt;
      const retainedOperations = nonterminalReceipt.evidence?.operations;
      const lastPoll = [...(retainedOperations ?? [])]
        .reverse()
        .find((operation) => operation.phase === 'poll');
      if (retainedReceipt === undefined || lastPoll === undefined) {
        throw new Error('expected retained receipt and poll');
      }
      lastPoll.status = 'running';
      retainedReceipt.run.status = 'running';
      const { evidenceDigest: _oldDigest, ...unsignedReceipt } = retainedReceipt;
      retainedReceipt.evidenceDigest = independentDigest(unsignedReceipt);
      expect(reportSchema.safeParse(nonterminalReceipt).success).toBe(false);
    } finally {
      closeServer(mock.server);
    }
  });

  it('records cross-origin poll rejection as a zero-request preflight termination', async () => {
    const mock = await startMockRubrist('cross-origin-poll');
    const { path } = await writeInputs([{ id: 'pass-a', input: 'alpha' }]);
    try {
      const report = await runShadow(makeConfig(path, mock.url));
      expect(report.decision).toBe('inconclusive');
      expect(report.trust).toEqual({
        status: 'unavailable',
        derivation: 'rubrist_receipt_v1',
        admissible: false,
        reason: 'no_completed_evidence',
      });
      expect(mock.callCounts).toMatchObject({ submit: 1, poll: 0, receipt: 0 });
      expect(report.evidence?.operations.at(-1)).toEqual({
        phase: 'poll',
        policy: 'retry_transient',
        attempts: [],
        termination: { kind: 'preflight', errorKind: 'protocol' },
      });
      expect(report.items[0]).toMatchObject({ errorKind: 'protocol', errorStage: 'judge' });
    } finally {
      closeServer(mock.server);
    }
  });

  it('retries transient poll GETs and records real ordered operation attempts', async () => {
    const mock = await startMockRubrist('poll-transient');
    const { path } = await writeInputs([{ id: 'pass-a', input: 'alpha' }]);
    try {
      const report = await runShadow(makeConfig(path, mock.url));
      expect(report.decision).toBe('promote');
      expect(mock.callCounts.poll).toBe(3);
      expect(report.evidence?.operations.map((operation) => operation.phase)).toEqual([
        'submit', 'poll', 'poll', 'receipt',
      ]);
      expect(report.evidence?.operations[1]?.attempts).toEqual([
        {
          attempt: 1,
          outcome: 'error',
          errorKind: 'http',
          httpStatus: 503,
          retryable: true,
          delayBeforeNextMs: 0,
        },
        { attempt: 2, outcome: 'success' },
      ]);
      expect(report.items[0]?.attempts.judge).toBeUndefined();
    } finally {
      closeServer(mock.server);
    }
  });

  it('retries receipt GETs but suppresses uncertain batch POST retries', async () => {
    const receiptMock = await startMockRubrist('receipt-transient');
    const submitMock = await startMockRubrist('submit-transient');
    const { path } = await writeInputs([{ id: 'pass-a', input: 'alpha' }]);
    try {
      const recovered = await runShadow(makeConfig(path, receiptMock.url));
      expect(recovered.decision).toBe('promote');
      expect(recovered.evidence?.evalRunId).toBe('run-1');
      expect(receiptMock.callCounts.receipt).toBe(2);
      expect(recovered.evidence?.operations.at(-1)?.attempts).toHaveLength(2);

      const suppressed = await runShadow(makeConfig(path, submitMock.url));
      expect(suppressed.decision).toBe('inconclusive');
      expect(suppressed.evidence?.evalRunId).toBeUndefined();
      expect(submitMock.callCounts.submit).toBe(1);
      expect(suppressed.evidence?.operations).toEqual([
        {
          phase: 'submit',
          policy: 'single_non_idempotent',
          attempts: [{
            attempt: 1,
            outcome: 'error',
            errorKind: 'http',
            httpStatus: 503,
            retryable: true,
          }],
        },
      ]);
    } finally {
      closeServer(receiptMock.server);
      closeServer(submitMock.server);
    }
  });

  it('maps a provider HTTP failure to judge-stage inconclusive evidence', async () => {
    const mock = await startMockRubrist('provider-error');
    const { path } = await writeInputs([{ id: 'pass-a', input: 'alpha' }]);
    try {
      const report = await runShadow(makeConfig(path, mock.url));
      expect(report.decision).toBe('inconclusive');
      expect(report.items[0]).toMatchObject({ errorStage: 'judge', errorKind: 'incomplete' });
      expect(mock.callCounts.receipt).toBe(2);
      expect(report.evidence?.operations.at(-1)?.attempts).toHaveLength(2);
    } finally {
      closeServer(mock.server);
    }
  });

  it('bounds polling and maps a never-terminal run to judge timeout', async () => {
    // The poll deadline is wall-clock (`Date.now()`), and a request whose budget the
    // deadline clamps is recorded as a `timeout` attempt rather than a `deadline`
    // termination. Fake only `Date` (timers, fetch aborts, and the candidate child
    // process stay real) and let the mock jump the clock past the deadline while it
    // serves the first poll, so the crossing no longer depends on machine latency.
    const pollTimeoutMs = 500;
    const mock = await startMockRubrist('pending', {
      onPoll: () => vi.setSystemTime(Date.now() + pollTimeoutMs),
    });
    const { path } = await writeInputs([{ id: 'pass-a', input: 'alpha' }]);
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      const report = await runShadow(makeConfig(path, mock.url, undefined, pollTimeoutMs));
      expect(mock.callCounts.poll).toBe(1);
      expect(mock.callCounts.receipt).toBe(0);
      expect(report.decision).toBe('inconclusive');
      expect(report.items[0]).toMatchObject({ errorStage: 'judge', errorKind: 'incomplete' });
      expect(report.evidence).toMatchObject({ status: 'failed' });
      expect(report.evidence?.operations.at(-1)).toEqual({
        phase: 'poll',
        policy: 'retry_transient',
        attempts: [],
        termination: { kind: 'deadline', errorKind: 'timeout' },
      });
      expect(reportSchema.safeParse(report).success).toBe(true);
    } finally {
      vi.useRealTimers();
      closeServer(mock.server);
    }
  });
});

describe('Rubrist full CLI contract', () => {
  for (const [mode, expectedCode, expectedVerdict] of [
    ['valid', 0, 'promote'],
    ['tampered-evidence', 2, 'inconclusive'],
  ] as const) {
    it(`writes a matching ${expectedVerdict} report and exit code for ${mode} evidence`, async () => {
      const mock = await startMockRubrist(mode);
      const { dir, path } = await writeInputs([{ id: 'pass-cli', input: 'cli' }]);
      const outputDir = join(dir, 'out');
      const configPath = join(dir, 'dailies.json');
      const config = makeConfig(path, mock.url);
      await writeFile(configPath, JSON.stringify({ ...config, output: { dir: outputDir } }), 'utf8');
      try {
        const cli = await runCli(configPath);
        const report = reportSchema.parse(
          JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8')),
        ) as Report;
        expect(cli.code).toBe(expectedCode);
        expect(report.decision).toBe(expectedVerdict);
        expect(cli.code).toBe(decideExitCode(report));
        expect(cli.stdout).toContain(`decision: ${expectedVerdict}`);
      } finally {
        closeServer(mock.server);
      }
    });
  }

  for (const invalidId of ['x'.repeat(241)]) {
    it(`exits 2 before calls for invalid clientItemId ${JSON.stringify(invalidId.slice(0, 12))}`, async () => {
      let candidateCalls = 0;
      const candidateServer = createServer((_req, res) => {
        candidateCalls += 1;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{"output":"unused"}');
      });
      const candidatePort = await listen(candidateServer);
      const mock = await startMockRubrist();
      const { dir, path } = await writeInputs([{ id: invalidId, input: 'must-not-run' }]);
      const outputDir = join(dir, 'out');
      const configPath = join(dir, 'dailies.json');
      const config = makeConfig(path, mock.url);
      config.candidate = {
        type: 'http',
        url: `http://127.0.0.1:${candidatePort}/candidate`,
        bodyTemplate: '{"input": {input}}',
      };
      await writeFile(
        configPath,
        JSON.stringify({ ...config, output: { dir: outputDir } }),
        'utf8',
      );
      try {
        const cli = await runCli(configPath);
        expect(cli.code).toBe(2);
        expect(cli.stderr).toContain('is not a valid Rubrist clientItemId');
        expect(candidateCalls).toBe(0);
        expect(mock.requests).toHaveLength(0);
      } finally {
        closeServer(candidateServer);
        closeServer(mock.server);
      }
    });
  }
});
