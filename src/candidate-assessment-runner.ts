import { runCandidate } from './candidate.js';
import { suiteInputItemSchema, type CandidateAssessmentConfig, type SuiteInputItem } from './candidate-assessment-config.js';
import type { RubristJudgeConfig } from './config.js';
import {
  RUBRIST_CLIENT_ITEM_ID_MAX_LENGTH,
  RubristCollectionError,
  collectRubristAssessment,
  type RubristEvidenceOperation,
} from './rubrist.js';
import { verifyRubristReceipt, type RubristOutcome } from './rubrist-receipt.js';
import { classifyOperationError } from './errors.js';
import {
  loadInputArtifactWithSchema,
  type ParsedInputArtifact,
} from './inputs.js';
import { mapPool } from './pool.js';
import {
  applyCandidatePolicy,
  candidatePolicyDigest,
  verifyCandidatePolicy,
} from './candidate-policy.js';
import {
  aggregateCriterionItems,
  buildCandidateAssessmentDecisionStatement,
  candidateExecutionIdentity,
  compareCriterionOutcome,
  providerExecutionIdentity,
  candidateAssessmentReportSchema,
  suiteCandidateDatasetDigest,
  suiteExecutionPolicyDigest,
  type CriterionItem,
  type SuiteCandidateItem,
  type CandidateAssessmentReport,
} from './candidate-assessment-report.js';
import { RetryFailure, runWithRetry, type AttemptRecord } from './retry.js';
import {
  loadEvaluatorSuiteManifest,
  verifyReceiptManifestBinding,
  type EvaluatorSuiteManifest,
  type EvaluatorSuiteManifestMember,
} from './suite-manifest.js';

interface CandidateSuccess {
  item: SuiteInputItem;
  result: SuiteCandidateItem;
}

type CandidateExecution =
  | { success: CandidateSuccess }
  | { failure: SuiteCandidateItem };

async function executeCandidate(config: CandidateAssessmentConfig, item: SuiteInputItem): Promise<CandidateExecution> {
  const base = {
    id: item.id,
    input: item.input,
    ...(item.baseline_output === undefined ? {} : { baseline_output: item.baseline_output }),
    ...(item.baseline_labels === undefined ? {} : { baseline_labels: item.baseline_labels }),
  };
  try {
    const executed = await runWithRetry(() =>
      runCandidate(config.candidate, item.input, config.timeoutMs));
    const result: SuiteCandidateItem = {
      ...base,
      status: 'success',
      candidate_output: executed.value,
      attempts: executed.attempts,
    };
    return { success: { item, result } };
  } catch (error) {
    const retryFailure = error instanceof RetryFailure ? error : undefined;
    const original = retryFailure?.originalError ?? error;
    const detail = classifyOperationError(original);
    const attempts: AttemptRecord[] = retryFailure?.attempts ?? [{
      attempt: 1,
      outcome: 'error',
      errorKind: detail.kind,
      ...(detail.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
      retryable: false,
    }];
    return {
      failure: {
        ...base,
        status: 'error',
        error: `candidate failed after ${attempts.length} attempt(s): ${original instanceof Error ? original.message : String(original)}`,
        errorKind: detail.kind,
        attempts,
      },
    };
  }
}

function criterionItems(
  candidates: SuiteCandidateItem[],
  member: EvaluatorSuiteManifestMember,
  outcomes: Map<string, RubristOutcome>,
): CriterionItem[] {
  return candidates.map((candidate) => {
    const baselineLabel = candidate.baseline_labels?.[member.criterionVersionId];
    const assessedLabel = candidate.status === 'success'
      ? (outcomes.get(candidate.id) ?? null)
      : null;
    const comparison = compareCriterionOutcome(baselineLabel, assessedLabel);
    return {
      id: candidate.id,
      ...(baselineLabel === undefined ? {} : { baselineLabel }),
      assessedLabel,
      comparison,
      regression: comparison === 'regression',
    };
  });
}

function baseCriterionResult(
  manifest: EvaluatorSuiteManifest,
  member: EvaluatorSuiteManifestMember,
  config: CandidateAssessmentConfig,
  inputDigest: string,
) {
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
    scope: { id: config.scope.id, kind: config.scope.kind, inputDigest },
  };
}

