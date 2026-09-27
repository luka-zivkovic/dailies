import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest, type RubristCandidateItem } from '../src/rubrist.js';
import {
  parseCanonicalRubristReceiptBytes,
  rubristReceiptSchema,
  verifyRubristReceipt,
} from '../src/rubrist-receipt.js';

type Mutation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'reverse'; path: string }
  | { op: 'recompute-dataset-digest' }
  | { op: 'recompute-skill-digest' }
  | { op: 'recompute-evidence-digest' };

interface ConformanceCase {
  name: string;
  baseFixture?: string;
  structural: 'accept' | 'reject';
  semantic: 'accept' | 'reject' | 'not-run';
  expectedEvalRunId?: string;
  expectedSkillVersionId?: string;
  expectedSkillDigest?: string;
  errorIncludes?: string;
  mutations: Mutation[];
}

interface Vector {
  contract: string;
  candidates: RubristCandidateItem[];
  receipt: unknown;
}

const contractRoot = new URL('../contracts/', import.meta.url);
// Byte-identical to Rubrist's published copies (Dailies ADR-0008).
const pinnedFileDigests = {
  schema: '3b572012a4cf6172ecee46e9de6e821a5bae431f2489ac39e85393f2fb2b5129',
  specification: 'e126debd3f564aff463f65a32f6bb2eebfa1f9a6bedd647b53cb9f373a2473f5',
  complete: '2f5d3f00eb633da22472242c0c0a9abb2e5e7ab4e7c15bbe28dd2eae77ab20eb',
  incomplete: '23e3022bf6d31dec1954bcd890d8c6be7bc5a5c9bba807e25aa053aecbf8cc3a',
  conformance: '98924a3591381322f19c9aed9c981b78b6b233a684bb8f27dc6504f1ce363f73',
} as const;

const fileBytes = (path: string) => readFileSync(new URL(path, contractRoot));
const loadJson = (path: string): unknown => JSON.parse(fileBytes(path).toString('utf8'));
const fileDigest = (path: string) => createHash('sha256').update(fileBytes(path)).digest('hex');
const vector = (name: string) => loadJson(`fixtures/${name}`) as Vector;
const corpus = () => loadJson('fixtures/assessment-receipt-v1.conformance.json') as { baseFixture: string; cases: ConformanceCase[] };

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(receipt: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === 'recompute-dataset-digest') {
    const items = receipt.items as Array<{ clientItemId: string; contentDigest: string }>;
    receipt.datasetDigest = sha256Digest(items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })));
    return;
  }
  if (mutation.op === 'recompute-skill-digest') {
    receipt.skillDigest = sha256Digest(receipt.evaluator);
    return;
  }
  if (mutation.op === 'recompute-evidence-digest') {
    const { evidenceDigest: _excluded, ...unsigned } = receipt;
    receipt.evidenceDigest = sha256Digest(unsigned);
    return;
  }
  const { parent, key } = pointerTarget(receipt, mutation.path);
  if (mutation.op === 'reverse') {
    const value = Array.isArray(parent) ? parent[Number(key)] : (parent as Record<string, unknown>)[key];
    (value as unknown[]).reverse();
    return;
  }
  if (mutation.op === 'remove') {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return;
  }
  if (Array.isArray(parent)) {
    // RFC 6902: add inserts (or appends at "-"); replace overwrites.
    if (mutation.op === 'add') parent.splice(key === '-' ? parent.length : Number(key), 0, mutation.value);
    else parent[Number(key)] = mutation.value;
    return;
  }
  // add and replace create an own member, even for a __proto__ key, as JSON.parse does.
  else Object.defineProperty(parent, key, { value: mutation.value, enumerable: true, writable: true, configurable: true });
}

function materialize(testCase: ConformanceCase, base: string): { v: Vector; raw: unknown } {
  const v = vector(testCase.baseFixture ?? base);
  const receipt = structuredClone(v.receipt) as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(receipt, mutation);
  return { v, raw: receipt };
}

