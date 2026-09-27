import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  binaryCalibrationArtifactByteDigest,
  expectedBinaryCalibrationIdentity,
  parseCanonicalBinaryCalibrationBytes,
} from '../src/binary-calibration.js';
import {
  parseSuiteConfig,
  type SuiteConfig,
  type SuiteConfigInput,
} from '../src/suite-config.js';
import { parseCandidateAssessmentConfig } from '../src/candidate-assessment-config.js';

const bytes = readFileSync(new URL(
  '../contracts/fixtures/binary-calibration-v1.complete.json',
  import.meta.url,
));
const artifact = parseCanonicalBinaryCalibrationBytes(bytes);
const identity = expectedBinaryCalibrationIdentity(artifact);

function rawConfig(): SuiteConfig {
  return {
    contract: 'dailies/suite-config/v1',
    schemaVersion: 1,
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
      contract: 'dailies/release-policy/v1',
      schemaVersion: 1,
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

const SECOND_CRITERION = 'criterionv_second_1';

/** A configuration whose policy has a second criterion after the fixture's. */
function twoCriterionConfig(): SuiteConfig {
  const config = rawConfig();
  config.policy.criteria.push({
    ...structuredClone(config.policy.criteria[0]!),
    criterionVersionId: SECOND_CRITERION,
  });
  config.calibrationEvidence.push({ criterionVersionId: SECOND_CRITERION, source: null });
  return config;
}

describe('suite configuration', () => {
  it('parses a suite configuration, which the candidate assessment configuration refuses', () => {
    const parsed = parseSuiteConfig(rawConfig());
    expect(parsed).toMatchObject({ contract: 'dailies/suite-config/v1', schemaVersion: 1 });
    expect(parsed.calibrationEvidence[0]?.source?.expectedIdentity).toEqual(identity);
    expect(() => parseCandidateAssessmentConfig(rawConfig())).toThrow();
  });

  it('requires exact ordered policy coverage but permits explicit source absence', () => {
    const absent = rawConfig();
    absent.calibrationEvidence[0]!.source = null;
    expect(parseSuiteConfig(absent).calibrationEvidence[0]?.source).toBeNull();

    const wrong = rawConfig();
    wrong.calibrationEvidence[0]!.criterionVersionId = 'another-criterion';
    expect(() => parseSuiteConfig(wrong)).toThrow(/policy criterion order/);

    const missing = rawConfig();
    missing.calibrationEvidence = [];
    expect(() => parseSuiteConfig(missing)).toThrow();
  });

  it('binds a null source for every criterion, in policy order, when calibrationEvidence is left out', () => {
    const omitted: SuiteConfigInput = twoCriterionConfig();
    delete omitted.calibrationEvidence;
    expect(parseSuiteConfig(omitted).calibrationEvidence).toEqual([
      { criterionVersionId: identity.criterionVersionId, source: null },
      { criterionVersionId: SECOND_CRITERION, source: null },
    ]);

    // A set calibration requirement with no source is a run result
    // (source_not_configured), not a configuration error.
    const calibratedExample = JSON.parse(readFileSync(new URL(
      '../fixtures/examples/suite-calibrated/dailies.config.json',
      import.meta.url,
    ), 'utf8')) as SuiteConfig;
    const required: SuiteConfigInput = twoCriterionConfig();
    required.policy.criteria[0]!.calibrationRequirement =
      calibratedExample.policy.criteria[0]!.calibrationRequirement;
    expect(required.policy.criteria[0]!.calibrationRequirement).not.toBeNull();
    delete required.calibrationEvidence;
    expect(parseSuiteConfig(required).calibrationEvidence[0]?.source).toBeNull();
  });

  it('refuses a present list that covers only some criteria or breaks policy order', () => {
    const partial = twoCriterionConfig();
    partial.calibrationEvidence.pop();
    expect(() => parseSuiteConfig(partial)).toThrow(/exact policy criterion coverage/);

    const reversed = twoCriterionConfig();
    reversed.calibrationEvidence.reverse();
    expect(() => parseSuiteConfig(reversed)).toThrow(/policy criterion order/);
  });

  it('refuses another or a missing contract, and another schema version', () => {
    const other = { ...rawConfig(), contract: 'dailies/suite-config/v2' };
    expect(() => parseSuiteConfig(other)).toThrow(
      /unsupported suite config contract: dailies\/suite-config\/v2/,
    );

    const { contract: _contract, ...missing } = rawConfig();
    expect(() => parseSuiteConfig(missing)).toThrow(/unsupported suite config contract: missing/);

    expect(() => parseSuiteConfig({ ...rawConfig(), schemaVersion: 2 })).toThrow();
  });

  it('refuses a release policy with another contract or schema version', () => {
    const config = rawConfig();
    expect(() => parseSuiteConfig({
      ...config,
      policy: { ...config.policy, contract: 'dailies/release-policy/v2' },
    })).toThrow();
    expect(() => parseSuiteConfig({
      ...config,
      policy: { ...config.policy, schemaVersion: 2 },
    })).toThrow();
  });

  it('requires suite identity fields to be all absent or all present', () => {
    const partial = rawConfig();
    partial.calibrationEvidence[0]!.source!.expectedIdentity.suiteManifestId = null;
    expect(() => parseSuiteConfig(partial)).toThrow(/all null or all present/);

    const noSuite = rawConfig();
    Object.assign(noSuite.calibrationEvidence[0]!.source!.expectedIdentity, {
      suiteManifestId: null,
      suiteManifestDigest: null,
      suiteMemberPosition: null,
    });
    expect(() => parseSuiteConfig(noSuite)).not.toThrow();
  });

  it('rejects unknown fields and a source bound to another criterion', () => {
    const unknown = rawConfig() as SuiteConfig & { calibrationLatest?: boolean };
    unknown.calibrationLatest = true;
    expect(() => parseSuiteConfig(unknown)).toThrow();

    const swapped = rawConfig();
    swapped.calibrationEvidence[0]!.source!.expectedIdentity.criterionVersionId = 'other-version';
    expect(() => parseSuiteConfig(swapped)).toThrow(/must match its criterion binding/);
  });
});
