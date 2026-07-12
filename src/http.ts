/**
 * fetch with a hard timeout. A hung endpoint must map to an item error
 * (counted as a failure), never wedge the whole run.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`${what} request timed out after ${timeoutMs}ms: ${url}`);
    }
    // Node wraps abort causes in a TypeError("fetch failed") sometimes; unwrap timeouts.
    if (
      err instanceof Error &&
      err.cause instanceof Error &&
      err.cause.name === 'TimeoutError'
    ) {
      throw new Error(`${what} request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  }
}
