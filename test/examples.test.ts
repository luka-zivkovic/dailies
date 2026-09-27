import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCanonicalSuiteReportBytes } from '../src/suite-report.js';
import { singleReportSchema } from '../src/report.js';

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

  it('bundled single example promotes offline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dailies-example-single-'));
    tempDirs.push(dir);
    const config = JSON.parse(await readFile(join(projectRoot, 'fixtures', 'dailies.config.json'), 'utf8')) as {
      output: { dir: string };
    };
    config.output.dir = 'dailies-out';
    await writeFile(join(dir, 'dailies.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
    await cp(join(projectRoot, 'fixtures', 'example-inputs.jsonl'), join(dir, 'example-inputs.jsonl'));
    const result = await runCli(join(dir, 'dailies.config.json'));
    expect(result.code, result.stderr).toBe(0);
    const report = singleReportSchema.parse(JSON.parse(await readFile(join(dir, 'dailies-out', 'report.json'), 'utf8')));
    expect(report.decision).toBe('promote');
  });

  it('suite promotes against the mock Rubrist stub without calibration evidence', async () => {
    const providerUrl = await startMock(join(examplesRoot, 'suite', 'suite-manifest.json'));
    const configPath = await stageExample('suite', providerUrl);
    const result = await runCli(configPath);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('decision: promote');
    const outDir = join(dirname(configPath), 'dailies-out');
    const report = parseCanonicalSuiteReportBytes(await readFile(join(outDir, 'report.json')));
    expect(report.decision).toBe('promote');
    expect(report.decisionPrecedence).toBe('policy_satisfied');
    expect(report.criteria).toHaveLength(2);
    for (const criterion of report.criteria) {
      expect(criterion.calibrationPolicy).toMatchObject({ status: 'not_required', admissible: true });
    }
    expect(report.candidateAssessment.status).toBe('completed');
    if (report.candidateAssessment.status === 'completed') {
      for (const criterion of report.candidateAssessment.report.criteria) {
        expect(criterion.trust).toMatchObject({ status: 'complete', class: 'verified', admissible: true });
        expect(criterion.totals).toMatchObject({ passed: 3, total: 3, regressions: 0 });
      }
    }
    expect(await readFile(join(outDir, 'report.md'), 'utf8')).toContain('PROMOTE');
  });

  it('suite blocks when the stub scripts a failing criterion', async () => {
    const providerUrl = await startMock(
      join(examplesRoot, 'suite', 'suite-manifest.json'),
      ['--fail-criterion', 'criterionv_refund_policy_2'],
    );
    const configPath = await stageExample('suite', providerUrl);
    const result = await runCli(configPath);
    expect(result.code).toBe(1);
    const report = parseCanonicalSuiteReportBytes(
      await readFile(join(dirname(configPath), 'dailies-out', 'report.json')),
    );
    expect(report.decision).toBe('block');
    expect(report.candidateAssessment.status === 'completed' &&
      report.candidateAssessment.report.criteria[1]?.totals.regressions).toBe(3);
  });

  it('suite blocks when the stub scripts an abstaining criterion, counting it as not passing', async () => {
    const providerUrl = await startMock(
      join(examplesRoot, 'suite', 'suite-manifest.json'),
      ['--abstain-criterion', 'criterionv_safety_1'],
    );
    const configPath = await stageExample('suite', providerUrl);
    const result = await runCli(configPath);
    expect(result.code).toBe(1);
    const outDir = join(dirname(configPath), 'dailies-out');
    const report = parseCanonicalSuiteReportBytes(await readFile(join(outDir, 'report.json')));
    expect(report.decision).toBe('block');
    const candidate = report.candidateAssessment.status === 'completed' ? report.candidateAssessment.report.criteria[0] : undefined;
    expect(candidate?.items.map((item) => item.assessedLabel)).toEqual(['abstain', 'abstain', 'abstain']);
    expect(candidate?.totals).toMatchObject({ evaluated: 3, passed: 0, abstained: 3, passRate: 0, regressions: 3 });
    expect(await readFile(join(outDir, 'report.md'), 'utf8')).toContain('Abstained (counted as not passing): 3');
  });

  it('suite-calibrated shows an abstaining criterion\'s candidate pass rate and abstentions next to its block', async () => {
    const providerUrl = await startMock(
      join(examplesRoot, 'suite-calibrated', 'suite-manifest.json'),
      ['--abstain-criterion', 'criterionv_safety_1'],
    );
    const configPath = await stageExample('suite-calibrated', providerUrl);
    const result = await runCli(configPath);
    expect(result.code).toBe(1);
    const markdown = await readFile(join(dirname(configPath), 'dailies-out', 'report.md'), 'utf8');
    expect(markdown).toContain('Candidate pass rate: 0.0% (0/3); regressions: 3');
    expect(markdown).toContain('Abstained (counted as not passing): 3');
  });

  it('suite-calibrated promotes with verified local calibration evidence and a canonical suite report', async () => {
    const providerUrl = await startMock(join(examplesRoot, 'suite-calibrated', 'suite-manifest.json'));
    const configPath = await stageExample('suite-calibrated', providerUrl);
    const result = await runCli(configPath);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('decision: promote');
    const outDir = join(dirname(configPath), 'dailies-out');
    const report = parseCanonicalSuiteReportBytes(await readFile(join(outDir, 'report.json')));
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

  it('suite-calibrated without calibrationEvidence runs, and each required calibration is not configured', async () => {
    const providerUrl = await startMock(join(examplesRoot, 'suite-calibrated', 'suite-manifest.json'));
    const configPath = await stageExample('suite-calibrated', providerUrl);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    delete config.calibrationEvidence;
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    const result = await runCli(configPath);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('dailies inconclusive: release policy stopped at mandatory_evidence_incomplete');
    const report = parseCanonicalSuiteReportBytes(
      await readFile(join(dirname(configPath), 'dailies-out', 'report.json')),
    );
    expect(report.decision).toBe('inconclusive');
    expect(report.decisionPrecedence).toBe('mandatory_evidence_incomplete');
    expect(report.candidateAssessment.status).toBe('completed');
    expect(report.criteria).toHaveLength(2);
    for (const criterion of report.criteria) {
      expect(criterion.artifactEvidence).toMatchObject({ disposition: 'unavailable', reason: 'source_not_configured' });
      expect(criterion.calibrationPolicy.admissible).toBe(false);
    }
  });

  it('suite-calibrated stays inconclusive without the stub instead of inventing evidence', async () => {
    const configPath = await stageExample('suite-calibrated', 'http://127.0.0.1:1');
    const result = await runCli(configPath);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('dailies inconclusive');
  });
});
