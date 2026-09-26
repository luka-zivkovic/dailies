import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { canonicalJson } from './rubrist-canonical.js';
import type { RubristReceiptV2 } from './rubrist-receipt-v2.js';
import { withRubristV2RawGuards } from './rubrist-v2.js';

// Rubrist evaluator suite manifest v2 (contracts/evaluator-suite-manifest-v2.md),
// verified independently of Rubrist's runtime. v1's shape and rules; members
// carry the v2 skillDigest. It replaced manifest v1 (Dailies ADR-0008).

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nonEmptyStringSchema = z.string().min(1);

export const evaluatorSuiteManifestV2MemberSchema = z.object({
  position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  criterionId: nonEmptyStringSchema,
  criterionVersionId: nonEmptyStringSchema,
  criterionName: nonEmptyStringSchema,
  criterionDefinition: nonEmptyStringSchema,
  criterionDigest: digestSchema,
  skillId: nonEmptyStringSchema,
  skillVersionId: nonEmptyStringSchema,
  skillDigest: digestSchema,
  outputContractDigest: digestSchema,
  applicability: z.object({ kind: z.literal('all_items') }).strict(),
}).strict();

export const evaluatorSuiteTrialPlanV2Schema = z.object({
  kind: z.literal('independent_repetitions'),
  trialsPerItem: z.number().int().min(2).max(10),
}).strict();

const manifestObjectSchema = z.object({
  contract: z.literal('rubrist/evaluator-suite-manifest/v2'),
  schemaVersion: z.literal(2),
  manifestId: nonEmptyStringSchema,
  suiteId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  members: z.array(evaluatorSuiteManifestV2MemberSchema).min(1),
  trialPlan: evaluatorSuiteTrialPlanV2Schema.nullable(),
  manifestDigest: digestSchema,
}).strict();

export const evaluatorSuiteManifestV2Schema = withRubristV2RawGuards(manifestObjectSchema, 'suite manifests');
export type EvaluatorSuiteManifestV2 = z.infer<typeof manifestObjectSchema>;
export type EvaluatorSuiteManifestV2Member = z.infer<typeof evaluatorSuiteManifestV2MemberSchema>;

export interface ExpectedEvaluatorSuiteManifestV2 {
  manifestId: string;
  manifestDigest: string;
  members?: EvaluatorSuiteManifestV2Member[];
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function evaluatorSuiteCriterionDigestV2(
  input: Pick<
    EvaluatorSuiteManifestV2Member,
    'criterionId' | 'criterionVersionId' | 'criterionName' | 'criterionDefinition'
  >,
): string {
  return digest({
    criterionId: input.criterionId,
    criterionVersionId: input.criterionVersionId,
    criterionName: input.criterionName,
    criterionDefinition: input.criterionDefinition,
  });
}

export function evaluatorSuiteManifestV2Digest(
  input: Omit<EvaluatorSuiteManifestV2, 'manifestDigest'> | EvaluatorSuiteManifestV2,
): string {
  const { manifestDigest: _excluded, ...unsigned } = input as EvaluatorSuiteManifestV2;
  return digest(unsigned);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`suite manifest ${field} values must be unique`);
  }
}

function verifyExpectedMembers(
  actual: EvaluatorSuiteManifestV2Member[],
  expected: EvaluatorSuiteManifestV2Member[],
): void {
  const expectedByCriterion = new Map(expected.map((member) => [member.criterionId, member]));
  for (const member of actual) {
    if (!expectedByCriterion.has(member.criterionId)) {
      throw new Error(`suite manifest contains unknown criterion ${member.criterionId}`);
    }
  }
  if (actual.length !== expected.length) {
    throw new Error('suite manifest does not have exact criterion coverage');
  }
  if (actual.some((member, index) => member.criterionId !== expected[index]?.criterionId)) {
    throw new Error('suite manifest criterion order mismatch');
  }
  for (const [index, member] of actual.entries()) {
    const wanted = expected[index]!;
    if (member.criterionVersionId !== wanted.criterionVersionId) {
      throw new Error(`suite manifest substituted criterion version at position ${index}`);
    }
    if (
      member.criterionName !== wanted.criterionName ||
      member.criterionDefinition !== wanted.criterionDefinition ||
      member.criterionDigest !== wanted.criterionDigest
    ) {
      throw new Error(`suite manifest substituted criterion definition at position ${index}`);
    }
    if (
      member.skillId !== wanted.skillId ||
      member.skillVersionId !== wanted.skillVersionId ||
      member.skillDigest !== wanted.skillDigest ||
      member.outputContractDigest !== wanted.outputContractDigest
    ) {
      throw new Error(`suite manifest substituted evaluator at position ${index}`);
    }
    if (member.applicability.kind !== wanted.applicability.kind) {
      throw new Error(`suite manifest substituted applicability at position ${index}`);
    }
  }
}

