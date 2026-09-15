import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CONFIG_SCHEMA_VERSION } from './config.js';
import { SUITE_CONFIG_SCHEMA_VERSION } from './config-v5.js';
import { SUITE_CONFIG_V6_SCHEMA_VERSION } from './config-v6.js';

/** Config generations whose `inputs.digest` and `scope.expectedItems` this command maintains. */
export const DIGEST_SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [
  CONFIG_SCHEMA_VERSION,
  SUITE_CONFIG_SCHEMA_VERSION,
  SUITE_CONFIG_V6_SCHEMA_VERSION,
];

export interface DigestSyncOptions {
  /** Report only; never write the config file. */
  check?: boolean;
}

export interface DigestSyncResult {
  configPath: string;
  schemaVersion: number;
  inputsPath: string;
  digest: { declared: string | undefined; observed: string };
  expectedItems: { declared: number | undefined; observed: number };
  /** True when both declared values already equal the observed values. */
  matches: boolean;
  /** True when the config file was rewritten. */
  written: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SHA-256 of the exact artifact bytes, matching the runtime input loader. */
export function inputArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Non-blank line count, matching how the runtime loader counts items. */
export function inputArtifactLineCount(bytes: Uint8Array): number {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace one uniquely matched JSON value token in place; undefined when not unique. */
function replaceUniqueToken(
  text: string,
  key: string,
  oldValueToken: string,
  newValueToken: string,
): string | undefined {
  const pattern = new RegExp(
    `("${escapeRegExp(key)}"\\s*:\\s*)${escapeRegExp(oldValueToken)}(?=\\s*[,}\\n\\r])`,
    'g',
  );
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const start = match.index!;
  const prefix = match[1]!;
  return text.slice(0, start) + prefix + newValueToken +
    text.slice(start + match[0].length);
}

function detectIndent(text: string): string | number {
  const match = /^(?:\{|\[)\r?\n([ \t]+)"/.exec(text);
  return match?.[1] ?? 2;
}

/**
 * Serialize with the original key order and detected indentation. Used only
 * when an in-place token replacement is not uniquely possible.
 */
function reserialize(config: Record<string, unknown>, originalText: string): string {
  const trailingNewline = originalText.endsWith('\n') ? '\n' : '';
  return JSON.stringify(config, null, detectIndent(originalText)) + trailingNewline;
}

/**
 * Recompute the configured JSONL artifact digest and line count and, unless
 * `check` is set, rewrite `inputs.digest` and `scope.expectedItems` in the
 * config file without touching any other key.
 */
export async function syncInputDigest(
  configPath: string,
  options: DigestSyncOptions = {},
): Promise<DigestSyncResult> {
  const absConfigPath = resolve(configPath);
  const originalText = await readFile(absConfigPath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(originalText);
  } catch (error) {
    throw new Error(`config ${absConfigPath} is not valid JSON`, { cause: error });
  }
  if (!isRecord(raw)) {
    throw new Error(`config ${absConfigPath} must be a JSON object`);
  }
  const schemaVersion = raw.schemaVersion;
  if (typeof schemaVersion !== 'number' || !DIGEST_SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new Error(
      `unsupported config schema version: ${schemaVersion === undefined ? 'missing' : String(schemaVersion)}; ` +
        `dailies digest supports schemaVersion ${DIGEST_SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    );
  }
  const inputs = raw.inputs;
  if (!isRecord(inputs) || inputs.type !== 'jsonl' || typeof inputs.path !== 'string' || inputs.path.length === 0) {
    throw new Error('config inputs must declare { "type": "jsonl", "path": "<file>" }');
  }
  const scope = raw.scope;
  if (!isRecord(scope)) {
    throw new Error('config must declare a scope object');
  }

  const inputsPath = isAbsolute(inputs.path) ? inputs.path : resolve(dirname(absConfigPath), inputs.path);
  const bytes = await readFile(inputsPath);
  const observedDigest = inputArtifactDigest(bytes);
  let observedItems: number;
  try {
    observedItems = inputArtifactLineCount(bytes);
  } catch (error) {
    throw new Error(`inputs file ${inputsPath}: not valid UTF-8`, { cause: error });
  }
  if (observedItems === 0) {
    throw new Error(`inputs file is empty: ${inputsPath}`);
  }

  const declaredDigest = typeof inputs.digest === 'string' ? inputs.digest : undefined;
  const declaredItems = typeof scope.expectedItems === 'number' ? scope.expectedItems : undefined;
  const digestMatches = declaredDigest === observedDigest;
  const itemsMatch = declaredItems === observedItems;
  const matches = digestMatches && itemsMatch;

  const result: DigestSyncResult = {
    configPath: absConfigPath,
    schemaVersion,
    inputsPath,
    digest: { declared: declaredDigest, observed: observedDigest },
    expectedItems: { declared: declaredItems, observed: observedItems },
    matches,
    written: false,
  };
  if (matches || options.check === true) return result;

  // Prefer exact in-place token replacement so the rest of the file is untouched.
  let nextText: string | undefined = originalText;
  if (!digestMatches) {
    nextText = declaredDigest === undefined
      ? undefined
      : replaceUniqueToken(nextText, 'digest', JSON.stringify(declaredDigest), JSON.stringify(observedDigest));
  }
  if (nextText !== undefined && !itemsMatch) {
    nextText = declaredItems === undefined
      ? undefined
      : replaceUniqueToken(nextText, 'expectedItems', String(declaredItems), String(observedItems));
  }
  inputs.digest = observedDigest;
  scope.expectedItems = observedItems;
  if (nextText !== undefined) {
    // Verify the textual patch produced exactly the intended object; otherwise reserialize.
    let patched: unknown;
    try {
      patched = JSON.parse(nextText);
    } catch {
      patched = undefined;
    }
    if (patched === undefined || JSON.stringify(patched) !== JSON.stringify(raw)) {
      nextText = undefined;
    }
  }
  await writeFile(absConfigPath, nextText ?? reserialize(raw, originalText), 'utf8');
  result.written = true;
  return result;
}

/** Human-readable summary lines for the CLI. */
export function formatDigestSyncResult(result: DigestSyncResult, check: boolean): string[] {
  const state = (same: boolean) => same ? 'match' : check ? 'MISMATCH' : 'updated';
  return [
    `config: ${result.configPath} (schemaVersion ${result.schemaVersion})`,
    `inputs: ${result.inputsPath}`,
    `digest: ${result.digest.declared ?? '(missing)'} -> ${result.digest.observed} ` +
      `[${state(result.digest.declared === result.digest.observed)}]`,
    `expectedItems: ${result.expectedItems.declared ?? '(missing)'} -> ${result.expectedItems.observed} ` +
      `[${state(result.expectedItems.declared === result.expectedItems.observed)}]`,
    result.matches
      ? 'config already matches the input artifact; nothing written'
      : check
        ? 'config does not match the input artifact; run `dailies digest --config <path>` to update it'
        : `wrote ${result.configPath}`,
  ];
}
