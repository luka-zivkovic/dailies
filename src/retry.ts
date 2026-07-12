/** Run `fn`, retrying once on failure. Throws the last error if the retry also fails. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
