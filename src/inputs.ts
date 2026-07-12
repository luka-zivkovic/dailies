import { readFile } from 'node:fs/promises';
import { inputItemSchema, type InputItem } from './config.js';

export async function loadInputs(path: string): Promise<InputItem[]> {
  const text = await readFile(path, 'utf8');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error(`inputs file is empty: ${path}`);
  }
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`inputs file ${path}, line ${i + 1}: not valid JSON`);
    }
    const result = inputItemSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `inputs file ${path}, line ${i + 1}: ${result.error.issues[0]?.message ?? 'invalid item'}`,
      );
    }
    return result.data;
  });
}
