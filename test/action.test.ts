import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const actionPath = join(projectRoot, 'action.yml');
const scriptPath = join(projectRoot, 'scripts', 'action-run.sh');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ActionYaml {
  name: string;
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, { value: string }>;
  runs: { using: string; steps: Array<{ id?: string; shell?: string; run?: string; env?: Record<string, string> }> };
}

interface FakeRun {
  /** Exit code the fake CLI returns. */
  exit: number;
  /** Report decision the fake CLI writes; omit to write no report. */
  decision?: 'promote' | 'block' | 'inconclusive';
}

interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  summary: string;
  npxArgs: string;
}

/**
 * Run scripts/action-run.sh with a fake `npx` first on PATH. The fake records
 * its arguments, writes report.json/report.md into the configured output
 * directory (relative to the config), and exits with the requested code.
 */
async function runStep(
  fake: FakeRun,
  env: Record<string, string> = {},
  options: { staleReport?: boolean; withConfig?: boolean } = {},
): Promise<StepResult> {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-action-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const configPath = join(dir, 'project', 'dailies.config.json');
  await mkdir(dirname(configPath));
  if (options.withConfig !== false) {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 4, output: { dir: './gate-out' } }), 'utf8');
  }
  const outDir = join(dir, 'project', 'gate-out');
  if (options.staleReport) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'report.json'), JSON.stringify({ decision: 'promote', stale: true }), 'utf8');
    await writeFile(join(outDir, 'report.md'), '# stale\n', 'utf8');
  }
  const argsFile = join(dir, 'npx-args.txt');
  const fakeNpx = [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
    ...(fake.decision === undefined ? [] : [
      `mkdir -p ${JSON.stringify(outDir)}`,
      `printf '%s' '{"schemaVersion":4,"decision":"${fake.decision}","finishedAt":"'"$(date +%s%N)"'"}' > ${JSON.stringify(join(outDir, 'report.json'))}`,
      `printf '# Dailies report\\n\\ndecision: ${fake.decision} %s\\n' "$(date +%s%N)" > ${JSON.stringify(join(outDir, 'report.md'))}`,
    ]),
    `exit ${fake.exit}`,
    '',
  ].join('\n');
  await writeFile(join(bin, 'npx'), fakeNpx, 'utf8');
  await chmod(join(bin, 'npx'), 0o755);
  const outputFile = join(dir, 'github-output.txt');
  const summaryFile = join(dir, 'github-summary.md');
  await writeFile(outputFile, '', 'utf8');
  await writeFile(summaryFile, '', 'utf8');

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      'bash',
      [scriptPath],
      {
        cwd: join(dir, 'project'),
        timeout: 20_000,
        env: {
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          HOME: process.env.HOME ?? dir,
          DAILIES_CONFIG: 'dailies.config.json',
          DAILIES_VERSION: '0.3.0',
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
  const outputs: Record<string, string> = {};
  for (const line of (await readFile(outputFile, 'utf8')).split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) outputs[line.slice(0, index)] = line.slice(index + 1);
  }
  const npxArgs = await readFile(argsFile, 'utf8').catch(() => '');
  return { ...result, outputs, summary: await readFile(summaryFile, 'utf8'), npxArgs };
}

describe('action.yml', () => {
  it('parses as a composite action with the documented inputs and outputs', async () => {
    const action = parseYaml(await readFile(actionPath, 'utf8')) as ActionYaml;
    expect(action.runs.using).toBe('composite');
    expect(Object.keys(action.inputs)).toEqual(['config', 'version', 'fail-on-inconclusive', 'summary']);
    expect(action.inputs.config).toMatchObject({ required: true });
    expect(action.inputs['fail-on-inconclusive']?.default).toBe('true');
    expect(action.inputs.summary?.default).toBe('true');
    expect(Object.keys(action.outputs)).toEqual(['decision', 'exit-code', 'report-json', 'report-md']);
    for (const output of Object.values(action.outputs)) {
      expect(output.value).toMatch(/^\$\{\{ steps\.run\.outputs\.[a-z-]+ \}\}$/);
    }
    const step = action.runs.steps.find((entry) => entry.id === 'run');
    expect(step?.shell).toBe('bash');
    expect(step?.run).toContain('scripts/action-run.sh');
    expect(step?.env).toMatchObject({
      DAILIES_CONFIG: '${{ inputs.config }}',
      DAILIES_VERSION: '${{ inputs.version }}',
      DAILIES_FAIL_ON_INCONCLUSIVE: '${{ inputs.fail-on-inconclusive }}',
      DAILIES_SUMMARY: '${{ inputs.summary }}',
    });
  });

  it('defaults the version input to the current package version', async () => {
    const action = parseYaml(await readFile(actionPath, 'utf8')) as ActionYaml;
    const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { version: string };
    expect(action.inputs.version?.default).toBe(pkg.version);
  });
});

