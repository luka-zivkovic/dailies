import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/rubrist.js';
import type { RubristReceipt } from '../src/rubrist-receipt.js';
import {
  evaluatorSuiteCriterionDigest,
  evaluatorSuiteManifestDigest,
  evaluatorSuiteManifestSchema,
  parseCanonicalEvaluatorSuiteManifestBytes,
  verifyEvaluatorSuiteManifest,
  verifyReceiptManifestBinding,
  type EvaluatorSuiteManifest,
} from '../src/suite-manifest.js';

type Mutation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'reverse'; path: string }
  | { op: 'reindex-members' }
  | { op: 'recompute-criterion-digests' }
  | { op: 'recompute-manifest-digest' };

interface ConformanceCase {
  name: string;
  structural: 'accept' | 'reject';
  semantic: 'accept' | 'reject' | 'not-run';
  errorIncludes?: string;
  mutations: Mutation[];
}

const contractRoot = new URL('../contracts/', import.meta.url);
// Byte-identical to Rubrist's published copies (Dailies ADR-0008).
const pinnedFileDigests = {
  schema: '1c2dbb52ba90acdb6dba1292a5ac7e44ee6f516e9c699178ab4ed1aa74727c19',
  specification: 'b512740d5810104c62ed75e369d726143e6a57d59486ca7beed67e9429b71c03',
  fixture: '148d3f745ec0b7abddf82056fda65701e354de931d961012dd64288215bb5dc7',
  conformance: '073c99f0157080b201be35cb378a350c6d935e71e5fa4e750a7de67ecb06ccba',
} as const;

const fileBytes = (path: string) => readFileSync(new URL(path, contractRoot));
const loadJson = (path: string): unknown => JSON.parse(fileBytes(path).toString('utf8'));
const fileDigest = (path: string) => createHash('sha256').update(fileBytes(path)).digest('hex');
const fixture = () => loadJson('fixtures/evaluator-suite-manifest-v1.complete.json') as EvaluatorSuiteManifest;
const corpus = () => loadJson('fixtures/evaluator-suite-manifest-v1.conformance.json') as { cases: ConformanceCase[] };

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(manifest: Record<string, unknown>, mutation: Mutation): void {
  const members = manifest.members as Array<Record<string, unknown>>;
  if (mutation.op === 'reindex-members') {
    members.forEach((member, index) => { member.position = index; });
    return;
  }
  if (mutation.op === 'recompute-criterion-digests') {
    for (const member of members) {
      member.criterionDigest = evaluatorSuiteCriterionDigest(member as unknown as EvaluatorSuiteManifest['members'][number]);
    }
    return;
  }
  if (mutation.op === 'recompute-manifest-digest') {
    manifest.manifestDigest = evaluatorSuiteManifestDigest(manifest as unknown as EvaluatorSuiteManifest);
    return;
  }
  const { parent, key } = pointerTarget(manifest, mutation.path);
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

function materialize(testCase: ConformanceCase): unknown {
  const manifest = structuredClone(fixture()) as unknown as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(manifest, mutation);
  return manifest;
}

describe('vendored Rubrist evaluator suite manifest (Dailies ADR-0008)', () => {
  it('pins the vendored schema, specification, and corpus byte for byte', () => {
    expect(fileDigest('evaluator-suite-manifest-v1.schema.json')).toBe(pinnedFileDigests.schema);
    expect(fileDigest('evaluator-suite-manifest-v1.md')).toBe(pinnedFileDigests.specification);
    expect(fileDigest('fixtures/evaluator-suite-manifest-v1.complete.json')).toBe(pinnedFileDigests.fixture);
    expect(fileDigest('fixtures/evaluator-suite-manifest-v1.conformance.json')).toBe(pinnedFileDigests.conformance);
  });

  it('keeps JSON Schema and the Dailies runtime schema aligned over the portable corpus', () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(loadJson('evaluator-suite-manifest-v1.schema.json') as object);
    for (const testCase of corpus().cases) {
      const raw = materialize(testCase);
      const expected = testCase.structural === 'accept';
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(evaluatorSuiteManifestSchema.safeParse(raw).success, `Dailies schema: ${testCase.name}`).toBe(expected);
    }
  });

  it('accepts or rejects every semantic case for the stated reason', () => {
    const base = fixture();
    const expected = { manifestId: base.manifestId, manifestDigest: base.manifestDigest, members: structuredClone(base.members) };
    for (const testCase of corpus().cases.filter((entry) => entry.semantic !== 'not-run')) {
      const raw = materialize(testCase);
      const verify = () => verifyEvaluatorSuiteManifest(raw, expected);
      if (testCase.semantic === 'accept') {
        expect(verify, testCase.name).not.toThrow();
      } else {
        expect(testCase.errorIncludes, `${testCase.name} states its reason`).toBeTruthy();
        expect(verify, testCase.name).toThrow(testCase.errorIncludes);
      }
    }
  });

  it('parses only exact canonical UTF-8 bytes without a byte-order mark', () => {
    const manifest = fixture();
    const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
    expect(parseCanonicalEvaluatorSuiteManifestBytes(bytes)).toEqual(manifest);
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(fileBytes('fixtures/evaluator-suite-manifest-v1.complete.json')))
      .toThrow('not exact canonical JSON');
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])))
      .toThrow('not valid JSON');
  });

  it('binds a receipt to its member by project, evaluator version, and skillDigest', () => {
    const manifest = fixture();
    const member = manifest.members[1]!;
    const receipt = {
      projectId: manifest.projectId, skillId: member.skillId, skillVersionId: member.skillVersionId, skillDigest: member.skillDigest,
    } as RubristReceipt;
    expect(() => verifyReceiptManifestBinding(receipt, manifest, member)).not.toThrow();
    expect(() => verifyReceiptManifestBinding({ ...receipt, skillDigest: manifest.members[0]!.skillDigest }, manifest, member))
      .toThrow('skillDigest mismatch');
    expect(() => verifyReceiptManifestBinding({ ...receipt, projectId: 'other' }, manifest, member)).toThrow('projectId mismatch');
  });

  it('fails validation, rather than throwing, on hostile nesting', () => {
    let payload: unknown = 'leaf';
    for (let depth = 0; depth < 5_000; depth += 1) payload = [payload];
    const deep = { ...structuredClone(fixture()), unexpected: payload };
    expect(() => evaluatorSuiteManifestSchema.safeParse(deep)).not.toThrow();
    expect(evaluatorSuiteManifestSchema.safeParse(deep).success).toBe(false);
  });
});
