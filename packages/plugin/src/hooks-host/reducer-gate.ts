import { loadState } from "../state";

export async function reducerStillEntitled(): Promise<boolean> {
  return (await loadState()) !== null;
}
