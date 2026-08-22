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
  const items = lines.map((line, i) => {
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

  const firstLineById = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const firstLine = firstLineById.get(item.id);
    if (firstLine !== undefined) {
      throw new Error(
        `inputs file ${path}, line ${index + 1}: duplicate input id ${JSON.stringify(item.id)} ` +
          `(first seen on line ${firstLine})`,
      );
    }
    firstLineById.set(item.id, index + 1);
  }

  return items;
}
