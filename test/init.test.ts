import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  initializeDailiesProject,
  STARTER_CONFIG_FILENAME,
  STARTER_INPUTS_FILENAME,
} from '../src/init.js';
import { loadInputArtifact } from '../src/inputs.js';
import { runShadow } from '../src/runner.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dailies-init-'));
  tempDirs.push(directory);
  return directory;
}

describe('starter initialization', () => {
  it('creates a valid, digest-pinned starter that promotes on its declared demo scope', async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, 'starter');
    const result = await initializeDailiesProject(directory);
    const inputBytes = await readFile(result.inputsPath);
    const config = parseConfig(JSON.parse(await readFile(result.configPath, 'utf8')));
    const digest = `sha256:${createHash('sha256').update(inputBytes).digest('hex')}`;

    expect(result.directory).toBe(directory);
    expect(config.inputs).toMatchObject({
      path: STARTER_INPUTS_FILENAME,
      digest,
    });
    expect(config.scope).toMatchObject({
      kind: 'regression_corpus',
      expectedItems: 3,
      population: 'Only the three generated starter behaviors.',
    });

    const artifact = await loadInputArtifact(result.inputsPath, config.inputs.digest);
    expect(artifact.items).toHaveLength(3);
    const report = await runShadow({
      ...config,
      inputs: { ...config.inputs, path: result.inputsPath },
      output: { dir: join(directory, config.output.dir) },
    });
    expect(report.decision).toBe('promote');
    expect(report.totals).toMatchObject({ passed: 3, total: 3, regressions: 0, errored: 0 });
  });

  it('refuses to overwrite either starter file and leaves the other path untouched', async () => {
    const directory = await temporaryDirectory();
    const existingConfig = join(directory, STARTER_CONFIG_FILENAME);
    await writeFile(existingConfig, 'keep me\n', 'utf8');

    await expect(initializeDailiesProject(directory)).rejects.toThrow(
      `refusing to overwrite existing file: ${existingConfig}`,
    );
    expect(await readFile(existingConfig, 'utf8')).toBe('keep me\n');
    await expect(readFile(join(directory, STARTER_INPUTS_FILENAME), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('allows only one winner when two initializations race', async () => {
    const directory = await temporaryDirectory();
    const outcomes = await Promise.allSettled([
      initializeDailiesProject(directory),
      initializeDailiesProject(directory),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const config = parseConfig(
      JSON.parse(await readFile(join(directory, STARTER_CONFIG_FILENAME), 'utf8')),
    );
    await expect(
      loadInputArtifact(join(directory, STARTER_INPUTS_FILENAME), config.inputs.digest),
    ).resolves.toMatchObject({ byteLength: expect.any(Number) });
  });
});
