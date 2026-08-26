import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { decideExitCode, reportSchema, type Report } from '../src/report.js';
import { selfReportedTestPolicy, v4ContractForBytes } from './v4-fixture.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, 'dist', 'cli.js');
const tempDirs: string[] = [];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(configPath: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, '--config', configPath],
      { cwd: dirname(configPath), timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

async function writeRun(
  inputs: object[],
  overrides: Record<string, unknown> = {},
): Promise<{ configPath: string; outputDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-cli-'));
  tempDirs.push(dir);
  const inputBytes = inputs.map((input) => JSON.stringify(input)).join('\n') + '\n';
  await writeFile(join(dir, 'inputs.jsonl'), inputBytes, 'utf8');
  const outputDir = join(dir, 'out');
  const config = {
    ...v4ContractForBytes('inputs.jsonl', inputBytes, inputs.length),
    trustPolicy: selfReportedTestPolicy,
    candidate: { type: 'command', template: 'printf %s {input}' },
    judge: { type: 'exact-match' },
    thresholds: { minPassRate: 1, maxRegressions: 0 },
    concurrency: 2,
    timeoutMs: 1_000,
    output: { dir: 'out' },
    ...overrides,
  };
  const configPath = join(dir, 'dailies.json');
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  return { configPath, outputDir };
}

async function readReport(outputDir: string): Promise<Report> {
  return reportSchema.parse(JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8')));
}

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server did not bind');
      resolve(address.port);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CLI decision and report agreement', () => {
  it('writes promote and exits 0 when all evidence is complete and passing', async () => {
    const { configPath, outputDir } = await writeRun([
      { id: 'a', input: 'alpha', baseline_output: 'alpha' },
      { id: 'b', input: 'beta', baseline_output: 'beta' },
    ]);

    const cli = await runCli(configPath);
    const report = await readReport(outputDir);

    expect(cli.code).toBe(0);
    expect(report.decision).toBe('promote');
    expect(cli.code).toBe(decideExitCode(report));
    expect(cli.stdout).toContain('decision: promote');
    expect(await readFile(join(outputDir, 'report.md'), 'utf8')).toContain(
      '# Dailies release report: PROMOTE',
    );
  });

  it('writes block and exits 1 for a completed, judged regression', async () => {
    const { configPath, outputDir } = await writeRun([
      { id: 'regressed', input: 'candidate', baseline_label: 'pass', baseline_output: 'baseline' },
    ]);

    const cli = await runCli(configPath);
    const report = await readReport(outputDir);

    expect(cli.code).toBe(1);
    expect(report.decision).toBe('block');
    expect(report.items[0]).toMatchObject({ outcome: 'fail', regression: true });
    expect(cli.code).toBe(decideExitCode(report));
    expect(cli.stdout).toContain('decision: block');
    expect(await readFile(join(outputDir, 'report.md'), 'utf8')).toContain(
      '# Dailies release report: BLOCK',
    );
  });

  it('writes inconclusive and exits 2 for three passes plus one judge timeout at .75', async () => {
    const judgeServer = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { input: string };
      if (body.input === 'judge-hangs') return;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ score: 1, pass: true }));
    });
    const port = await listen(judgeServer);

    try {
      const { configPath, outputDir } = await writeRun(
        [
          { id: 'a', input: 'alpha', baseline_output: 'alpha' },
          { id: 'b', input: 'beta', baseline_output: 'beta' },
          { id: 'c', input: 'gamma', baseline_output: 'gamma' },
          { id: 'd', input: 'judge-hangs', baseline_output: 'judge-hangs' },
        ],
        {
          judge: { type: 'http', url: `http://127.0.0.1:${port}/judge` },
          thresholds: { minPassRate: 0.75, maxRegressions: 1 },
          timeoutMs: 50,
        },
      );

      const cli = await runCli(configPath);
      const report = await readReport(outputDir);

      expect(cli.code).toBe(2);
      expect(report.decision).toBe('inconclusive');
      expect(report.totals).toMatchObject({
        passed: 3,
        errored: 1,
        candidateErrored: 0,
        judgeErrored: 1,
        evaluated: 3,
        evaluationCoverage: 0.75,
        passRate: 0.75,
        regressions: 0,
      });
      expect(cli.code).toBe(decideExitCode(report));
      expect(cli.stdout).toContain('decision: inconclusive');
      expect(cli.stderr).toContain('dailies inconclusive:');
      expect(await readFile(join(outputDir, 'report.md'), 'utf8')).toContain(
        '# Dailies release report: INCONCLUSIVE',
      );
    } finally {
      judgeServer.closeAllConnections();
      judgeServer.close();
    }
  });

  it('writes block and exits 1 when a required candidate times out', async () => {
    const { configPath, outputDir } = await writeRun(
      [{ id: 'required', input: 'x', baseline_output: 'x' }],
      {
        candidate: { type: 'command', template: 'sleep 30' },
        timeoutMs: 50,
      },
    );

    const cli = await runCli(configPath);
    const report = await readReport(outputDir);

    expect(cli.code).toBe(1);
    expect(report.decision).toBe('block');
    expect(report.items[0]).toMatchObject({
      outcome: 'error',
      errorStage: 'candidate',
      errorKind: 'timeout',
      regression: false,
    });
    expect(cli.code).toBe(decideExitCode(report));
    expect(cli.stdout).toContain('decision: block');
  });

  it('retries a transient judge 503 and records deterministic attempts in the CLI report', async () => {
    let calls = 0;
    const judgeServer = createServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res
          .writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' })
          .end('{"error":"temporary"}');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"score":1,"pass":true}');
    });
    const port = await listen(judgeServer);
    try {
      const { configPath, outputDir } = await writeRun(
        [{ id: 'retry', input: 'retry', baseline_label: 'pass', baseline_output: 'retry' }],
        { judge: { type: 'http', url: `http://127.0.0.1:${port}/judge` } },
      );
      const cli = await runCli(configPath);
      const report = await readReport(outputDir);
      expect(cli.code).toBe(0);
      expect(calls).toBe(2);
      expect(report.items[0]?.attempts.judge).toEqual([
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
    } finally {
      judgeServer.closeAllConnections();
      judgeServer.close();
    }
  });

  it('explains self-reported trust insufficiency and retains a reasoned override', async () => {
    const judgeServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"score":1,"pass":true}');
    });
    const port = await listen(judgeServer);
    try {
      const judge = { type: 'http', url: `http://127.0.0.1:${port}/judge` };
      const ordinary = await writeRun(
        [{ id: 'ordinary', input: 'x', baseline_output: 'x' }],
        {
          judge,
          trustPolicy: { admissibleClasses: ['verified', 'deterministic'] },
        },
      );
      const ordinaryCli = await runCli(ordinary.configPath);
      expect(ordinaryCli.code).toBe(2);
      expect(ordinaryCli.stderr).toContain('self_reported evidence is not admitted');
      expect((await readReport(ordinary.outputDir)).decision).toBe('inconclusive');

      const reason = 'Customer accepts the migration judge for this release.';
      const overridden = await writeRun(
        [{ id: 'overridden', input: 'x', baseline_output: 'x' }],
        {
          judge,
          trustPolicy: {
            admissibleClasses: ['verified', 'deterministic', 'self_reported'],
            selfReportedOverride: { reason },
          },
        },
      );
      const overriddenCli = await runCli(overridden.configPath);
      expect(overriddenCli.code).toBe(0);
      expect((await readReport(overridden.outputDir)).decision).toBe('promote');
      expect(await readFile(join(overridden.outputDir, 'report.md'), 'utf8')).toContain(reason);
    } finally {
      judgeServer.closeAllConnections();
      judgeServer.close();
    }
  });

  it.each([
    ['a non-retryable 401', 401, '{"error":"unauthorized"}', 'http'],
    ['a malformed successful payload', 200, '{"pass":true}', 'protocol'],
  ] as const)('does not retry %s', async (_name, status, body, errorKind) => {
    let calls = 0;
    const judgeServer = createServer((_req, res) => {
      calls += 1;
      res.writeHead(status, { 'content-type': 'application/json' }).end(body);
    });
    const port = await listen(judgeServer);
    try {
      const { configPath, outputDir } = await writeRun(
        [{ id: 'no-retry', input: 'x', baseline_label: 'pass', baseline_output: 'x' }],
        { judge: { type: 'http', url: `http://127.0.0.1:${port}/judge` } },
      );
      const cli = await runCli(configPath);
      const report = await readReport(outputDir);
      expect(cli.code).toBe(2);
      expect(calls).toBe(1);
      expect(report.items[0]?.attempts.judge).toHaveLength(1);
      expect(report.items[0]?.attempts.judge?.[0]).toMatchObject({
        attempt: 1,
        outcome: 'error',
        errorKind,
        retryable: false,
      });
    } finally {
      judgeServer.closeAllConnections();
      judgeServer.close();
    }
  });

  it('rejects a non-v4 config before candidate or judge calls', async () => {
    let candidateCalls = 0;
    const candidateServer = createServer((_req, res) => {
      candidateCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"output":"x"}');
    });
    const port = await listen(candidateServer);
    try {
      const { configPath } = await writeRun(
        [{ id: 'must-not-run', input: 'x', baseline_output: 'x' }],
        {
          schemaVersion: 3,
          candidate: {
            type: 'http',
            url: `http://127.0.0.1:${port}/candidate`,
            bodyTemplate: '{"prompt": {input}}',
          },
        },
      );
      const cli = await runCli(configPath);
      expect(cli.code).toBe(2);
      expect(cli.stderr).toContain('release execution requires schemaVersion 4');
      expect(candidateCalls).toBe(0);
    } finally {
      candidateServer.closeAllConnections();
      candidateServer.close();
    }
  });
});
