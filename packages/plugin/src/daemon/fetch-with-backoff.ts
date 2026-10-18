import type { DaemonRuntime } from "./runtime";

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;
const RECENT_FAILURE_THRESHOLD = 3;

export type FetchWrapper = () => Promise<DaemonRuntime>;

export function withBackoff(fetcher: FetchWrapper): FetchWrapper {
  let consecutiveFailures = 0;
  let cooldownUntil = 0;
  let lastErr: Error | null = null;

  return async function fetchWithBackoff(): Promise<DaemonRuntime> {
    const now = Date.now();
    if (cooldownUntil > now && lastErr) {
      throw new Error(
        `bundle fetch cooling down for ${cooldownUntil - now}ms (last: ${lastErr.message})`
      );
    }
    try {
      const out = await fetcher();
      consecutiveFailures = 0;
      cooldownUntil = 0;
      lastErr = null;
      return out;
    } catch (err) {
      consecutiveFailures += 1;
      lastErr = err as Error;
      if (consecutiveFailures >= RECENT_FAILURE_THRESHOLD) {
        const delay = Math.min(
          MAX_DELAY_MS,
          BASE_DELAY_MS * 2 ** (consecutiveFailures - RECENT_FAILURE_THRESHOLD)
        );
        cooldownUntil = Date.now() + delay;
      }
      throw err;
    }
  };
}
