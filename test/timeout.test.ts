import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCandidate } from '../src/candidate.js';
import type { Config } from '../src/config.js';
import { judgeItem } from '../src/judge.js';
import { decideExitCode, EXIT_BLOCK } from '../src/report.js';
import { runShadow } from '../src/runner.js';
import { v4ContractForPath } from './v4-fixture.js';

/** A server that accepts requests but never responds (simulates a hung endpoint). */
let hangingServer: Server;
let hangingUrl: string;

beforeAll(async () => {
  hangingServer = createServer(() => {
    // never respond
  });
  await new Promise<void>((resolve) => {
    hangingServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = hangingServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  hangingUrl = `http://127.0.0.1:${addr.port}/hang`;
});

afterAll(() => {
  hangingServer.closeAllConnections();
  hangingServer.close();
});

describe('timeouts', () => {
  it('kills a hung candidate command after timeoutMs', async () => {
    await expect(
      runCandidate({ type: 'command', template: 'sleep 30' }, 'in', 200),
    ).rejects.toThrow(/candidate command timed out after 200ms/);
  });

  it('aborts a hung candidate HTTP request after timeoutMs', async () => {
    await expect(
      runCandidate({ type: 'http', url: hangingUrl, bodyTemplate: '{"prompt": {input}}' }, 'in', 200),
    ).rejects.toThrow(/candidate request timed out after 200ms/);
  });

  it('aborts a hung judge HTTP request after timeoutMs', async () => {
    await expect(
      judgeItem({ type: 'http', url: hangingUrl }, 'in', 'out', undefined, 200),
    ).rejects.toThrow(/judge request timed out after 200ms/);
  });

  it('maps a candidate timeout to an item error (counted as failure, never skipped)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-timeout-'));
    const inputsPath = join(dir, 'inputs.jsonl');
    await writeFile(
      inputsPath,
      JSON.stringify({ id: 'slow', input: 'x', baseline_output: 'x' }) + '\n',
      'utf8',
    );
    const config: Config = {
      ...v4ContractForPath(inputsPath),
      candidate: { type: 'command', template: 'sleep 30' },
      judge: { type: 'exact-match' },
      thresholds: { minPassRate: 1, maxRegressions: 0 },
      concurrency: 1,
      timeoutMs: 150,
      output: { dir: 'unused' },
    };

    const report = await runShadow(config);

    expect(report.totals).toMatchObject({
      total: 1,
      passed: 0,
      failed: 1,
      errored: 1,
      candidateErrored: 1,
      judgeErrored: 0,
      evaluated: 0,
      allErrored: true,
    });
    expect(report.decision).toBe('block');
    expect(decideExitCode(report)).toBe(EXIT_BLOCK);
    expect(report.items[0]?.pass).toBe(false);
    expect(report.items[0]).toMatchObject({
      outcome: 'error',
      errorStage: 'candidate',
      errorKind: 'timeout',
      regression: false,
    });
    expect(report.items[0]?.error).toMatch(/timed out after 150ms/);
    expect(report.items[0]?.attempts.candidate).toEqual([
      {
        attempt: 1,
        outcome: 'error',
        errorKind: 'timeout',
        retryable: true,
        delayBeforeNextMs: 100,
      },
      {
        attempt: 2,
        outcome: 'error',
        errorKind: 'timeout',
        retryable: true,
      },
    ]);
  }, 15_000);
});
