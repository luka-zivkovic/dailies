import { runCandidate } from './candidate.js';
import type { Config, InputItem } from './config.js';
import {
  RUBRIST_CLIENT_ITEM_ID_MAX_LENGTH,
  RubristCollectionError,
  RubristProtocolError,
  collectRubristAssessment,
  type RubristEvidenceOperation,
} from './rubrist.js';
import type { RubristOutcome, RubristReceiptV2 } from './rubrist-receipt-v2.js';
import { classifyOperationError } from './errors.js';
import { judgeItem } from './judge.js';
import { loadInputArtifact } from './inputs.js';
import { mapPool } from './pool.js';
import {
  aggregate,
  buildDecisionStatement,
  compareOutcome,
  decideDecision,
  REPORT_SCHEMA_VERSION,
  reportSchema,
  type ItemResult,
  type Report,
} from './report.js';
import {
  RetryFailure,
  runWithRetry,
  type AttemptRecord,
} from './retry.js';

interface CandidateSuccess {
  item: InputItem;
  base: Pick<ItemResult, 'id' | 'input' | 'baseline_label' | 'baseline_output'>;
  candidateOutput: string;
  candidateAttempts: AttemptRecord[];
}

type CandidateExecution =
  | { success: CandidateSuccess }
  | { failure: ItemResult };

async function executeCandidate(config: Config, item: InputItem): Promise<CandidateExecution> {
  const base: Pick<ItemResult, 'id' | 'input' | 'baseline_label' | 'baseline_output'> = {
    id: item.id,
    input: item.input,
    ...(item.baseline_label !== undefined ? { baseline_label: item.baseline_label } : {}),
    ...(item.baseline_output !== undefined ? { baseline_output: item.baseline_output } : {}),
  };

  try {
    const result = await runWithRetry(() =>
      runCandidate(config.candidate, item.input, config.timeoutMs),
    );
    return {
      success: {
        item,
        base,
        candidateOutput: result.value,
        candidateAttempts: result.attempts,
      },
    };
  } catch (err) {
    const retryFailure = err instanceof RetryFailure ? err : undefined;
    const originalError = retryFailure?.originalError ?? err;
    const attempts = retryFailure?.attempts ?? [
      {
        attempt: 1,
        outcome: 'error' as const,
        errorKind: classifyOperationError(originalError).kind,
        retryable: false,
      },
    ];
    return {
      failure: {
        ...base,
        error: `candidate failed after ${attempts.length} attempt(s): ${originalError instanceof Error ? originalError.message : String(originalError)}`,
        outcome: 'error',
        errorStage: 'candidate',
        errorKind: classifyOperationError(originalError).kind,
        pass: false,
        comparison: 'unpaired',
        // No judge result exists, so this is incomplete evidence rather than a
        // measured regression against the baseline.
        regression: false,
        attempts: { candidate: attempts },
      },
    };
  }
}

async function judgeCandidate(config: Config, execution: CandidateSuccess): Promise<ItemResult> {
  const { item, base, candidateOutput } = execution;
  try {
    const result = await runWithRetry(() =>
      judgeItem(config.judge, item.input, candidateOutput, item.baseline_output, config.timeoutMs),
    );
    const judge = result.value;
    const outcome = judge.pass ? 'pass' : 'fail';
    const comparison = compareOutcome(item.baseline_label, outcome);
    return {
      ...base,
      candidate_output: candidateOutput,
      judge,
      outcome,
      pass: judge.pass,
      comparison,
      regression: comparison === 'regression',
      trustClass: config.judge.type === 'exact-match' ? 'deterministic' : 'self_reported',
      attempts: { candidate: execution.candidateAttempts, judge: result.attempts },
    };
  } catch (err) {
    const retryFailure = err instanceof RetryFailure ? err : undefined;
    const originalError = retryFailure?.originalError ?? err;
    const judgeAttempts = retryFailure?.attempts ?? [
      {
        attempt: 1,
        outcome: 'error' as const,
        errorKind: classifyOperationError(originalError).kind,
        retryable: false,
      },
    ];
    return {
      ...base,
      candidate_output: candidateOutput,
      error: `judge failed after ${judgeAttempts.length} attempt(s): ${originalError instanceof Error ? originalError.message : String(originalError)}`,
      outcome: 'error',
      errorStage: 'judge',
      errorKind: classifyOperationError(originalError).kind,
      pass: false,
      comparison: 'unpaired',
      regression: false,
      attempts: { candidate: execution.candidateAttempts, judge: judgeAttempts },
    };
  }
}

