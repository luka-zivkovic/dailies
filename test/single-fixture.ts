import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SingleConfig } from '../src/config.js';

export function sha256Bytes(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function singleContractForBytes(
  path: string,
  bytes: string | Buffer,
  expectedItems: number,
): Pick<SingleConfig, 'contract' | 'schemaVersion' | 'inputs' | 'scope' | 'trustPolicy'> {
  return {
    contract: 'dailies/single-config/v1',
    schemaVersion: 1,
    inputs: { type: 'jsonl', path, digest: sha256Bytes(bytes) },
    scope: {
      id: 'test-scope',
      kind: 'regression_corpus',
      expectedItems,
      collectionProcedure: 'Pinned test fixture.',
      population: 'Behavior exercised by this test fixture.',
      timeWindow: {
        kind: 'not_applicable',
        reason: 'Static test fixtures are not sampled from a time window.',
      },
    },
    trustPolicy: { admissibleClasses: ['verified', 'deterministic'] },
  };
}

export function singleContractForPath(
  path: string,
  expectedItems?: number,
): Pick<SingleConfig, 'contract' | 'schemaVersion' | 'inputs' | 'scope' | 'trustPolicy'> {
  const bytes = readFileSync(path);
  const count = expectedItems ?? bytes.toString('utf8').split('\n').filter((line) => line.trim()).length;
  return singleContractForBytes(path, bytes, count);
}

export const selfReportedTestPolicy: SingleConfig['trustPolicy'] = {
  admissibleClasses: ['verified', 'deterministic', 'self_reported'],
  selfReportedOverride: {
    reason: 'Test fixture explicitly exercises the generic HTTP integration.',
  },
};
