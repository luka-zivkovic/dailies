import { createHash } from 'node:crypto';
import { OperationError } from './errors.js';

// Rubrist's canonical JSON and digests, which every Rubrist evidence verifier
// shares. A leaf module, so the verifiers and the collection client can import
// it and each other without a cycle.

export class RubristProtocolError extends OperationError {
  constructor(message: string) {
    super(message, 'protocol');
    this.name = 'RubristProtocolError';
  }
}

/** Rubrist's canonical JSON: recursive lexicographic object keys, stable array order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RubristProtocolError('canonical JSON rejects non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => entry === undefined ? 'null' : canonicalJson(entry))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new RubristProtocolError(`canonical JSON does not support ${typeof value}`);
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
