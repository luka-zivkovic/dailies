import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { formatDigestSyncResult, syncInputDigest } from '../src/digest.js';
import { loadInputArtifact } from '../src/inputs.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, 'dist', 'cli.js');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const TWO_ITEMS =
  '{"id":"a","input":"x","baseline_label":"pass","baseline_output":"x"}\n' +
  '{"id":"b","input":"y","baseline_output":"y"}\n';
const THREE_ITEMS = TWO_ITEMS + '\n{"id":"c","input":"z","baseline_output":"z"}\n';

/** A hand-formatted v4 config whose layout should survive an in-place update. */
function formattedConfig(digest: string, expectedItems: number): string {
  return `{
  "schemaVersion": 4,
  "inputs": {
    "type": "jsonl",
    "path": "cases.jsonl",
    "digest": "${digest}"
  },
  "scope": {
    "id": "example-scope",
    "kind": "regression_corpus",
    "expectedItems": ${expectedItems},
    "collectionProcedure": "Authored.",
    "population": "Two documented behaviors.",
    "timeWindow": { "kind": "not_applicable", "reason": "static" }
  },
  "candidate": { "type": "command", "template": "printf %s {input}" },
  "judge": { "type": "exact-match" },
  "thresholds": { "minPassRate": 1, "maxRegressions": 0 },
  "output": { "dir": "./out" }
}
`;
}

async function writeProject(configText: string, inputsText: string): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-digest-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'dailies.config.json');
  await writeFile(configPath, configText, 'utf8');
  await writeFile(join(dir, 'cases.jsonl'), inputsText, 'utf8');
  return { dir, configPath };
}

function runCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], { cwd, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

describe('dailies digest', () => {
  it('reports a match without writing when digest and expectedItems are current', async () => {
    const text = formattedConfig(sha256(TWO_ITEMS), 2);
    const { configPath } = await writeProject(text, TWO_ITEMS);
    const result = await syncInputDigest(configPath);
    expect(result).toMatchObject({
      schemaVersion: 4,
      matches: true,
      written: false,
      digest: { declared: sha256(TWO_ITEMS), observed: sha256(TWO_ITEMS) },
      expectedItems: { declared: 2, observed: 2 },
    });
    expect(await readFile(configPath, 'utf8')).toBe(text);
    expect(formatDigestSyncResult(result, false).at(-1)).toContain('nothing written');
  });

  it('updates only the two tokens in place and preserves formatting and key order', async () => {
    const stale = formattedConfig(sha256(TWO_ITEMS), 2);
    const { configPath, dir } = await writeProject(stale, THREE_ITEMS);
    const result = await syncInputDigest(configPath);
    expect(result).toMatchObject({
      matches: false,
      written: true,
      digest: { declared: sha256(TWO_ITEMS), observed: sha256(THREE_ITEMS) },
      expectedItems: { declared: 2, observed: 3 },
    });
    const updated = await readFile(configPath, 'utf8');
    expect(updated).toBe(formattedConfig(sha256(THREE_ITEMS), 3));
    // The rewritten config is valid and the run-time loader accepts the artifact.
    const config = parseConfig(JSON.parse(updated));
    const artifact = await loadInputArtifact(join(dir, 'cases.jsonl'), config.inputs.digest);
    expect(artifact.items).toHaveLength(config.scope.expectedItems);
    // Blank lines never count as items.
    expect(config.scope.expectedItems).toBe(3);
  });

  it('never writes in --check mode and reports the mismatch', async () => {
    const stale = formattedConfig(sha256(TWO_ITEMS), 2);
    const { configPath } = await writeProject(stale, THREE_ITEMS);
    const result = await syncInputDigest(configPath, { check: true });
    expect(result).toMatchObject({ matches: false, written: false });
    expect(await readFile(configPath, 'utf8')).toBe(stale);
    const lines = formatDigestSyncResult(result, true);
    expect(lines.some((line) => line.includes('MISMATCH'))).toBe(true);
    expect(lines.at(-1)).toContain('does not match');
  });

  it('refuses unknown or missing schema versions without touching the file', async () => {
    for (const version of [3, 7, '4', undefined]) {
      const text = JSON.stringify({
        ...(version === undefined ? {} : { schemaVersion: version }),
        inputs: { type: 'jsonl', path: 'cases.jsonl', digest: 'sha256:0' },
        scope: { expectedItems: 1 },
      }, null, 2) + '\n';
      const { configPath } = await writeProject(text, TWO_ITEMS);
      await expect(syncInputDigest(configPath)).rejects.toThrow(/unsupported config schema version/);
      expect(await readFile(configPath, 'utf8')).toBe(text);
    }
  });

  it('accepts v5 and v6 configs and leaves every other key byte-identical', async () => {
    for (const schemaVersion of [5, 6]) {
      const text = `{
  "schemaVersion": ${schemaVersion},
  "inputs": { "type": "jsonl", "path": "cases.jsonl", "digest": "${sha256('old')}" },
  "scope": { "id": "s", "kind": "regression_corpus", "expectedItems": 1 },
  "suite": {
    "manifest": {
      "type": "file", "path": "manifest.json", "manifestId": "m",
      "manifestDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    }
  },
  "calibrationEvidence": [ { "source": { "artifactDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111" } } ],
  "expectedItems": 99
}
`;
      const { configPath } = await writeProject(text, TWO_ITEMS);
      const result = await syncInputDigest(configPath);
      expect(result).toMatchObject({ schemaVersion, written: true });
      const updated = await readFile(configPath, 'utf8');
      expect(updated).toBe(
        text
          .replace(sha256('old'), sha256(TWO_ITEMS))
          .replace('"expectedItems": 1', '"expectedItems": 2'),
      );
      // Sibling digests and an unrelated top-level expectedItems are untouched.
      expect(updated).toContain('"manifestDigest": "sha256:0000');
      expect(updated).toContain('"artifactDigest": "sha256:1111');
      expect(updated).toContain('"expectedItems": 99');
    }
  });

  it('fills in a missing digest or expectedItems by reserializing with the original key order', async () => {
    const text = JSON.stringify({
      schemaVersion: 4,
      output: { dir: 'out' },
      inputs: { type: 'jsonl', path: 'cases.jsonl' },
      scope: { id: 's', kind: 'regression_corpus' },
    }, null, 4) + '\n';
    const { configPath } = await writeProject(text, TWO_ITEMS);
    const result = await syncInputDigest(configPath);
    expect(result).toMatchObject({
      written: true,
      digest: { declared: undefined, observed: sha256(TWO_ITEMS) },
      expectedItems: { declared: undefined, observed: 2 },
    });
    const updated = await readFile(configPath, 'utf8');
    expect(Object.keys(JSON.parse(updated) as object)).toEqual(['schemaVersion', 'output', 'inputs', 'scope']);
    expect(updated.startsWith('{\n    "schemaVersion": 4,')).toBe(true);
    expect(JSON.parse(updated)).toMatchObject({
      inputs: { digest: sha256(TWO_ITEMS) },
      scope: { expectedItems: 2 },
    });
  });

  it('rejects an empty input artifact', async () => {
    const { configPath } = await writeProject(formattedConfig(sha256(''), 1), '\n\n');
    await expect(syncInputDigest(configPath)).rejects.toThrow(/inputs file is empty/);
  });

  it('exits 0 on match, 1 on --check mismatch, and 2 on an unsupported config through the CLI', async () => {
    const { configPath, dir } = await writeProject(formattedConfig(sha256(TWO_ITEMS), 2), THREE_ITEMS);
    const check = await runCli(['digest', '--config', 'dailies.config.json', '--check'], dir);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain('MISMATCH');
    expect(await readFile(configPath, 'utf8')).toBe(formattedConfig(sha256(TWO_ITEMS), 2));

    const write = await runCli(['digest', '--config', 'dailies.config.json'], dir);
    expect(write.code).toBe(0);
    expect(write.stdout).toContain(`${sha256(TWO_ITEMS)} -> ${sha256(THREE_ITEMS)} [updated]`);
    expect(write.stdout).toContain('expectedItems: 2 -> 3 [updated]');

    const again = await runCli(['digest', '--config', 'dailies.config.json', '--check'], dir);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('nothing written');

    const run = await runCli(['--config', 'dailies.config.json'], dir);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('decision: promote');

    await writeFile(configPath, JSON.stringify({ schemaVersion: 3, inputs: {}, scope: {} }), 'utf8');
    const unsupported = await runCli(['digest', '--config', 'dailies.config.json'], dir);
    expect(unsupported.code).toBe(2);
    expect(unsupported.stderr).toContain('unsupported config schema version: 3');
  });
});
