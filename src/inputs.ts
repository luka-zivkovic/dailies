import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { z } from 'zod';
import { inputItemSchema, type InputItem } from './config.js';

export interface InputArtifact {
  items: InputItem[];
  digest: string;
  byteLength: number;
}

export interface ParsedInputArtifact<T> {
  items: T[];
  digest: string;
  byteLength: number;
}

/** Read, hash, decode, and parse one immutable snapshot of an input artifact. */
export async function loadInputArtifact(
  path: string,
  expectedDigest?: string,
): Promise<InputArtifact> {
  return loadInputArtifactWithSchema(path, inputItemSchema, expectedDigest);
}

/** Version-selectable exact-byte loader used by the additive suite contract. */
export async function loadInputArtifactWithSchema<T extends { id: string }>(
  path: string,
  schema: z.ZodType<T>,
  expectedDigest?: string,
): Promise<ParsedInputArtifact<T>> {
  const bytes = await readFile(path);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    throw new Error(`input artifact digest mismatch: expected ${expectedDigest}, observed ${digest}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`inputs file ${path}: not valid UTF-8`, { cause: error });
  }

  const lines = text.split('\n').map((line, index) => ({
    line: line.trim(),
    lineNumber: index + 1,
  })).filter(({ line }) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(`inputs file is empty: ${path}`);
  }
  const items = lines.map(({ line, lineNumber }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`inputs file ${path}, line ${lineNumber}: not valid JSON`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `inputs file ${path}, line ${lineNumber}: ${result.error.issues[0]?.message ?? 'invalid item'}`,
      );
    }
    return { item: result.data, lineNumber };
  });

  const firstLineById = new Map<string, number>();
  for (const { item, lineNumber } of items) {
    const firstLine = firstLineById.get(item.id);
    if (firstLine !== undefined) {
      throw new Error(
        `inputs file ${path}, line ${lineNumber}: duplicate input id ${JSON.stringify(item.id)} ` +
          `(first seen on line ${firstLine})`,
      );
    }
    firstLineById.set(item.id, lineNumber);
  }

  return {
    items: items.map(({ item }) => item),
    digest,
    byteLength: bytes.byteLength,
  };
}

export async function loadInputs(path: string): Promise<InputItem[]> {
  return (await loadInputArtifact(path)).items;
}
