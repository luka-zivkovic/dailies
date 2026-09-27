#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  parseSuiteConfig,
  type SuiteConfig,
} from './suite-config.js';
import { parseSingleConfig, type SingleConfig } from './config.js';
import { CONFIG_CONTRACTS, declaredContract, SUITE_CONFIG_CONTRACT, SUITE_REPORT_CONTRACT } from './contracts.js';
import { decideExitCode, EXIT_RUN_ERROR, renderMarkdown } from './report.js';
import {
  renderSuiteMarkdown,
  serializeSuiteReport,
} from './suite-report.js';
import { runShadow } from './runner.js';
import { runSuiteRelease } from './suite-runner.js';
import { initializeDailiesProject } from './init.js';
import { formatDigestSyncResult, syncInputDigest } from './digest.js';

/** `dailies digest --check` exit status when the config does not match its input artifact. */
const EXIT_DIGEST_MISMATCH = 1;

function resolveFrom(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

/** Load a single or suite configuration by its contract (ADR-0010). */
async function loadConfig(configPath: string): Promise<SingleConfig | SuiteConfig> {
  const absPath = resolve(configPath);
  const raw: unknown = JSON.parse(await readFile(absPath, 'utf8'));
  const contract = declaredContract(raw);
  if (typeof contract !== 'string' || !CONFIG_CONTRACTS.includes(contract)) {
    throw new Error(
      `unsupported config contract: ${contract === undefined ? 'missing' : String(contract)}; ` +
        `dailies runs ${CONFIG_CONTRACTS.join(' or ')}`,
    );
  }
  const config = contract === SUITE_CONFIG_CONTRACT ? parseSuiteConfig(raw) : parseSingleConfig(raw);
  // Paths in the config are relative to the config file's directory.
  const baseDir = dirname(absPath);
  config.inputs.path = resolveFrom(baseDir, config.inputs.path);
  config.output.dir = resolveFrom(baseDir, config.output.dir);
  if (config.contract === SUITE_CONFIG_CONTRACT) {
    config.suite.manifest.path = resolveFrom(baseDir, config.suite.manifest.path);
    for (const binding of config.calibrationEvidence) {
      if (binding.source !== null) {
        binding.source.path = resolveFrom(baseDir, binding.source.path);
      }
    }
  }
  return config;
}

async function runConfiguredRelease(configPath: string): Promise<number> {
  const config = await loadConfig(configPath);
  const report = config.contract === SUITE_CONFIG_CONTRACT
    ? await runSuiteRelease(config)
    : await runShadow(config);

  await mkdir(config.output.dir, { recursive: true });
  const jsonPath = join(config.output.dir, 'report.json');
  const mdPath = join(config.output.dir, 'report.md');
  if (report.contract === SUITE_REPORT_CONTRACT) {
    await writeFile(jsonPath, serializeSuiteReport(report));
    await writeFile(mdPath, renderSuiteMarkdown(report), 'utf8');
    console.log(
      `decision: ${report.decision} | criteria ${report.criteria.length}, ` +
      `candidate assessment ${report.candidateAssessment.status}, ` +
      `precedence ${report.decisionPrecedence}`,
    );
  } else {
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n');
    await writeFile(mdPath, renderMarkdown(report), 'utf8');
    const { totals } = report;
    console.log(
      `decision: ${report.decision} | pass rate ${(totals.passRate * 100).toFixed(1)}% ` +
        `(${totals.passed}/${totals.total}), regressions ${totals.regressions}, ` +
        `evaluated ${totals.evaluated}/${totals.total}, errored ${totals.errored}` +
        (totals.abstained === 0 ? '' : `, abstained ${totals.abstained}`),
    );
  }
  console.log(`report: ${jsonPath}`);
  console.log(`report: ${mdPath}`);

  if (report.decision === 'inconclusive') {
    if (report.contract === SUITE_REPORT_CONTRACT) {
      console.error(
        `dailies inconclusive: release policy stopped at ` +
          `${report.decisionPrecedence}. Incomplete or unverifiable required evidence is not a ` +
          `decision on the candidate. Exiting ${EXIT_RUN_ERROR} (run error).`,
      );
    } else {
      const { totals } = report;
      if (
        totals.errored === 0 &&
        report.trust.status === 'complete' &&
        !report.trust.admissible
      ) {
        console.error(
          `dailies inconclusive: complete ${report.trust.class} evidence is not admitted by ` +
            `the configured trust policy. Record an explicit policy override where appropriate. ` +
            `Exiting ${EXIT_RUN_ERROR} (run error).`,
        );
      } else {
        console.error(
          `dailies inconclusive: ${totals.errored} of ${totals.total} items errored and ` +
            `${totals.evaluated}/${totals.total} were fully evaluated. Incomplete evidence is not ` +
            `a decision on the candidate. Exiting ${EXIT_RUN_ERROR} (run error).`,
        );
      }
    }
  }
  return decideExitCode(report);
}

async function main(): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name('dailies')
    .enablePositionalOptions()
    .description(
      'Evaluate an AI release candidate and emit a promote/block/inconclusive report',
    )
    .option('--config <path>', 'path to a Dailies JSON configuration');

  program
    .command('init')
    .description('create a runnable starter configuration and regression corpus')
    .argument('[directory]', 'directory to initialize', '.')
    .action(async (directory: string) => {
      const result = await initializeDailiesProject(directory);
      console.log(`created: ${result.inputsPath}`);
      console.log(`created: ${result.configPath}`);
      console.log(`next: ${result.nextCommand}`);
    });

  program
    .command('digest')
    .description(
      'recompute the JSONL input digest and line count and update inputs.digest and scope.expectedItems',
    )
    .requiredOption('--config <path>', 'path to a Dailies JSON configuration')
    .option('--check', 'report whether the config matches the input artifact without writing', false)
    .action(async (options: { config: string; check: boolean }) => {
      const result = await syncInputDigest(options.config, { check: options.check });
      for (const line of formatDigestSyncResult(result, options.check)) console.log(line);
      if (options.check && !result.matches) exitCode = EXIT_DIGEST_MISMATCH;
    });

  program.action(async () => {
    const { config: configPath } = program.opts<{ config?: string }>();
    if (configPath === undefined) {
      throw new Error(
        'missing --config <path>; run `dailies init` to create a starter configuration',
      );
    }
    exitCode = await runConfiguredRelease(configPath);
  });

  await program.parseAsync();
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`dailies error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT_RUN_ERROR;
  });