async function collectCriterion(
  manifest: EvaluatorSuiteManifest,
  member: EvaluatorSuiteManifestMember,
  config: CandidateAssessmentConfig,
  candidates: SuiteCandidateItem[],
  deadline: number,
  inputDigest: string,
): Promise<Omit<CandidateAssessmentReport['criteria'][number], 'policyResult'>> {
  const successful = candidates.filter(
    (candidate): candidate is SuiteCandidateItem & { status: 'success'; candidate_output: string } =>
      candidate.status === 'success' && candidate.candidate_output !== undefined,
  );
  const base = baseCriterionResult(manifest, member, config, inputDigest);
  if (successful.length === 0) {
    const items = criterionItems(candidates, member, new Map());
    return {
      ...base,
      trust: {
        status: 'unavailable',
        derivation: 'rubrist_receipt_v1',
        admissible: false,
        reason: 'no_candidate_outputs',
      },
      evidence: {
        state: 'incomplete',
        operations: [],
        zeroRequestTermination: {
          phase: 'candidate_filter',
          reason: 'no_candidate_outputs',
        },
        error: 'No successful candidate outputs were available for assessment.',
      },
      totals: aggregateCriterionItems(items),
      items,
    };
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const items = criterionItems(candidates, member, new Map());
    return {
      ...base,
      trust: {
        status: 'unavailable',
        derivation: 'rubrist_receipt_v1',
        admissible: false,
        reason: 'integrity_failure',
      },
      evidence: {
        state: 'integrity_failure',
        operations: [],
        zeroRequestTermination: {
          phase: 'evidence_submission',
          reason: 'shared_evidence_deadline_elapsed',
        },
        error: 'The Dailies-owned suite evidence deadline elapsed before criterion submission.',
      },
      totals: aggregateCriterionItems(items),
      items,
    };
  }
  const judge: RubristJudgeConfig = {
    type: 'rubrist',
    url: config.suite.provider.url,
    ...(config.suite.provider.headers === undefined ? {} : { headers: config.suite.provider.headers }),
    skillVersionId: member.skillVersionId,
    pollIntervalMs: config.suite.provider.pollIntervalMs,
    pollTimeoutMs: remaining,
  };
  let operations: RubristEvidenceOperation[] = [];
  let collectedEvalRunId: string | undefined;
  let collectedReceipt: Awaited<ReturnType<typeof collectRubristAssessment>>['receipt'] | undefined;
  try {
    const assessment = await collectRubristAssessment(
      judge,
      successful.map((candidate) => ({
        id: candidate.id,
        input: candidate.input,
        output: candidate.candidate_output,
      })),
      Math.min(config.timeoutMs, remaining),
    );
    operations = assessment.operations;
    collectedEvalRunId = assessment.evalRunId;
    collectedReceipt = assessment.receipt;
    verifyReceiptManifestBinding(assessment.receipt, manifest, member);
    const items = criterionItems(candidates, member, assessment.outcomes);
    return {
      ...base,
      trust: {
        status: 'complete',
        class: 'verified',
        derivation: 'rubrist_receipt_v1',
        admissible: config.trustPolicy.admissibleClasses.includes('verified'),
      },
      evidence: {
        state: 'complete',
        evalRunId: assessment.evalRunId,
        operations,
        receipt: assessment.receipt,
      },
      totals: aggregateCriterionItems(items),
      items,
    };
  } catch (error) {
    const collection = error instanceof RubristCollectionError ? error : undefined;
    operations = collection?.operations ?? operations;
    const receipt = collection?.receipt;
    const evalRunId = collection?.evalRunId ?? collectedEvalRunId;
    let bindingRejectedReceipt: typeof receipt;
    let bindingRejectionReason: string | undefined;
    if (receipt !== undefined && evalRunId !== undefined) {
      try {
        verifyRubristReceipt(receipt, {
          evalRunId,
          skillVersionId: member.skillVersionId,
          candidates: successful.map((candidate) => ({
            id: candidate.id,
            input: candidate.input,
            output: candidate.candidate_output,
          })),
        });
        try {
          verifyReceiptManifestBinding(receipt, manifest, member);
        } catch (bindingError) {
          bindingRejectedReceipt = receipt;
          bindingRejectionReason = bindingError instanceof Error
            ? bindingError.message
            : String(bindingError);
          throw bindingError;
        }
        const items = criterionItems(candidates, member, new Map());
        return {
          ...base,
          trust: {
            status: 'unavailable',
            derivation: 'rubrist_receipt_v1',
            admissible: false,
            reason: 'incomplete_evidence',
          },
          evidence: {
            state: 'incomplete',
            evalRunId,
            operations,
            receipt,
            error: error instanceof Error ? error.message : String(error),
          },
          totals: aggregateCriterionItems(items),
          items,
        };
      } catch (verificationError) {
        error = verificationError;
      }
    }
    const items = criterionItems(candidates, member, new Map());
    let rejectedReceipt;
    let rejection;
    if (bindingRejectedReceipt !== undefined || (collection === undefined && collectedReceipt !== undefined)) {
      rejectedReceipt = bindingRejectedReceipt ?? collectedReceipt;
      rejection = {
        kind: 'manifest_binding' as const,
        reason: bindingRejectionReason ?? (error instanceof Error ? error.message : String(error)),
      };
    }
    return {
      ...base,
      trust: {
        status: 'unavailable',
        derivation: 'rubrist_receipt_v1',
        admissible: false,
        reason: 'integrity_failure',
      },
      evidence: {
        state: 'integrity_failure',
        ...(evalRunId === undefined ? {} : { evalRunId }),
        operations,
        ...(rejectedReceipt === undefined ? {} : { rejectedReceipt, rejection }),
        error: error instanceof Error ? error.message : String(error),
      },
      totals: aggregateCriterionItems(items),
      items,
    };
  }
}

