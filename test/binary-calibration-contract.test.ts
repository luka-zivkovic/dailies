import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  binaryCalibrationArtifactByteDigest,
  binaryCalibrationArtifactSchema,
  binaryCalibrationEvidenceDigest,
  BinaryCalibrationIntegrityError,
  compareBinary64ToCanonicalDecimal,
  compareExactRationals,
  decodeNonnegativeBinary64Rational,
  expectedBinaryCalibrationIdentity,
  parseCanonicalBinaryCalibrationBytes,
  parseCanonicalDecimalRational,
  verifyBinaryCalibrationArtifact,
  wilsonScoreBinary64,
  type BinaryCalibrationArtifact,
  type ExpectedBinaryCalibrationIdentity,
} from '../src/binary-calibration.js';

type Mutation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'reverse'; path: string }
  | { op: 'recompute-evidence-digest' };

interface ConformanceCase {
  name: string;
  structural: 'accept' | 'reject';
  semantic: 'accept' | 'reject' | 'not-run';
  errorIncludes?: string;
  baseFixture?: string;
  expectedOverrides?: Partial<ExpectedBinaryCalibrationIdentity>;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: 'rubrist/binary-calibration/v1';
  baseFixture: string;
  expectedIdentityByFixture: Record<string, ExpectedBinaryCalibrationIdentity>;
  cases: ConformanceCase[];
}

const contractRoot = new URL('../contracts/', import.meta.url);
const pinnedFileDigests = {
  schema: '2e50ce0cef7b650a06f0aa011c552f1f7bb60e02bd3dc3d6751ff923b66ddf0d',
  specification: 'dee8960964941a65e819fbd50168ed5cd9f2764bc2eac50c57e1905bcf56f0f6',
  complete: 'f68a7aae8216dcf91510f63d72b0f8955bb5d0cae1ae0abc633245d0d183283c',
  repeated: '37b3b8471f9b4f9f4278655c54a6033ed185c5d731d9bcb881f7d0052e17e3e7',
  incomplete: '3cf6d2b44e790cad592fd4372a38fcce8748c43cb1cff4067b707d48a76198cd',
  conformance: '4caaa800b5e5d2a63ab1ef71511918b2d90877a5f6d147809f7334db075c1c89',
  wilsonReference: '948ac238d7b5780dd160dd29bbcad52259c3ae574287fc19fb63cdc41e02d8dd',
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

function corpus(): ConformanceCorpus {
  return json('fixtures/binary-calibration-v1.conformance.json') as ConformanceCorpus;
}

function fixture(name: string): BinaryCalibrationArtifact {
  return json(`fixtures/${name}`) as BinaryCalibrationArtifact;
}

function pointerValue(root: unknown, pointer: string): unknown {
  const segments = pointer.split('/').slice(1).map((segment) =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let value = root;
  for (const segment of segments) {
    value = Array.isArray(value)
      ? value[Number(segment)]
      : (value as Record<string, unknown>)[segment];
  }
  return value;
}

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split('/').slice(1).map((segment) =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.length === 0) throw new Error('fixture mutations cannot target the root');
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent)
      ? parent[Number(segment)]
      : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function addValue(parent: unknown, key: string, value: unknown): void {
  if (Array.isArray(parent)) parent.splice(key === '-' ? parent.length : Number(key), 0, value);
  else (parent as Record<string, unknown>)[key] = value;
}

function applyMutation(artifact: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === 'recompute-evidence-digest') {
    artifact.evidenceDigest = binaryCalibrationEvidenceDigest(artifact);
    return;
  }
  if (mutation.op === 'copy') {
    const copied = structuredClone(pointerValue(artifact, mutation.from));
    const { parent, key } = pointerTarget(artifact, mutation.path);
    addValue(parent, key, copied);
    return;
  }
  const { parent, key } = pointerTarget(artifact, mutation.path);
  if (mutation.op === 'reverse') {
    const target = Array.isArray(parent)
      ? parent[Number(key)]
      : (parent as Record<string, unknown>)[key];
    if (!Array.isArray(target)) throw new Error(`${mutation.path} is not an array`);
    target.reverse();
    return;
  }
  if (mutation.op === 'remove') {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return;
  }
  if (mutation.op === 'add') {
    addValue(parent, key, mutation.value);
    return;
  }
  if (Array.isArray(parent)) parent[Number(key)] = mutation.value;
  else (parent as Record<string, unknown>)[key] = mutation.value;
}

