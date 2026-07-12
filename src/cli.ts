#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Command } from 'commander';
import { parseConfig, type Config } from './config.js';
import { renderMarkdown } from './report.js';
import { runShadow } from './runner.js';

const EXIT_PROMOTE = 0;
const EXIT_BLOCK = 1;
const EXIT_RUN_ERROR = 2;

function resolveFrom(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

async function loadConfig(configPath: string): Promise<Config> {
  const absPath = resolve(configPath);
  const raw: unknown = JSON.parse(await readFile(absPath, 'utf8'));
  const config = parseConfig(raw);
  // Paths in the config are relative to the config file's directory.
  const baseDir = dirname(absPath);
  config.inputs.path = resolveFrom(baseDir, config.inputs.path);
  config.output.dir = resolveFrom(baseDir, config.output.dir);
  return config;
}

async function main(): Promise<number> {
  const program = new Command()
    .name('shadow-run')
    .description(
      'Run a candidate AI change against historical inputs, judge it vs production, emit a promote/block report',
    )
    .requiredOption('--config <path>', 'path to shadow.config.json')
    .parse();

  const { config: configPath } = program.opts<{ config: string }>();

  const config = await loadConfig(configPath);
  const report = await runShadow(config);

  await mkdir(config.output.dir, { recursive: true });
  const jsonPath = join(config.output.dir, 'report.json');
  const mdPath = join(config.output.dir, 'report.md');
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await writeFile(mdPath, renderMarkdown(report), 'utf8');

  const { totals } = report;
  console.log(
    `verdict: ${report.verdict} | pass rate ${(totals.passRate * 100).toFixed(1)}% ` +
      `(${totals.passed}/${totals.total}), regressions ${totals.regressions}, errored ${totals.errored}`,
  );
  console.log(`report: ${jsonPath}`);
  console.log(`report: ${mdPath}`);

  return report.verdict === 'promote' ? EXIT_PROMOTE : EXIT_BLOCK;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`shadow-run error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT_RUN_ERROR;
  });
