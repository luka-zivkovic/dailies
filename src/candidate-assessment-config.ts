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
import { candidatePolicySchema } from './candidate-policy.js';

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

export const candidateAssessmentConfigSchema = z.object({
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
  policy: candidatePolicySchema,
  trustPolicy: trustPolicySchema.default({
    admissibleClasses: ['verified', 'deterministic'],
  }),
  concurrency: z.number().int().min(1).default(4),
  timeoutMs: z.number().int().min(1).default(DEFAULT_TIMEOUT_MS),
  output: z.object({ dir: z.string().min(1) }).strict(),
}).strict();

export type CandidateAssessmentConfig = z.infer<typeof candidateAssessmentConfigSchema>;
export type SuiteInputItem = z.infer<typeof suiteInputItemSchema>;
export type SuiteProviderConfig = z.infer<typeof suiteProviderConfigSchema>;

/**
 * The suite's candidate assessment configuration: what the suite runner
 * projects from a suite configuration, with calibration requirements left
 * out. It is not a format of its own (ADR-0010), so it carries no contract.
 */
export function parseCandidateAssessmentConfig(raw: unknown): CandidateAssessmentConfig {
  return candidateAssessmentConfigSchema.parse(raw);
}
