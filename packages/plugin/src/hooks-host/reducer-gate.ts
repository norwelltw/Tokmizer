import { loadState } from "../state";
import { gatingPlan, gatingBonus } from "../entitlement";
import { reducerEntitled } from "../engine/plans";

export async function reducerStillEntitled(): Promise<boolean> {
  const state = await loadState();
  if (!state) return false;
  return reducerEntitled(gatingPlan(state), gatingBonus(state));
}
