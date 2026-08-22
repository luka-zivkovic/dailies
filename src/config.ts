import { z } from 'zod';

/** Default per-call timeout for candidate/judge invocations, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_COEVAL_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_COEVAL_POLL_TIMEOUT_MS = 300_000;
export const MAX_COEVAL_POLL_INTERVAL_MS = 30_000;
export const MAX_COEVAL_POLL_TIMEOUT_MS = 1_800_000;

export const inputsConfigSchema = z.object({
  type: z.literal('jsonl'),
  path: z.string().min(1),
});

export const candidateConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'),
    /** Shell command with an `{input}` placeholder, e.g. `my-cli --prompt {input}`. */
    template: z.string().min(1),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    /**
     * Request body with an `{input}` placeholder. The placeholder is replaced
     * with the JSON-encoded input (quotes included), e.g. `{"prompt": {input}}`.
     */
    bodyTemplate: z.string().min(1),
  }),
]);

export const judgeConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal('exact-match'),
  }),
  z.object({
    type: z.literal('coeval'),
    /** Base URL for the Coeval API, without an endpoint-specific suffix. */
    url: z.string().url(),
    /** API authentication and any deployment-specific request headers. */
    headers: z.record(z.string()).optional(),
    /** Immutable Coeval judging skill version used to produce the evidence. */
    skillVersionId: z.string().min(1),
    pollIntervalMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_COEVAL_POLL_INTERVAL_MS)
      .default(DEFAULT_COEVAL_POLL_INTERVAL_MS),
    pollTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_COEVAL_POLL_TIMEOUT_MS)
      .default(DEFAULT_COEVAL_POLL_TIMEOUT_MS),
  }),
]);

export const configSchema = z.object({
  inputs: inputsConfigSchema,
  candidate: candidateConfigSchema,
  judge: judgeConfigSchema,
  thresholds: z.object({
    /** Minimum fraction of items that must pass, in [0, 1]. */
    minPassRate: z.number().min(0).max(1),
    /** Maximum explicit baseline_label pass → candidate fail comparisons tolerated. */
    maxRegressions: z.number().int().min(0),
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
  }),
});

export type Config = z.infer<typeof configSchema>;
export type CandidateConfig = z.infer<typeof candidateConfigSchema>;
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;
export type CoevalJudgeConfig = Extract<JudgeConfig, { type: 'coeval' }>;

/** One line of the inputs JSONL file. */
export const inputItemSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  /** Historical judged quality. Required for a paired regression comparison. */
  baseline_label: z.enum(['pass', 'fail']).optional(),
  baseline_output: z.string().optional(),
});

export type InputItem = z.infer<typeof inputItemSchema>;

export function parseConfig(raw: unknown): Config {
  return configSchema.parse(raw);
}
