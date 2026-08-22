import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.js';

export function sha256Bytes(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function v4ContractForBytes(
  path: string,
  bytes: string | Buffer,
  expectedItems: number,
): Pick<Config, 'schemaVersion' | 'inputs' | 'scope' | 'trustPolicy'> {
  return {
    schemaVersion: 4,
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

export function v4ContractForPath(
  path: string,
  expectedItems?: number,
): Pick<Config, 'schemaVersion' | 'inputs' | 'scope' | 'trustPolicy'> {
  const bytes = readFileSync(path);
  const count = expectedItems ?? bytes.toString('utf8').split('\n').filter((line) => line.trim()).length;
  return v4ContractForBytes(path, bytes, count);
}

export const selfReportedTestPolicy: Config['trustPolicy'] = {
  admissibleClasses: ['verified', 'deterministic', 'self_reported'],
  selfReportedOverride: {
    reason: 'Test fixture explicitly exercises the generic HTTP integration.',
  },
};
