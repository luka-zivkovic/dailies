import { describe, expect, it } from 'vitest';
import {
  applyReleasePolicy,
  type CriterionPolicyInput,
  type ReleasePolicyV1,
} from '../src/policy.js';

const digest = `sha256:${'1'.repeat(64)}`;
const policy: ReleasePolicyV1 = {
  schemaVersion: 1,
  id: 'properties',
  version: '1',
  manifestId: 'manifest',
  manifestDigest: digest,
  criteria: [
    {
      criterionVersionId: 'blocking',
      evidenceRequirement: 'mandatory',
      consequence: 'blocking',
      rule: { kind: 'binary_threshold/v1', minPassRate: 0.8, maxRegressions: 0 },
    },
    {
      criterionVersionId: 'advisory',
      evidenceRequirement: 'optional',
      consequence: 'advisory',
      rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
    },
  ],
  compensationGroups: [],
};

function observed(
  blocking: Partial<CriterionPolicyInput> = {},
  advisory: Partial<CriterionPolicyInput> = {},
): CriterionPolicyInput[] {
  return [
    {
      criterionVersionId: 'blocking',
      evidenceState: 'complete',
      trustAdmissible: true,
      passed: 1,
      total: 1,
      passRate: 1,
      regressions: 0,
      ...blocking,
    },
    {
      criterionVersionId: 'advisory',
      evidenceState: 'complete',
      trustAdmissible: true,
      passed: 1,
      total: 1,
      passRate: 1,
      regressions: 0,
      ...advisory,
    },
  ];
}

describe('suite decision properties', () => {
  it('advisory evidence cannot alter a decision', () => {
    for (const blockingRate of [0, 0.79, 0.8, 1]) {
      const decisions = new Set<string>();
      for (const advisoryRate of [0, 0.25, 0.75, 1]) {
        decisions.add(applyReleasePolicy(
          policy,
          observed({ passRate: blockingRate }, { passRate: advisoryRate }),
          false,
        ).decision);
      }
      expect(decisions.size).toBe(1);
    }
  });

  it('removing or making required evidence inadmissible never promotes', () => {
    for (const evidenceState of ['incomplete', 'integrity_failure'] as const) {
      expect(applyReleasePolicy(policy, observed({ evidenceState }), false).decision)
        .not.toBe('promote');
    }
    expect(applyReleasePolicy(policy, observed({ trustAdmissible: false }), false).decision)
      .toBe('inconclusive');
  });

  it('preserves all mixed-evidence precedence combinations', () => {
    for (const candidateFailed of [false, true]) {
      expect(applyReleasePolicy(
        policy,
        observed({ evidenceState: 'integrity_failure', passRate: 0 }),
        candidateFailed,
      )).toMatchObject({ decision: 'inconclusive', precedence: 'required_integrity_failure' });
    }
    expect(applyReleasePolicy(policy, observed({ passRate: 0 }), true))
      .toMatchObject({ decision: 'block', precedence: 'candidate_execution_failure' });
    expect(applyReleasePolicy(policy, observed({ passRate: 0 }), false))
      .toMatchObject({ decision: 'block', precedence: 'complete_blocking_failure' });
  });

  it('never improves a blocking decision when its threshold becomes stricter', () => {
    for (const passRate of [0, 0.25, 0.5, 0.75, 1]) {
      for (const lenientThreshold of [0, 0.5, 0.8, 1]) {
        for (const strictThreshold of [0, 0.5, 0.8, 1].filter(
          (threshold) => threshold >= lenientThreshold,
        )) {
          const lenient = structuredClone(policy);
          const strict = structuredClone(policy);
          const lenientRule = lenient.criteria[0]!.rule;
          const strictRule = strict.criteria[0]!.rule;
          if (lenientRule.kind !== 'binary_threshold/v1' || strictRule.kind !== 'binary_threshold/v1') {
            throw new Error('wrong property fixture');
          }
          lenientRule.minPassRate = lenientThreshold;
          strictRule.minPassRate = strictThreshold;
          if (applyReleasePolicy(strict, observed({ passRate }), false).decision === 'promote') {
            expect(applyReleasePolicy(lenient, observed({ passRate }), false).decision)
              .toBe('promote');
          }
        }
      }
    }
  });
});
