import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  canonicalJson,
  type CoevalAssessmentReceipt,
} from './coeval.js';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nonEmptyStringSchema = z.string().min(1);

export const evaluatorSuiteManifestMemberSchema = z.object({
  position: z.number().int().nonnegative(),
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

export const evaluatorSuiteTrialPlanSchema = z.object({
  kind: z.literal('independent_repetitions'),
  trialsPerItem: z.number().int().min(2).max(10),
}).strict();

export const evaluatorSuiteManifestSchema = z.object({
  contract: z.literal('coeval/evaluator-suite-manifest/v1'),
  schemaVersion: z.literal(1),
  manifestId: nonEmptyStringSchema,
  suiteId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  revision: z.number().int().positive(),
  members: z.array(evaluatorSuiteManifestMemberSchema).min(1),
  trialPlan: evaluatorSuiteTrialPlanSchema.nullable(),
  manifestDigest: digestSchema,
}).strict();

export type EvaluatorSuiteManifest = z.infer<typeof evaluatorSuiteManifestSchema>;
export type EvaluatorSuiteManifestMember = z.infer<typeof evaluatorSuiteManifestMemberSchema>;

export interface ExpectedEvaluatorSuiteManifest {
  manifestId: string;
  manifestDigest: string;
  members?: EvaluatorSuiteManifestMember[];
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function evaluatorSuiteCriterionDigest(
  input: Pick<
    EvaluatorSuiteManifestMember,
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

export function evaluatorSuiteManifestDigest(
  input: Omit<EvaluatorSuiteManifest, 'manifestDigest'> | EvaluatorSuiteManifest,
): string {
  const { manifestDigest: _excluded, ...unsigned } = input as EvaluatorSuiteManifest;
  return digest(unsigned);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`suite manifest ${field} values must be unique`);
  }
}

function verifyExpectedMembers(
  actual: EvaluatorSuiteManifestMember[],
  expected: EvaluatorSuiteManifestMember[],
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

export function verifyEvaluatorSuiteManifest(
  raw: unknown,
  expected?: ExpectedEvaluatorSuiteManifest,
): EvaluatorSuiteManifest {
  const manifest = evaluatorSuiteManifestSchema.parse(raw);
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
    if (member.criterionDigest !== evaluatorSuiteCriterionDigest(member)) {
      throw new Error(`suite manifest criterionDigest mismatch for ${member.criterionVersionId}`);
    }
  }
  if (manifest.manifestDigest !== evaluatorSuiteManifestDigest(manifest)) {
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

export function parseCanonicalEvaluatorSuiteManifestBytes(
  bytes: Uint8Array,
  expected?: ExpectedEvaluatorSuiteManifest,
): EvaluatorSuiteManifest {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Evaluator suite manifest bytes are not valid UTF-8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Evaluator suite manifest bytes are not valid JSON');
  }
  const parsed = evaluatorSuiteManifestSchema.parse(raw);
  if (canonicalJson(parsed) !== text) {
    throw new Error('Evaluator suite manifest copy is not exact canonical JSON');
  }
  return verifyEvaluatorSuiteManifest(parsed, expected);
}

export async function loadEvaluatorSuiteManifest(
  path: string,
  expected: ExpectedEvaluatorSuiteManifest,
): Promise<EvaluatorSuiteManifest> {
  return parseCanonicalEvaluatorSuiteManifestBytes(await readFile(path), expected);
}

export function verifyReceiptManifestBinding(
  receipt: CoevalAssessmentReceipt,
  manifest: EvaluatorSuiteManifest,
  member: EvaluatorSuiteManifestMember,
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
