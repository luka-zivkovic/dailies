#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Command } from 'commander';
import { parseConfig, type Config } from './config.js';
import { decideExitCode, EXIT_RUN_ERROR, renderMarkdown } from './report.js';
import { runShadow } from './runner.js';

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
    .name('dailies')
    .description(
      'Run a candidate AI change against historical inputs and emit a promote/block/inconclusive report',
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
    `decision: ${report.decision} | pass rate ${(totals.passRate * 100).toFixed(1)}% ` +
      `(${totals.passed}/${totals.total}), regressions ${totals.regressions}, ` +
      `evaluated ${totals.evaluated}/${totals.total}, errored ${totals.errored}`,
  );
  console.log(`report: ${jsonPath}`);
  console.log(`report: ${mdPath}`);

  if (report.decision === 'inconclusive') {
    console.error(
      `dailies inconclusive: ${totals.errored} of ${totals.total} items errored and ` +
        `${totals.evaluated}/${totals.total} were fully evaluated. Incomplete evidence is not ` +
        `a decision on the candidate. Exiting ${EXIT_RUN_ERROR} (run error).`,
    );
  }
  return decideExitCode(report);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`dailies error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT_RUN_ERROR;
  });
