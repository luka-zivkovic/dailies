import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { loadInputArtifact, loadInputs } from '../src/inputs.js';
import { runShadow } from '../src/runner.js';
import { v4ContractForPath } from './v4-fixture.js';

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

    let candidateCalls = 0;
    const server = createServer((_req, res) => {
      candidateCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"output":"unused"}');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('server did not bind');
        resolve(address.port);
      });
    });
    const config: Config = {
      ...v4ContractForPath(path),
      candidate: {
        type: 'http',
        url: `http://127.0.0.1:${port}/candidate`,
        bodyTemplate: '{"input": {input}}',
      },
      judge: { type: 'exact-match' },
      thresholds: { minPassRate: 1, maxRegressions: 0 },
      concurrency: 1,
      timeoutMs: 1_000,
      output: { dir: 'unused' },
    };
    try {
      await expect(runShadow(config)).rejects.toThrow(/duplicate input id/);
      expect(candidateCalls).toBe(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('rejects a missing exact-match baseline before candidate execution', async () => {
    const path = await writeInputs([{ id: 'missing', input: 'a' }]);
    let candidateCalls = 0;
    const server = createServer((_req, res) => {
      candidateCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"output":"unused"}');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('server did not bind');
        resolve(address.port);
      });
    });
    const config: Config = {
      ...v4ContractForPath(path),
      candidate: {
        type: 'http',
        url: `http://127.0.0.1:${port}/candidate`,
        bodyTemplate: '{"input": {input}}',
      },
      judge: { type: 'exact-match' },
      thresholds: { minPassRate: 1, maxRegressions: 0 },
      concurrency: 1,
      timeoutMs: 1_000,
      output: { dir: 'unused' },
    };

    try {
      await expect(runShadow(config)).rejects.toThrow(
        /input missing is missing baseline_output required by the exact-match judge/,
      );
      expect(candidateCalls).toBe(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('rejects an invalid baseline_label at input parsing', async () => {
    const path = await writeInputs([
      { id: 'invalid-label', input: 'a', baseline_label: 'unknown' },
    ]);
    await expect(loadInputs(path)).rejects.toThrow(/line 1/);
  });

  it('uses exact bytes as identity independently of the file path', async () => {
    const bytes = '{"id":"one","input":"alpha"}\n';
    const firstDir = await mkdtemp(join(tmpdir(), 'dailies-input-identity-a-'));
    const secondDir = await mkdtemp(join(tmpdir(), 'dailies-input-identity-b-'));
    const first = join(firstDir, 'first.jsonl');
    const second = join(secondDir, 'renamed.jsonl');
    await Promise.all([writeFile(first, bytes), writeFile(second, bytes)]);

    const [firstArtifact, secondArtifact] = await Promise.all([
      loadInputArtifact(first),
      loadInputArtifact(second),
    ]);
    expect(firstArtifact.digest).toBe(secondArtifact.digest);
    expect(firstArtifact.byteLength).toBe(Buffer.byteLength(bytes));
    expect(firstArtifact.items).toEqual(secondArtifact.items);
  });

  it('distinguishes byte-level JSONL variants that parse to equivalent cases', async () => {
    const variants = [
      '{"id":"one","input":"alpha"}',
      '{"id":"one","input":"alpha"}\n',
      '{"id":"one","input":"alpha"}\r\n',
      ' { "id": "one", "input": "alpha" }\n',
      '{"input":"alpha","id":"one"}\n',
      '\uFEFF{"id":"one","input":"alpha"}\n',
    ];
    const dir = await mkdtemp(join(tmpdir(), 'dailies-input-variants-'));
    const artifacts = await Promise.all(variants.map(async (bytes, index) => {
      const path = join(dir, `${index}.jsonl`);
      await writeFile(path, bytes);
      return loadInputArtifact(path);
    }));

    expect(new Set(artifacts.map((artifact) => artifact.digest)).size).toBe(variants.length);
    expect(artifacts.every((artifact) => artifact.items[0]?.id === 'one')).toBe(true);
  });

  it('rejects invalid UTF-8 instead of hashing one byte sequence and parsing replacement text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dailies-invalid-utf8-'));
    const path = join(dir, 'inputs.jsonl');
    await writeFile(path, Buffer.from([0xc3, 0x28]));
    await expect(loadInputArtifact(path)).rejects.toThrow(/not valid UTF-8/);
  });
});
