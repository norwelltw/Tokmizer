import type { Plan } from "../contracts";

export function powerAvailable(plan: Plan, bonusActive = false): boolean {
  return true;
}

export function reducerEntitled(plan: Plan, bonusActive = false): boolean {
  return true;
}
