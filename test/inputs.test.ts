import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { loadInputs } from '../src/inputs.js';
import { runShadow } from '../src/runner.js';

async function writeInputs(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-inputs-'));
  const path = join(dir, 'inputs.jsonl');
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return path;
}

describe('input preflight', () => {
  it('rejects duplicate input ids with both line numbers', async () => {
    const path = await writeInputs([
      { id: 'same', input: 'a', baseline_output: 'a' },
      { id: 'same', input: 'b', baseline_output: 'b' },
    ]);

    await expect(loadInputs(path)).rejects.toThrow(
      /line 2: duplicate input id "same" \(first seen on line 1\)/,
    );
  });

  it('rejects a missing exact-match baseline before candidate execution', async () => {
    const path = await writeInputs([{ id: 'missing', input: 'a' }]);
    const config: Config = {
      inputs: { type: 'jsonl', path },
      // If preflight regresses, this would become an item-level candidate error.
      candidate: { type: 'command', template: 'exit 91' },
      judge: { type: 'exact-match' },
      thresholds: { minPassRate: 1, maxRegressions: 0 },
      concurrency: 1,
      timeoutMs: 1_000,
      output: { dir: 'unused' },
    };

    await expect(runShadow(config)).rejects.toThrow(
      /input missing is missing baseline_output required by the exact-match judge/,
    );
  });

  it('rejects an invalid baseline_label at input parsing', async () => {
    const path = await writeInputs([
      { id: 'invalid-label', input: 'a', baseline_label: 'unknown' },
    ]);
    await expect(loadInputs(path)).rejects.toThrow(/line 1/);
  });
});
