#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  parseSuiteConfig,
  SUITE_CONFIG_SCHEMA_VERSION,
  type SuiteConfig,
} from './config-v5.js';
import {
  parseSuiteConfigV6,
  SUITE_CONFIG_V6_SCHEMA_VERSION,
  type SuiteConfigV6,
} from './config-v6.js';
import { parseConfig, type Config } from './config.js';
import { decideExitCode, EXIT_RUN_ERROR, renderMarkdown } from './report.js';
import { renderSuiteMarkdown } from './report-v5.js';
import {
  renderCalibrationReportMarkdown,
  serializeCalibrationReportV6,
} from './report-v6.js';
import { runShadow } from './runner.js';
import { runSuiteRelease } from './suite-runner.js';
import { runCalibrationSuiteRelease } from './suite-runner-v6.js';

function resolveFrom(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

async function loadConfig(configPath: string): Promise<Config | SuiteConfig | SuiteConfigV6> {
  const absPath = resolve(configPath);
  const raw: unknown = JSON.parse(await readFile(absPath, 'utf8'));
  const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  const config = version === SUITE_CONFIG_V6_SCHEMA_VERSION
    ? parseSuiteConfigV6(raw)
    : version === SUITE_CONFIG_SCHEMA_VERSION
      ? parseSuiteConfig(raw)
      : parseConfig(raw);
  // Paths in the config are relative to the config file's directory.
  const baseDir = dirname(absPath);
  config.inputs.path = resolveFrom(baseDir, config.inputs.path);
  config.output.dir = resolveFrom(baseDir, config.output.dir);
  if (config.schemaVersion === SUITE_CONFIG_SCHEMA_VERSION ||
    config.schemaVersion === SUITE_CONFIG_V6_SCHEMA_VERSION) {
    config.suite.manifest.path = resolveFrom(baseDir, config.suite.manifest.path);
  }
  if (config.schemaVersion === SUITE_CONFIG_V6_SCHEMA_VERSION) {
    for (const binding of config.calibrationEvidence) {
      if (binding.source !== null) {
        binding.source.path = resolveFrom(baseDir, binding.source.path);
      }
    }
  }
  return config;
}

async function main(): Promise<number> {
  const program = new Command()
    .name('dailies')
    .description(
      'Evaluate an AI release candidate and emit a promote/block/inconclusive report',
    )
    .requiredOption('--config <path>', 'path to a Dailies JSON configuration')
    .parse();

  const { config: configPath } = program.opts<{ config: string }>();

  const config = await loadConfig(configPath);
  const report = config.schemaVersion === SUITE_CONFIG_V6_SCHEMA_VERSION
    ? await runCalibrationSuiteRelease(config)
    : config.schemaVersion === SUITE_CONFIG_SCHEMA_VERSION
      ? await runSuiteRelease(config)
      : await runShadow(config);

  await mkdir(config.output.dir, { recursive: true });
  const jsonPath = join(config.output.dir, 'report.json');
  const mdPath = join(config.output.dir, 'report.md');
  await writeFile(
    jsonPath,
    report.schemaVersion === SUITE_CONFIG_V6_SCHEMA_VERSION
      ? serializeCalibrationReportV6(report)
      : JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile(
    mdPath,
    report.schemaVersion === SUITE_CONFIG_V6_SCHEMA_VERSION
      ? renderCalibrationReportMarkdown(report)
      : report.schemaVersion === SUITE_CONFIG_SCHEMA_VERSION
        ? renderSuiteMarkdown(report)
        : renderMarkdown(report),
    'utf8',
  );

  if (report.schemaVersion === SUITE_CONFIG_V6_SCHEMA_VERSION) {
    console.log(
      `decision: ${report.decision} | criteria ${report.criteria.length}, ` +
      `candidate assessment ${report.candidateAssessment.status}, ` +
      `precedence ${report.decisionPrecedence}`,
    );
  } else if (report.schemaVersion === SUITE_CONFIG_SCHEMA_VERSION) {
    console.log(
      `decision: ${report.decision} | criteria ${report.criteria.length}, ` +
      `candidate executions ${report.candidateExecution.succeeded}/${report.candidateExecution.total}, ` +
      `precedence ${report.decisionPrecedence}`,
    );
  } else {
    const { totals } = report;
    console.log(
      `decision: ${report.decision} | pass rate ${(totals.passRate * 100).toFixed(1)}% ` +
        `(${totals.passed}/${totals.total}), regressions ${totals.regressions}, ` +
        `evaluated ${totals.evaluated}/${totals.total}, errored ${totals.errored}`,
    );
  }
  console.log(`report: ${jsonPath}`);
  console.log(`report: ${mdPath}`);

  if (report.decision === 'inconclusive') {
    if (report.schemaVersion === SUITE_CONFIG_V6_SCHEMA_VERSION) {
      console.error(
        `dailies inconclusive: calibration-aware release policy stopped at ` +
          `${report.decisionPrecedence}. Incomplete or unverifiable required evidence is not a ` +
          `decision on the candidate. Exiting ${EXIT_RUN_ERROR} (run error).`,
      );
    } else if (report.schemaVersion === SUITE_CONFIG_SCHEMA_VERSION) {
      console.error(
        `dailies inconclusive: criterion release policy stopped at ` +
          `${report.decisionPrecedence}. Incomplete evidence is not a decision on the ` +
          `candidate. Exiting ${EXIT_RUN_ERROR} (run error).`,
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

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`dailies error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT_RUN_ERROR;
  });
