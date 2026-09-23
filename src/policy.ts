import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './rubrist.js';
import type { EvaluatorSuiteManifest } from './suite-manifest.js';

const nonBlankStringSchema = z.string().min(1).refine((value) => value.trim().length > 0);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const binaryThresholdRuleSchema = z.object({
  kind: z.literal('binary_threshold/v1'),
  minPassRate: z.number().min(0).max(1),
  maxRegressions: z.number().int().nonnegative(),
}).strict();

export const passRateOperandRuleSchema = z.object({
  kind: z.literal('pass_rate_operand/v1'),
  unit: z.literal('pass_rate_ratio'),
}).strict();

export const criterionPolicySchema = z.discriminatedUnion('consequence', [
  z.object({
    criterionVersionId: nonBlankStringSchema,
    evidenceRequirement: z.literal('mandatory'),
    consequence: z.literal('blocking'),
    rule: binaryThresholdRuleSchema,
  }).strict(),
  z.object({
    criterionVersionId: nonBlankStringSchema,
    evidenceRequirement: z.enum(['mandatory', 'optional']),
    consequence: z.literal('advisory'),
    rule: binaryThresholdRuleSchema,
  }).strict(),
  z.object({
    criterionVersionId: nonBlankStringSchema,
    evidenceRequirement: z.literal('mandatory'),
    consequence: z.literal('compensatory'),
    compensationGroupId: nonBlankStringSchema,
    rule: passRateOperandRuleSchema,
  }).strict(),
]);

export const compensationFormulaSchema = z.object({
  contract: z.literal('dailies/weighted-pass-rate/v1'),
  unit: z.literal('pass_rate_ratio'),
  minimumPassRate: z.number().min(0).max(1),
  terms: z.array(z.object({
    criterionVersionId: nonBlankStringSchema,
    weightBasisPoints: z.number().int().positive().max(10_000),
  }).strict()).min(2),
}).strict().superRefine((formula, ctx) => {
  const identities = formula.terms.map((term) => term.criterionVersionId);
  if (new Set(identities).size !== identities.length) {
    ctx.addIssue({ code: 'custom', path: ['terms'], message: 'formula terms must be unique' });
  }
  const total = formula.terms.reduce((sum, term) => sum + term.weightBasisPoints, 0);
  if (total !== 10_000) {
    ctx.addIssue({
      code: 'custom',
      path: ['terms'],
      message: 'formula weightBasisPoints must total exactly 10000',
    });
  }
});

export const releasePolicyV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: nonBlankStringSchema,
  version: nonBlankStringSchema,
  manifestId: nonBlankStringSchema,
  manifestDigest: digestSchema,
  criteria: z.array(criterionPolicySchema).min(1),
  compensationGroups: z.array(z.object({
    id: nonBlankStringSchema,
    formula: compensationFormulaSchema,
  }).strict()).default([]),
}).strict();

export type CriterionPolicy = z.infer<typeof criterionPolicySchema>;
export type CompensationFormula = z.infer<typeof compensationFormulaSchema>;
export type ReleasePolicyV1 = z.infer<typeof releasePolicyV1Schema>;

export function releasePolicyDigest(policy: ReleasePolicyV1): string {
  return `sha256:${createHash('sha256').update(canonicalJson(policy)).digest('hex')}`;
}

