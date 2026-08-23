import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  authoredInvariantFamilySchema,
  verifyAuthoredInvariantRun,
} from '../src/robustness.js';

const execFileAsync = promisify(execFile);

describe('Batch 6 authored invariant robustness gate', () => {
  it('runs real supported seams with zero false promotions and exact deterministic outcomes', async () => {
    const scriptPath = fileURLToPath(
      new URL('../scripts/invariant-robustness.mjs', import.meta.url),
    );
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const run = verifyAuthoredInvariantRun(JSON.parse(stdout));

    expect(stderr).toContain('not competitor evidence');
    expect(run).toMatchObject({
      evidenceClass: 'authored_correctness_only',
      comparativeClaim: 'forbidden',
      summary: {
        scenarios: 24,
        trials: 48,
        falsePromotions: 0,
        falseBlocks: 0,
        exactOracleMismatches: 0,
        callCountMismatches: 0,
        reportValidationFailures: 0,
        nondeterministicScenarios: 0,
        completionOrderFailures: 0,
        executionEvidenceFailures: 0,
        passed: true,
      },
      environment: {
        tool: { name: 'dailies' },
        isolation: {
          network: 'configured_endpoints_validated_loopback',
          caches: 'fresh_temporary_cache_directory',
          externalModels: 'none_configured',
        },
      },
    });
    expect(run.scenarioSetDigest)
      .toBe('sha256:280a7539aa8c04768da5281066e30a41849d97954aabfbc1dafb7d359ddf8a2d');
    expect(run.environment.isolation.validatedLoopbackEndpoints).toBeGreaterThan(0);
    expect(run.environment.isolation.credentialVariablesRemoved).toBeGreaterThanOrEqual(0);
    expect(run.environment.isolation.proxyVariablesRemoved).toBeGreaterThanOrEqual(0);

    const allFamilies = authoredInvariantFamilySchema.options;
    expect(new Set(run.scenarios.map((scenario) => scenario.family)))
      .toEqual(new Set(allFamilies));
    expect(new Set(run.scenarios.map((scenario) => scenario.seam))).toEqual(new Set([
      'v4_runner',
      'v4_cli',
      'v5_policy',
      'v6_policy',
      'report_parser',
    ]));

    const byId = new Map(run.outcomes.map((outcome) => [outcome.scenarioId, outcome]));
    expect(byId.get('control-cli-promote')).toMatchObject({
      exitCode: 0,
      processSignal: null,
      calls: { candidate: 1, evidenceProvider: 0 },
    });
    expect(byId.get('tamper-input-digest-aborts-cli')).toMatchObject({
      native: { terminal: 'abort', decision: null },
      exitCode: 2,
      processSignal: null,
      calls: { candidate: 0, evidenceProvider: 0 },
      normalized: {
        releaseSignal: 'aborted',
        evidenceState: 'integrity_failure',
        observationClass: 'artifact_tamper',
      },
      rawEvidence: { artifactDigest: null, artifactByteLength: 0 },
    });
    expect(byId.get('timeout-judge-remains-inconclusive')).toMatchObject({
      native: { terminal: 'report', decision: 'inconclusive' },
      normalized: {
        releaseSignal: 'no_decision',
        errorKind: 'timeout',
      },
      calls: { candidate: 1, evidenceProvider: 2 },
    });
    expect(byId.get('transport-candidate-failure-blocks')).toMatchObject({
      native: { terminal: 'report', decision: 'block' },
      normalized: {
        releaseSignal: 'do_not_proceed',
        observationClass: 'candidate_execution_failure',
        errorKind: 'transport',
      },
      calls: { candidate: 2, evidenceProvider: 0 },
    });
    expect(byId.get('scope-input-identity-mismatch-aborts')).toMatchObject({
      exitCode: null,
      calls: { candidate: 0, evidenceProvider: 0 },
      normalized: { observationClass: 'scope_mismatch', errorKind: 'protocol' },
    });
    const completionOutcomes = run.outcomes.filter(
      (outcome) => outcome.scenarioId === 'nondeterminism-completion-order-stable',
    );
    expect(completionOutcomes).toHaveLength(2);
    expect(new Set(completionOutcomes.map((outcome) => outcome.semanticDigest)).size).toBe(1);
    expect(new Set(completionOutcomes.map(
      (outcome) => outcome.executionEvidence.completionOrderDigest,
    )).size).toBe(2);
    expect(completionOutcomes.every(
      (outcome) => outcome.executionEvidence.maxInFlight > 1,
    )).toBe(true);
    expect(completionOutcomes[0]?.rawEvidence.artifactDigest)
      .toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.runtimeDistributions).toHaveLength(run.scenarios.length);
    expect(run.runtimeDistributions.every((distribution) =>
      BigInt(distribution.minNanoseconds) <= BigInt(distribution.p50Nanoseconds) &&
      BigInt(distribution.p50Nanoseconds) <= BigInt(distribution.p95Nanoseconds) &&
      BigInt(distribution.p95Nanoseconds) <= BigInt(distribution.maxNanoseconds)))
      .toBe(true);
  }, 35_000);
});
