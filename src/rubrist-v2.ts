import { z } from 'zod';
import { sha256Digest } from './rubrist.js';

// Shared building blocks for the Rubrist v2 evidence Dailies verifies
// (Rubrist ADR-0014; Dailies ADR-0008). This is Dailies' own implementation of
// the vendored contracts in contracts/: nothing here imports Rubrist code.

export const RUBRIST_EVALUATOR_IDENTITY_BASIS = 'rubrist/evaluator-identity/v2';
export const RUBRIST_V2_MAX_JSON_DEPTH = 64;

export const rubristV2DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const rubristV2CountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Whether a string holds an unpaired UTF-16 surrogate. */
function stringHasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * The raw-document rules the v2 contracts share and JSON Schema can't fully
 * express, checked iteratively so hostile nesting fails validation instead of
 * the stack: nesting beyond depth 64 (the root is depth 0), an own `__proto__`
 * key anywhere, and a lone surrogate in any key or string.
 */
export function rubristV2RawDocumentProblem(raw: unknown): string | null {
  const stack: Array<{ entry: unknown; depth: number }> = [{ entry: raw, depth: 0 }];
  while (stack.length > 0) {
    const { entry, depth } = stack.pop()!;
    if (typeof entry === 'string') {
      if (stringHasLoneSurrogate(entry)) return 'must not contain lone UTF-16 surrogates';
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    if (depth > RUBRIST_V2_MAX_JSON_DEPTH) return `must not nest deeper than ${RUBRIST_V2_MAX_JSON_DEPTH} levels`;
    if (Array.isArray(entry)) {
      for (const child of entry) stack.push({ entry: child, depth: depth + 1 });
      continue;
    }
    if (Object.hasOwn(entry, '__proto__')) return 'must not contain a __proto__ key';
    for (const [key, child] of Object.entries(entry)) {
      if (stringHasLoneSurrogate(key)) return 'must not contain lone UTF-16 surrogates';
      stack.push({ entry: child, depth: depth + 1 });
    }
  }
  return null;
}

/** Wrap an object schema so the raw document is checked first. */
export function withRubristV2RawGuards<T extends z.ZodTypeAny>(schema: T, noun: string) {
  return z.unknown().superRefine((raw, ctx) => {
    const problem = rubristV2RawDocumentProblem(raw);
    if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${noun} ${problem}` });
  }).pipe(schema);
}

const providers = ['mock', 'anthropic', 'openai', 'openrouter', 'custom', 'typesafe'] as const;
type Provider = (typeof providers)[number];
const verdictProtocols = [
  'anthropic.structured-output/v1',
  'anthropic.forced-tool/v1',
  'openai.structured-output/v1',
  'openai.forced-function/v1',
  'prompted-json/v1',
  'typed-question/v1',
  'mock/v1',
] as const;
export type RubristVerdictProtocol = (typeof verdictProtocols)[number];

const OPENAI_FAMILY: readonly RubristVerdictProtocol[] = [
  'openai.structured-output/v1',
  'openai.forced-function/v1',
  'prompted-json/v1',
];
const PROTOCOLS_BY_PROVIDER: Record<Provider, readonly RubristVerdictProtocol[]> = {
  mock: ['mock/v1'],
  anthropic: ['anthropic.structured-output/v1', 'anthropic.forced-tool/v1', 'prompted-json/v1'],
  openai: OPENAI_FAMILY,
  openrouter: OPENAI_FAMILY,
  custom: OPENAI_FAMILY,
  typesafe: ['typed-question/v1'],
};
const REASONING_FAMILY: Partial<Record<Provider, 'anthropic' | 'openai' | 'openrouter'>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  openrouter: 'openrouter',
  custom: 'openai',
};

// Calibration v2 states this in its JSON Schema; receipts and manifests reject
// lone surrogates anywhere through their raw guards.
const modelTextSchema = z.string().min(1).max(240)
  .refine((value) => !stringHasLoneSurrogate(value), 'model text must not contain lone UTF-16 surrogates');
const tokenCountSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const reasoningSchema = z.discriminatedUnion('family', [
  z.object({
    family: z.literal('anthropic'),
    thinking: z.discriminatedUnion('type', [
      z.object({ type: z.literal('disabled') }).strict(),
      z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER) }).strict(),
      z.object({ type: z.literal('adaptive') }).strict(),
    ]),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  }).strict(),
  z.object({
    family: z.literal('openai'),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high']),
  }).strict(),
  z.object({
    family: z.literal('openrouter'),
    enabled: z.boolean(),
    effort: z.enum(['low', 'medium', 'high']).nullable(),
    maxTokens: tokenCountSchema.nullable(),
  }).strict(),
]);

/** The execution binding: exactly what Rubrist sent, with unset settings as `null`. */
export const rubristExecutionBindingSchema = z.object({
  provider: z.enum(providers),
  endpoint: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('managed') }).strict(),
    z.object({ kind: z.literal('custom'), baseUrlDigest: rubristV2DigestSchema }).strict(),
  ]),
  modelId: modelTextSchema,
  modelVersion: modelTextSchema,
  sampling: z.object({
    temperature: z.number().min(0).max(2).nullable(),
    topP: z.number().min(0).max(1).nullable(),
  }).strict(),
  reasoning: reasoningSchema.nullable(),
  outputTokenLimit: z.number().int().min(1).max(1_000_000).nullable(),
  verdictProtocol: z.enum(verdictProtocols),
  routing: z.object({ requireParameters: z.literal(true), allowFallbacks: z.literal(false) }).strict().nullable(),
}).strict().superRefine((binding, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (!PROTOCOLS_BY_PROVIDER[binding.provider].includes(binding.verdictProtocol)) {
    issue('verdictProtocol', `${binding.verdictProtocol} is not a ${binding.provider} protocol`);
  }
  const endpointFits = binding.provider === 'custom'
    ? binding.endpoint.kind === 'custom'
    : binding.provider === 'openai' || binding.endpoint.kind === 'managed';
  if (!endpointFits) issue('endpoint', `${binding.provider} bindings can't name a ${binding.endpoint.kind} endpoint`);
  if ((binding.provider === 'openrouter') !== (binding.routing !== null)) {
    issue('routing', 'OpenRouter bindings state their routing requirements; others have none');
  }
  if (binding.reasoning !== null && binding.reasoning.family !== REASONING_FAMILY[binding.provider]) {
    issue('reasoning', `${binding.provider} has no ${binding.reasoning.family} reasoning shape`);
  }
  if (binding.reasoning?.family === 'openrouter') {
    const { enabled, effort, maxTokens } = binding.reasoning;
    if (effort !== null && maxTokens !== null) issue('reasoning', 'OpenRouter reasoning takes an effort or a token budget, not both');
    if (!enabled && (effort !== null || maxTokens !== null)) issue('reasoning', 'disabled OpenRouter reasoning states no effort or token budget');
  }
  if (binding.provider === 'anthropic' && binding.outputTokenLimit === null) {
    issue('outputTokenLimit', 'Anthropic requires an output token limit');
  }
  if (binding.provider === 'typesafe' || binding.provider === 'mock') {
    if (binding.sampling.temperature !== null || binding.sampling.topP !== null) {
      issue('sampling', `${binding.provider} takes no sampling settings`);
    }
    if (binding.outputTokenLimit !== null) issue('outputTokenLimit', `${binding.provider} takes no output token limit`);
  }
});
export type RubristExecutionBinding = z.infer<typeof rubristExecutionBindingSchema>;

/** The evaluator identity v2 evidence carries: never the definition's text, only its digest. */
export const rubristEvaluatorIdentitySchema = z.object({
  basis: z.literal(RUBRIST_EVALUATOR_IDENTITY_BASIS),
  definitionDigest: rubristV2DigestSchema,
  executionBinding: rubristExecutionBindingSchema,
}).strict();
export type RubristEvaluatorIdentity = z.infer<typeof rubristEvaluatorIdentitySchema>;

/** skillDigest v2: SHA-256 over the canonical evaluator identity. */
export function rubristSkillDigestV2(identity: RubristEvaluatorIdentity): string {
  return sha256Digest(identity);
}
