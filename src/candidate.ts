import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CandidateConfig } from './config.js';

const execFileAsync = promisify(execFile);

function shellQuote(s: string): string {
  return `'` + s.replaceAll(`'`, `'\\''`) + `'`;
}

/** Run one input through the candidate; returns the candidate's output string. */
export async function runCandidate(candidate: CandidateConfig, input: string): Promise<string> {
  if (candidate.type === 'command') {
    const cmd = candidate.template.replaceAll('{input}', shellQuote(input));
    const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd]);
    return stdout.replace(/\n$/, '');
  }

  // http
  const body = candidate.bodyTemplate.replaceAll('{input}', JSON.stringify(input));
  const res = await fetch(candidate.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...candidate.headers },
    body,
  });
  if (!res.ok) {
    throw new Error(`candidate HTTP ${res.status} from ${candidate.url}`);
  }
  const text = await res.text();
  // If the response is JSON with a string `output` field, use it; otherwise the raw body.
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { output?: unknown }).output === 'string'
    ) {
      return (parsed as { output: string }).output;
    }
  } catch {
    // not JSON — fall through to raw text
  }
  return text;
}
