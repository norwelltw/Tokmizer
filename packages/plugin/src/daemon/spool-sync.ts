import { loadState } from "../state";
import { heartbeat, jwtExpired } from "../license";
import { flush } from "../learn/recorder";
import { flushTelemetry } from "../learn/telemetry";
import { networkEnabled } from "../network";

const AUTH_RENEW_COOLDOWN_MS = 10 * 60_000;
const JWT_SKEW_MS = 60_000;

export function createSpoolSync(baseUrl: string): () => Promise<void> {
  let lastRenewAt = 0;
  const renew = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastRenewAt < AUTH_RENEW_COOLDOWN_MS) return;
    let next: Awaited<ReturnType<typeof heartbeat>>;
    try {
      next = await heartbeat(baseUrl);
    } catch {
      lastRenewAt = now;
      return;
    }
    if (next && !jwtExpired(next.jwt, JWT_SKEW_MS)) lastRenewAt = now;
  };
  return async () => {
    if (!networkEnabled()) return;
    const state = await loadState();
    if (!state) return;
    if (jwtExpired(state.jwt, JWT_SKEW_MS)) {
      await renew();
      return;
    }
    const results = await Promise.all([flush(baseUrl), flushTelemetry(baseUrl)]);
    if (results.includes("auth")) await renew();
  };
}
