export const ERROR_KINDS = [
  'timeout',
  'transport',
  'http',
  'protocol',
  'incomplete',
  'execution',
  'unknown',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface OperationErrorOptions {
  httpStatus?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

/** Typed failure used by retry policy and persisted attempt audit data. */
export class OperationError extends Error {
  readonly kind: ErrorKind;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, kind: ErrorKind, options: OperationErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OperationError';
    this.kind = kind;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Parse Retry-After seconds or an HTTP date into a nonnegative delay. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const delay = Number(trimmed) * 1_000;
    return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : undefined;
  }
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

export function httpOperationError(
  what: string,
  url: string,
  response: Pick<Response, 'status' | 'headers'>,
): OperationError {
  return new OperationError(`${what} HTTP ${response.status} from ${url}`, 'http', {
    httpStatus: response.status,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  });
}

export function classifyOperationError(error: unknown): {
  kind: ErrorKind;
  httpStatus?: number;
  retryAfterMs?: number;
} {
  if (error instanceof OperationError) {
    return {
      kind: error.kind,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return { kind: 'timeout' };
  const status = /HTTP (\d+)/i.exec(message)?.[1];
  if (status !== undefined) return { kind: 'http', httpStatus: Number(status) };
  if (/gate contract|Rubrist contract|"output" field/i.test(message)) {
    return { kind: 'protocol' };
  }
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) {
    return { kind: 'transport' };
  }
  if (error instanceof Error && 'code' in error) return { kind: 'execution' };
  return { kind: 'unknown' };
}

export function isRetryableFailure(kind: ErrorKind, httpStatus?: number): boolean {
  if (kind === 'timeout' || kind === 'transport') return true;
  return kind === 'http' &&
    httpStatus !== undefined &&
    (httpStatus === 429 || httpStatus >= 500);
}
