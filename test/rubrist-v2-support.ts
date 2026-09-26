import { readFileSync } from 'node:fs';
import { sha256Digest } from '../src/rubrist.js';
import type { RubristEvaluatorIdentity } from '../src/rubrist-v2.js';

// Receipt v2 test support: signed receipts for an evaluator identity, and the
// identities behind the vendored manifest fixture's members.

function contractFixture(name: string): { evaluator: { identity: RubristEvaluatorIdentity } } {
  return JSON.parse(readFileSync(new URL(`../contracts/fixtures/${name}`, import.meta.url), 'utf8'));
}

type CalibrationFixtureName = 'complete' | 'typed-question' | 'repeated' | 'incomplete';

/** The evaluator identity a calibration fixture carries. */
export function knownEvaluatorIdentity(name: CalibrationFixtureName): RubristEvaluatorIdentity {
  return structuredClone(contractFixture(`binary-calibration-v2.${name}.json`).evaluator.identity);
}

/** The calibration fixtures carry the evaluator identities the manifest fixture's skillDigests name. */
const KNOWN_IDENTITIES: RubristEvaluatorIdentity[] = (
  ['complete', 'typed-question', 'repeated', 'incomplete'] as const
).map(knownEvaluatorIdentity);

/** The identity whose skillDigest v2 is the member's. */
export function evaluatorIdentityFor(member: { skillDigest: string; skillVersionId: string }): RubristEvaluatorIdentity {
  const identity = KNOWN_IDENTITIES.find((candidate) => sha256Digest(candidate) === member.skillDigest);
  if (identity === undefined) throw new Error(`no known evaluator identity for ${member.skillVersionId}`);
  return structuredClone(identity);
}

/** A different, digest-valid identity, for receipts that must fail a manifest binding. */
export function otherEvaluatorIdentity(identity: RubristEvaluatorIdentity): RubristEvaluatorIdentity {
  return { ...structuredClone(identity), definitionDigest: `sha256:${'9'.repeat(64)}` };
}

export type ReceiptItemResult =
  | { state: 'outcome'; outcome: 'pass' | 'fail' | 'abstain' }
  | { state: 'failure'; failureKind: string }
  | { state: 'not_attempted' };

export interface ReceiptItemInput {
  clientItemId: string;
  caseId: string;
  input: string;
  output: string;
  result: ReceiptItemResult;
}

const NOTHING_OBSERVED = {
  model: null,
  requestId: null,
  responseId: null,
  systemFingerprint: null,
  upstreamProvider: null,
  thinkingReturned: null,
  reasoningTokens: null,
};

export interface ReceiptV2Options {
  evalRunId: string;
  projectId: string;
  skillId: string;
  skillVersionId: string;
  evaluator: RubristEvaluatorIdentity;
  items: ReceiptItemInput[];
  runStatus: 'completed' | 'failed' | 'canceled';
}

/** A signed, internally consistent receipt v2: sorted items, recomputed counters and digests. */
export function receiptV2(options: ReceiptV2Options): Record<string, unknown> {
  const protocol = options.evaluator.executionBinding.verdictProtocol;
  const scoreKind = protocol === 'typed-question/v1' ? 'native_probability' : 'self_reported_score';
  const items = [...options.items]
    .sort((left, right) => left.clientItemId < right.clientItemId ? -1 : left.clientItemId > right.clientItemId ? 1 : 0)
    .map((item) => {
      const base = {
        clientItemId: item.clientItemId,
        caseId: item.caseId,
        contentDigest: sha256Digest({ input: item.input, output: item.output }),
        result: item.result,
      };
      if (item.result.state === 'outcome') {
        const value = item.result.outcome === 'pass' ? 0.9 : item.result.outcome === 'fail' ? 0.1 : 0.5;
        return {
          ...base,
          verdictId: `verdict-${item.caseId}`,
          evaluatorScore: { value, kind: scoreKind },
          observed: {
            ...NOTHING_OBSERVED,
            model: options.evaluator.executionBinding.modelId,
            requestId: `request-${item.caseId}`,
          },
        };
      }
      return {
        ...base,
        verdictId: null,
        evaluatorScore: null,
        observed: item.result.state === 'failure' ? NOTHING_OBSERVED : null,
      };
    });
  const outcomes = (outcome: string) =>
    items.filter((item) => item.result.state === 'outcome' && item.result.outcome === outcome).length;
  const complete = options.runStatus === 'completed' && items.every((item) => item.result.state === 'outcome');
  const receipt: Record<string, unknown> = {
    contract: 'rubrist/assessment-receipt/v2',
    schemaVersion: 2,
    receiptId: `receipt-${options.evalRunId}`,
    evalRunId: options.evalRunId,
    projectId: options.projectId,
    skillId: options.skillId,
    skillVersionId: options.skillVersionId,
    status: complete ? 'complete' : 'incomplete',
    run: {
      status: options.runStatus,
      totalItems: items.length,
      passItems: outcomes('pass'),
      failItems: outcomes('fail'),
      abstainedItems: outcomes('abstain'),
      failedItems: items.filter((item) => item.result.state === 'failure').length,
      notAttemptedItems: items.filter((item) => item.result.state === 'not_attempted').length,
      agreedItems: 0,
    },
    evaluator: options.evaluator,
    skillDigest: sha256Digest(options.evaluator),
    datasetDigest: sha256Digest(items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest }))),
    items,
  };
  receipt.evidenceDigest = sha256Digest(receipt);
  return receipt;
}
