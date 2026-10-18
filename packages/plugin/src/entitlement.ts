import type { Plan } from "./contracts";
import type { State } from "./state";

const DEFAULT_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function offlineGraceMs(): number {
  const raw = Number(process.env.TOKMIZER_OFFLINE_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OFFLINE_GRACE_MS;
}

export function graceExceeded(
  state: Pick<State, "lastHeartbeatOkAt" | "subEndsAt">,
  now: number = Date.now()
): boolean {
  const last = state.lastHeartbeatOkAt;
  if (typeof last === "number" && now - last > offlineGraceMs()) return true;
  if (state.subEndsAt) {
    const end = Date.parse(state.subEndsAt);
    if (Number.isFinite(end) && now > end) return true;
  }
  return false;
}

export function gatingPlan(
  state: Pick<State, "plan" | "lastHeartbeatOkAt" | "subEndsAt">,
  now: number = Date.now()
): Plan {
  return state.plan;
}

export function gatingBonus(
  state: Pick<State, "bonusActive" | "lastHeartbeatOkAt" | "subEndsAt">,
  now: number = Date.now()
): boolean {
  return state.bonusActive ?? false;
}
