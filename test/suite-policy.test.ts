import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyReleasePolicy,
  releasePolicyDigest,
  verifyReleasePolicy,
  type CriterionPolicyInput,
  type ReleasePolicyV1,
} from '../src/policy.js';
import {
  verifyEvaluatorSuiteManifestV2,
  type EvaluatorSuiteManifestV2,
} from '../src/suite-manifest-v2.js';

const manifest = verifyEvaluatorSuiteManifestV2(JSON.parse(readFileSync(
  new URL('../contracts/fixtures/evaluator-suite-manifest-v2.complete.json', import.meta.url),
  'utf8',
)) as EvaluatorSuiteManifestV2);

function policy(overrides: Partial<ReleasePolicyV1> = {}): ReleasePolicyV1 {
  return verifyReleasePolicy({
    schemaVersion: 1,
    id: 'customer-release',
    version: '1',
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    criteria: [
      {
        criterionVersionId: manifest.members[0]!.criterionVersionId,
        evidenceRequirement: 'mandatory',
        consequence: 'blocking',
        rule: { kind: 'binary_threshold/v1', minPassRate: 0.9, maxRegressions: 0 },
      },
      {
        criterionVersionId: manifest.members[1]!.criterionVersionId,
        evidenceRequirement: 'mandatory',
        consequence: 'advisory',
        rule: { kind: 'binary_threshold/v1', minPassRate: 0.8, maxRegressions: 1 },
      },
    ],
    compensationGroups: [],
    ...overrides,
  }, manifest);
}

function evidence(
  first: Partial<CriterionPolicyInput> = {},
  second: Partial<CriterionPolicyInput> = {},
): CriterionPolicyInput[] {
  return [
    {
      criterionVersionId: manifest.members[0]!.criterionVersionId,
      evidenceState: 'complete',
      trustAdmissible: true,
      passed: 2,
      total: 2,
      passRate: 1,
      regressions: 0,
      ...first,
    },
    {
      criterionVersionId: manifest.members[1]!.criterionVersionId,
      evidenceState: 'complete',
      trustAdmissible: true,
      passed: 2,
      total: 2,
      passRate: 1,
      regressions: 0,
      ...second,
    },
  ];
}

