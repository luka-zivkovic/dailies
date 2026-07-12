import { z } from 'zod';

/** Default per-call timeout for candidate/judge invocations, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000;

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
]);

export const configSchema = z.object({
  inputs: inputsConfigSchema,
  candidate: candidateConfigSchema,
  judge: judgeConfigSchema,
  thresholds: z.object({
    /** Minimum fraction of items that must pass, in [0, 1]. */
    minPassRate: z.number().min(0).max(1),
    /** Maximum number of regressions (failing items that have a baseline) tolerated. */
    maxRegressions: z.number().int().min(0),
  }),
  concurrency: z.number().int().min(1).default(4),
  /**
   * Per-call timeout (ms) applied to every candidate command/request and every
   * judge request. A timed-out call is an item error and counts as a failure.
   */
  timeoutMs: z.number().int().min(1).default(DEFAULT_TIMEOUT_MS),
  output: z.object({
    dir: z.string().min(1),
  }),
});

export type Config = z.infer<typeof configSchema>;
export type CandidateConfig = z.infer<typeof candidateConfigSchema>;
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;

/** One line of the inputs JSONL file. */
export const inputItemSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  baseline_output: z.string().optional(),
});

export type InputItem = z.infer<typeof inputItemSchema>;

export function parseConfig(raw: unknown): Config {
  return configSchema.parse(raw);
}
