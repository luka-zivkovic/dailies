import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { reportV5Schema } from '../src/report-v5.js';
import { parseCanonicalCalibrationReportV6Bytes } from '../src/report-v6.js';
import { reportSchema } from '../src/report.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, 'dist', 'cli.js');
const mockPath = join(projectRoot, 'scripts', 'mock-rubrist.mjs');
const examplesRoot = join(projectRoot, 'fixtures', 'examples');
const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(configPath: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, '--config', configPath], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

/** Start scripts/mock-rubrist.mjs on an ephemeral port and return its base URL. */
function startMock(manifestPath: string, extraArgs: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [mockPath, '--manifest', manifestPath, '--port', '0', ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const match = /listening on (http:\/\/[^\s]+)/.exec(output);
      if (match) resolve(match[1]!);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    child.on('exit', (code) => reject(new Error(`mock-rubrist exited ${code}: ${output}`)));
    child.on('error', reject);
  });
}

/** Copy an example to a temp dir and point its provider at `providerUrl`. */
async function stageExample(name: string, providerUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dailies-example-${name}-`));
  tempDirs.push(dir);
  await cp(join(examplesRoot, name), dir, { recursive: true });
  await rm(join(dir, 'dailies-out'), { recursive: true, force: true });
  const configPath = join(dir, 'dailies.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    suite: { provider: { url: string } };
  };
  config.suite.provider.url = providerUrl;
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return configPath;
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'dailies-out') continue;
      files.push(...await listFiles(root, relative));
    } else if (entry.name !== 'README.md') {
      files.push(relative);
    }
  }
  return files.sort();
}

describe('fixtures/examples', () => {
  it('match the output of scripts/build-examples.mjs byte for byte', async () => {
    const { buildExamples } = await import('../scripts/build-examples.mjs') as {
      buildExamples: (outDir: string) => Promise<string[]>;
    };
    const dir = await mkdtemp(join(tmpdir(), 'dailies-examples-build-'));
    tempDirs.push(dir);
    const written = await buildExamples(dir);
    expect(written.sort()).toEqual(await listFiles(examplesRoot));
    for (const relative of written) {
      const expected = await readFile(join(dir, relative));
      const committed = await readFile(join(examplesRoot, relative));
      expect(committed.equals(expected), `${relative} drifted; rerun node scripts/build-examples.mjs`).toBe(true);
    }
  });

  it('bundled v4 example promotes offline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dailies-example-v4-'));
    tempDirs.push(dir);
    const config = JSON.parse(await readFile(join(projectRoot, 'fixtures', 'dailies.config.json'), 'utf8')) as {
      output: { dir: string };
    };
    config.output.dir = 'dailies-out';
    await writeFile(join(dir, 'dailies.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
    await cp(join(projectRoot, 'fixtures', 'example-inputs.jsonl'), join(dir, 'example-inputs.jsonl'));
    const result = await runCli(join(dir, 'dailies.config.json'));
    expect(result.code, result.stderr).toBe(0);
    const report = reportSchema.parse(JSON.parse(await readFile(join(dir, 'dailies-out', 'report.json'), 'utf8')));
    expect(report.decision).toBe('promote');
  });

  it('v5-suite promotes against the mock Rubrist stub and writes a verified v5 report', async () => {
    const providerUrl = await startMock(join(examplesRoot, 'v5-suite', 'suite-manifest.json'));
    const configPath = await stageExample('v5-suite', providerUrl);
    const result = await runCli(configPath);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('decision: promote');
    const outDir = join(dirname(configPath), 'dailies-out');
    const report = reportV5Schema.parse(JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')));
    expect(report.decision).toBe('promote');
    expect(report.decisionPrecedence).toBe('policy_satisfied');
    expect(report.criteria).toHaveLength(2);
    for (const criterion of report.criteria) {
      expect(criterion.trust).toMatchObject({ status: 'complete', class: 'verified', admissible: true });
      expect(criterion.evidence.state).toBe('complete');
      expect(criterion.totals).toMatchObject({ passed: 3, total: 3, regressions: 0 });
    }
    expect(await readFile(join(outDir, 'report.md'), 'utf8')).toContain('PROMOTE');
  });

  it('v5-suite blocks when the stub scripts a failing criterion', async () => {
    const providerUrl = await startMock(
      join(examplesRoot, 'v5-suite', 'suite-manifest.json'),
      ['--fail-criterion', 'criterionv_refund_policy_2'],
    );
    const configPath = await stageExample('v5-suite', providerUrl);
    const result = await runCli(configPath);
    expect(result.code).toBe(1);
    const report = reportV5Schema.parse(
      JSON.parse(await readFile(join(dirname(configPath), 'dailies-out', 'report.json'), 'utf8')),
    );
    expect(report.decision).toBe('block');
    expect(report.criteria[1]?.totals.regressions).toBe(3);
  });

  it('v5-suite blocks when the stub scripts an abstaining criterion, counting it as not passing', async () => {
    const providerUrl = await startMock(
      join(examplesRoot, 'v5-suite', 'suite-manifest.json'),
      ['--abstain-criterion', 'criterionv_safety_1'],
    );
    const configPath = await stageExample('v5-suite', providerUrl);
    const result = await runCli(configPath);
    expect(result.code).toBe(1);
    const outDir = join(dirname(configPath), 'dailies-out');
    const report = reportV5Schema.parse(JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')));
    expect(report.decision).toBe('block');
    expect(report.criteria[0]?.items.map((item) => item.assessedLabel)).toEqual(['abstain', 'abstain', 'abstain']);
    expect(report.criteria[0]?.totals).toMatchObject({ evaluated: 3, passed: 0, abstained: 3, passRate: 0, regressions: 3 });
    expect(await readFile(join(outDir, 'report.md'), 'utf8')).toContain('Abstained (counted as not passing): 3');
  });

  it('v6-calibration shows an abstaining criterion\'s candidate pass rate and abstentions next to its block', async () => {
    const providerUrl = await startMock(
      join(examplesRoot, 'v6-calibration', 'suite-manifest.json'),
      ['--abstain-criterion', 'criterionv_safety_1'],
    );
    const configPath = await stageExample('v6-calibration', providerUrl);
    const result = await runCli(configPath);
    expect(result.code).toBe(1);
    const markdown = await readFile(join(dirname(configPath), 'dailies-out', 'report.md'), 'utf8');
    expect(markdown).toContain('Candidate pass rate: 0.0% (0/3); regressions: 3');
    expect(markdown).toContain('Abstained (counted as not passing): 3');
  });

  it('v6-calibration promotes with verified local calibration evidence and a canonical v6 report', async () => {
    const providerUrl = await startMock(join(examplesRoot, 'v6-calibration', 'suite-manifest.json'));
    const configPath = await stageExample('v6-calibration', providerUrl);
    const result = await runCli(configPath);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('decision: promote');
    const outDir = join(dirname(configPath), 'dailies-out');
    const report = parseCanonicalCalibrationReportV6Bytes(await readFile(join(outDir, 'report.json')));
    expect(report.decision).toBe('promote');
    expect(report.candidateAssessment.status).toBe('completed');
    expect(report.criteria).toHaveLength(2);
    for (const criterion of report.criteria) {
      expect(criterion.evidenceState).toBe('verified');
      expect(criterion.trust.status).toBe('verified');
      expect(criterion.calibrationPolicy).toMatchObject({ status: 'satisfied', admissible: true });
    }
    expect(await readFile(join(outDir, 'report.md'), 'utf8')).toContain('Calibration evidence: 2/2 verified');
  });

  it('v6-calibration stays inconclusive without the stub instead of inventing evidence', async () => {
    const configPath = await stageExample('v6-calibration', 'http://127.0.0.1:1');
    const result = await runCli(configPath);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('dailies inconclusive');
  });
});
