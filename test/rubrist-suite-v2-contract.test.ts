import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/rubrist.js';
import type { RubristReceiptV2 } from '../src/rubrist-receipt-v2.js';
import {
  evaluatorSuiteCriterionDigestV2,
  evaluatorSuiteManifestV2Digest,
  evaluatorSuiteManifestV2Schema,
  parseCanonicalEvaluatorSuiteManifestV2Bytes,
  verifyEvaluatorSuiteManifestV2,
  verifyReceiptV2ManifestBinding,
  type EvaluatorSuiteManifestV2,
} from '../src/suite-manifest-v2.js';

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
  schema: '16a4f00c58bdb235b9a2baba00a1b381da6fa6675255c1ef3e02a30982fb8ad2',
  specification: 'b5398763150ed15a11d5dcf1331e20a4a0c1407874b3253d9fe9955b480184e2',
  fixture: '0ad44a443c1430cd613c96c91b8a780e882ce5f0e36f2750c53a5adf6afe494e',
  conformance: '148703d19c979a759486e076c5d455dde810d7d59149b9bc7be9aa23901027e3',
} as const;

const fileBytes = (path: string) => readFileSync(new URL(path, contractRoot));
const loadJson = (path: string): unknown => JSON.parse(fileBytes(path).toString('utf8'));
const fileDigest = (path: string) => createHash('sha256').update(fileBytes(path)).digest('hex');
const fixture = () => loadJson('fixtures/evaluator-suite-manifest-v2.complete.json') as EvaluatorSuiteManifestV2;
const corpus = () => loadJson('fixtures/evaluator-suite-manifest-v2.conformance.json') as { cases: ConformanceCase[] };

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
      member.criterionDigest = evaluatorSuiteCriterionDigestV2(member as unknown as EvaluatorSuiteManifestV2['members'][number]);
    }
    return;
  }
  if (mutation.op === 'recompute-manifest-digest') {
    manifest.manifestDigest = evaluatorSuiteManifestV2Digest(manifest as unknown as EvaluatorSuiteManifestV2);
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
  if (Array.isArray(parent)) parent[Number(key)] = mutation.value;
  // add and replace create an own member, even for a __proto__ key, as JSON.parse does.
  else Object.defineProperty(parent, key, { value: mutation.value, enumerable: true, writable: true, configurable: true });
}

function materialize(testCase: ConformanceCase): unknown {
  const manifest = structuredClone(fixture()) as unknown as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(manifest, mutation);
  return manifest;
}

describe('vendored Rubrist evaluator suite manifest v2 (Dailies ADR-0008)', () => {
  it('pins the vendored schema, specification, and corpus byte for byte', () => {
    expect(fileDigest('evaluator-suite-manifest-v2.schema.json')).toBe(pinnedFileDigests.schema);
    expect(fileDigest('evaluator-suite-manifest-v2.md')).toBe(pinnedFileDigests.specification);
    expect(fileDigest('fixtures/evaluator-suite-manifest-v2.complete.json')).toBe(pinnedFileDigests.fixture);
    expect(fileDigest('fixtures/evaluator-suite-manifest-v2.conformance.json')).toBe(pinnedFileDigests.conformance);
  });

  it('keeps JSON Schema and the Dailies runtime schema aligned over the portable corpus', () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(loadJson('evaluator-suite-manifest-v2.schema.json') as object);
    for (const testCase of corpus().cases) {
      const raw = materialize(testCase);
      const expected = testCase.structural === 'accept';
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(evaluatorSuiteManifestV2Schema.safeParse(raw).success, `Dailies schema: ${testCase.name}`).toBe(expected);
    }
  });

  it('accepts or rejects every semantic case for the stated reason', () => {
    const base = fixture();
    const expected = { manifestId: base.manifestId, manifestDigest: base.manifestDigest, members: structuredClone(base.members) };
    for (const testCase of corpus().cases.filter((entry) => entry.semantic !== 'not-run')) {
      const raw = materialize(testCase);
      const verify = () => verifyEvaluatorSuiteManifestV2(raw, expected);
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
    expect(parseCanonicalEvaluatorSuiteManifestV2Bytes(bytes)).toEqual(manifest);
    expect(() => parseCanonicalEvaluatorSuiteManifestV2Bytes(fileBytes('fixtures/evaluator-suite-manifest-v2.complete.json')))
      .toThrow('not exact canonical JSON');
    expect(() => parseCanonicalEvaluatorSuiteManifestV2Bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])))
      .toThrow('not valid JSON');
  });

  it('binds a receipt v2 to its member by project, evaluator version, and skillDigest', () => {
    const manifest = fixture();
    const member = manifest.members[1]!;
    const receipt = {
      projectId: manifest.projectId, skillId: member.skillId, skillVersionId: member.skillVersionId, skillDigest: member.skillDigest,
    } as RubristReceiptV2;
    expect(() => verifyReceiptV2ManifestBinding(receipt, manifest, member)).not.toThrow();
    expect(() => verifyReceiptV2ManifestBinding({ ...receipt, skillDigest: manifest.members[0]!.skillDigest }, manifest, member))
      .toThrow('skillDigest mismatch');
    expect(() => verifyReceiptV2ManifestBinding({ ...receipt, projectId: 'other' }, manifest, member)).toThrow('projectId mismatch');
  });

  it('fails validation, rather than throwing, on hostile nesting', () => {
    let payload: unknown = 'leaf';
    for (let depth = 0; depth < 5_000; depth += 1) payload = [payload];
    const deep = { ...structuredClone(fixture()), unexpected: payload };
    expect(() => evaluatorSuiteManifestV2Schema.safeParse(deep)).not.toThrow();
    expect(evaluatorSuiteManifestV2Schema.safeParse(deep).success).toBe(false);
  });
});
