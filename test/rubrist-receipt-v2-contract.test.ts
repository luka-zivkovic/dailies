import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest, type RubristCandidateItem } from '../src/rubrist.js';
import {
  parseCanonicalRubristReceiptV2Bytes,
  rubristReceiptV2Schema,
  verifyRubristReceiptV2,
} from '../src/rubrist-receipt-v2.js';

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
  schema: '701aed7aa5931fad30e876ce3e075c7b3d4de992e0b5eb4537ed26d26c5b7826',
  specification: '7dc4c844c7da77559955f4bf0f5eb5a2b43ea899c84e5bd04889000b08f9b793',
  complete: '23b972a1ba9e78c5ea074ea9fb9abf7df74c108c8a58d14f473ee82d910e00eb',
  incomplete: 'bdfb4378c78410274a78cf6f7545ed7440e10b67693161a0c211123e10f317b0',
  conformance: 'f9269a1b5d35fa76ddb05a9d47d3722c7abc121d5437237c3e3fb0dba0f54432',
} as const;

const fileBytes = (path: string) => readFileSync(new URL(path, contractRoot));
const loadJson = (path: string): unknown => JSON.parse(fileBytes(path).toString('utf8'));
const fileDigest = (path: string) => createHash('sha256').update(fileBytes(path)).digest('hex');
const vector = (name: string) => loadJson(`fixtures/${name}`) as Vector;
const corpus = () => loadJson('fixtures/assessment-receipt-v2.conformance.json') as { baseFixture: string; cases: ConformanceCase[] };

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
  if (Array.isArray(parent)) parent[Number(key)] = mutation.value;
  // add and replace create an own member, even for a __proto__ key, as JSON.parse does.
  else Object.defineProperty(parent, key, { value: mutation.value, enumerable: true, writable: true, configurable: true });
}

function materialize(testCase: ConformanceCase, base: string): { v: Vector; raw: unknown } {
  const v = vector(testCase.baseFixture ?? base);
  const receipt = structuredClone(v.receipt) as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(receipt, mutation);
  return { v, raw: receipt };
}

describe('vendored Rubrist assessment receipt v2 (Dailies ADR-0008)', () => {
  it('pins the vendored schema, specification, and vectors byte for byte', () => {
    expect(fileDigest('assessment-receipt-v2.schema.json')).toBe(pinnedFileDigests.schema);
    expect(fileDigest('assessment-receipt-v2.md')).toBe(pinnedFileDigests.specification);
    expect(fileDigest('fixtures/assessment-receipt-v2.complete.json')).toBe(pinnedFileDigests.complete);
    expect(fileDigest('fixtures/assessment-receipt-v2.incomplete.json')).toBe(pinnedFileDigests.incomplete);
    expect(fileDigest('fixtures/assessment-receipt-v2.conformance.json')).toBe(pinnedFileDigests.conformance);
  });

  it('verifies both positive vectors with candidate linkage, recomputing skillDigest from the receipt alone', () => {
    const complete = vector('assessment-receipt-v2.complete.json');
    expect(verifyRubristReceiptV2(complete.receipt, { candidates: complete.candidates }))
      .toEqual({ status: 'complete', labels: new Map([['a', 'pass'], ['b', 'fail']]) });
    const incomplete = vector('assessment-receipt-v2.incomplete.json');
    expect(verifyRubristReceiptV2(incomplete.receipt, { candidates: incomplete.candidates }))
      .toEqual({ status: 'incomplete', labels: new Map([['a', 'pass']]) });
  });

  it('keeps JSON Schema and the Dailies runtime schema aligned over the portable corpus', () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(loadJson('assessment-receipt-v2.schema.json') as object);
    const { baseFixture, cases } = corpus();
    for (const testCase of cases) {
      const { raw } = materialize(testCase, baseFixture);
      const expected = testCase.structural === 'accept';
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(rubristReceiptV2Schema.safeParse(raw).success, `Dailies schema: ${testCase.name}`).toBe(expected);
    }
  });

  it('accepts or rejects every semantic case for the stated reason', () => {
    const { baseFixture, cases } = corpus();
    for (const testCase of cases.filter((entry) => entry.semantic !== 'not-run')) {
      const { v, raw } = materialize(testCase, baseFixture);
      const verify = () => verifyRubristReceiptV2(raw, {
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
    const receipt = vector('assessment-receipt-v2.incomplete.json').receipt;
    const bytes = Buffer.from(canonicalJson(receipt), 'utf8');
    expect(parseCanonicalRubristReceiptV2Bytes(bytes).receipt).toEqual(receipt);
    expect(() => parseCanonicalRubristReceiptV2Bytes(Buffer.from(JSON.stringify(receipt, null, 2)))).toThrow('not exact canonical JSON');
    expect(() => parseCanonicalRubristReceiptV2Bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))).toThrow('not valid JSON');
    expect(() => parseCanonicalRubristReceiptV2Bytes(Uint8Array.from([0xff]))).toThrow('not valid UTF-8');
  });

  it('refuses what JSON Schema cannot express: lone surrogates and hostile nesting', () => {
    const receipt = structuredClone(vector('assessment-receipt-v2.complete.json').receipt) as Record<string, unknown>;
    expect(rubristReceiptV2Schema.safeParse({ ...receipt, receiptId: 'receipt\ud800' }).success).toBe(false);
    let payload: unknown = 'leaf';
    for (let depth = 0; depth < 5_000; depth += 1) payload = [payload];
    expect(() => rubristReceiptV2Schema.safeParse({ ...receipt, unexpected: payload })).not.toThrow();
    expect(rubristReceiptV2Schema.safeParse({ ...receipt, unexpected: payload }).success).toBe(false);
  });
});
