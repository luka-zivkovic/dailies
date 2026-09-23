import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  binaryCalibrationArtifactByteDigest,
  expectedBinaryCalibrationIdentity,
  parseCanonicalBinaryCalibrationBytes,
} from '../src/binary-calibration.js';
import {
  parseSuiteConfigV6,
  type SuiteConfigV6,
} from '../src/config-v6.js';
import { parseSuiteConfig } from '../src/config-v5.js';

const bytes = readFileSync(new URL(
  '../contracts/fixtures/binary-calibration-v1.complete.json',
  import.meta.url,
));
const artifact = parseCanonicalBinaryCalibrationBytes(bytes);
const identity = expectedBinaryCalibrationIdentity(artifact);

function rawConfig(): SuiteConfigV6 {
  return {
    schemaVersion: 6,
    inputs: {
      type: 'jsonl',
      path: 'cases.jsonl',
      digest: `sha256:${'1'.repeat(64)}`,
    },
    scope: {
      id: 'candidate-regression',
      kind: 'regression_corpus',
      expectedItems: 2,
      collectionProcedure: 'Pinned authored regression cases.',
      population: 'Only the named regression behaviors.',
      timeWindow: { kind: 'not_applicable', reason: 'Static corpus.' },
    },
    candidate: { type: 'command', template: 'candidate {input}' },
    suite: {
      manifest: {
        type: 'file',
        path: 'suite.json',
        manifestId: identity.suiteManifestId!,
        manifestDigest: identity.suiteManifestDigest!,
      },
      provider: {
        type: 'rubrist',
        url: 'https://rubrist.example',
        pollIntervalMs: 1_000,
        evidenceDeadlineMs: 60_000,
      },
    },
    policy: {
      schemaVersion: 2,
      id: 'release-policy',
      version: '1',
      manifestId: identity.suiteManifestId!,
      manifestDigest: identity.suiteManifestDigest!,
      criteria: [{
        criterionVersionId: identity.criterionVersionId,
        evidenceRequirement: 'mandatory',
        consequence: 'blocking',
        rule: { kind: 'binary_threshold/v1', minPassRate: 1, maxRegressions: 0 },
        calibrationRequirement: null,
      }],
      compensationGroups: [],
    },
    calibrationEvidence: [{
      criterionVersionId: identity.criterionVersionId,
      source: {
        type: 'file',
        path: 'calibration.json',
        artifactDigest: binaryCalibrationArtifactByteDigest(bytes),
        expectedIdentity: structuredClone(identity),
      },
    }],
    trustPolicy: { admissibleClasses: ['verified', 'deterministic'] },
    concurrency: 2,
    timeoutMs: 1_000,
    output: { dir: 'out' },
  };
}

describe('suite configuration v6', () => {
  it('parses additively without reinterpreting schema v5', () => {
    const parsed = parseSuiteConfigV6(rawConfig());
    expect(parsed.schemaVersion).toBe(6);
    expect(parsed.calibrationEvidence[0]?.source?.expectedIdentity).toEqual(identity);
    expect(() => parseSuiteConfig(rawConfig())).toThrow(/schemaVersion 5/);
  });

  it('requires exact ordered policy coverage but permits explicit source absence', () => {
    const absent = rawConfig();
    absent.calibrationEvidence[0]!.source = null;
    expect(parseSuiteConfigV6(absent).calibrationEvidence[0]?.source).toBeNull();

    const wrong = rawConfig();
    wrong.calibrationEvidence[0]!.criterionVersionId = 'another-criterion';
    expect(() => parseSuiteConfigV6(wrong)).toThrow(/policy criterion order/);

    const missing = rawConfig();
    missing.calibrationEvidence = [];
    expect(() => parseSuiteConfigV6(missing)).toThrow();
  });

  it('requires suite identity fields to be all absent or all present', () => {
    const partial = rawConfig();
    partial.calibrationEvidence[0]!.source!.expectedIdentity.suiteManifestId = null;
    expect(() => parseSuiteConfigV6(partial)).toThrow(/all null or all present/);

    const noSuite = rawConfig();
    Object.assign(noSuite.calibrationEvidence[0]!.source!.expectedIdentity, {
      suiteManifestId: null,
      suiteManifestDigest: null,
      suiteMemberPosition: null,
    });
    expect(() => parseSuiteConfigV6(noSuite)).not.toThrow();
  });

  it('rejects unknown fields and a source bound to another criterion', () => {
    const unknown = rawConfig() as SuiteConfigV6 & { calibrationLatest?: boolean };
    unknown.calibrationLatest = true;
    expect(() => parseSuiteConfigV6(unknown)).toThrow();

    const swapped = rawConfig();
    swapped.calibrationEvidence[0]!.source!.expectedIdentity.criterionVersionId = 'other-version';
    expect(() => parseSuiteConfigV6(swapped)).toThrow(/must match its criterion binding/);
  });
});
