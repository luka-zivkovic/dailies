import { describe, expect, it } from 'vitest';
import { parseCandidateAssessmentConfig } from '../src/candidate-assessment-config.js';

const digest = `sha256:${'1'.repeat(64)}`;
const base = {
  inputs: { type: 'jsonl', path: 'inputs.jsonl', digest },
  scope: {
    id: 'scope',
    kind: 'regression_corpus',
    expectedItems: 1,
    collectionProcedure: 'Pinned fixture.',
    population: 'Fixture behavior.',
    timeWindow: { kind: 'not_applicable', reason: 'Static.' },
  },
  candidate: { type: 'command', template: 'printf %s {input}' },
  suite: {
    manifest: { type: 'file', path: 'manifest.json', manifestId: 'manifest', manifestDigest: digest },
    provider: { type: 'rubrist', url: 'https://rubrist.example' },
  },
  policy: {
    id: 'policy',
    version: '1',
    manifestId: 'manifest',
    manifestDigest: digest,
    criteria: [{
      criterionVersionId: 'criterion-v1',
      evidenceRequirement: 'mandatory',
      consequence: 'blocking',
      rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
    }],
    compensationGroups: [],
  },
  output: { dir: 'out' },
};

describe('candidate assessment config', () => {
  it('is additive and applies bounded provider defaults', () => {
    expect(parseCandidateAssessmentConfig(base)).toMatchObject({
      suite: { provider: { pollIntervalMs: 1_000, evidenceDeadlineMs: 300_000 } },
      concurrency: 4,
      timeoutMs: 60_000,
    });
  });

  it('rejects a schemaVersion, unknown fields, ambiguous consequence rules, and implicit compensation', () => {
    expect(() => parseCandidateAssessmentConfig({ ...base, schemaVersion: 4 })).toThrow();
    expect(() => parseCandidateAssessmentConfig({ ...base, thresholds: { minPassRate: 1, maxRegressions: 0 } }))
      .toThrow();
    expect(() => parseCandidateAssessmentConfig({
      ...base,
      policy: {
        ...base.policy,
        criteria: [{
          criterionVersionId: 'criterion-v1',
          evidenceRequirement: 'mandatory',
          consequence: 'compensatory',
          rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
        }],
      },
    })).toThrow();
    expect(() => parseCandidateAssessmentConfig({
      ...base,
      policy: {
        ...base.policy,
        criteria: [{
          ...base.policy.criteria[0],
          evidenceRequirement: 'optional',
        }],
      },
    })).toThrow();
    expect(() => parseCandidateAssessmentConfig({
      ...base,
      policy: {
        ...base.policy,
        criteria: [{
          criterionVersionId: 'criterion-v1',
          evidenceRequirement: 'mandatory',
          consequence: 'compensatory',
          compensationGroupId: 'quality',
          rule: {
            kind: 'pass_rate_operand/v1',
            unit: 'pass_rate_ratio',
            minPassRate: 0.5,
          },
        }],
      },
    })).toThrow();
  });

  it('rejects invalid deadlines and self-reported trust without a reasoned override', () => {
    expect(() => parseCandidateAssessmentConfig({
      ...base,
      suite: { ...base.suite, provider: { ...base.suite.provider, evidenceDeadlineMs: 0 } },
    })).toThrow();
    expect(() => parseCandidateAssessmentConfig({
      ...base,
      trustPolicy: { admissibleClasses: ['self_reported'] },
    })).toThrow(/override/i);
  });
});
