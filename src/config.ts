import { z } from 'zod';

/** Default per-call timeout for candidate/judge invocations, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RUBRIST_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_RUBRIST_POLL_TIMEOUT_MS = 300_000;
export const MAX_RUBRIST_POLL_INTERVAL_MS = 30_000;
export const MAX_RUBRIST_POLL_TIMEOUT_MS = 1_800_000;

export const CONFIG_SCHEMA_VERSION = 4;
export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const nonBlankStringSchema = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must contain a non-whitespace character',
});
export const trustClassSchema = z.enum(['verified', 'deterministic', 'self_reported']);

export const inputsConfigSchema = z.object({
  type: z.literal('jsonl'),
  path: z.string().min(1),
  /** SHA-256 of the exact bytes read and parsed by Dailies. */
  digest: z.string().regex(SHA256_DIGEST_PATTERN),
}).strict();

export const scopeKindSchema = z.enum([
  'regression_corpus',
  'sealed_representative_evaluation',
  'production_sample',
  'manual_review_set',
]);

export const timeWindowSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('range'),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    kind: z.literal('not_applicable'),
    reason: nonBlankStringSchema,
  }).strict(),
]);

export const scopeConfigSchema = z.object({
  id: nonBlankStringSchema,
  kind: scopeKindSchema,
  expectedItems: z.number().int().positive(),
  collectionProcedure: nonBlankStringSchema,
  population: nonBlankStringSchema,
  timeWindow: timeWindowSchema,
}).strict().superRefine((scope, ctx) => {
  if (
    scope.timeWindow.kind === 'range' &&
    Date.parse(scope.timeWindow.end) < Date.parse(scope.timeWindow.start)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['timeWindow', 'end'],
      message: 'time window end must not precede start',
    });
  }
  if (scope.kind === 'production_sample' && scope.timeWindow.kind !== 'range') {
    ctx.addIssue({
      code: 'custom',
      path: ['timeWindow'],
      message: 'production_sample requires a bounded time range',
    });
  }
});

export const trustPolicySchema = z.object({
  admissibleClasses: z.array(trustClassSchema).min(1).default(['verified', 'deterministic']),
  selfReportedOverride: z.object({ reason: nonBlankStringSchema }).strict().optional(),
}).strict().superRefine((policy, ctx) => {
  const unique = new Set(policy.admissibleClasses);
  if (unique.size !== policy.admissibleClasses.length) {
    ctx.addIssue({ code: 'custom', path: ['admissibleClasses'], message: 'trust classes must be unique' });
  }
  const admitsSelfReported = unique.has('self_reported');
  if (admitsSelfReported && policy.selfReportedOverride === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['selfReportedOverride'],
      message: 'admitting self_reported evidence requires an override reason',
    });
  }
  if (!admitsSelfReported && policy.selfReportedOverride !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['selfReportedOverride'],
      message: 'self-reported override requires self_reported in admissibleClasses',
    });
  }
});

export const candidateConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'),
    /** Shell command with an `{input}` placeholder, e.g. `my-cli --prompt {input}`. */
    template: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    /**
     * Request body with an `{input}` placeholder. The placeholder is replaced
     * with the JSON-encoded input (quotes included), e.g. `{"prompt": {input}}`.
     */
    bodyTemplate: z.string().min(1),
  }).strict(),
]);

export const judgeConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }).strict(),
  z.object({
    type: z.literal('exact-match'),
  }).strict(),
  z.object({
    type: z.literal('rubrist'),
    /** Base URL for the Rubrist API, without an endpoint-specific suffix. */
    url: z.string().url(),
    /** API authentication and any deployment-specific request headers. */
    headers: z.record(z.string()).optional(),
    /** Immutable Rubrist judging skill version used to produce the evidence. */
    skillVersionId: z.string().min(1),
    pollIntervalMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_RUBRIST_POLL_INTERVAL_MS)
      .default(DEFAULT_RUBRIST_POLL_INTERVAL_MS),
    pollTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_RUBRIST_POLL_TIMEOUT_MS)
      .default(DEFAULT_RUBRIST_POLL_TIMEOUT_MS),
  }).strict(),
]);

export const configSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  inputs: inputsConfigSchema,
  scope: scopeConfigSchema,
  candidate: candidateConfigSchema,
  judge: judgeConfigSchema,
  thresholds: z.object({
    /** Minimum fraction of items that must pass, in [0, 1]. */
    minPassRate: z.number().min(0).max(1),
    /** Maximum explicit baseline_label pass → candidate fail comparisons tolerated. */
    maxRegressions: z.number().int().min(0),
  }).strict(),
  trustPolicy: trustPolicySchema.default({
    admissibleClasses: ['verified', 'deterministic'],
  }),
  concurrency: z.number().int().min(1).default(4),
  /**
   * Per-call timeout (ms) applied to every candidate command/request and every
   * judge request. A timed-out candidate blocks; a timed-out judge makes the
   * run inconclusive.
   */
  timeoutMs: z.number().int().min(1).default(DEFAULT_TIMEOUT_MS),
  output: z.object({
    dir: z.string().min(1),
  }).strict(),
}).strict();

export type Config = z.infer<typeof configSchema>;
export type CandidateConfig = z.infer<typeof candidateConfigSchema>;
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;
export type RubristJudgeConfig = Extract<JudgeConfig, { type: 'rubrist' }>;
export type ScopeConfig = z.infer<typeof scopeConfigSchema>;
export type TrustClass = z.infer<typeof trustClassSchema>;
export type TrustPolicy = z.infer<typeof trustPolicySchema>;

/** One line of the inputs JSONL file. */
export const inputItemSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  /** Historical judged quality. Required for a paired regression comparison. */
  baseline_label: z.enum(['pass', 'fail']).optional(),
  baseline_output: z.string().optional(),
}).strict();

export type InputItem = z.infer<typeof inputItemSchema>;

export function parseConfig(raw: unknown): Config {
  const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `unsupported config schema version: ${version === undefined ? 'missing' : String(version)}; ` +
        `release execution requires schemaVersion ${CONFIG_SCHEMA_VERSION}`,
    );
  }
  return configSchema.parse(raw);
}