function rubristJudgeFailure(execution: CandidateSuccess, err: unknown): ItemResult {
  const detail = classifyOperationError(err);
  const logicalKind = detail.kind === 'protocol' ? 'protocol' : 'incomplete';
  return {
    ...execution.base,
    candidate_output: execution.candidateOutput,
    error: `Rubrist judge failed: ${err instanceof Error ? err.message : String(err)}`,
    outcome: 'error',
    errorStage: 'judge',
    errorKind: logicalKind,
    pass: false,
    comparison: 'unpaired',
    regression: false,
    attempts: {
      candidate: execution.candidateAttempts,
    },
  };
}

/** An abstention counts as not passing (ADR-0009). */
function rubristJudgedResult(
  execution: CandidateSuccess,
  outcome: RubristOutcome,
): ItemResult {
  const pass = outcome === 'pass';
  const comparison = compareOutcome(execution.item.baseline_label, outcome);
  return {
    ...execution.base,
    candidate_output: execution.candidateOutput,
    judge: {
      score: pass ? 1 : 0,
      pass,
      reason: outcome === 'abstain'
        ? 'Rubrist assessment receipt: the evaluator abstained'
        : `Rubrist assessment receipt judged ${outcome}`,
    },
    outcome,
    pass,
    comparison,
    regression: comparison === 'regression',
    trustClass: 'verified',
    attempts: {
      candidate: execution.candidateAttempts,
    },
  };
}

export interface RunShadowOptions {
  /** Injectable wall clock for deterministic report tests and reproducible harnesses. */
  now?: () => Date;
}

