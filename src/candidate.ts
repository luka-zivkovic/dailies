import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_TIMEOUT_MS, type CandidateConfig } from './config.js';
import { fetchWithTimeout } from './http.js';

const execFileAsync = promisify(execFile);

/**
 * Explicit maxBuffer for candidate commands. Node's default (1 MiB) causes
 * spurious ENOBUFS failures on large-but-legitimate outputs.
 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function shellQuote(s: string): string {
  return `'` + s.replaceAll(`'`, `'\\''`) + `'`;
}

/** Run one input through the candidate; returns the candidate's output string. */
export async function runCandidate(
  candidate: CandidateConfig,
  input: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  if (candidate.type === 'command') {
    // The replacement must be a function: with a string replacement,
    // `$$`/`$&`/`$'`/`$\`` in the input would be interpreted as substitution
    // patterns and silently corrupt it (e.g. `x$$y` -> `x$y`).
    const cmd = candidate.template.replaceAll('{input}', () => shellQuote(input));
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd], {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_BUFFER_BYTES,
      });
      return stdout.replace(/\n$/, '');
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      if (e.killed === true && e.signal === 'SIGKILL') {
        throw new Error(`candidate command timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  // http — function replacement for the same reason as above.
  const body = candidate.bodyTemplate.replaceAll('{input}', () => JSON.stringify(input));
  const res = await fetchWithTimeout(
    candidate.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...candidate.headers },
      body,
    },
    timeoutMs,
    'candidate',
  );
  if (!res.ok) {
    throw new Error(`candidate HTTP ${res.status} from ${candidate.url}`);
  }
  const text = await res.text();

  // If the response is JSON with an `output` key, that key must be a string;
  // a present-but-non-string `output` is an error, not a raw-body fallback.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // not JSON — use the raw body
  }
  if (parsed !== null && typeof parsed === 'object' && 'output' in parsed) {
    const output = (parsed as { output: unknown }).output;
    if (typeof output === 'string') {
      return output;
    }
    const kind = output === null ? 'null' : Array.isArray(output) ? 'array' : typeof output;
    throw new Error(
      `candidate response from ${candidate.url} has an "output" field that is not a string (got ${kind})`,
    );
  }
  return text; // JSON without an `output` key — use the raw body
}
