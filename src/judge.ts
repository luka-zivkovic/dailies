import { z } from 'zod';
import type { JudgeConfig } from './config.js';

/** The judge-gate contract response: POST /judge → { score, pass, reason? } */
export const judgeResultSchema = z.object({
  score: z.number(),
  pass: z.boolean(),
  reason: z.string().optional(),
});

export type JudgeResult = z.infer<typeof judgeResultSchema>;

export async function judgeItem(
  judge: JudgeConfig,
  input: string,
  candidateOutput: string,
  baselineOutput?: string,
): Promise<JudgeResult> {
  if (judge.type === 'exact-match') {
    if (baselineOutput === undefined) {
      return {
        score: 0,
        pass: false,
        reason: 'exact-match judge requires baseline_output on the input item',
      };
    }
    const pass = candidateOutput === baselineOutput;
    return {
      score: pass ? 1 : 0,
      pass,
      ...(pass ? {} : { reason: 'candidate output does not exactly match baseline output' }),
    };
  }

  // http judge implementing the gate contract
  const res = await fetch(judge.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...judge.headers },
    body: JSON.stringify({
      input,
      candidate_output: candidateOutput,
      ...(baselineOutput !== undefined ? { baseline_output: baselineOutput } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`judge HTTP ${res.status} from ${judge.url}`);
  }
  const parsed = judgeResultSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`judge response does not match gate contract: ${parsed.error.message}`);
  }
  return parsed.data;
}