/** Run the full shadow evaluation. Throws on run errors (bad inputs file, etc.). */
export async function runShadow(config: Config, options: RunShadowOptions = {}): Promise<Report> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const inputArtifact = await loadInputArtifact(config.inputs.path, config.inputs.digest);
  const inputs = inputArtifact.items;
  if (inputs.length !== config.scope.expectedItems) {
    throw new Error(
      `scope ${JSON.stringify(config.scope.id)} expected ${config.scope.expectedItems} items, ` +
        `but the exact input artifact contains ${inputs.length}`,
    );
  }

  if (config.judge.type === 'rubrist') {
    const invalid = inputs.find(
      (item) => item.id.length > RUBRIST_CLIENT_ITEM_ID_MAX_LENGTH,
    );
    if (invalid) {
      throw new Error(
        `input id ${JSON.stringify(invalid.id)} is not a valid Rubrist clientItemId: ` +
          `IDs must be at most ${RUBRIST_CLIENT_ITEM_ID_MAX_LENGTH} characters`,
      );
    }
  }

  if (config.judge.type === 'exact-match') {
    const missing = inputs.find((item) => item.baseline_output === undefined);
    if (missing) {
      throw new Error(
        `input ${missing.id} is missing baseline_output required by the exact-match judge`,
      );
    }
  }

  // Candidate execution is deliberately a separate phase. A Rubrist judge must
  // receive all successful traces in one release-evidence batch, while failed
  // required candidates remain Dailies-owned blocking results.
  const candidateExecutions = await mapPool(inputs, config.concurrency, (item) =>
    executeCandidate(config, item),
  );

  let evidence: {
    provider: 'rubrist';
    skillVersionId: string;
    evalRunId?: string;
    status: 'complete' | 'incomplete' | 'failed';
    operations: RubristEvidenceOperation[];
    receipt?: RubristReceiptV2;
  } | undefined;
  let items: ItemResult[];
  if (config.judge.type === 'rubrist') {
    const successful = candidateExecutions.flatMap((execution) =>
      'success' in execution ? [execution.success] : [],
    );
    let judged = new Map<string, ItemResult>();
    if (successful.length > 0) {
      try {
        const assessment = await collectRubristAssessment(
          config.judge,
          successful.map((execution) => ({
            id: execution.item.id,
            input: execution.item.input,
            output: execution.candidateOutput,
          })),
          config.timeoutMs,
        );
        evidence = {
          provider: 'rubrist',
          skillVersionId: config.judge.skillVersionId,
          evalRunId: assessment.evalRunId,
          status: 'complete',
          operations: assessment.operations,
          receipt: assessment.receipt,
        };
        judged = new Map(
          successful.map((execution) => {
            const outcome = assessment.outcomes.get(execution.item.id);
            if (outcome === undefined) {
              throw new RubristProtocolError(`missing verified outcome for ${execution.item.id}`);
            }
            return [execution.item.id, rubristJudgedResult(execution, outcome)];
          }),
        );
      } catch (err) {
        judged = new Map(
          successful.map((execution) => [execution.item.id, rubristJudgeFailure(execution, err)]),
        );
        if (err instanceof RubristCollectionError) {
          evidence = {
            provider: 'rubrist',
            skillVersionId: config.judge.skillVersionId,
            ...(err.evalRunId === undefined ? {} : { evalRunId: err.evalRunId }),
            status: err.receipt === undefined ? 'failed' : 'incomplete',
            operations: err.operations,
            ...(err.receipt === undefined ? {} : { receipt: err.receipt }),
          };
        } else {
          evidence = undefined;
        }
      }
    }
    items = candidateExecutions.map((execution) =>
      'failure' in execution
        ? execution.failure
        : (judged.get(execution.success.item.id) ??
          rubristJudgeFailure(
            execution.success,
            new RubristProtocolError(`missing judge result for ${execution.success.item.id}`),
          )),
    );
  } else {
    items = await mapPool(candidateExecutions, config.concurrency, (execution) =>
      'failure' in execution
        ? Promise.resolve(execution.failure)
        : judgeCandidate(config, execution.success),
    );
  }

  const totals = aggregate(items);
  const trustPath = config.judge.type === 'exact-match'
    ? { class: 'deterministic' as const, derivation: 'exact_match_v1' as const }
    : config.judge.type === 'rubrist'
      ? { class: 'verified' as const, derivation: 'rubrist_receipt_v2' as const }
      : { class: 'self_reported' as const, derivation: 'http_judge_v1' as const };
  const policyAdmissible = config.trustPolicy.admissibleClasses.includes(trustPath.class);
  const trust = totals.evaluated > 0
    ? { status: 'complete' as const, ...trustPath, admissible: policyAdmissible }
    : {
        status: 'unavailable' as const,
        derivation: trustPath.derivation,
        admissible: false as const,
        reason: 'no_completed_evidence' as const,
      };
  const admissible = trust.status === 'complete' && trust.admissible;
  const decision = decideDecision(totals, config.thresholds, admissible);
  const report: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    judgeType: config.judge.type,
    startedAt,
    finishedAt: now().toISOString(),
    thresholds: config.thresholds,
    totals,
    scope: {
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
        itemCount: inputs.length,
      },
      coverage: {
        expectedItems: config.scope.expectedItems,
        observedItems: inputs.length,
        evaluatedItems: totals.evaluated,
      },
      producerProvenance: {
        datasetRevision: 'not_provided',
        exposure: 'not_provided',
        review: 'not_provided',
      },
    },
    trustPolicy: config.trustPolicy,
    trust,
    decision,
    decisionStatement: buildDecisionStatement(
      decision,
      config.scope.kind,
      config.scope.id,
      inputArtifact.digest,
    ),
    ...(evidence === undefined ? {} : { evidence }),
    items,
  };
  // Validate the report against its versioned schema before anyone consumes it.
  return reportSchema.parse(report);
}
