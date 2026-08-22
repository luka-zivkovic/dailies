import { describe, expect, it } from 'vitest';
import { parseSuiteConfig } from '../src/config-v5.js';

const digest = `sha256:${'1'.repeat(64)}`;
const base = {
  schemaVersion: 5,
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
    provider: { type: 'coeval', url: 'https://coeval.example' },
  },
  policy: {
    schemaVersion: 1,
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

describe('suite config v5', () => {
  it('is additive and applies bounded provider defaults', () => {
    expect(parseSuiteConfig(base)).toMatchObject({
      schemaVersion: 5,
      suite: { provider: { pollIntervalMs: 1_000, evidenceDeadlineMs: 300_000 } },
      concurrency: 4,
      timeoutMs: 60_000,
    });
  });

  it('rejects v4, unknown fields, ambiguous consequence rules, and implicit compensation', () => {
    expect(() => parseSuiteConfig({ ...base, schemaVersion: 4 })).toThrow(/requires schemaVersion 5/);
    expect(() => parseSuiteConfig({ ...base, thresholds: { minPassRate: 1, maxRegressions: 0 } }))
      .toThrow();
    expect(() => parseSuiteConfig({
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
    expect(() => parseSuiteConfig({
      ...base,
      policy: {
        ...base.policy,
        criteria: [{
          ...base.policy.criteria[0],
          evidenceRequirement: 'optional',
        }],
      },
    })).toThrow();
    expect(() => parseSuiteConfig({
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
    expect(() => parseSuiteConfig({
      ...base,
      suite: { ...base.suite, provider: { ...base.suite.provider, evidenceDeadlineMs: 0 } },
    })).toThrow();
    expect(() => parseSuiteConfig({
      ...base,
      trustPolicy: { admissibleClasses: ['self_reported'] },
    })).toThrow(/override/i);
  });
});