function materialize(testCase: ConformanceCase, defaultFixture: string): {
  artifact: Record<string, unknown>;
  fixtureName: string;
} {
  const fixtureName = testCase.baseFixture ?? defaultFixture;
  const artifact = structuredClone(fixture(fixtureName)) as unknown as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(artifact, mutation);
  return { artifact, fixtureName };
}

describe('vendored Rubrist binary calibration v1 contract', () => {
  it('pins only the reviewed public producer bytes', () => {
    expect(fileDigest('binary-calibration-v1.schema.json')).toBe(pinnedFileDigests.schema);
    expect(fileDigest('binary-calibration-v1.md')).toBe(pinnedFileDigests.specification);
    expect(fileDigest('fixtures/binary-calibration-v1.complete.json')).toBe(pinnedFileDigests.complete);
    expect(fileDigest('fixtures/binary-calibration-v1.repeated.json')).toBe(pinnedFileDigests.repeated);
    expect(fileDigest('fixtures/binary-calibration-v1.incomplete.json')).toBe(pinnedFileDigests.incomplete);
    expect(fileDigest('fixtures/binary-calibration-v1.conformance.json')).toBe(pinnedFileDigests.conformance);
    expect(fileDigest('reference/binary-calibration-wilson-v1.py')).toBe(
      pinnedFileDigests.wilsonReference,
    );
    expect(() => bytes('binary-calibration-private-ledger-v1.schema.json')).toThrow();
    expect(() => bytes('fixtures/binary-calibration-private-ledger-v1.complete.json')).toThrow();
  });

  it('accepts all three exact canonical transport fixtures with complete expected identity', () => {
    const vectors = corpus();
    for (const fixtureName of Object.keys(vectors.expectedIdentityByFixture)) {
      const exactBytes = bytes(`fixtures/${fixtureName}`);
      const artifact = parseCanonicalBinaryCalibrationBytes(
        exactBytes,
        vectors.expectedIdentityByFixture[fixtureName],
      );
      expect(expectedBinaryCalibrationIdentity(artifact), fixtureName).toEqual(
        vectors.expectedIdentityByFixture[fixtureName],
      );
      expect(binaryCalibrationArtifactByteDigest(exactBytes).slice(7), fixtureName).toBe(
        fileDigest(`fixtures/${fixtureName}`),
      );
    }
  });

  it('requires the complete closed expected-identity tuple', () => {
    const complete = fixture('binary-calibration-v1.complete.json');
    const expected = expectedBinaryCalibrationIdentity(complete);
    const { drawDigest: _missing, ...partial } = expected;
    expect(() => verifyBinaryCalibrationArtifact(
      complete,
      partial as ExpectedBinaryCalibrationIdentity,
    )).toThrow(/drawDigest mismatch/);
    expect(() => verifyBinaryCalibrationArtifact(complete, {
      ...expected,
      unexpected: 'not part of the identity contract',
    } as ExpectedBinaryCalibrationIdentity)).toThrow(/unknown fields: unexpected/);
  });

  it('rejects BOM, invalid UTF-8, invalid JSON, and noncanonical transport bytes', () => {
    const complete = bytes('fixtures/binary-calibration-v1.complete.json');
    expect(() => parseCanonicalBinaryCalibrationBytes(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      complete,
    ]))).toThrow(/BOM/);
    expect(() => parseCanonicalBinaryCalibrationBytes(Uint8Array.from([0xff]))).toThrow(/UTF-8/);
    expect(() => parseCanonicalBinaryCalibrationBytes(Buffer.from('{', 'utf8'))).toThrow(/valid JSON/);
    expect(() => parseCanonicalBinaryCalibrationBytes(Buffer.concat([
      complete,
      Buffer.from('\n'),
    ]))).toThrow(/exact canonical JSON/);
  });

  it('matches JSON Schema structure and every portable semantic case independently', () => {
    const schema = json('binary-calibration-v1.schema.json');
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const vectors = corpus();
    expect(vectors.cases).toHaveLength(96);

    for (const testCase of vectors.cases) {
      const { artifact, fixtureName } = materialize(testCase, vectors.baseFixture);
      const shouldAcceptStructure = testCase.structural === 'accept';
      expect(validate(artifact), `JSON Schema: ${testCase.name}`).toBe(shouldAcceptStructure);
      expect(
        binaryCalibrationArtifactSchema.safeParse(artifact).success,
        `Dailies Zod: ${testCase.name}`,
      ).toBe(shouldAcceptStructure);
      if (testCase.semantic === 'not-run') continue;

      const expected = {
        ...vectors.expectedIdentityByFixture[fixtureName],
        ...testCase.expectedOverrides,
      };
      const verify = () => verifyBinaryCalibrationArtifact(artifact, expected);
      if (testCase.semantic === 'accept') {
        expect(verify, testCase.name).not.toThrow();
      } else {
        expect(verify, testCase.name).toThrow(testCase.errorIncludes);
      }
    }
  });
});

