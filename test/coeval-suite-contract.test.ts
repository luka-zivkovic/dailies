import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
} from '../src/coeval.js';
import {
  evaluatorSuiteCriterionDigest,
  evaluatorSuiteManifestDigest,
  evaluatorSuiteManifestSchema,
  parseCanonicalEvaluatorSuiteManifestBytes,
  verifyEvaluatorSuiteManifest,
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

interface ConformanceCorpus {
  contract: 'coeval/evaluator-suite-manifest/v1';
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL('../contracts/', import.meta.url);
const pinnedFileDigests = {
  schema: 'd9510a027313659f0fe11f8dc300874a9b106c57ca08f7cf168d90839bd60b26',
  specification: '6f0982d3e2b8da38b54fb4d91dab2a92340799b4cd406f29e0698264dd1a43e8',
  fixture: '64fcd11e94f209015914294bb9f6ef33ee3e1fb4766c3081e0a58f69eed785ae',
  conformance: 'd09392d37c255fcf05361fbe8b7e78ec4306af876352d9b8a05dd621ae0d2458',
} as const;

function bytes(relativePath: string): Buffer {
  return readFileSync(new URL(relativePath, contractRoot));
}

function json(relativePath: string): unknown {
  return JSON.parse(bytes(relativePath).toString('utf8'));
}

function fileDigest(relativePath: string): string {
  return createHash('sha256').update(bytes(relativePath)).digest('hex');
}

function fixture(): EvaluatorSuiteManifest {
  return json('fixtures/evaluator-suite-manifest-v1.complete.json') as EvaluatorSuiteManifest;
}

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split('/').slice(1).map((segment) =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent)
      ? parent[Number(segment)]
      : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function mutate(manifest: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === 'reindex-members') {
    (manifest.members as Array<Record<string, unknown>>).forEach((member, index) => {
      member.position = index;
    });
    return;
  }
  if (mutation.op === 'recompute-criterion-digests') {
    (manifest.members as EvaluatorSuiteManifest['members']).forEach((member) => {
      member.criterionDigest = evaluatorSuiteCriterionDigest(member);
    });
    return;
  }
  if (mutation.op === 'recompute-manifest-digest') {
    manifest.manifestDigest = evaluatorSuiteManifestDigest(
      manifest as unknown as EvaluatorSuiteManifest,
    );
    return;
  }
  const { parent, key } = pointerTarget(manifest, mutation.path);
  if (mutation.op === 'reverse') {
    const value = Array.isArray(parent)
      ? parent[Number(key)]
      : (parent as Record<string, unknown>)[key];
    if (!Array.isArray(value)) throw new Error('mutation target is not an array');
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

describe('vendored Coeval evaluator-suite-manifest v1 contract', () => {
  it('pins the reviewed producer bytes and keeps receipt v1 pins unchanged', () => {
    expect(fileDigest('evaluator-suite-manifest-v1.schema.json')).toBe(pinnedFileDigests.schema);
    expect(fileDigest('evaluator-suite-manifest-v1.md')).toBe(pinnedFileDigests.specification);
    expect(fileDigest('fixtures/evaluator-suite-manifest-v1.complete.json')).toBe(pinnedFileDigests.fixture);
    expect(fileDigest('fixtures/evaluator-suite-manifest-v1.conformance.json')).toBe(pinnedFileDigests.conformance);
    expect(fileDigest('assessment-receipt-v1.schema.json')).toBe(
      'ca18a7b3bfa4610ff56ab88d60044f4357df2d035ac5e072356becc20250e9e7',
    );
  });

  it('matches producer JSON Schema and semantic conformance cases', () => {
    const schema = json('evaluator-suite-manifest-v1.schema.json');
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const corpus = json(
      'fixtures/evaluator-suite-manifest-v1.conformance.json',
    ) as ConformanceCorpus;
    const base = fixture();
    const expected = {
      manifestId: base.manifestId,
      manifestDigest: base.manifestDigest,
      members: structuredClone(base.members),
    };

    for (const testCase of corpus.cases) {
      const raw = structuredClone(base) as unknown as Record<string, unknown>;
      for (const operation of testCase.mutations) mutate(raw, operation);
      const structural = testCase.structural === 'accept';
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(structural);
      expect(evaluatorSuiteManifestSchema.safeParse(raw).success, `Zod: ${testCase.name}`)
        .toBe(structural);
      if (testCase.semantic === 'not-run') continue;
      const verify = () => verifyEvaluatorSuiteManifest(raw, expected);
      if (testCase.semantic === 'accept') expect(verify, testCase.name).not.toThrow();
      else expect(verify, testCase.name).toThrow(testCase.errorIncludes);
    }
  });

  it('accepts only exact canonical UTF-8 artifact bytes', () => {
    const manifest = verifyEvaluatorSuiteManifest(fixture());
    const canonical = Buffer.from(canonicalJson(manifest), 'utf8');
    // The portable fixture is deliberately readable JSON, not the persisted
    // canonical artifact bytes.
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(
      bytes('fixtures/evaluator-suite-manifest-v1.complete.json'),
    )).toThrow(/not exact canonical JSON/);
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(Uint8Array.from([0xff])))
      .toThrow(/not valid UTF-8/);
    expect(parseCanonicalEvaluatorSuiteManifestBytes(canonical)).toEqual(manifest);
  });
});