export interface RunCandidateAssessmentOptions {
  now?: () => Date;
}

export interface PreflightedCandidateAssessment {
  inputArtifact: ParsedInputArtifact<SuiteInputItem>;
  manifest: EvaluatorSuiteManifest;
  policy: ReturnType<typeof verifyCandidatePolicy>;
}

export function suiteReleaseScope(
  config: CandidateAssessmentConfig,
  inputArtifact: ParsedInputArtifact<SuiteInputItem>,
): CandidateAssessmentReport['scope'] {
  return {
    id: config.scope.id,
    kind: config.scope.kind,
    collectionProcedure: config.scope.collectionProcedure,
    population: config.scope.population,
    timeWindow: config.scope.timeWindow,
    inputArtifact: {
      type: 'jsonl',
      digest: inputArtifact.digest,
      declaredDigest: config.inputs.digest,
      byteLength: inputArtifact.byteLength,
      itemCount: inputArtifact.items.length,
    },
    coverage: {
      expectedItems: config.scope.expectedItems,
      observedItems: inputArtifact.items.length,
    },
    producerProvenance: {
      datasetRevision: 'not_provided',
      exposure: 'not_provided',
      review: 'not_provided',
    },
  };
}

/**
 * Load and verify every local candidate-assessment input before any candidate
 * or evidence provider work starts. The returned snapshot is then consumed
 * without reopening the input or manifest path.
 */
export async function preflightCandidateAssessment(
  config: CandidateAssessmentConfig,
): Promise<PreflightedCandidateAssessment> {
  const inputArtifact = await loadInputArtifactWithSchema(
    config.inputs.path,
    suiteInputItemSchema,
    config.inputs.digest,
  );
  if (inputArtifact.items.length !== config.scope.expectedItems) {
    throw new Error(
      `scope ${JSON.stringify(config.scope.id)} expected ${config.scope.expectedItems} items, ` +
      `but the exact input artifact contains ${inputArtifact.items.length}`,
    );
  }
  const manifest = await loadEvaluatorSuiteManifest(config.suite.manifest.path, {
    manifestId: config.suite.manifest.manifestId,
    manifestDigest: config.suite.manifest.manifestDigest,
  });
  if (manifest.trialPlan !== null) {
    throw new Error(
      'evaluator suite trialPlan independent_repetitions is valid producer metadata but unsupported by Dailies suite execution',
    );
  }
  const policy = verifyCandidatePolicy(config.policy, manifest);
  const invalidClientId = inputArtifact.items.find(
    (item) => item.id.length > RUBRIST_CLIENT_ITEM_ID_MAX_LENGTH,
  );
  if (invalidClientId !== undefined) {
    throw new Error(
      `input id ${JSON.stringify(invalidClientId.id)} is not a valid Rubrist clientItemId: ` +
      `IDs must be at most ${RUBRIST_CLIENT_ITEM_ID_MAX_LENGTH} characters`,
    );
  }
  const expectedCriterionVersions = new Set(
    manifest.members.map((member) => member.criterionVersionId),
  );
  for (const item of inputArtifact.items) {
    for (const criterionVersionId of Object.keys(item.baseline_labels ?? {})) {
      if (!expectedCriterionVersions.has(criterionVersionId)) {
        throw new Error(
          `input ${JSON.stringify(item.id)} has baseline label for unknown criterion version ${JSON.stringify(criterionVersionId)}`,
        );
      }
    }
  }

  return { inputArtifact, manifest, policy };
}

