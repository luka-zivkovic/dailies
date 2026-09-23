import { z } from 'zod';
import {
  candidateConfigSchema,
  inputsConfigSchema,
  MAX_RUBRIST_POLL_INTERVAL_MS,
  MAX_RUBRIST_POLL_TIMEOUT_MS,
  DEFAULT_RUBRIST_POLL_INTERVAL_MS,
  DEFAULT_RUBRIST_POLL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  scopeConfigSchema,
  trustPolicySchema,
} from './config.js';
import { releasePolicyV1Schema } from './policy.js';

export const SUITE_CONFIG_SCHEMA_VERSION = 5;

export const suiteInputItemSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  baseline_output: z.string().optional(),
  baseline_labels: z.record(z.enum(['pass', 'fail'])).optional(),
}).strict().superRefine((item, ctx) => {
  if (item.baseline_labels !== undefined) {
    for (const key of Object.keys(item.baseline_labels)) {
      if (key.length === 0 || !key.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['baseline_labels', key],
          message: 'criterion version identity must not be blank',
        });
      }
    }
  }
});

export const suiteProviderConfigSchema = z.object({
  type: z.literal('rubrist'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  pollIntervalMs: z.number().int().min(1).max(MAX_RUBRIST_POLL_INTERVAL_MS)
    .default(DEFAULT_RUBRIST_POLL_INTERVAL_MS),
  evidenceDeadlineMs: z.number().int().min(1).max(MAX_RUBRIST_POLL_TIMEOUT_MS)
    .default(DEFAULT_RUBRIST_POLL_TIMEOUT_MS),
}).strict();

export const suiteConfigSchema = z.object({
  schemaVersion: z.literal(SUITE_CONFIG_SCHEMA_VERSION),
  inputs: inputsConfigSchema,
  scope: scopeConfigSchema,
  candidate: candidateConfigSchema,
  suite: z.object({
    manifest: z.object({
      type: z.literal('file'),
      path: z.string().min(1),
      manifestId: z.string().min(1),
      manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }).strict(),
    provider: suiteProviderConfigSchema,
  }).strict(),
  policy: releasePolicyV1Schema,
  trustPolicy: trustPolicySchema.default({
    admissibleClasses: ['verified', 'deterministic'],
  }),
  concurrency: z.number().int().min(1).default(4),
  timeoutMs: z.number().int().min(1).default(DEFAULT_TIMEOUT_MS),
  output: z.object({ dir: z.string().min(1) }).strict(),
}).strict();

export type SuiteConfig = z.infer<typeof suiteConfigSchema>;
export type SuiteInputItem = z.infer<typeof suiteInputItemSchema>;
export type SuiteProviderConfig = z.infer<typeof suiteProviderConfigSchema>;

export function parseSuiteConfig(raw: unknown): SuiteConfig {
  const version = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== SUITE_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `unsupported suite config schema version: ${version === undefined ? 'missing' : String(version)}; ` +
      `criterion release execution requires schemaVersion ${SUITE_CONFIG_SCHEMA_VERSION}`,
    );
  }
  return suiteConfigSchema.parse(raw);
}
