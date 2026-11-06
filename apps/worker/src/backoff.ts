/**
 * Exponential backoff with "equal jitter": the ceiling doubles per attempt (base 2 s, capped at
 * 300 s) and the delay is drawn uniformly from [ceiling / 2, ceiling]. The jitter spreads retries of
 * many events that failed together; the lower half keeps a minimum spacing per event.
 */
export const BACKOFF_BASE_SECONDS = 2;
export const BACKOFF_CAP_SECONDS = 300;

export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  const ceiling = Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.min(attempt - 1, 30));
  const r = Math.min(Math.max(random(), 0), 1);
  return ceiling / 2 + (r * ceiling) / 2;
}