describe('criterion release policy v1', () => {
  it('requires exact ordered policy coverage and pins the manifest identity', () => {
    expect(policy().criteria.map((entry) => entry.criterionVersionId)).toEqual(
      manifest.members.map((member) => member.criterionVersionId),
    );
    expect(() => policy({ manifestDigest: `sha256:${'0'.repeat(64)}` })).toThrow(/manifestDigest/);
    expect(() => policy({ criteria: policy().criteria.slice(0, 1) })).toThrow(/exact/);
    expect(() => policy({ criteria: [...policy().criteria].reverse() })).toThrow(/manifest order/);
    expect(releasePolicyDigest(policy())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('implements the accepted mixed-evidence precedence exactly', () => {
    const accepted = policy();
    expect(applyReleasePolicy(accepted, evidence({ evidenceState: 'integrity_failure' }), true))
      .toMatchObject({ decision: 'inconclusive', precedence: 'required_integrity_failure' });
    expect(applyReleasePolicy(accepted, evidence(), true))
      .toMatchObject({ decision: 'block', precedence: 'candidate_execution_failure' });
    expect(applyReleasePolicy(
      accepted,
      evidence({ passRate: 0 }, { evidenceState: 'incomplete' }),
      false,
    )).toMatchObject({ decision: 'block', precedence: 'complete_blocking_failure' });
    expect(applyReleasePolicy(
      accepted,
      evidence({}, { evidenceState: 'incomplete' }),
      false,
    )).toMatchObject({ decision: 'inconclusive', precedence: 'mandatory_evidence_incomplete' });
    expect(applyReleasePolicy(accepted, evidence(), false))
      .toMatchObject({ decision: 'promote', precedence: 'policy_satisfied' });
  });

  it('lets identical criterion evidence support different explicit policies', () => {
    const observed = evidence({ passRate: 0.85 });
    const strict = policy();
    const permissiveCriteria = structuredClone(strict.criteria);
    const first = permissiveCriteria[0]!;
    if (first.rule.kind !== 'binary_threshold/v1') throw new Error('wrong fixture');
    first.rule.minPassRate = 0.8;
    const permissive = policy({ id: 'permissive', criteria: permissiveCriteria });
    expect(applyReleasePolicy(strict, observed, false).decision).toBe('block');
    expect(applyReleasePolicy(permissive, observed, false).decision).toBe('promote');
  });

  it('never lets advisory evidence rescue a block or mandatory incompleteness', () => {
    expect(applyReleasePolicy(policy(), evidence({ passRate: 0 }, { passRate: 1 }), false).decision)
      .toBe('block');
    expect(applyReleasePolicy(
      policy(),
      evidence({ evidenceState: 'incomplete' }, { passRate: 1 }),
      false,
    ).decision).toBe('inconclusive');
  });

  it('compensates only through an explicit same-unit formula', () => {
    const compensatory = policy({
      criteria: manifest.members.map((member, index) => ({
        criterionVersionId: member.criterionVersionId,
        evidenceRequirement: 'mandatory' as const,
        consequence: 'compensatory' as const,
        compensationGroupId: 'quality',
        rule: { kind: 'pass_rate_operand/v1' as const, unit: 'pass_rate_ratio' as const },
      })),
      compensationGroups: [{
        id: 'quality',
        formula: {
          contract: 'dailies/weighted-pass-rate/v1',
          unit: 'pass_rate_ratio',
          minimumPassRate: 0.8,
          terms: [
            { criterionVersionId: manifest.members[0]!.criterionVersionId, weightBasisPoints: 6000 },
            { criterionVersionId: manifest.members[1]!.criterionVersionId, weightBasisPoints: 4000 },
          ],
        },
      }],
    });
    const compensated = applyReleasePolicy(
      compensatory,
      evidence(
        { passRate: 0.7, passed: 7, total: 10 },
        { passRate: 1, passed: 10, total: 10 },
      ),
      false,
    );
    expect(compensated).toMatchObject({
      decision: 'promote',
      criteria: [{ rulePassed: null }, { rulePassed: null }],
      compensation: [{
        weightedPassRate: 0.82,
        passed: true,
        exactComparison: {
          weightedNumerator: '41',
          weightedDenominator: '50',
          minimumNumerator: '4',
          minimumDenominator: '5',
        },
      }],
    });
    const failed = applyReleasePolicy(
      compensatory,
      evidence(
        { passRate: 0.5, passed: 1, total: 2 },
        { passRate: 0.5, passed: 1, total: 2 },
      ),
      false,
    );
    expect(failed).toMatchObject({ decision: 'block', precedence: 'compensation_failure' });

    const raw = structuredClone(compensatory) as Record<string, any>;
    raw.compensationGroups[0].formula.terms[1].weightBasisPoints = 3000;
    expect(() => verifyReleasePolicy(raw, manifest)).toThrow(/10000/);
    const missingFormula = structuredClone(compensatory);
    missingFormula.compensationGroups = [];
    expect(() => verifyReleasePolicy(missingFormula, manifest)).toThrow(/missing compensation group/);
  });

  it('allows only the four explicit evidence/consequence roles and gives compensation no hidden threshold', () => {
    const accepted = policy();
    const optionalAdvisory = structuredClone(accepted);
    optionalAdvisory.criteria[1]!.evidenceRequirement = 'optional';
    expect(() => verifyReleasePolicy(optionalAdvisory, manifest)).not.toThrow();

    for (const consequence of ['blocking', 'compensatory'] as const) {
      const invalid = structuredClone(accepted) as Record<string, any>;
      invalid.criteria[0].evidenceRequirement = 'optional';
      invalid.criteria[0].consequence = consequence;
      if (consequence === 'compensatory') {
        invalid.criteria[0].compensationGroupId = 'quality';
        invalid.criteria[0].rule = {
          kind: 'pass_rate_operand/v1',
          unit: 'pass_rate_ratio',
        };
      }
      expect(() => verifyReleasePolicy(invalid, manifest), consequence).toThrow();
    }

    const raw = structuredClone(accepted) as Record<string, any>;
    raw.criteria[0] = {
      criterionVersionId: manifest.members[0]!.criterionVersionId,
      evidenceRequirement: 'mandatory',
      consequence: 'compensatory',
      compensationGroupId: 'quality',
      rule: { kind: 'pass_rate_operand/v1', unit: 'pass_rate_ratio', minPassRate: 0.5 },
    };
    expect(() => verifyReleasePolicy(raw, manifest)).toThrow();
  });
});
