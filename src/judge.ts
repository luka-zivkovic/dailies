import { z } from 'zod';
import { DEFAULT_TIMEOUT_MS, type JudgeConfig } from './config.js';
import { OperationError, httpOperationError } from './errors.js';
import { fetchWithTimeout } from './http.js';

/** The judge-gate contract response: POST /judge → { score, pass, reason? } */
export const judgeResultSchema = z.object({
  score: z.number(),
  pass: z.boolean(),
  reason: z.string().optional(),
}).strict();

export type JudgeResult = z.infer<typeof judgeResultSchema>;

export async function judgeItem(
  judge: JudgeConfig,
  input: string,
  candidateOutput: string,
  baselineOutput?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
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

  if (judge.type === 'coeval') {
    throw new OperationError(
      'coeval judge must be run through its batch evidence protocol',
      'protocol',
    );
  }

  // http judge implementing the gate contract
  const res = await fetchWithTimeout(
    judge.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...judge.headers },
      body: JSON.stringify({
        input,
        candidate_output: candidateOutput,
        ...(baselineOutput !== undefined ? { baseline_output: baselineOutput } : {}),
      }),
    },
    timeoutMs,
    'judge',
  );
  if (!res.ok) {
    throw httpOperationError('judge', judge.url, res);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (error) {
    throw new OperationError(
      `judge response does not match gate contract: invalid JSON`,
      'protocol',
      { cause: error },
    );
  }
  const parsed = judgeResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OperationError(
      `judge response does not match gate contract: ${parsed.error.message}`,
      'protocol',
    );
  }
  return parsed.data;
}