describe('scripts/action-run.sh', () => {
  it('runs npx with the pinned version, succeeds on promote, and exposes outputs and the summary', async () => {
    const result = await runStep({ exit: 0, decision: 'promote' });
    expect(result.code, result.stderr).toBe(0);
    expect(result.npxArgs.split('\n').filter(Boolean)).toEqual(['--yes', 'dailies@0.3.0', '--config', 'dailies.config.json']);
    expect(result.outputs.decision).toBe('promote');
    expect(result.outputs['exit-code']).toBe('0');
    expect(result.outputs['report-json']).toMatch(/\/gate-out\/report\.json$/);
    expect(result.outputs['report-md']).toMatch(/\/gate-out\/report\.md$/);
    expect(result.summary).toContain('decision: promote');
    expect(result.stdout).not.toContain('::warning::');
    expect(result.stdout).not.toContain('::error::');
  });

  it('fails the step on block', async () => {
    const result = await runStep({ exit: 1, decision: 'block' });
    expect(result.code).toBe(1);
    expect(result.outputs).toMatchObject({ decision: 'block', 'exit-code': '1' });
    expect(result.stdout).toContain('::error::Dailies blocked the release');
  });

  it('fails the step on inconclusive by default', async () => {
    const result = await runStep({ exit: 2, decision: 'inconclusive' });
    expect(result.code).toBe(2);
    expect(result.outputs).toMatchObject({ decision: 'inconclusive', 'exit-code': '2' });
    expect(result.stdout).toContain('::error::Dailies was inconclusive');
  });

  it('only warns on inconclusive when fail-on-inconclusive is false, keeping the decision visible', async () => {
    const result = await runStep({ exit: 2, decision: 'inconclusive' }, { DAILIES_FAIL_ON_INCONCLUSIVE: 'false' });
    expect(result.code).toBe(0);
    expect(result.outputs).toMatchObject({ decision: 'inconclusive', 'exit-code': '2' });
    expect(result.stdout).toContain('::warning::Dailies was inconclusive');
    expect(result.stdout).not.toContain('::error::');
  });

  it('treats a run error without a report as inconclusive and leaves report outputs empty', async () => {
    const result = await runStep({ exit: 2 });
    expect(result.code).toBe(2);
    expect(result.outputs).toMatchObject({
      decision: 'inconclusive',
      'exit-code': '2',
      'report-json': '',
      'report-md': '',
    });
    expect(result.summary).toBe('');
  });

  it('ignores a stale report from an earlier run', async () => {
    const result = await runStep({ exit: 2 }, {}, { staleReport: true });
    expect(result.code).toBe(2);
    expect(result.outputs).toMatchObject({ decision: 'inconclusive', 'report-json': '', 'report-md': '' });
    expect(result.summary).toBe('');
  });

  it('never treats exit 0 as promote when the report disagrees or is missing', async () => {
    const disagree = await runStep({ exit: 0, decision: 'block' });
    expect(disagree.code).toBe(1);
    expect(disagree.outputs.decision).toBe('block');
    expect(disagree.stdout).toContain('refusing to treat the run as promote');

    const missing = await runStep({ exit: 0 });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain('refusing to treat the run as promote');
  });

  it('skips the job summary when summary is false', async () => {
    const result = await runStep({ exit: 0, decision: 'promote' }, { DAILIES_SUMMARY: 'false' });
    expect(result.code).toBe(0);
    expect(result.summary).toBe('');
    expect(result.outputs['report-md']).toMatch(/report\.md$/);
  });

  it('fails early on a missing config or an invalid boolean input', async () => {
    const missing = await runStep({ exit: 0, decision: 'promote' }, {}, { withConfig: false });
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain('::error::Dailies config not found');
    expect(missing.npxArgs).toBe('');

    const invalid = await runStep({ exit: 0, decision: 'promote' }, { DAILIES_FAIL_ON_INCONCLUSIVE: 'maybe' });
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toContain("'fail-on-inconclusive' must be true or false");
    expect(invalid.npxArgs).toBe('');
  });
});