export function verifyReleasePolicy(
  raw: unknown,
  manifest: EvaluatorSuiteManifest,
): ReleasePolicyV1 {
  const policy = releasePolicyV1Schema.parse(raw);
  if (policy.manifestId !== manifest.manifestId) {
    throw new Error(`policy manifestId mismatch: expected ${manifest.manifestId}`);
  }
  if (policy.manifestDigest !== manifest.manifestDigest) {
    throw new Error(`policy manifestDigest mismatch: expected ${manifest.manifestDigest}`);
  }
  if (policy.criteria.length !== manifest.members.length) {
    throw new Error('policy must have exact manifest criterion coverage');
  }
  const criterionIds = policy.criteria.map((entry) => entry.criterionVersionId);
  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new Error('policy criterionVersionId values must be unique');
  }
  for (const [index, member] of manifest.members.entries()) {
    if (policy.criteria[index]?.criterionVersionId !== member.criterionVersionId) {
      throw new Error('policy criteria must exactly follow manifest order');
    }
  }
  const groups = new Map<string, (typeof policy.compensationGroups)[number]>();
  for (const group of policy.compensationGroups) {
    if (groups.has(group.id)) throw new Error('compensation group ids must be unique');
    groups.set(group.id, group);
  }
  const compensatory = policy.criteria.filter(
    (entry): entry is Extract<CriterionPolicy, { consequence: 'compensatory' }> =>
      entry.consequence === 'compensatory',
  );
  const expectedByGroup = new Map<string, string[]>();
  for (const entry of compensatory) {
    const values = expectedByGroup.get(entry.compensationGroupId) ?? [];
    values.push(entry.criterionVersionId);
    expectedByGroup.set(entry.compensationGroupId, values);
    if (!groups.has(entry.compensationGroupId)) {
      throw new Error(`missing compensation group ${entry.compensationGroupId}`);
    }
  }
  for (const group of policy.compensationGroups) {
    const expected = expectedByGroup.get(group.id);
    if (expected === undefined) {
      throw new Error(`compensation group ${group.id} has no compensatory criteria`);
    }
    const actual = group.formula.terms.map((term) => term.criterionVersionId);
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
      throw new Error(`compensation group ${group.id} must exactly cover its criteria in manifest order`);
    }
  }
  return policy;
}

export type CriterionEvidenceState = 'complete' | 'incomplete' | 'integrity_failure';

export interface CriterionPolicyInput {
  criterionVersionId: string;
  evidenceState: CriterionEvidenceState;
  trustAdmissible: boolean;
  passed: number;
  total: number;
  passRate: number;
  regressions: number;
}

export interface CriterionPolicyResult extends CriterionPolicyInput {
  evidenceRequirement: CriterionPolicy['evidenceRequirement'];
  consequence: CriterionPolicy['consequence'];
  rulePassed: boolean | null;
}

export interface CompensationResult {
  id: string;
  status: 'complete' | 'incomplete';
  weightedPassRate: number | null;
  minimumPassRate: number;
  passed: boolean | null;
  exactComparison: {
    weightedNumerator: string;
    weightedDenominator: string;
    minimumNumerator: string;
    minimumDenominator: string;
  } | null;
}

export type DecisionPrecedence =
  | 'required_integrity_failure'
  | 'candidate_execution_failure'
  | 'complete_blocking_failure'
  | 'mandatory_evidence_incomplete'
  | 'compensation_failure'
  | 'policy_satisfied';

export interface PolicyDecision {
  decision: 'promote' | 'block' | 'inconclusive';
  precedence: DecisionPrecedence;
  criteria: CriterionPolicyResult[];
  compensation: CompensationResult[];
}

function rulePass(entry: CriterionPolicy, input: CriterionPolicyInput): boolean | null {
  if (input.evidenceState !== 'complete' || !input.trustAdmissible) return null;
  // Compensatory entries are operands, not independently gated rules. The
  // compensation formula is the only place where their pass rates are judged.
  if (entry.rule.kind === 'pass_rate_operand/v1') return null;
  return input.passRate >= entry.rule.minPassRate &&
    input.regressions <= entry.rule.maxRegressions;
}

interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function normalizeFraction(fraction: Fraction): Fraction {
  const divisor = gcd(fraction.numerator, fraction.denominator);
  return {
    numerator: fraction.numerator / divisor,
    denominator: fraction.denominator / divisor,
  };
}

