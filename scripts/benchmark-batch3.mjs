import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  SUITE_REPORT_SCHEMA_VERSION,
  aggregateCriterionItems,
  applyReleasePolicy,
  buildSuiteDecisionStatement,
  candidateExecutionIdentity,
  compareCriterionOutcome,
  evaluatorSuiteCriterionDigest,
  evaluatorSuiteManifestDigest,
  providerExecutionIdentity,
  releasePolicyDigest,
  reportV5Schema,
  sha256Digest,
  suiteCandidateDatasetDigest,
  suiteExecutionPolicyDigest,
  verifyEvaluatorSuiteManifest,
  verifyReleasePolicy,
} from '../dist/index.js';

const CRITERION_COUNTS = [1, 10, 50];
const CANDIDATE_ITEMS = 100;
const WARMUP_ITERATIONS = 3;
const SAMPLE_ITERATIONS = 25;
const FIXED_TIME = '2026-08-23T00:00:00.000Z';

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function syntheticManifest(criterionCount) {
  const members = Array.from({ length: criterionCount }, (_, position) => {
    const identity = String(position).padStart(3, '0');
    const criterion = {
      criterionId: `criterion_${identity}`,
      criterionVersionId: `criterionv_${identity}_1`,
      criterionName: `Synthetic criterion ${identity}`,
      criterionDefinition: `Deterministic benchmark criterion ${identity}.`,
    };
    return {
      position,
      ...criterion,
      criterionDigest: evaluatorSuiteCriterionDigest(criterion),
      skillId: `skill_${identity}`,
      skillVersionId: `skillv_${identity}_1`,
      skillDigest: sha256Digest({ kind: 'synthetic-skill', identity }),
      outputContractDigest: sha256Digest({ kind: 'synthetic-output', version: 1 }),
      applicability: { kind: 'all_items' },
    };
  });
  const unsigned = {
    contract: 'rubrist/evaluator-suite-manifest/v1',
    schemaVersion: 1,
    manifestId: `benchmark_manifest_${criterionCount}`,
    suiteId: `benchmark_suite_${criterionCount}`,
    projectId: 'benchmark_project',
    revision: 1,
    members,
    trialPlan: null,
  };
  return { ...unsigned, manifestDigest: evaluatorSuiteManifestDigest(unsigned) };
}

function syntheticPolicy(manifest) {
  return {
    schemaVersion: 1,
    id: `benchmark_policy_${manifest.members.length}`,
    version: '1',
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    criteria: manifest.members.map((member) => ({
      criterionVersionId: member.criterionVersionId,
      evidenceRequirement: 'mandatory',
      consequence: 'blocking',
      rule: { kind: 'binary_threshold/v1', minPassRate: 0.8, maxRegressions: 100 },
    })),
    compensationGroups: [],
  };
}

function syntheticCandidates(manifest) {
  return Array.from({ length: CANDIDATE_ITEMS }, (_, index) => {
    const identity = String(index).padStart(3, '0');
    return {
      id: `item-${identity}`,
      input: `synthetic input ${identity}`,
      baseline_labels: Object.fromEntries(
        manifest.members.map((member) => [member.criterionVersionId, 'pass']),
      ),
      status: 'success',
      candidate_output: `synthetic output ${identity}`,
      attempts: [{ attempt: 1, outcome: 'success' }],
    };
  });
}

function syntheticReceipt(manifest, member, candidates, labels) {
  const items = candidates.map((candidate) => ({
    clientItemId: candidate.id,
    caseId: `case-${member.position}-${candidate.id}`,
    status: 'completed',
    judgedLabel: labels.get(candidate.id),
    verdictId: `verdict-${member.position}-${candidate.id}`,
    error: null,
    contentDigest: sha256Digest({
      input: candidate.input,
      output: candidate.candidate_output,
    }),
    providerMetadata: {
      model: 'synthetic-local-v1',
      requestId: `request-${member.position}-${candidate.id}`,
      responseId: `response-${member.position}-${candidate.id}`,
      systemFingerprint: null,
    },
  }));
  const receipt = {
    schemaVersion: 1,
    receiptId: `receipt-${member.skillVersionId}`,
    evalRunId: `run-${member.skillVersionId}`,
    projectId: manifest.projectId,
    skillId: member.skillId,
    skillVersionId: member.skillVersionId,
    status: 'complete',
    run: {
      status: 'completed',
      totalItems: candidates.length,
      completedItems: candidates.length,
      failedItems: 0,
      agreedItems: 0,
    },
    requestedModelBinding: {
      provider: 'synthetic-local',
      modelId: 'synthetic-local-v1',
      modelVersion: '1',
      temperature: 0,
    },
    skillDigest: member.skillDigest,
    datasetDigest: sha256Digest(
      items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })),
    ),
    items,
  };
  return { ...receipt, evidenceDigest: sha256Digest(receipt) };
}

