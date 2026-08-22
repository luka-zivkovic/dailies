import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  coevalAssessmentReceiptSchema,
  sha256Digest,
  verifyCoevalReceipt,
  type CoevalAssessmentReceipt,
  type CoevalCandidateItem,
} from '../src/coeval.js';

interface ContractFixture {
  contract: 'coeval/assessment-receipt/v1';
  candidates: CoevalCandidateItem[];
  receipt: unknown;
}

type Mutation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'reverse'; path: string }
  | { op: 'recompute-dataset-digest' }
  | { op: 'recompute-evidence-digest' };

interface ConformanceCase {
  name: string;
  structural: 'accept' | 'reject';
  semantic: 'accept' | 'reject' | 'not-run';
  expectedEvalRunId?: string;
  expectedSkillVersionId?: string;
  errorIncludes?: string;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: 'coeval/assessment-receipt/v1';
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL('../contracts/', import.meta.url);
const pinnedFileDigests = {
  schema: 'ca18a7b3bfa4610ff56ab88d60044f4357df2d035ac5e072356becc20250e9e7',
  specification: 'a81c814bacb4dfcf34e3af6aabda7f31c75124a8dc446bddccf664890531c65f',
  fixture: '530e7322feb5bc16d025daaef14bec8d73488a168a602d82b37fae2a06d12274',
  conformance: '68063300ab99c1ebade883050421fcb25ef8c34862f839d92d26d0d0d6fae225',
} as const;

function fileBytes(relativePath: string): Buffer {
  return readFileSync(new URL(relativePath, contractRoot));
}

function loadJson(relativePath: string): unknown {
  return JSON.parse(fileBytes(relativePath).toString('utf8'));
}

function fileDigest(relativePath: string): string {
  return createHash('sha256').update(fileBytes(relativePath)).digest('hex');
}

function fixture(relativePath = 'fixtures/assessment-receipt-v1.complete.json'): ContractFixture {
  return loadJson(relativePath) as ContractFixture;
}

function corpus(): ConformanceCorpus {
  return loadJson('fixtures/assessment-receipt-v1.conformance.json') as ConformanceCorpus;
}

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split('/').slice(1).map((segment) =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~')
  );
  if (segments.length === 0) throw new Error('fixture mutations cannot target the document root');
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[Number(segment)];
    else parent = (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(receipt: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === 'recompute-dataset-digest') {
    const items = receipt.items as Array<{ clientItemId: string; contentDigest: string }>;
    receipt.datasetDigest = sha256Digest(
      items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })),
    );
    return;
  }
  if (mutation.op === 'recompute-evidence-digest') {
    const { evidenceDigest: _excluded, ...unsigned } = receipt;
    receipt.evidenceDigest = sha256Digest(unsigned);
    return;
  }
  const { parent, key } = pointerTarget(receipt, mutation.path);
  if (mutation.op === 'reverse') {
    const value = Array.isArray(parent)
      ? parent[Number(key)]
      : (parent as Record<string, unknown>)[key];
    if (!Array.isArray(value)) throw new Error(`${mutation.path} is not an array`);
    value.reverse();
    return;
  }
  if (mutation.op === 'remove') {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return;
  }
  if (Array.isArray(parent)) parent[Number(key)] = mutation.value;
  else (parent as Record<string, unknown>)[key] = mutation.value;
}

function materialize(vector: ContractFixture, testCase: ConformanceCase): unknown {
  const receipt = structuredClone(vector.receipt) as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(receipt, mutation);
  return receipt;
}

describe('vendored Coeval assessment receipt v1 contract', () => {
  it('pins the reviewed schema and portable corpus bytes', () => {
    expect(fileDigest('assessment-receipt-v1.schema.json')).toBe(pinnedFileDigests.schema);
    expect(fileDigest('assessment-receipt-v1.md')).toBe(pinnedFileDigests.specification);
    expect(fileDigest('fixtures/assessment-receipt-v1.complete.json')).toBe(pinnedFileDigests.fixture);
    expect(fileDigest('fixtures/assessment-receipt-v1.conformance.json')).toBe(pinnedFileDigests.conformance);
  });

  it('keeps the vendored JSON Schema closed and versioned', () => {
    const schema = loadJson('assessment-receipt-v1.schema.json') as {
      $id?: string;
      additionalProperties?: boolean;
      properties?: { schemaVersion?: { const?: number } };
    };
    expect(schema.$id).toBe('https://coeval.dev/contracts/assessment-receipt-v1.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.schemaVersion?.const).toBe(1);
  });

  it('parses and independently verifies the portable Coeval fixture', () => {
    const vector = fixture();
    const receipt = coevalAssessmentReceiptSchema.parse(vector.receipt);
    const verified = verifyCoevalReceipt(
      vector.receipt,
      receipt,
      receipt.evalRunId,
      receipt.skillVersionId,
      vector.candidates,
    );

    expect(vector.contract).toBe('coeval/assessment-receipt/v1');
    expect(verified.status).toBe('complete');
    expect([...verified.labels.entries()]).toEqual([['a', 'pass'], ['b', 'fail']]);
  });

  it('keeps JSON Schema and consumer Zod acceptance aligned over the portable corpus', () => {
    const schema = loadJson('assessment-receipt-v1.schema.json');
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const conformance = corpus();
    const vector = fixture(`fixtures/${conformance.baseFixture}`);

    for (const testCase of conformance.cases) {
      const raw = materialize(vector, testCase);
      const expected = testCase.structural === 'accept';
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(coevalAssessmentReceiptSchema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it('accepts or rejects every portable semantic case for the stated reason', () => {
    const conformance = corpus();
    const vector = fixture(`fixtures/${conformance.baseFixture}`);
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== 'not-run')) {
      const raw = materialize(vector, testCase);
      const receipt = coevalAssessmentReceiptSchema.parse(raw);
      const verify = () => verifyCoevalReceipt(
        raw,
        receipt,
        testCase.expectedEvalRunId ?? receipt.evalRunId,
        testCase.expectedSkillVersionId ?? receipt.skillVersionId,
        vector.candidates,
      );
      if (testCase.semantic === 'accept') expect(verify, testCase.name).not.toThrow();
      else expect(verify, testCase.name).toThrow(testCase.errorIncludes);
    }
  });
});
