import type { State } from "./state";

const DEFAULT_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function offlineGraceMs(): number {
  const raw = Number(process.env.TOKMIZER_OFFLINE_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OFFLINE_GRACE_MS;
}

export function graceExceeded(
  state: Pick<State, "lastHeartbeatOkAt">,
  now: number = Date.now()
): boolean {
  const last = state.lastHeartbeatOkAt;
  return typeof last === "number" && now - last > offlineGraceMs();
}