function addFractions(left: Fraction, right: Fraction): Fraction {
  return normalizeFraction({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

function decimalFraction(value: number): Fraction {
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, decimal = ''] = coefficient!.split('.');
  const digits = `${whole}${decimal}`;
  let numerator = BigInt(digits);
  let denominator = 10n ** BigInt(decimal.length);
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator *= 10n ** BigInt(-exponent);
  return normalizeFraction({ numerator, denominator });
}

export function applyReleasePolicy(
  policy: ReleasePolicyV1,
  evidence: CriterionPolicyInput[],
  candidateExecutionFailed: boolean,
  candidateIntegrityFailure = false,
): PolicyDecision {
  const byId = new Map(evidence.map((entry) => [entry.criterionVersionId, entry]));
  if (byId.size !== evidence.length || evidence.length !== policy.criteria.length) {
    throw new Error('policy evaluation requires exact unique criterion evidence coverage');
  }
  const criteria = policy.criteria.map((entry): CriterionPolicyResult => {
    const input = byId.get(entry.criterionVersionId);
    if (input === undefined) {
      throw new Error(`missing criterion evidence ${entry.criterionVersionId}`);
    }
    return {
      ...input,
      evidenceRequirement: entry.evidenceRequirement,
      consequence: entry.consequence,
      rulePassed: rulePass(entry, input),
    };
  });
  const compensation = policy.compensationGroups.map((group): CompensationResult => {
    const operands = group.formula.terms.map((term) => ({
      term,
      result: criteria.find((entry) => entry.criterionVersionId === term.criterionVersionId),
    }));
    const complete = operands.every(({ result }) =>
      result?.evidenceState === 'complete' && result.trustAdmissible);
    if (!complete) {
      return {
        id: group.id,
        status: 'incomplete',
        weightedPassRate: null,
        minimumPassRate: group.formula.minimumPassRate,
        passed: null,
        exactComparison: null,
      };
    }
    const weightedPassRate = operands.reduce(
      (sum, { term, result }) => sum + result!.passRate * term.weightBasisPoints,
      0,
    ) / 10_000;
    const weighted = operands.reduce<Fraction>((sum, { term, result }) =>
      addFractions(sum, {
        numerator: BigInt(term.weightBasisPoints) * BigInt(result!.passed),
        denominator: 10_000n * BigInt(result!.total),
      }), { numerator: 0n, denominator: 1n });
    const minimum = decimalFraction(group.formula.minimumPassRate);
    const passed = weighted.numerator * minimum.denominator >=
      minimum.numerator * weighted.denominator;
    return {
      id: group.id,
      status: 'complete',
      weightedPassRate,
      minimumPassRate: group.formula.minimumPassRate,
      passed,
      exactComparison: {
        weightedNumerator: weighted.numerator.toString(),
        weightedDenominator: weighted.denominator.toString(),
        minimumNumerator: minimum.numerator.toString(),
        minimumDenominator: minimum.denominator.toString(),
      },
    };
  });

  const isRequired = (entry: CriterionPolicyResult) =>
    entry.evidenceRequirement === 'mandatory' || entry.consequence === 'compensatory';
  if (candidateIntegrityFailure || criteria.some(
    (entry) => isRequired(entry) && entry.evidenceState === 'integrity_failure',
  )) {
    return { decision: 'inconclusive', precedence: 'required_integrity_failure', criteria, compensation };
  }
  if (candidateExecutionFailed) {
    return { decision: 'block', precedence: 'candidate_execution_failure', criteria, compensation };
  }
  if (criteria.some((entry) =>
    entry.consequence === 'blocking' && entry.rulePassed === false)) {
    return { decision: 'block', precedence: 'complete_blocking_failure', criteria, compensation };
  }
  if (criteria.some((entry) =>
    isRequired(entry) &&
    (entry.evidenceState !== 'complete' || !entry.trustAdmissible))) {
    return { decision: 'inconclusive', precedence: 'mandatory_evidence_incomplete', criteria, compensation };
  }
  if (compensation.some((group) => group.passed === false)) {
    return { decision: 'block', precedence: 'compensation_failure', criteria, compensation };
  }
  return { decision: 'promote', precedence: 'policy_satisfied', criteria, compensation };
}