export function verifyEvaluatorSuiteManifestV2(
  raw: unknown,
  expected?: ExpectedEvaluatorSuiteManifestV2,
): EvaluatorSuiteManifestV2 {
  const manifest = evaluatorSuiteManifestV2Schema.parse(raw);
  for (const [index, member] of manifest.members.entries()) {
    if (member.position !== index) {
      throw new Error(`suite manifest members are not ordered by contiguous position at index ${index}`);
    }
    if (!member.criterionName.trim() || !member.criterionDefinition.trim()) {
      throw new Error(`suite manifest criterion text must not be blank at position ${index}`);
    }
  }
  assertUnique(manifest.members.map((member) => member.criterionId), 'criterionId');
  assertUnique(manifest.members.map((member) => member.criterionVersionId), 'criterionVersionId');
  assertUnique(manifest.members.map((member) => member.skillVersionId), 'skillVersionId');
  for (const member of manifest.members) {
    if (member.criterionDigest !== evaluatorSuiteCriterionDigestV2(member)) {
      throw new Error(`suite manifest criterionDigest mismatch for ${member.criterionVersionId}`);
    }
  }
  if (manifest.manifestDigest !== evaluatorSuiteManifestV2Digest(manifest)) {
    throw new Error('suite manifest manifestDigest mismatch');
  }
  if (expected?.members !== undefined) verifyExpectedMembers(manifest.members, expected.members);
  if (expected !== undefined && manifest.manifestId !== expected.manifestId) {
    throw new Error(`suite manifest manifestId mismatch: expected ${expected.manifestId}`);
  }
  if (expected !== undefined && manifest.manifestDigest !== expected.manifestDigest) {
    throw new Error(`suite manifest identity digest mismatch: expected ${expected.manifestDigest}`);
  }
  return manifest;
}

export function parseCanonicalEvaluatorSuiteManifestV2Bytes(
  bytes: Uint8Array,
  expected?: ExpectedEvaluatorSuiteManifestV2,
): EvaluatorSuiteManifestV2 {
  let text: string;
  try {
    // ignoreBOM keeps a leading byte-order mark, so such a copy fails the parse.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('Evaluator suite manifest bytes are not valid UTF-8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Evaluator suite manifest bytes are not valid JSON');
  }
  const parsed = evaluatorSuiteManifestV2Schema.parse(raw);
  if (canonicalJson(parsed) !== text) {
    throw new Error('Evaluator suite manifest copy is not exact canonical JSON');
  }
  return verifyEvaluatorSuiteManifestV2(parsed, expected);
}

export async function loadEvaluatorSuiteManifestV2(
  path: string,
  expected: ExpectedEvaluatorSuiteManifestV2,
): Promise<EvaluatorSuiteManifestV2> {
  return parseCanonicalEvaluatorSuiteManifestV2Bytes(await readFile(path), expected);
}

/**
 * A verified receipt v2 belongs to a manifest member when its project,
 * evaluator version, and recomputed skillDigest match the member's.
 */
export function verifyReceiptV2ManifestBinding(
  receipt: RubristReceiptV2,
  manifest: EvaluatorSuiteManifestV2,
  member: EvaluatorSuiteManifestV2Member,
): void {
  if (receipt.projectId !== manifest.projectId) {
    throw new Error(`receipt projectId mismatch for ${member.criterionVersionId}`);
  }
  if (receipt.skillId !== member.skillId) {
    throw new Error(`receipt skillId mismatch for ${member.criterionVersionId}`);
  }
  if (receipt.skillVersionId !== member.skillVersionId) {
    throw new Error(`receipt skillVersionId mismatch for ${member.criterionVersionId}`);
  }
  if (receipt.skillDigest !== member.skillDigest) {
    throw new Error(`receipt skillDigest mismatch for ${member.criterionVersionId}`);
  }
}
