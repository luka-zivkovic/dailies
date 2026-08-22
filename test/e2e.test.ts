import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { decideExitCode, EXIT_RUN_ERROR } from '../src/report.js';
import { runShadow } from '../src/runner.js';

interface JudgeRequest {
  input: string;
  candidate_output: string;
  baseline_output?: string;
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      resolve(addr.port);
    });
  });
}

describe('end-to-end with mock HTTP candidate and judge', () => {
  let candidateServer: Server;
  let judgeServer: Server;
  let candidateUrl: string;
  let judgeUrl: string;
  /** Ids that should fail on their first candidate request (to exercise retry). */
  const flakyOnce = new Set<string>();
  /** Inputs whose judge request should hang until the client timeout aborts it. */
  const hangingJudgeInputs = new Set<string>();
  /** Inputs whose judge response should violate the gate contract. */
  const invalidJudgeInputs = new Set<string>();
  const judgeCalls: JudgeRequest[] = [];

  beforeAll(async () => {
    // Mock candidate: uppercases the prompt. Flaky ids fail with a 500 once.
    candidateServer = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { prompt: string };
      if (flakyOnce.has(body.prompt)) {
        flakyOnce.delete(body.prompt);
        res.writeHead(500).end('transient');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ output: body.prompt.toUpperCase() }));
    });

    // Mock judge implementing the gate contract: pass iff candidate output is
    // the uppercased input.
    judgeServer = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as JudgeRequest;
      judgeCalls.push(body);
      if (hangingJudgeInputs.has(body.input)) return;
      if (invalidJudgeInputs.has(body.input)) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ pass: true }));
        return;
      }
      const pass = body.candidate_output === body.input.toUpperCase();
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          score: pass ? 1 : 0,
          pass,
          ...(pass ? {} : { reason: 'candidate output is not the uppercased input' }),
        }),
      );
    });

    const [candidatePort, judgePort] = await Promise.all([
      listen(candidateServer),
      listen(judgeServer),
    ]);
    candidateUrl = `http://127.0.0.1:${candidatePort}/generate`;
    judgeUrl = `http://127.0.0.1:${judgePort}/judge`;
  });

  afterAll(() => {
    candidateServer.closeAllConnections();
    judgeServer.closeAllConnections();
    candidateServer.close();
    judgeServer.close();
  });

  async function writeInputs(lines: object[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-e2e-'));
    const path = join(dir, 'inputs.jsonl');
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return path;
  }

  function makeConfig(inputsPath: string, overrides: Partial<Config> = {}): Config {
    return {
      inputs: { type: 'jsonl', path: inputsPath },
      candidate: { type: 'http', url: candidateUrl, bodyTemplate: '{"prompt": {input}}' },
      judge: { type: 'http', url: judgeUrl },
      thresholds: { minPassRate: 1, maxRegressions: 0 },
      concurrency: 2,
      timeoutMs: 10_000,
      output: { dir: 'unused' },
      ...overrides,
    };
  }

  it('runs candidate + judge over all inputs and promotes when everything passes', async () => {
    const inputsPath = await writeInputs([
      { id: 'a', input: 'hello', baseline_output: 'HELLO' },
      { id: 'b', input: 'world', baseline_output: 'WORLD' },
      { id: 'c', input: 'no baseline here' },
    ]);
    const report = await runShadow(makeConfig(inputsPath));

    expect(report.schemaVersion).toBe(3);
    expect(report.verdict).toBe('promote');
    expect(report.totals).toMatchObject({ total: 3, passed: 3, failed: 0, regressions: 0 });
    expect(report.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(report.items[0]?.candidate_output).toBe('HELLO');
    // baseline_output is forwarded to the judge when present
    const judged = judgeCalls.find((c) => c.input === 'hello');
    expect(judged?.baseline_output).toBe('HELLO');
  });

  it('retries a transient candidate failure once and still passes', async () => {
    flakyOnce.add('flaky');
    const inputsPath = await writeInputs([
      { id: 'flaky-item', input: 'flaky', baseline_output: 'FLAKY' },
    ]);
    const report = await runShadow(makeConfig(inputsPath));

    expect(report.verdict).toBe('promote');
    expect(report.items[0]?.error).toBeUndefined();
    expect(report.items[0]?.candidate_output).toBe('FLAKY');
    expect(report.items[0]?.attempts.candidate).toEqual([
      {
        attempt: 1,
        outcome: 'error',
        errorKind: 'http',
        httpStatus: 500,
        retryable: true,
        delayBeforeNextMs: 100,
      },
      { attempt: 2, outcome: 'success' },
    ]);
  });

  it('counts a persistently failing candidate as a failure (never skipped) and blocks', async () => {
    const inputsPath = await writeInputs([{ id: 'x', input: 'y', baseline_output: 'Y' }]);
    // Unreachable candidate: fails on the first attempt and on the retry.
    const config = makeConfig(inputsPath, {
      candidate: {
        type: 'http',
        url: 'http://127.0.0.1:1/generate',
        bodyTemplate: '{"prompt": {input}}',
      },
    });
    const report = await runShadow(config);

    expect(report.verdict).toBe('block');
    expect(report.totals).toMatchObject({
      total: 1,
      passed: 0,
      failed: 1,
      errored: 1,
      candidateErrored: 1,
      judgeErrored: 0,
      evaluated: 0,
      regressions: 0,
      allErrored: true,
    });
    expect(report.items[0]).toMatchObject({
      outcome: 'error',
      errorStage: 'candidate',
      regression: false,
    });
    expect(report.items[0]?.error).toMatch(/candidate failed after 2 attempt\(s\)/);
  });

  it('is inconclusive when one judge times out even if threshold slack would promote', async () => {
    hangingJudgeInputs.add('judge-hangs');
    const inputsPath = await writeInputs([
      { id: 'a', input: 'alpha', baseline_output: 'ALPHA' },
      { id: 'b', input: 'beta', baseline_output: 'BETA' },
      { id: 'c', input: 'gamma', baseline_output: 'GAMMA' },
      { id: 'd', input: 'judge-hangs', baseline_output: 'JUDGE-HANGS' },
    ]);
    const report = await runShadow(
      makeConfig(inputsPath, {
        thresholds: { minPassRate: 0.75, maxRegressions: 1 },
        timeoutMs: 50,
      }),
    );

    expect(report.verdict).toBe('inconclusive');
    expect(decideExitCode(report)).toBe(EXIT_RUN_ERROR);
    expect(report.totals).toMatchObject({
      total: 4,
      passed: 3,
      failed: 1,
      errored: 1,
      candidateErrored: 0,
      judgeErrored: 1,
      evaluated: 3,
      evaluationCoverage: 0.75,
      passRate: 0.75,
      regressions: 0,
      allErrored: false,
    });
    expect(report.items[3]).toMatchObject({
      outcome: 'error',
      errorStage: 'judge',
      errorKind: 'timeout',
      pass: false,
      regression: false,
    });
  });

  it('is inconclusive when the judge response violates the gate contract', async () => {
    invalidJudgeInputs.add('invalid-judge-contract');
    const inputsPath = await writeInputs([
      { id: 'good', input: 'alpha', baseline_output: 'ALPHA' },
      { id: 'invalid', input: 'invalid-judge-contract', baseline_output: 'INVALID' },
    ]);
    const report = await runShadow(
      makeConfig(inputsPath, {
        thresholds: { minPassRate: 0.5, maxRegressions: 1 },
      }),
    );

    expect(report.verdict).toBe('inconclusive');
    expect(report.totals).toMatchObject({
      passed: 1,
      errored: 1,
      judgeErrored: 1,
      protocolErrored: 1,
      evaluated: 1,
      evaluationCoverage: 0.5,
      regressions: 0,
    });
    expect(report.items[1]).toMatchObject({
      outcome: 'error',
      errorStage: 'judge',
      errorKind: 'protocol',
      regression: false,
    });
  });

  it('blocks when the judge fails items beyond thresholds and reports regressions', async () => {
    const inputsPath = await writeInputs([
      { id: 'good', input: 'alpha', baseline_label: 'pass', baseline_output: 'ALPHA' },
      { id: 'bad-1', input: 'beta', baseline_label: 'pass', baseline_output: 'unreachable-baseline' },
    ]);
    // Judge passes only uppercased-input matches; make it fail by giving the
    // candidate a body the judge will reject: use a template that sends a
    // constant prompt so candidate_output never matches input.toUpperCase().
    const config = makeConfig(inputsPath, {
      candidate: { type: 'http', url: candidateUrl, bodyTemplate: '{"prompt": "constant"}' },
      thresholds: { minPassRate: 0.9, maxRegressions: 0 },
    });
    const report = await runShadow(config);

    expect(report.verdict).toBe('block');
    expect(report.totals.passed).toBe(0);
    expect(report.totals.regressions).toBe(2);
    expect(report.items.every((i) => i.judge?.reason !== undefined || i.error !== undefined)).toBe(true);
  });
});