async function executePreflightedSuiteRelease(
  config: CandidateAssessmentConfig,
  preflight: PreflightedCandidateAssessment,
  now: () => Date,
  startedAt: string,
): Promise<CandidateAssessmentReport> {
  const { inputArtifact, manifest, policy } = preflight;

  const executions = await mapPool(inputArtifact.items, config.concurrency, (item) =>
    executeCandidate(config, item));
  const candidateItems = executions.map((execution) =>
    'success' in execution ? execution.success.result : execution.failure);
  const deadline = Date.now() + config.suite.provider.evidenceDeadlineMs;
  const collected = await mapPool(manifest.members, config.concurrency, (member) =>
    collectCriterion(
      manifest,
      member,
      config,
      candidateItems,
      deadline,
      inputArtifact.digest,
    ));
  const policyInputs = collected.map((result) => ({
    criterionVersionId: result.criterionVersionId,
    evidenceState: result.evidence.state,
    trustAdmissible: result.trust.status === 'complete' && result.trust.admissible,
    passed: result.totals.passed,
    total: result.totals.total,
    passRate: result.totals.passRate,
    regressions: result.totals.regressions,
  }));
  const candidateFailed = candidateItems.some((item) => item.status === 'error');
  const candidateIntegrityFailure = candidateItems.some(
    (item) => item.status === 'error' && item.errorKind === 'protocol',
  );
  const applied = applyCandidatePolicy(
    policy,
    policyInputs,
    candidateFailed,
    candidateIntegrityFailure,
  );
  const criteria: CandidateAssessmentReport['criteria'] = collected.map((result, index) => ({
    ...result,
    policyResult: {
      evidenceRequirement: applied.criteria[index]!.evidenceRequirement,
      consequence: applied.criteria[index]!.consequence,
      rulePassed: applied.criteria[index]!.rulePassed,
    },
  }));
  const policyDigest = candidatePolicyDigest(policy);
  const successfulCandidates = candidateItems.filter(
    (candidate): candidate is SuiteCandidateItem & { status: 'success'; candidate_output: string } =>
      candidate.status === 'success' && candidate.candidate_output !== undefined,
  );
  const executionPolicy: CandidateAssessmentReport['executionPolicy'] = {
    scheduling: 'manifest_order_bounded_pool/v1',
    deadlineStartsAt: 'after_candidate_execution',
    evidenceDeadlineMs: config.suite.provider.evidenceDeadlineMs,
    pollIntervalMs: config.suite.provider.pollIntervalMs,
    perCallTimeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
    provider: providerExecutionIdentity(config.suite.provider),
    candidate: candidateExecutionIdentity(config.candidate),
  };
  const report: CandidateAssessmentReport = {
    startedAt,
    finishedAt: now().toISOString(),
    scope: suiteReleaseScope(config, inputArtifact),
    trustPolicy: config.trustPolicy,
    manifest,
    policy,
    policyDigest,
    executionPolicy,
    executionPolicyDigest: suiteExecutionPolicyDigest(executionPolicy),
    candidateExecution: {
      total: candidateItems.length,
      succeeded: candidateItems.filter((item) => item.status === 'success').length,
      failed: candidateItems.filter((item) => item.status === 'error').length,
      items: candidateItems,
    },
    candidateDatasetDigest: suiteCandidateDatasetDigest(successfulCandidates.map((candidate) => ({
      id: candidate.id,
      input: candidate.input,
      output: candidate.candidate_output,
    }))),
    criteria,
    compensation: applied.compensation,
    decision: applied.decision,
    decisionPrecedence: applied.precedence,
    decisionStatement: buildCandidateAssessmentDecisionStatement(
      applied.decision,
      policy.id,
      policy.version,
      policyDigest,
      manifest.manifestId,
      manifest.manifestDigest,
      config.scope.kind,
      config.scope.id,
      inputArtifact.digest,
    ),
  };
  return candidateAssessmentReportSchema.parse(report);
}

/** Execute one already-preflighted candidate-assessment snapshot without reopening files. */
export async function runPreflightedCandidateAssessment(
  config: CandidateAssessmentConfig,
  preflight: PreflightedCandidateAssessment,
  options: RunCandidateAssessmentOptions = {},
): Promise<CandidateAssessmentReport> {
  const now = options.now ?? (() => new Date());
  return executePreflightedSuiteRelease(config, preflight, now, now().toISOString());
}

export async function runCandidateAssessment(
  config: CandidateAssessmentConfig,
  options: RunCandidateAssessmentOptions = {},
): Promise<CandidateAssessmentReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const preflight = await preflightCandidateAssessment(config);
  return executePreflightedSuiteRelease(config, preflight, now, startedAt);
}