describe('binary calibration exact numeric helpers', () => {
  const wilsonVectors = [
    [0, 1, '0000000000000000', '3fe963f2b137a224'],
    [1, 1, '3fca70353b21776f', '3ff0000000000000'],
    [1, 10, '3f924e245a7a897b', '3fd9dd9812f0d630'],
    [5, 10, '3fce48aeb11b0309', '3fe86dd453b93f3e'],
    [9, 10, '3fe31133f68794e8', '3fef6d8edd2c2bb4'],
    [50, 100, '3fd9d8603400ff4c', '3fe313cfe5ff805a'],
    [95, 100, '3fec6c8a47aac295', '3fef4f83a153164e'],
    [4999, 5000, '3feff6b9d64d7e07', '3fefffb5f55a1295'],
    [5000, 5000, '3feff9b6032817ca', '3ff0000000000000'],
    [0, 5000, '0000000000000000', '3f4927f35fa0d6f6'],
    [2500, 5000, '3fdf1d054c31143a', '3fe0717d59e775e3'],
    [1, 2, '3fb83332751478d2', '3fecf999b15d70e6'],
    [1, 4, '3fa75736a4957224', '3fe661245bc994b7'],
    [3, 8, '3fc1841d1220dfb6', '3fe6375bb9c5caa9'],
    [1, 1024, '3f26990e01be86b6', '3f769283d80c32d2'],
    [1, 4096, '3f069887f6ba4b06', '3f56a34855e6bc81'],
  ] as const;

  it('matches the independent Python Wilson reference vectors bit-for-bit', () => {
    for (const [x, n, lowerBinary64, upperBinary64] of wilsonVectors) {
      expect(wilsonScoreBinary64(x, n), `${x}/${n}`).toEqual({ lowerBinary64, upperBinary64 });
    }
  });

  it('decodes binary64 and canonical decimals to exact BigInt rationals', () => {
    expect(decodeNonnegativeBinary64Rational('3fe0000000000000')).toEqual({
      numerator: 1n,
      denominator: 2n,
    });
    expect(parseCanonicalDecimalRational('0.5')).toEqual({ numerator: 1n, denominator: 2n });
    expect(compareExactRationals(
      decodeNonnegativeBinary64Rational('3fe0000000000000'),
      parseCanonicalDecimalRational('0.5'),
    )).toBe(0);
    expect(() => decodeNonnegativeBinary64Rational('8000000000000000')).toThrow(/negative zero/);
    expect(() => decodeNonnegativeBinary64Rational('7ff0000000000000')).toThrow(/NaN or infinite/);
    expect(() => decodeNonnegativeBinary64Rational('3ff0000000000001')).toThrow(/outside/);
  });

  it('does not round the Wilson-bound threshold canary through a host decimal', () => {
    // Both render as 0.8882495307680808 in JavaScript, but the exact binary64
    // value is slightly smaller than that exact canonical decimal.
    const canaryBytes = Buffer.from('3fec6c8a47aac295', 'hex');
    expect(Number.parseFloat('0.8882495307680808')).toBe(
      canaryBytes.readDoubleBE(0),
    );
    expect(compareBinary64ToCanonicalDecimal(
      '3fec6c8a47aac295',
      '0.8882495307680808',
    )).toBe(-1);
  });

  it('keeps artifact integrity errors typed separately', () => {
    try {
      parseCanonicalBinaryCalibrationBytes(Uint8Array.from([0xff]));
      throw new Error('expected parse failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BinaryCalibrationIntegrityError);
      expect((error as BinaryCalibrationIntegrityError).code).toBe('invalid_bytes');
    }
  });
});