function buildFixture(criterionCount) {
  const manifest = syntheticManifest(criterionCount);
  const policy = syntheticPolicy(manifest);
  const candidates = syntheticCandidates(manifest);
  const inputBytes = candidates.map((candidate) => JSON.stringify({
    id: candidate.id,
    input: candidate.input,
    baseline_labels: candidate.baseline_labels,
  })).join('\n') + '\n';
  return {
    rawManifest: manifest,
    rawPolicy: policy,
    candidates,
    inputDigest: sha256Bytes(inputBytes),
    inputByteLength: Buffer.byteLength(inputBytes),
  };
}

function deriveValidatedReport(fixture) {
  const manifest = verifyEvaluatorSuiteManifest(fixture.rawManifest, {
    manifestId: fixture.rawManifest.manifestId,
    manifestDigest: fixture.rawManifest.manifestDigest,
  });
  const policy = verifyReleasePolicy(fixture.rawPolicy, manifest);
  const criteriaWithoutPolicy = manifest.members.map((member) => {
    const labels = new Map(fixture.candidates.map((candidate, itemIndex) => [
      candidate.id,
      (itemIndex + member.position) % 10 === 0 ? 'fail' : 'pass',
    ]));
    const items = fixture.candidates.map((candidate) => {
      const baselineLabel = candidate.baseline_labels[member.criterionVersionId];
      const assessedLabel = labels.get(candidate.id);
      const comparison = compareCriterionOutcome(baselineLabel, assessedLabel);
      return {
        id: candidate.id,
        baselineLabel,
        assessedLabel,
        comparison,
        regression: comparison === 'regression',
      };
    });
    const receipt = syntheticReceipt(manifest, member, fixture.candidates, labels);
    return {
      position: member.position,
      criterionId: member.criterionId,
      criterionVersionId: member.criterionVersionId,
      criterionName: member.criterionName,
      criterionDefinition: member.criterionDefinition,
      criterionDigest: member.criterionDigest,
      skillId: member.skillId,
      skillVersionId: member.skillVersionId,
      skillDigest: member.skillDigest,
      outputContractDigest: member.outputContractDigest,
      suite: { manifestId: manifest.manifestId, manifestDigest: manifest.manifestDigest },
      scope: {
        id: 'benchmark-scope',
        kind: 'regression_corpus',
        inputDigest: fixture.inputDigest,
      },
      trust: {
        status: 'complete',
        class: 'verified',
        derivation: 'rubrist_receipt_v1',
        admissible: true,
      },
      evidence: {
        state: 'complete',
        evalRunId: receipt.evalRunId,
        operations: [
          {
            phase: 'submit',
            policy: 'single_non_idempotent',
            attempts: [{ attempt: 1, outcome: 'success' }],
            status: 'pending',
          },
          {
            phase: 'poll',
            policy: 'retry_transient',
            attempts: [{ attempt: 1, outcome: 'success' }],
            status: 'completed',
          },
          {
            phase: 'receipt',
            policy: 'retry_transient',
            attempts: [{ attempt: 1, outcome: 'success' }],
            status: 'complete',
          },
        ],
        receipt,
      },
      totals: aggregateCriterionItems(items),
      items,
    };
  });
  const policyInputs = criteriaWithoutPolicy.map((criterion) => ({
    criterionVersionId: criterion.criterionVersionId,
    evidenceState: criterion.evidence.state,
    trustAdmissible: criterion.trust.admissible,
    passed: criterion.totals.passed,
    total: criterion.totals.total,
    passRate: criterion.totals.passRate,
    regressions: criterion.totals.regressions,
  }));
  const applied = applyReleasePolicy(policy, policyInputs, false, false);
  const criteria = criteriaWithoutPolicy.map((criterion, index) => ({
    ...criterion,
    policyResult: {
      evidenceRequirement: applied.criteria[index].evidenceRequirement,
      consequence: applied.criteria[index].consequence,
      rulePassed: applied.criteria[index].rulePassed,
    },
  }));
  const provider = providerExecutionIdentity({ type: 'rubrist', url: 'https://benchmark.invalid' });
  const candidate = candidateExecutionIdentity({
    type: 'command',
    template: 'synthetic-candidate {input}',
  });
  const executionPolicy = {
    scheduling: 'manifest_order_bounded_pool/v1',
    deadlineStartsAt: 'after_candidate_execution',
    evidenceDeadlineMs: 300_000,
    pollIntervalMs: 1_000,
    perCallTimeoutMs: 60_000,
    concurrency: 4,
    provider,
    candidate,
  };
  const policyDigest = releasePolicyDigest(policy);
  const successfulCandidates = fixture.candidates.map((candidate) => ({
    id: candidate.id,
    input: candidate.input,
    output: candidate.candidate_output,
  }));
  return reportV5Schema.parse({
    schemaVersion: SUITE_REPORT_SCHEMA_VERSION,
    startedAt: FIXED_TIME,
    finishedAt: FIXED_TIME,
    scope: {
      id: 'benchmark-scope',
      kind: 'regression_corpus',
      collectionProcedure: 'Deterministic in-memory Batch 3 benchmark fixture.',
      population: 'Synthetic benchmark items only.',
      timeWindow: { kind: 'not_applicable', reason: 'Synthetic static fixture.' },
      inputArtifact: {
        type: 'jsonl',
        digest: fixture.inputDigest,
        declaredDigest: fixture.inputDigest,
        byteLength: fixture.inputByteLength,
        itemCount: fixture.candidates.length,
      },
      coverage: { expectedItems: fixture.candidates.length, observedItems: fixture.candidates.length },
      producerProvenance: {
        datasetRevision: 'not_provided',
        exposure: 'not_provided',
        review: 'not_provided',
      },
    },
    trustPolicy: { admissibleClasses: ['verified'] },
    manifest,
    policy,
    policyDigest,
    executionPolicy,
    executionPolicyDigest: suiteExecutionPolicyDigest(executionPolicy),
    candidateExecution: {
      total: fixture.candidates.length,
      succeeded: fixture.candidates.length,
      failed: 0,
      items: fixture.candidates,
    },
    candidateDatasetDigest: suiteCandidateDatasetDigest(successfulCandidates),
    criteria,
    compensation: applied.compensation,
    decision: applied.decision,
    decisionPrecedence: applied.precedence,
    decisionStatement: buildSuiteDecisionStatement(
      applied.decision,
      policy.id,
      policy.version,
      policyDigest,
      manifest.manifestId,
      manifest.manifestDigest,
      'regression_corpus',
      'benchmark-scope',
      fixture.inputDigest,
    ),
  });
}