describe('vendored Rubrist assessment receipt (Dailies ADR-0008)', () => {
  it('pins the vendored schema, specification, and vectors byte for byte', () => {
    expect(fileDigest('assessment-receipt-v1.schema.json')).toBe(pinnedFileDigests.schema);
    expect(fileDigest('assessment-receipt-v1.md')).toBe(pinnedFileDigests.specification);
    expect(fileDigest('fixtures/assessment-receipt-v1.complete.json')).toBe(pinnedFileDigests.complete);
    expect(fileDigest('fixtures/assessment-receipt-v1.incomplete.json')).toBe(pinnedFileDigests.incomplete);
    expect(fileDigest('fixtures/assessment-receipt-v1.conformance.json')).toBe(pinnedFileDigests.conformance);
  });

  it('verifies both positive vectors with candidate linkage, recomputing skillDigest from the receipt alone', () => {
    const complete = vector('assessment-receipt-v1.complete.json');
    expect(verifyRubristReceipt(complete.receipt, { candidates: complete.candidates }))
      .toEqual({ status: 'complete', outcomes: new Map([['a', 'pass'], ['b', 'fail'], ['c', 'abstain']]) });
    // An incomplete receipt yields no outcomes, even for items with one.
    const incomplete = vector('assessment-receipt-v1.incomplete.json');
    expect(verifyRubristReceipt(incomplete.receipt, { candidates: incomplete.candidates }))
      .toEqual({ status: 'incomplete', outcomes: new Map() });
  });

  it('refuses duplicate candidate ids, which would hide a candidate from linkage', () => {
    const complete = vector('assessment-receipt-v1.complete.json');
    const [first] = complete.candidates;
    const duplicated = [{ ...first!, input: 'bogus', output: 'bogus' }, ...complete.candidates];
    expect(() => verifyRubristReceipt(complete.receipt, { candidates: duplicated }))
      .toThrow(/candidate clientItemId values must be unique/);
  });

  it('keeps JSON Schema and the Dailies runtime schema aligned over the portable corpus', () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(loadJson('assessment-receipt-v1.schema.json') as object);
    const { baseFixture, cases } = corpus();
    for (const testCase of cases) {
      const { raw } = materialize(testCase, baseFixture);
      const expected = testCase.structural === 'accept';
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(rubristReceiptSchema.safeParse(raw).success, `Dailies schema: ${testCase.name}`).toBe(expected);
    }
  });

  it('accepts or rejects every semantic case for the stated reason', () => {
    const { baseFixture, cases } = corpus();
    for (const testCase of cases.filter((entry) => entry.semantic !== 'not-run')) {
      const { v, raw } = materialize(testCase, baseFixture);
      const verify = () => verifyRubristReceipt(raw, {
        evalRunId: testCase.expectedEvalRunId,
        skillVersionId: testCase.expectedSkillVersionId,
        skillDigest: testCase.expectedSkillDigest,
        candidates: v.candidates,
      });
      if (testCase.semantic === 'accept') {
        expect(verify, testCase.name).not.toThrow();
      } else {
        expect(testCase.errorIncludes, `${testCase.name} states its reason`).toBeTruthy();
        expect(verify, testCase.name).toThrow(testCase.errorIncludes);
      }
    }
  });

  it('parses only exact canonical UTF-8 bytes without a byte-order mark', () => {
    const receipt = vector('assessment-receipt-v1.incomplete.json').receipt;
    const bytes = Buffer.from(canonicalJson(receipt), 'utf8');
    expect(parseCanonicalRubristReceiptBytes(bytes).receipt).toEqual(receipt);
    expect(() => parseCanonicalRubristReceiptBytes(Buffer.from(JSON.stringify(receipt, null, 2)))).toThrow('not exact canonical JSON');
    expect(() => parseCanonicalRubristReceiptBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))).toThrow('not valid JSON');
    expect(() => parseCanonicalRubristReceiptBytes(Uint8Array.from([0xff]))).toThrow('not valid UTF-8');
  });

  it('refuses what JSON Schema cannot express: lone surrogates and hostile nesting', () => {
    const receipt = structuredClone(vector('assessment-receipt-v1.complete.json').receipt) as Record<string, unknown>;
    expect(rubristReceiptSchema.safeParse({ ...receipt, receiptId: 'receipt\ud800' }).success).toBe(false);
    let payload: unknown = 'leaf';
    for (let depth = 0; depth < 5_000; depth += 1) payload = [payload];
    expect(() => rubristReceiptSchema.safeParse({ ...receipt, unexpected: payload })).not.toThrow();
    expect(rubristReceiptSchema.safeParse({ ...receipt, unexpected: payload }).success).toBe(false);
  });
});