function assertInvariants(report, criterionCount) {
  assert.equal(report.decision, 'promote');
  assert.equal(report.decisionPrecedence, 'policy_satisfied');
  assert.equal(report.criteria.length, criterionCount);
  assert.equal(report.candidateExecution.total, CANDIDATE_ITEMS);
  assert.ok(report.criteria.every((criterion) => criterion.totals.total === CANDIDATE_ITEMS));
}

function percentile(samples, quantile) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function benchmarkScenario(criterionCount) {
  const fixture = buildFixture(criterionCount);
  const validated = deriveValidatedReport(fixture);
  assertInvariants(validated, criterionCount);
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    assertInvariants(deriveValidatedReport(fixture), criterionCount);
  }
  const samples = [];
  for (let index = 0; index < SAMPLE_ITERATIONS; index += 1) {
    const started = performance.now();
    const report = deriveValidatedReport(fixture);
    samples.push(performance.now() - started);
    assertInvariants(report, criterionCount);
  }
  return {
    criteria: criterionCount,
    candidateItems: CANDIDATE_ITEMS,
    samples: SAMPLE_ITERATIONS,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

const scenarios = CRITERION_COUNTS.map(benchmarkScenario);
const output = {
  benchmark: 'dailies/batch3-local-scalability/v1',
  description: 'Local manifest verification plus policy/report derivation and validation; no provider or network calls.',
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  measurement: { unit: 'milliseconds', warmups: WARMUP_ITERATIONS, samples: SAMPLE_ITERATIONS },
  scenarios,
};

console.error('Dailies Batch 3 internal scalability probe (not a competitor comparison)');
for (const scenario of scenarios) {
  console.error(
    `${scenario.criteria} criteria × ${scenario.candidateItems} items: ` +
    `p50 ${scenario.p50Ms.toFixed(3)} ms, p95 ${scenario.p95Ms.toFixed(3)} ms`,
  );
}
console.log(JSON.stringify(output, null, 2));
